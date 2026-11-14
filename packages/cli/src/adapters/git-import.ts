import { cp, lstat, mkdir, readdir } from "fs/promises";
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
  /** Every remote, origin included; empty when the source has none */
  remotes: SourceRemote[];
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

/** One of the source's remotes, as `jade import` recreates it */
export interface SourceRemote {
  name: string;
  /** Fetch URL; a relative local path is made absolute against the source */
  url: string;
  /** Push URL when it differs from the fetch URL */
  pushUrl: string | null;
  /** Branch `refs/remotes/<name>/HEAD` points at, if set */
  head: string | null;
}

/** The source's origin remote, which decides whether the app is published */
export function originOf(source: Pick<ImportSource, "remotes">): SourceRemote | null {
  return source.remotes.find((r) => r.name === "origin") ?? null;
}

/**
 * A remote URL as the bare repo should see it. Local paths are relative to
 * the source's work tree; the bare repo lives elsewhere, so make them absolute.
 * URLs with a scheme and scp-style `host:path` are left alone.
 */
function absoluteRemoteUrl(sourceRoot: string, url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  if (colon > 0 && (slash === -1 || colon < slash)) return url;
  return isAbsolute(url) || url.startsWith("~") ? url : resolve(sourceRoot, url);
}

async function listRemotes(root: string): Promise<SourceRemote[]> {
  const names = ((await out(root, ["remote"])) ?? "").split("\n").filter(Boolean);
  const remotes: SourceRemote[] = [];
  for (const name of names) {
    const fetchUrl = await out(root, ["remote", "get-url", name]);
    if (!fetchUrl) continue;
    const url = absoluteRemoteUrl(root, fetchUrl);
    const push = await out(root, ["remote", "get-url", "--push", name]);
    const pushUrl = push ? absoluteRemoteUrl(root, push) : null;
    const headRef = await out(root, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${name}/HEAD`]);
    remotes.push({
      name,
      url,
      pushUrl: pushUrl && pushUrl !== url ? pushUrl : null,
      head: headRef?.startsWith(`${name}/`) ? headRef.slice(name.length + 1) : null,
    });
  }
  return remotes;
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
  const remotes = await listRemotes(root);
  const status = (await out(root, ["status", "--porcelain"])) ?? "";

  let defaultBranch: string | null = null;
  const originHead = remotes.find((r) => r.name === "origin")?.head;
  if (originHead) defaultBranch = originHead;
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
    remotes,
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
    remotes: [],
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
 * remote-tracking ref, with HEAD on `defaultBranch` and each of `remotes`
 * recreated with the source's URLs and `<remote>/HEAD`. Nothing goes over
 * the network.
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
  remotes: SourceRemote[]
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
      ...remotes.flatMap((r) => [
        `+refs/remotes/${r.name}/*:refs/remotes/${r.name}/*`,
        // <remote>/HEAD is a symref; fetched, it would turn into a plain ref.
        `^refs/remotes/${r.name}/HEAD`,
      ]),
    ]);
    for (const r of remotes) {
      // `remote add` writes the default fetch refspec, the one gitCloneBare
      // sets for origin, so `jade update` and plain `git fetch` work.
      await git(["remote", "add", r.name, r.url]);
      if (r.pushUrl) await git(["remote", "set-url", "--push", r.name, r.pushUrl]);
      const head = r.head ?? (r.name === "origin" ? defaultBranch : null);
      if (head && (await refExists(bareRepoPath, `refs/remotes/${r.name}/${head}`))) {
        await git(["symbolic-ref", `refs/remotes/${r.name}/HEAD`, `refs/remotes/${r.name}/${head}`]);
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

/** An ignored top-level entry in the source, with its size on disk */
interface IgnoredEntry {
  path: string;
  /** Size in KiB (apparent size, symlinks not followed), or null when it couldn't be measured */
  kib: number | null;
}

/**
 * What exists in the source clone but not in its import. `jade import --check`
 * turns this into blockers (data the import doesn't have) and notes (things
 * jade never copies, to look over before deleting the source).
 */
export interface ImportCheck {
  /** Source refs (and a detached HEAD) not reachable from any ref or worktree in the bare repo */
  missingRefs: string[];
  /** Entries in the source's stash list */
  stashCount: number;
  /** Other worktrees of the source repo; deleting the source breaks them */
  linkedWorktrees: string[];
  /** Untracked nested git repositories, which the import never copies */
  nestedRepos: string[];
  /** Submodule checkouts with uncommitted changes or commits on no remote */
  submodules: string[];
  /** Changed or untracked files whose content isn't in the bare repo or any of its worktrees */
  unsavedFiles: string[];
  /** Remotes the bare repo lacks or points somewhere else */
  remotes: string[];
  /** Ignored top-level entries (node_modules, build output, local files) */
  ignored: IgnoredEntry[];
  /** Hooks in the source's hooks folder (samples excluded) */
  hooks: string[];
  /** Per-repo config keys beyond what git and jade manage (user.*, lfs.*, aliases, ...) */
  config: string[];
}

/** Config sections git or jade set up themselves, so not worth reporting */
const MANAGED_CONFIG = /^(core|remote|branch|submodule|extensions|worktree|gc|maintenance|index|init)\./;

async function hasObject(repo: string, sha: string): Promise<boolean> {
  return (await run(repo, ["cat-file", "-e", sha])).exitCode === 0;
}

/**
 * Whether `sha` is reachable from a ref or a worktree HEAD in `repo`. An
 * object that's merely present can be one gc away from deletion (a branch
 * deleted in the import after it was made).
 */
async function isReachable(repo: string, sha: string): Promise<boolean> {
  if (!(await hasObject(repo, sha))) return false;
  const commit = await out(repo, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
  if (!commit) return true; // a tag of a tree or blob: presence is all we can check
  // --all includes every worktree's HEAD unless --single-worktree is given.
  return (await out(repo, ["rev-list", "-n", "1", commit, "--not", "--all"])) === "";
}

/** Total size of a file or folder in bytes, without following symlinks; null if unreadable */
async function sizeOnDisk(path: string): Promise<number | null> {
  try {
    const st = await lstat(path);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      total += (await sizeOnDisk(resolve(path, entry.name))) ?? 0;
    }
    return total;
  } catch {
    return null;
  }
}

/** Split `-z` output into entries */
const zsplit = (s: string | null) => (s ?? "").split("\0").filter(Boolean);

/**
 * Compare a source clone with the bare repo it was imported into. Read-only
 * on both sides.
 */
export async function gitCheckImport(sourceRoot: string, bareRepoPath: string): Promise<ImportCheck> {
  const check: ImportCheck = {
    missingRefs: [],
    stashCount: 0,
    linkedWorktrees: [],
    nestedRepos: [],
    submodules: [],
    unsavedFiles: [],
    remotes: [],
    ignored: [],
    hooks: [],
    config: [],
  };

  // Refs: every branch, tag and remote-tracking ref, by object (an annotated
  // tag is its own object), plus a detached HEAD's commit.
  const refs = ((await out(sourceRoot, ["for-each-ref", "--format=%(objectname) %(refname)"])) ?? "")
    .split("\n")
    .filter(Boolean);
  for (const line of refs) {
    const [sha, ref] = [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)];
    if (ref === "refs/stash") continue;
    if (!(await isReachable(bareRepoPath, sha))) check.missingRefs.push(ref.replace(/^refs\/(heads|tags|remotes)\//, ""));
  }
  const detached = !(await out(sourceRoot, ["symbolic-ref", "--quiet", "HEAD"]));
  const head = await out(sourceRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (detached && head && !(await isReachable(bareRepoPath, head))) check.missingRefs.push(`HEAD (detached at ${head.slice(0, 7)})`);

  const stash = (await out(sourceRoot, ["stash", "list"])) ?? "";
  check.stashCount = stash ? stash.split("\n").length : 0;

  check.linkedWorktrees = ((await out(sourceRoot, ["worktree", "list", "--porcelain"])) ?? "")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .filter((p) => resolve(p) !== resolve(sourceRoot));

  // Uncommitted content: staged blobs, working-tree files that differ from
  // HEAD, and untracked files. Each must exist in the bare repo (carried work
  // or a later commit) or match the same path in one of its worktrees.
  const worktrees = ((await out(bareRepoPath, ["worktree", "list", "--porcelain"])) ?? "")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .filter((p) => resolve(p) !== resolve(bareRepoPath));
  // Without --directory, git still lists a nested repo as `dir/`.
  const untracked = zsplit(await out(sourceRoot, ["ls-files", "--others", "--exclude-standard", "-z"]));
  check.nestedRepos = untracked.filter((p) => p.endsWith("/"));
  const changed = zsplit(await out(sourceRoot, ["diff", "--name-only", "-z", "HEAD"]));
  const staged = zsplit(await out(sourceRoot, ["diff", "--cached", "--name-only", "-z"]));
  const candidates = new Set([...changed, ...untracked.filter((p) => !p.endsWith("/"))]);
  for (const rel of candidates) {
    if (!(await fsExists(resolve(sourceRoot, rel)))) continue; // a deletion loses nothing
    const sha = await out(sourceRoot, ["hash-object", "--", rel]);
    if (!sha || (await hasObject(bareRepoPath, sha))) continue;
    let found = false;
    for (const wt of worktrees) {
      if ((await fsExists(resolve(wt, rel))) && (await out(wt, ["hash-object", "--", rel])) === sha) {
        found = true;
        break;
      }
    }
    if (!found) check.unsavedFiles.push(rel);
  }
  for (const rel of staged) {
    const blob = (await out(sourceRoot, ["ls-files", "-s", "--", rel]))?.split(/\s+/)[1];
    if (blob && !(await hasObject(bareRepoPath, blob)) && !check.unsavedFiles.includes(rel)) {
      check.unsavedFiles.push(`${rel} (staged)`);
    }
  }

  // Submodule checkouts: local changes, or a HEAD no remote has.
  const modulePaths = ((await out(sourceRoot, ["config", "-f", ".gitmodules", "--get-regexp", "path"])) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(l.indexOf(" ") + 1));
  for (const path of modulePaths) {
    const dir = resolve(sourceRoot, path);
    if (!(await fsExists(resolve(dir, ".git")))) continue;
    const problems: string[] = [];
    if ((await out(dir, ["status", "--porcelain"])) !== "") problems.push("uncommitted changes");
    const unpushed = await out(dir, ["rev-list", "-n", "1", "HEAD", "--branches", "--not", "--remotes"]);
    if (unpushed) problems.push("commits on no remote");
    if (problems.length > 0) check.submodules.push(`${path} (${problems.join(", ")})`);
  }

  const bareRemotes = new Map<string, string>();
  for (const name of ((await out(bareRepoPath, ["remote"])) ?? "").split("\n").filter(Boolean)) {
    bareRemotes.set(name, (await out(bareRepoPath, ["remote", "get-url", name])) ?? "");
  }
  for (const r of await listRemotes(sourceRoot)) {
    const url = bareRemotes.get(r.name);
    if (url === undefined) check.remotes.push(`${r.name} (${r.url}) is missing`);
    else if (url !== r.url) check.remotes.push(`${r.name} points at ${url}, the source at ${r.url}`);
  }

  for (const path of zsplit(
    await out(sourceRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])
  )) {
    const bytes = await sizeOnDisk(resolve(sourceRoot, path));
    check.ignored.push({ path, kib: bytes === null ? null : Math.ceil(bytes / 1024) });
  }

  const hooksDir = await out(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
  if (hooksDir && (await fsExists(hooksDir))) {
    check.hooks = (await readdir(hooksDir)).filter((f) => !f.endsWith(".sample")).sort();
  }

  const keys = ((await out(sourceRoot, ["config", "--local", "--list", "--name-only"])) ?? "").split("\n");
  check.config = [...new Set(keys.filter((k) => k && !MANAGED_CONFIG.test(k)))];

  return check;
}
