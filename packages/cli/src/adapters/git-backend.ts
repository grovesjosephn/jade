/**
 * Injectable git backend interface.
 * Commands accept a GitBackend and default to the real implementation.
 * Tests can pass a mock backend to simulate git effects without spawning git.
 */
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

export interface WorktreeAddOptions {
  /** Start point for a branch that doesn't exist yet locally or on origin */
  from?: string;
}

import type { ImportSource, CarriedWork, SourceRemote, ImportCheck } from "./git-import.ts";

export interface GitBackend {
  cloneBare(url: string, destPath: string): Promise<void>;
  getDefaultBranch(bareRepoPath: string): Promise<string>;
  worktreeAdd(
    bareRepoPath: string,
    worktreePath: string,
    branch?: string,
    options?: WorktreeAddOptions
  ): Promise<string | undefined>;
  /** Local + origin branch names, deduplicated by short name */
  listBranches(bareRepoPath: string): Promise<string[]>;
  /** Fast-forward the worktree's branch to origin/<branch> if it's strictly behind */
  fastForwardToOrigin(cwd: string, branch: string): Promise<"updated" | "up-to-date" | "diverged" | "no-upstream">;
  worktreeList(bareRepoPath: string): Promise<WorktreeInfo[]>;
  worktreeRemove(bareRepoPath: string, worktreePath: string): Promise<void>;
  checkout(cwd: string, branch: string, create?: boolean): Promise<void>;
  currentBranch(cwd: string): Promise<string>;
  status(cwd: string): Promise<WorktreeStatus>;
  deleteBranch(cwd: string, branch: string, force?: boolean): Promise<void>;
  removeBareRepo(barePath: string): Promise<void>;
  fetch(bareRepoPath: string): Promise<void>;
  pullFF(cwd: string): Promise<void>;
  mergeBranch(cwd: string, branch: string): Promise<"merged" | "up-to-date">;
  /** Create a local-only repo: bare repo, first worktree on `branch`, one empty commit */
  initRepo(bareRepoPath: string, worktreePath: string, branch: string): Promise<void>;
  /** Whether the repo has an `origin` remote (false for apps never published) */
  hasOrigin(bareRepoPath: string): Promise<boolean>;
  /** Local branches with commits no remote-tracking branch contains */
  unpushedBranches(bareRepoPath: string): Promise<string[]>;
  /** Add `origin` at `url`, push `branches` with upstream, fetch */
  publish(bareRepoPath: string, url: string, branches: string[]): Promise<void>;
  /** Describe the ordinary clone at `path` for `jade import`; null if it isn't in a git work tree */
  inspectImportSource(path: string): Promise<ImportSource | null>;
  /** Whether the source clone has `branch` locally or as origin/<branch> */
  sourceHasBranch(sourceRoot: string, branch: string): Promise<boolean>;
  /** Build a bare repo from a source clone's refs, HEAD on `defaultBranch`, with the given remotes */
  importBare(sourceRoot: string, bareRepoPath: string, defaultBranch: string, remotes: SourceRemote[]): Promise<void>;
  /** Copy the source's staged, unstaged and untracked work into a worktree at the same commit */
  carryWork(sourceRoot: string, bareRepoPath: string, worktreePath: string): Promise<CarriedWork>;
  /** What the source clone has that its import (the bare repo and its worktrees) doesn't */
  checkImport(sourceRoot: string, bareRepoPath: string): Promise<ImportCheck>;
}

import {
  gitCloneBare,
  gitGetDefaultBranch,
  gitWorktreeAdd,
  gitWorktreeList,
  gitWorktreeRemove,
  gitCheckout,
  gitCurrentBranch,
  gitStatus,
  gitDeleteBranch,
  gitRemoveBareRepo,
  gitFetch,
  gitPullFF,
  gitMergeBranch,
  gitListBranches,
  gitFastForwardToOrigin,
  gitInitRepo,
  gitHasOrigin,
  gitUnpushedBranches,
  gitPublish,
} from "./git.ts";
import { gitCarryWork, gitCheckImport, gitImportBare, gitInspectImportSource, gitSourceHasBranch } from "./git-import.ts";

/**
 * Real git backend — delegates to the actual git utilities.
 * This is the default used by all commands in production.
 */
export const realGitBackend: GitBackend = {
  cloneBare: gitCloneBare,
  getDefaultBranch: gitGetDefaultBranch,
  worktreeAdd: gitWorktreeAdd,
  worktreeList: gitWorktreeList,
  worktreeRemove: gitWorktreeRemove,
  checkout: gitCheckout,
  currentBranch: gitCurrentBranch,
  status: gitStatus,
  deleteBranch: gitDeleteBranch,
  removeBareRepo: gitRemoveBareRepo,
  fetch: gitFetch,
  pullFF: gitPullFF,
  mergeBranch: gitMergeBranch,
  listBranches: gitListBranches,
  fastForwardToOrigin: gitFastForwardToOrigin,
  initRepo: gitInitRepo,
  hasOrigin: gitHasOrigin,
  unpushedBranches: gitUnpushedBranches,
  publish: gitPublish,
  inspectImportSource: gitInspectImportSource,
  sourceHasBranch: gitSourceHasBranch,
  importBare: gitImportBare,
  carryWork: gitCarryWork,
  checkImport: gitCheckImport,
};
