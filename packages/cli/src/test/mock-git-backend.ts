import { mkdir, rm } from "fs/promises";
import { join } from "path";
import type { GitBackend, WorktreeAddOptions, WorktreeInfo, WorktreeStatus } from "../adapters/git-backend.ts";
import type { ImportSource, SourceRemote } from "../adapters/git-import.ts";

/**
 * In-memory state that the mock backend tracks per bare repo path.
 * Tests can inspect or pre-configure this to control mock behavior.
 */
export interface MockBareRepoState {
  defaultBranch: string;
  /** Set of branch names that already exist in this repo */
  branches: Set<string>;
  /** Branch names that exist only on origin (refs/remotes/origin/*) */
  remoteBranches: Set<string>;
  /** Map from worktree path -> branch name for currently checked-out worktrees */
  worktrees: Map<string, string>;
  /**
   * Map from worktree path -> working-tree state. Paths absent from this map
   * report clean, so tests only seed the worktrees they want dirty.
   */
  statuses: Map<string, WorktreeStatus>;
  /** Whether the repo has an origin remote; false for `jade create`d apps */
  hasOrigin: boolean;
  /** Branches reported as holding unpushed commits */
  unpushed: Set<string>;
  /** URL passed to publish, once published */
  originUrl?: string;
}

const CLEAN: WorktreeStatus = { staged: 0, unstaged: 0, untracked: 0 };

/**
 * Create a MockBareRepoState with sensible defaults.
 */
export function makeMockBareRepoState(overrides: Partial<MockBareRepoState> = {}): MockBareRepoState {
  return {
    defaultBranch: "main",
    branches: new Set(overrides.branches ?? ["main"]),
    remoteBranches: new Set(overrides.remoteBranches),
    worktrees: new Map(overrides.worktrees),
    statuses: new Map(overrides.statuses),
    hasOrigin: true,
    unpushed: new Set(overrides.unpushed),
    ...overrides,
  };
}

/**
 * Mock GitBackend that simulates git effects on the filesystem (creating directories)
 * and maintains in-memory state for branches and worktrees.
 *
 * Usage in tests:
 *
 *   const { git, getState } = createMockGitBackend();
 *   const cmd = makeAddCommand(git);
 *   await cmd.run!({ args: { ... } } as any);
 *   expect(getState("/path/to/bare")).toBeDefined();
 */
export interface MockGitBackend {
  git: GitBackend;
  /** Get in-memory state for a bare repo (returns undefined if never cloned/initialized) */
  getState(bareRepoPath: string): MockBareRepoState | undefined;
  /** Pre-seed state for a bare repo (useful for pre-existing repos in worktree tests) */
  seedState(bareRepoPath: string, state?: Partial<MockBareRepoState>): void;
  /**
   * Source clones `jade import` can see, keyed by the path passed to it.
   * `branches` lists what the source has (local or origin/*).
   */
  importSources: Map<string, ImportSource & { branches: string[] }>;
  /** Calls recorded on the backend (for assertion purposes) */
  calls: { method: string; args: unknown[] }[];
}

export function createMockGitBackend(): MockGitBackend {
  const states = new Map<string, MockBareRepoState>();
  const calls: { method: string; args: unknown[] }[] = [];
  const importSources = new Map<string, ImportSource & { branches: string[] }>();
  const sourceByRoot = (root: string) => [...importSources.values()].find((s) => s.root === root);

  function record(method: string, ...args: unknown[]) {
    calls.push({ method, args });
  }

  function ensureState(bareRepoPath: string): MockBareRepoState {
    if (!states.has(bareRepoPath)) {
      states.set(bareRepoPath, makeMockBareRepoState());
    }
    return states.get(bareRepoPath)!;
  }

  const git: GitBackend = {
    /**
     * Simulate bare clone: create the destination directory and initialize state.
     * Does NOT require a real URL or remote.
     */
    async cloneBare(_url: string, destPath: string): Promise<void> {
      record("cloneBare", _url, destPath);
      await mkdir(destPath, { recursive: true });
      // Write a minimal HEAD file so the dir looks like a bare repo
      await Bun.write(join(destPath, "HEAD"), "ref: refs/heads/main\n");
      states.set(destPath, makeMockBareRepoState());
    },

    /**
     * Return the configured default branch for this repo (defaults to "main").
     */
    async getDefaultBranch(bareRepoPath: string): Promise<string> {
      record("getDefaultBranch", bareRepoPath);
      return ensureState(bareRepoPath).defaultBranch;
    },

    /**
     * Simulate worktree add:
     * - Creates the worktree directory on disk
     * - Tracks the branch->path mapping in memory
     * - Resolves branch conflicts by appending "-mock" suffix (deterministic)
     */
    async worktreeAdd(
      bareRepoPath: string,
      worktreePath: string,
      branch?: string,
      options?: WorktreeAddOptions
    ): Promise<string | undefined> {
      record("worktreeAdd", bareRepoPath, worktreePath, branch, options);
      const state = ensureState(bareRepoPath);
      const requestedBranch = branch ?? state.defaultBranch;

      // Mirror the real backend: a start point only matters for a brand-new
      // branch, and one that resolves to nothing is an error.
      const isNew = !state.branches.has(requestedBranch) && !state.remoteBranches.has(requestedBranch);
      if (isNew && options?.from && !state.branches.has(options.from) && !state.remoteBranches.has(options.from)) {
        throw new Error(`start point '${options.from}' not found`);
      }
      if (state.remoteBranches.has(requestedBranch)) state.branches.add(requestedBranch);

      // Determine the actual branch name to use
      let actualBranch = requestedBranch;

      if (state.branches.has(requestedBranch)) {
        // Branch already exists — check if it's currently checked out elsewhere
        const alreadyCheckedOut = [...state.worktrees.values()].includes(requestedBranch);
        if (alreadyCheckedOut) {
          // Conflict: produce a unique name deterministically
          actualBranch = `${requestedBranch}-mock`;
          state.branches.add(actualBranch);
        }
        // else: branch exists but is free — checkout is fine, keep actualBranch
      } else {
        // New branch — create it
        state.branches.add(requestedBranch);
      }

      // Create the worktree directory on disk
      await mkdir(worktreePath, { recursive: true });
      state.worktrees.set(worktreePath, actualBranch);

      return actualBranch;
    },

    /**
     * Return all worktrees for a bare repo as WorktreeInfo[].
     */
    async worktreeList(bareRepoPath: string): Promise<WorktreeInfo[]> {
      record("worktreeList", bareRepoPath);
      const state = states.get(bareRepoPath);
      if (!state) return [];
      return [...state.worktrees.entries()].map(([path, branch]) => ({
        path,
        branch,
        commit: "mock-commit-sha",
      }));
    },

    /**
     * Simulate worktree remove: delete the in-memory record (caller removes the dir).
     */
    async worktreeRemove(bareRepoPath: string, worktreePath: string): Promise<void> {
      record("worktreeRemove", bareRepoPath, worktreePath);
      const state = states.get(bareRepoPath);
      if (state) {
        state.worktrees.delete(worktreePath);
      }
    },

    /**
     * Simulate checkout: update the branch tracked at the given worktree path.
     */
    async checkout(cwd: string, branch: string, create?: boolean): Promise<void> {
      record("checkout", cwd, branch, create);
      for (const state of states.values()) {
        if (state.worktrees.has(cwd)) {
          state.worktrees.set(cwd, branch);
          if (create) state.branches.add(branch);
          return;
        }
      }
    },

    /**
     * Return the branch checked out at a worktree path.
     * Falls back to searching all repo states if not found by path.
     */
    async currentBranch(cwd: string): Promise<string> {
      record("currentBranch", cwd);
      for (const state of states.values()) {
        const branch = state.worktrees.get(cwd);
        if (branch) return branch;
      }
      return "main";
    },

    /**
     * Return the seeded working-tree state for a worktree path, or clean.
     */
    async status(cwd: string): Promise<WorktreeStatus> {
      record("status", cwd);
      for (const state of states.values()) {
        const seeded = state.statuses.get(cwd);
        if (seeded) return seeded;
      }
      return { ...CLEAN };
    },

    /**
     * Simulate branch deletion — just removes the branch name from state.
     */
    async deleteBranch(cwd: string, branch: string, _force?: boolean): Promise<void> {
      record("deleteBranch", cwd, branch, _force);
      for (const state of states.values()) {
        state.branches.delete(branch);
      }
    },

    /**
     * Simulate removing the bare repo directory — deletes on disk and in memory.
     */
    async removeBareRepo(barePath: string): Promise<void> {
      record("removeBareRepo", barePath);
      states.delete(barePath);
      await rm(barePath, { recursive: true, force: true });
    },

    async fetch(bareRepoPath: string): Promise<void> {
      record("fetch", bareRepoPath);
    },

    async pullFF(cwd: string): Promise<void> {
      record("pullFF", cwd);
    },

    /**
     * Simulate a merge: no divergent commits are tracked in mock state, so this
     * always reports "up-to-date". Override per-test (spread + replace) to
     * simulate a real merge or a conflict, same pattern as pullFF failures.
     */
    async listBranches(bareRepoPath: string): Promise<string[]> {
      record("listBranches", bareRepoPath);
      const state = ensureState(bareRepoPath);
      return [...new Set([...state.branches, ...state.remoteBranches])].sort();
    },

    /** No commits are modelled, so the mock is always up to date. */
    async fastForwardToOrigin(cwd: string, branch: string) {
      record("fastForwardToOrigin", cwd, branch);
      return "up-to-date" as const;
    },

    async mergeBranch(cwd: string, branch: string): Promise<"merged" | "up-to-date"> {
      record("mergeBranch", cwd, branch);
      return "up-to-date";
    },

    /** Simulate `jade create`: a local-only repo with its first worktree. */
    async initRepo(bareRepoPath: string, worktreePath: string, branch: string): Promise<void> {
      record("initRepo", bareRepoPath, worktreePath, branch);
      await mkdir(bareRepoPath, { recursive: true });
      await Bun.write(join(bareRepoPath, "HEAD"), `ref: refs/heads/${branch}\n`);
      await mkdir(worktreePath, { recursive: true });
      states.set(
        bareRepoPath,
        makeMockBareRepoState({
          defaultBranch: branch,
          branches: new Set([branch]),
          worktrees: new Map([[worktreePath, branch]]),
          hasOrigin: false,
        })
      );
    },

    async hasOrigin(bareRepoPath: string): Promise<boolean> {
      record("hasOrigin", bareRepoPath);
      return ensureState(bareRepoPath).hasOrigin;
    },

    async unpushedBranches(bareRepoPath: string): Promise<string[]> {
      record("unpushedBranches", bareRepoPath);
      return [...ensureState(bareRepoPath).unpushed].sort();
    },

    async publish(bareRepoPath: string, url: string, branches: string[]): Promise<void> {
      record("publish", bareRepoPath, url, branches);
      const state = ensureState(bareRepoPath);
      state.hasOrigin = true;
      state.originUrl = url;
      for (const b of branches) {
        state.remoteBranches.add(b);
        state.unpushed.delete(b);
      }
    },

    async inspectImportSource(path: string): Promise<ImportSource | null> {
      record("inspectImportSource", path);
      const source = importSources.get(path);
      if (!source) return null;
      const { branches: _branches, ...rest } = source;
      return rest;
    },

    async sourceHasBranch(sourceRoot: string, branch: string): Promise<boolean> {
      record("sourceHasBranch", sourceRoot, branch);
      return sourceByRoot(sourceRoot)?.branches.includes(branch) ?? false;
    },

    /** Simulate `jade import`'s bare repo: the source's branches, no worktrees yet. */
    async importBare(sourceRoot: string, bareRepoPath: string, defaultBranch: string, remotes: SourceRemote[]) {
      record("importBare", sourceRoot, bareRepoPath, defaultBranch, remotes);
      const originUrl = remotes.find((r) => r.name === "origin")?.url ?? null;
      await mkdir(bareRepoPath, { recursive: true });
      await Bun.write(join(bareRepoPath, "HEAD"), `ref: refs/heads/${defaultBranch}\n`);
      states.set(
        bareRepoPath,
        makeMockBareRepoState({
          defaultBranch,
          branches: new Set(sourceByRoot(sourceRoot)?.branches ?? [defaultBranch]),
          hasOrigin: originUrl !== null,
          originUrl: originUrl ?? undefined,
        })
      );
    },

    async carryWork(sourceRoot: string, bareRepoPath: string, worktreePath: string) {
      record("carryWork", sourceRoot, bareRepoPath, worktreePath);
      return { tracked: sourceByRoot(sourceRoot)?.dirty ?? false, untracked: [], skipped: [] };
    },

    async checkImport(sourceRoot: string, bareRepoPath: string) {
      record("checkImport", sourceRoot, bareRepoPath);
      return {
        missingRefs: [],
        stashCount: sourceByRoot(sourceRoot)?.stashCount ?? 0,
        linkedWorktrees: sourceByRoot(sourceRoot)?.linkedWorktrees ?? [],
        nestedRepos: [],
        submodules: [],
        unsavedFiles: [],
        remotes: [],
        ignored: [],
        hooks: [],
        config: [],
      };
    },
  };

  return {
    git,
    getState: (bareRepoPath) => states.get(bareRepoPath),
    seedState(bareRepoPath, overrides = {}) {
      states.set(bareRepoPath, makeMockBareRepoState(overrides));
    },
    importSources,
    calls,
  };
}
