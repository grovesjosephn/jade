import { fsRemove } from "./fs.ts";
import { realGitProcessRunner } from "./git-process.ts";
import type { WorktreeAddOptions } from "./git-backend.ts";

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
}

export interface WorktreeStatus {
  staged: number;
  unstaged: number;
  untracked: number;
}

/**
 * Count staged / unstaged / untracked entries in a worktree.
 *
 * Uses the default --untracked-files=normal so an untracked directory collapses
 * to a single entry instead of enumerating every file beneath it. A file can be
 * both staged and unstaged (porcelain "MM") and is counted in both — that
 * distinction is the useful part.
 */
export function parseStatusPorcelain(output: string): WorktreeStatus {
  const status: WorktreeStatus = { staged: 0, unstaged: 0, untracked: 0 };

  for (const line of output.split("\n")) {
    // Porcelain v1 lines are "XY path"; anything shorter isn't an entry.
    if (line.length < 3) continue;

    const x = line[0]!;
    const y = line[1]!;

    if (x === "?" && y === "?") {
      status.untracked++;
      continue;
    }

    if (x !== " ") status.staged++;
    if (y !== " ") status.unstaged++;
  }

  return status;
}

/**
 * Clone a bare repository
 */
export async function gitCloneBare(url: string, destPath: string): Promise<void> {
  await realGitProcessRunner.run(["clone", "--bare", url, destPath]);
  // `git clone --bare` omits the fetch refspec, so `git fetch` can't populate
  // refs/remotes/origin/*. Worktrees need those refs to pull updates from main.
  await realGitProcessRunner.run(
    ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
    { cwd: destPath }
  );
  // The refspec only says where fetched refs land — it doesn't create them. Until
  // something fetches, refs/remotes/origin/* is empty and every
  // `--set-upstream-to=origin/<branch>` in gitWorktreeAdd silently no-ops, leaving
  // worktrees with no upstream. Best-effort: the clone already succeeded, so a
  // remote that briefly can't be re-reached shouldn't fail the whole add.
  await realGitProcessRunner.run(["fetch", "origin"], { cwd: destPath, nothrow: true });
}

/**
 * Remove a bare repository directory
 */
export async function gitRemoveBareRepo(barePath: string): Promise<void> {
  await fsRemove(barePath);
}

/**
 * Get the default branch name from a bare repository
 */
export async function gitGetDefaultBranch(bareRepoPath: string): Promise<string> {
  try {
    const { stdout } = await realGitProcessRunner.run(["symbolic-ref", "HEAD"], { cwd: bareRepoPath });
    return stdout.trim().replace("refs/heads/", "");
  } catch {
    const { stdout: branches } = await realGitProcessRunner.run(["branch"], { cwd: bareRepoPath });

    if (branches.includes("main")) return "main";
    if (branches.includes("master")) return "master";
    if (branches.includes("develop")) return "develop";
    if (branches.includes("trunk")) return "trunk";

    const firstBranch = branches.trim().split("\n")[0];
    const branchName = firstBranch?.replace(/^\*?\s*/, "").trim();

    if (!branchName) {
      throw new Error("No branches found in repository");
    }

    return branchName;
  }
}

/**
 * Whether a fully-qualified ref (e.g. refs/heads/main) exists in a repository.
 * show-ref matches the exact name; rev-parse would also resolve suffixes like
 * `refs/remotes/origin/HEAD~1`.
 */
async function refExists(repoPath: string, ref: string): Promise<boolean> {
  const { exitCode } = await realGitProcessRunner.run(["show-ref", "--verify", "--quiet", ref], {
    cwd: repoPath,
    nothrow: true,
  });
  return exitCode === 0;
}

/**
 * Whether `ancestor` is reachable from `descendant` (true when they're equal).
 */
async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  const { exitCode } = await realGitProcessRunner.run(["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: repoPath,
    nothrow: true,
  });
  return exitCode === 0;
}

/**
 * Bring a worktree's checked-out branch up to origin/<branch> when that's a
 * pure fast-forward. Never merges or rewrites: a branch that's ahead stays as
 * is, and one that has diverged is reported for the caller to surface.
 */
export async function gitFastForwardToOrigin(
  cwd: string,
  branch: string
): Promise<"updated" | "up-to-date" | "diverged" | "no-upstream"> {
  const upstream = `refs/remotes/origin/${branch}`;
  if (!(await refExists(cwd, upstream))) return "no-upstream";
  if (await isAncestor(cwd, upstream, "HEAD")) return "up-to-date";
  if (!(await isAncestor(cwd, "HEAD", upstream))) return "diverged";
  await realGitProcessRunner.run(["merge", "--ff-only", upstream], { cwd });
  return "updated";
}

/**
 * Whether git can resolve a revision expression (tag, SHA, `x~2`) to a commit.
 */
async function commitExists(repoPath: string, rev: string): Promise<boolean> {
  const { exitCode } = await realGitProcessRunner.run(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], {
    cwd: repoPath,
    nothrow: true,
  });
  return exitCode === 0;
}

/**
 * Resolve a user-supplied start point to something `git worktree add` accepts.
 *
 * When both a local <name> and origin/<name> exist, take whichever has the other
 * in its history: origin when the local branch is merely behind (fetches only
 * move origin/*), local when it has commits origin lacks (unpushed work in a
 * worktree). If they've diverged, local wins so no local work is dropped.
 * Anything else git can resolve to a commit (a tag, a SHA, an explicit
 * `origin/x`) is accepted as-is.
 */
export async function resolveStartPoint(bareRepoPath: string, from: string): Promise<string> {
  const local = await refExists(bareRepoPath, `refs/heads/${from}`);
  const remote = await refExists(bareRepoPath, `refs/remotes/origin/${from}`);
  if (local && remote) {
    return (await isAncestor(bareRepoPath, `refs/heads/${from}`, `refs/remotes/origin/${from}`))
      ? `origin/${from}`
      : from;
  }
  if (remote) return `origin/${from}`;
  if (local) return from;
  if (await commitExists(bareRepoPath, from)) return from;
  throw new Error(`start point '${from}' not found`);
}

/**
 * Add a worktree from a bare repository
 * @param bareRepoPath - Path to the bare repository
 * @param worktreePath - Absolute path where the worktree should be created
 * @param branch - Optional branch name to checkout or create
 * @param options - `from`: start point for a branch that doesn't exist yet,
 *   resolved via resolveStartPoint; ignored when the branch already exists
 * @returns The actual branch name used (may differ from input if conflict occurred)
 */
export async function gitWorktreeAdd(
  bareRepoPath: string,
  worktreePath: string,
  branch?: string,
  options: WorktreeAddOptions = {}
): Promise<string | undefined> {
  const run = (args: string[]) => realGitProcessRunner.run(args, { cwd: bareRepoPath });
  // Best-effort: only succeeds if origin/<upstream> exists on the remote
  const setUpstream = (upstream: string, local: string) =>
    realGitProcessRunner.run(["branch", `--set-upstream-to=origin/${upstream}`, local], {
      cwd: worktreePath,
      nothrow: true,
    });

  if (!branch) {
    // No branch specified, use the repository's default branch
    const defaultBranch = await gitGetDefaultBranch(bareRepoPath);
    await run(["worktree", "add", worktreePath, defaultBranch]);
    await setUpstream(defaultBranch, defaultBranch);
    return defaultBranch;
  }

  if (await refExists(bareRepoPath, `refs/heads/${branch}`)) {
    // Branch exists locally - try to check it out
    try {
      await run(["worktree", "add", worktreePath, branch]);
      await setUpstream(branch, branch);
      return branch;
    } catch {
      // Already checked out in another worktree (or another conflict):
      // create a uniquely named branch from it instead
      const uniqueName = await generateUniqueBranchName(bareRepoPath, branch);
      await run(["worktree", "add", "-b", uniqueName, worktreePath, branch]);
      await setUpstream(branch, uniqueName);
      return uniqueName;
    }
  }

  if (await refExists(bareRepoPath, `refs/remotes/origin/${branch}`)) {
    // Only on origin (e.g. pushed by someone else after the clone): create the
    // local branch from it, tracking it, so the worktree has the real content
    try {
      await run(["worktree", "add", "--track", "-b", branch, worktreePath, `origin/${branch}`]);
      return branch;
    } catch {
      // Hierarchical conflict like test vs test/something
      const uniqueName = await generateUniqueBranchName(bareRepoPath, branch);
      await run(["worktree", "add", "--no-track", "-b", uniqueName, worktreePath, `origin/${branch}`]);
      await setUpstream(branch, uniqueName);
      return uniqueName;
    }
  }

  // New branch. With an explicit start point, don't let git's autoSetupMerge
  // make it track the start point (e.g. origin/develop): `git push` would then
  // target the wrong branch.
  const startArgs = options.from
    ? ["--no-track", await resolveStartPoint(bareRepoPath, options.from)]
    : [];
  const createArgs = (name: string) => {
    const [noTrack, startPoint] = startArgs;
    return noTrack
      ? ["worktree", "add", noTrack, "-b", name, worktreePath, startPoint!]
      : ["worktree", "add", "-b", name, worktreePath];
  };

  try {
    await run(createArgs(branch));
    return branch;
  } catch {
    // Failed to create (hierarchical conflict like test vs test/something)
    const uniqueName = await generateUniqueBranchName(bareRepoPath, branch);
    await run(createArgs(uniqueName));
    return uniqueName;
  }
}

/**
 * List branch names in a bare repository: local heads plus origin's
 * remote-tracking branches, deduplicated by short name (origin/x -> x).
 */
export async function gitListBranches(bareRepoPath: string): Promise<string[]> {
  const { stdout } = await realGitProcessRunner.run(
    ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"],
    { cwd: bareRepoPath }
  );

  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    const ref = line.trim();
    if (ref.startsWith("refs/heads/")) {
      names.add(ref.slice("refs/heads/".length));
    } else if (ref.startsWith("refs/remotes/origin/")) {
      const name = ref.slice("refs/remotes/origin/".length);
      if (name !== "HEAD") names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * List all worktrees for a bare repository
 */
export async function gitWorktreeList(bareRepoPath: string): Promise<WorktreeInfo[]> {
  const { stdout: result } = await realGitProcessRunner.run(["worktree", "list", "--porcelain"], {
    cwd: bareRepoPath,
  });

  const worktrees: WorktreeInfo[] = [];
  const lines = result.split("\n");
  let current: Partial<WorktreeInfo> = {};

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      current.path = line.substring(9);
    } else if (line.startsWith("branch ")) {
      current.branch = line.substring(7).replace("refs/heads/", "");
    } else if (line.startsWith("HEAD ")) {
      current.commit = line.substring(5);
    } else if (line.startsWith("bare")) {
      // Bare repo worktree - skip it
      current = {};
    } else if (line === "" && current.path) {
      // Only add if we have required fields
      if (current.path && current.branch && current.commit) {
        worktrees.push(current as WorktreeInfo);
      }
      current = {};
    }
  }

  // Handle last entry if file doesn't end with newline
  if (current.path && current.branch && current.commit) {
    worktrees.push(current as WorktreeInfo);
  }

  return worktrees;
}

/**
 * Remove a worktree from a bare repository
 * @param bareRepoPath - Path to the bare repository
 * @param worktreePath - Absolute path to the worktree to remove
 */
export async function gitWorktreeRemove(bareRepoPath: string, worktreePath: string): Promise<void> {
  await realGitProcessRunner.run(["worktree", "remove", worktreePath, "-f"], { cwd: bareRepoPath });
  await realGitProcessRunner.run(["worktree", "prune"], { cwd: bareRepoPath });
}

/**
 * Check if a branch is currently checked out in any worktree
 * @param bareRepoPath - Path to the bare repository
 * @param branch - Branch name to check
 */
export async function isBranchCheckedOutInWorktree(bareRepoPath: string, branch: string): Promise<boolean> {
  const worktrees = await gitWorktreeList(bareRepoPath);
  return worktrees.some((wt) => wt.branch === branch);
}

/**
 * Generate a unique branch name with a short hash suffix
 * @param bareRepoPath - Path to the bare repository
 * @param baseName - Base name for the branch
 */
export async function generateUniqueBranchName(bareRepoPath: string, baseName: string): Promise<string> {
  const { stdout: result } = await realGitProcessRunner.run(["rev-parse", "HEAD"], { cwd: bareRepoPath });
  const shortHash = result.trim().substring(0, 7);
  return `${baseName}-${shortHash}`;
}

/**
 * Checkout a branch
 */
export async function gitCheckout(
  cwd: string,
  branch: string,
  create: boolean = false
): Promise<void> {
  if (create) {
    await realGitProcessRunner.run(["checkout", "-b", branch], { cwd });
  } else {
    await realGitProcessRunner.run(["checkout", branch], { cwd });
  }
}

/**
 * Get current branch name
 */
export async function gitCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await realGitProcessRunner.run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  return stdout.trim();
}

/**
 * Get the working-tree state of a worktree
 */
export async function gitStatus(cwd: string): Promise<WorktreeStatus> {
  const { stdout } = await realGitProcessRunner.run(["status", "--porcelain"], { cwd });
  return parseStatusPorcelain(stdout);
}

/**
 * Commit changes
 */
export async function gitCommit(cwd: string, message: string): Promise<void> {
  await realGitProcessRunner.run(["commit", "-m", message], { cwd });
}

/**
 * Add files to staging
 */
export async function gitAdd(cwd: string, files: string[]): Promise<void> {
  await realGitProcessRunner.run(["add", ...files], { cwd });
}

/**
 * Check if a branch exists in worktrees
 */
export async function isBranchCheckedOut(cwd: string, branch: string): Promise<boolean> {
  const worktrees = await gitWorktreeList(cwd);
  return worktrees.some((wt) => wt.branch === branch);
}

/**
 * Fetch all remotes for a bare repository
 */
export async function gitFetch(bareRepoPath: string): Promise<void> {
  await realGitProcessRunner.run(["fetch", "--all", "--prune"], { cwd: bareRepoPath });
}

/**
 * Fast-forward pull in a worktree directory
 */
export async function gitPullFF(cwd: string): Promise<void> {
  const { stdout } = await realGitProcessRunner.run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  const branch = stdout.trim();
  await realGitProcessRunner.run(["pull", "--ff-only", "--prune", "origin", branch], { cwd });
}

/**
 * Merge a branch from origin into the currently checked out branch of a worktree.
 * Assumes refs/remotes/origin/<branch> is already current — call gitFetch first.
 * Throws (leaving the worktree mid-merge, for manual resolution) on conflict.
 */
export async function gitMergeBranch(cwd: string, branch: string): Promise<"merged" | "up-to-date"> {
  const { stdout } = await realGitProcessRunner.run(["merge", "--no-edit", `origin/${branch}`], { cwd });
  return /already up to date/i.test(stdout) ? "up-to-date" : "merged";
}

/**
 * Delete a branch in a repository
 */
export async function gitDeleteBranch(
  cwd: string,
  branch: string,
  force: boolean = false
): Promise<void> {
  if (force) {
    await realGitProcessRunner.run(["branch", "-D", branch], { cwd });
  } else {
    await realGitProcessRunner.run(["branch", "-d", branch], { cwd });
  }
}

/**
 * Create a brand-new local repository: an empty bare repo, its first worktree
 * on `branch`, and one empty commit. The commit matters: a worktree added to
 * a repo with no commits becomes an unrelated orphan branch, so without it
 * the first `jade workspace add` would branch off nothing.
 *
 * All-or-nothing: if any step fails (most often no git identity for the
 * commit), the bare repo and worktree are removed again.
 */
export async function gitInitRepo(bareRepoPath: string, worktreePath: string, branch: string): Promise<void> {
  try {
    await realGitProcessRunner.run(["init", "--quiet", "--bare", "-b", branch, bareRepoPath]);
    await realGitProcessRunner.run(["worktree", "add", "--quiet", "-b", branch, worktreePath], {
      cwd: bareRepoPath,
    });
    await realGitProcessRunner.run(["commit", "--quiet", "--allow-empty", "-m", "Initial commit"], {
      cwd: worktreePath,
    });
  } catch (error) {
    await fsRemove(worktreePath);
    await fsRemove(bareRepoPath);
    throw error;
  }
}

/**
 * Whether the repo has an `origin` remote. Apps made with `jade create` have
 * none until `jade publish`, and their bare repo is then the only copy.
 */
export async function gitHasOrigin(bareRepoPath: string): Promise<boolean> {
  const { exitCode } = await realGitProcessRunner.run(["config", "--get", "remote.origin.url"], {
    cwd: bareRepoPath,
    nothrow: true,
  });
  return exitCode === 0;
}

/**
 * Local branches holding commits that no remote-tracking branch contains, i.e.
 * work that exists only in this bare repo. Uses the last fetch's view of origin.
 */
export async function gitUnpushedBranches(bareRepoPath: string): Promise<string[]> {
  const { stdout } = await realGitProcessRunner.run(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    { cwd: bareRepoPath }
  );
  const unpushed: string[] = [];
  for (const branch of stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const { stdout: ahead } = await realGitProcessRunner.run(
      ["rev-list", "--max-count=1", `refs/heads/${branch}`, "--not", "--remotes"],
      { cwd: bareRepoPath }
    );
    if (ahead.trim()) unpushed.push(branch);
  }
  return unpushed;
}

/**
 * Connect a local-only repo to a new, empty remote: add `origin` with the
 * fetch refspec `jade add` sets on clone, push `branches` with upstream
 * tracking (stored in the bare repo's config, so every worktree sees it), then
 * fetch and record origin/HEAD.
 *
 * If the push fails, the remote is removed again, leaving the repo local-only
 * so the publish can simply be retried.
 */
export async function gitPublish(bareRepoPath: string, url: string, branches: string[]): Promise<void> {
  const run = (args: string[]) => realGitProcessRunner.run(args, { cwd: bareRepoPath });
  await run(["remote", "add", "origin", url]);
  try {
    await run(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    await run(["push", "--quiet", "-u", "origin", ...branches]);
  } catch (error) {
    await realGitProcessRunner.run(["remote", "remove", "origin"], { cwd: bareRepoPath, nothrow: true });
    throw error;
  }
  await run(["fetch", "--quiet", "origin"]);
  await realGitProcessRunner.run(["remote", "set-head", "origin", "--auto"], { cwd: bareRepoPath, nothrow: true });
}
