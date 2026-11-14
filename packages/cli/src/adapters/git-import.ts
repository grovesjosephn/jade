import { cp, mkdir } from "fs/promises";
import { dirname, isAbsolute, resolve } from "path";
import { fsExists, fsRemove } from "./fs.ts";
import { realGitProcessRunner } from "./git-process.ts";

/**
 * Git operations behind `jade import`: turning an ordinary clone (a directory
 * with a `.git/` folder) into a jade bare repo plus worktrees. Every operation
 * on the source repo is read-only: refs and objects are copied out of it, and
 * nothing in it is changed.
 */

/** What `jade import` needs to know about the repo it's pointed at */
export interface ImportSource {
  /** Top of the source working tree */
  root: string;
  /** Checked-out branch, or null on a detached HEAD */
  branch: string | null;
  /** Commit HEAD points at */
  head: string;
  /** origin's URL, or null when the source has no origin remote */
  originUrl: string | null;
  /** Best guess at the default branch: origin/HEAD, then main/master; null if none fits */
  defaultBranch: string | null;
  /** Whether the work tree has staged, unstaged or untracked (not ignored) changes */
  dirty: boolean;
  /** Set when the source can't be imported, with the reason */
  problem: string | null;
  /** The source has submodules; their checkouts aren't carried over */
  hasSubmodules: boolean;
  /** Entries in the source's stash list; stashes aren't carried over */
  stashCount: number;
  /** Other worktrees of the source repo; their uncommitted work isn't carried over */
  linkedWorktrees: string[];
}

const run = (cwd: string, args: string[]) => realGitProcessRunner.run(args, { cwd, nothrow: true });
const out = async (cwd: string, args: string[]) => {
  const r = await run(cwd, args);
  return r.exitCode === 0 ? r.stdout.trim() : null;
};

async function refExists(repo: string, ref: string): Promise<boolean> {
  return (await run(repo, ["show-ref", "--verify", "--quiet", ref])).exitCode === 0;
}

/**
 * Inspect the repo at `path` (or the repo containing it). Returns null when
 * `path` isn't inside a git work tree at all.
 */
export async function gitInspectImportSource(path: string): Promise<ImportSource | null> {
  if (!(await fsExists(path))) return null;
  if ((await out(path, ["rev-parse", "--is-bare-repository"])) === "true") {
    return blankSource(path, "it's a bare repository; point jade import at a working copy");
  }
  const root = await out(path, ["rev-parse", "--show-toplevel"]);
  if (!root) return null;

  const gitDir = await out(root, ["rev-parse", "--absolute-git-dir"]);
  const commonDir = await out(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const superproject = await out(root, ["rev-parse", "--show-superproject-working-tree"]);
  const head = await out(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);

  let problem: string | null = null;
  if (superproject) problem = `it's a submodule of ${superproject}`;
  else if (gitDir && commonDir && resolve(gitDir) !== resolve(commonDir)) {
    problem = `it's a linked worktree of ${dirname(commonDir)}; import the main checkout instead`;
  } else if (!head) problem = "it has no commits yet";
  else if (gitDir) {
    for (const [file, what] of [
      ["MERGE_HEAD", "a merge"],
      ["rebase-merge", "a rebase"],
      ["rebase-apply", "a rebase or am"],
      ["CHERRY_PICK_HEAD", "a cherry-pick"],
      ["REVERT_HEAD", "a revert"],
      ["BISECT_LOG", "a bisect"],
    ] as const) {
      if (await fsExists(resolve(gitDir, file))) {
        problem = `${what} is in progress; finish or abort it first`;
        break;
      }
    }
  }

  const branch = await out(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const originUrl = await out(root, ["remote", "get-url", "origin"]);
  const status = (await out(root, ["status", "--porcelain"])) ?? "";

  let defaultBranch: string | null = null;
  const originHead = await out(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead?.startsWith("origin/")) defaultBranch = originHead.slice("origin/".length);
  else {
    for (const candidate of ["main", "master"]) {
      if (
        (await refExists(root, `refs/heads/${candidate}`)) ||
        (await refExists(root, `refs/remotes/origin/${candidate}`))
      ) {
        defaultBranch = candidate;
        break;
      }
    }
  }

  const stashList = (await out(root, ["stash", "list"])) ?? "";
  const worktreeList = (await out(root, ["worktree", "list", "--porcelain"])) ?? "";
  const linkedWorktrees = worktreeList
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .filter((p) => resolve(p) !== resolve(root));

  return {
    root,
    branch,
    head: head ?? "",
    originUrl,
    defaultBranch,
    dirty: status.length > 0,
    problem,
    hasSubmodules: await fsExists(resolve(root, ".gitmodules")),
    stashCount: stashList ? stashList.split("\n").length : 0,
    linkedWorktrees,
  };
}

function blankSource(root: string, problem: string): ImportSource {
  return {
    root,
    branch: null,
    head: "",
    originUrl: null,
    defaultBranch: null,
    dirty: false,
    problem,
    hasSubmodules: false,
    stashCount: 0,
    linkedWorktrees: [],
  };
}

/**
 * Whether `branch` exists in the source, locally or as origin/<branch>.
 */
export async function gitSourceHasBranch(sourceRoot: string, branch: string): Promise<boolean> {
  return (
    (await refExists(sourceRoot, `refs/heads/${branch}`)) ||
    (await refExists(sourceRoot, `refs/remotes/origin/${branch}`))
  );
}

/**
 * Build a bare repo from a source clone: every local branch, tag and
 * origin/* remote-tracking ref, with HEAD on `defaultBranch` and origin
 * pointing where the source's origin does (no origin if `originUrl` is null).
 * Nothing goes over the network.
 *
 * Not `git clone --bare <source>`: that would point origin at the source
 * directory, drop refs/remotes/origin/*, and set HEAD to whatever branch the
 * source happens to have checked out.
 *
 * All-or-nothing: on failure the bare repo is removed again.
 */
export async function gitImportBare(
  sourceRoot: string,
  bareRepoPath: string,
  defaultBranch: string,
  originUrl: string | null
): Promise<void> {
  const git = (args: string[]) => realGitProcessRunner.run(args, { cwd: bareRepoPath });
  try {
    await realGitProcessRunner.run(["init", "--quiet", "--bare", "-b", defaultBranch, bareRepoPath]);
    await git([
      "fetch",
      "--quiet",
      "--no-tags",
      sourceRoot,
      "+refs/heads/*:refs/heads/*",
      "+refs/tags/*:refs/tags/*",
      "+refs/remotes/origin/*:refs/remotes/origin/*",
      // origin/HEAD is a symref; fetched, it would turn into a plain ref.
      "^refs/remotes/origin/HEAD",
    ]);
    if (originUrl) {
      // Same refspec gitCloneBare sets, so `jade update` can fetch.
      await git(["remote", "add", "origin", originUrl]);
      if (await refExists(bareRepoPath, `refs/remotes/origin/${defaultBranch}`)) {
        await git(["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${defaultBranch}`]);
      }
    }
  } catch (error) {
    await fsRemove(bareRepoPath);
    throw error;
  }
}

/** What carrying uncommitted work into a worktree moved */
export interface CarriedWork {
  /** Staged and unstaged changes to tracked files were applied */
  tracked: boolean;
  /** Untracked (not ignored) files copied, relative to the work tree root */
  untracked: string[];
  /** Untracked directories left behind: nested repos, which git lists as `dir/` */
  skipped: string[];
}

/**
 * Copy the source's uncommitted work into `worktreePath`, which must be a
 * worktree of `bareRepoPath` checked out at the source's HEAD commit.
 *
 * Tracked changes travel as a stash commit (`git stash create` writes the
 * commit without touching the source's stash list or work tree). It's pushed
 * into the bare repo under a temporary ref, applied with --index so staged
 * stays staged and unstaged stays unstaged, and the ref is deleted again.
 * Untracked files are copied as they are. Ignored files are not carried.
 */
export async function gitCarryWork(
  sourceRoot: string,
  bareRepoPath: string,
  worktreePath: string
): Promise<CarriedWork> {
  const result: CarriedWork = { tracked: false, untracked: [], skipped: [] };

  const { stdout: stashOut } = await realGitProcessRunner.run(["stash", "create"], { cwd: sourceRoot });
  const stash = stashOut.trim();
  if (stash) {
    const tempRef = "refs/jade-import/stash";
    await realGitProcessRunner.run(["push", "--quiet", "--no-verify", bareRepoPath, `${stash}:${tempRef}`], {
      cwd: sourceRoot,
    });
    try {
      await realGitProcessRunner.run(["stash", "apply", "--quiet", "--index", stash], { cwd: worktreePath });
    } finally {
      await realGitProcessRunner.run(["update-ref", "-d", tempRef], { cwd: bareRepoPath, nothrow: true });
    }
    result.tracked = true;
  }

  const { stdout: others } = await realGitProcessRunner.run(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: sourceRoot }
  );
  for (const rel of others.split("\0").filter(Boolean)) {
    if (isAbsolute(rel) || rel.split("/").includes("..")) continue;
    if (rel.endsWith("/")) {
      result.skipped.push(rel);
      continue;
    }
    const dest = resolve(worktreePath, rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(resolve(sourceRoot, rel), dest, { verbatimSymlinks: true, preserveTimestamps: true });
    result.untracked.push(rel);
  }

  return result;
}
