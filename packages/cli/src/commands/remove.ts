import { defineCommand } from "citty";
import { resolve } from "path";
import { intro, outro, cancel, log, spinner } from "../adapters/ui.ts";
import { getBarePath, listWorktreeDirs, listBareRepos } from "../core/layout.ts";
import { removeAppFromConfig } from "../core/config.ts";
import { type GitBackend, realGitBackend } from "../adapters/git-backend.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";
import { type ConfigBackend, realConfigBackend } from "../core/config-backend.ts";
import { hubArgs, resolveHub } from "../core/hub.ts";

/**
 * What would be lost by deleting an app's bare repo and worktrees: no remote
 * at all, local branches with commits origin doesn't have (as of the last
 * fetch), and worktrees with uncommitted changes.
 */
async function findUnsavedWork(git: GitBackend, bareRepoPath: string): Promise<string[]> {
  const risks: string[] = [];
  if (!(await git.hasOrigin(bareRepoPath))) {
    risks.push(`never published: .bare/ is the only copy (see 'jade publish')`);
  } else {
    const unpushed = await git.unpushedBranches(bareRepoPath);
    if (unpushed.length > 0) risks.push(`unpushed commits on: ${unpushed.join(", ")}`);
  }
  for (const wt of await git.worktreeList(bareRepoPath)) {
    try {
      const st = await git.status(wt.path);
      if (st.staged + st.unstaged + st.untracked > 0) risks.push(`uncommitted changes in ${wt.path}`);
    } catch {
      // A worktree git can't read is reported by `jade status`; don't block on it.
    }
  }
  return risks;
}

export function makeRemoveCommand(
  git: GitBackend = realGitBackend,
  fs: FileSystemBackend = realFileSystemBackend,
  config: ConfigBackend = realConfigBackend
) {
  return defineCommand({
    meta: {
      name: "remove",
      description: "Remove a repository from the workspace",
    },
    args: {
      name: {
        type: "positional",
        description: "App name to remove",
        required: true,
      },
      force: {
        type: "boolean",
        alias: "f",
        description: "Remove even if it holds work that exists nowhere else",
        default: false,
      },
      ...hubArgs,
    },
    async run({ args }) {
      intro(`Removing repository from workspace`);

      const hub = await resolveHub(args, fs);

      if (!hub) {
        cancel(`Not in a jade hub. Run 'jade init' first.`);
        process.exit(1);
      }

      const appName = args.name as string;
      const barePath = getBarePath(hub);
      const bareRepoPath = resolve(barePath, appName);

      const bareRepos = await listBareRepos(hub, fs);
      if (!bareRepos.includes(appName)) {
        const hint = bareRepos.length > 0
          ? `\nAvailable apps: ${bareRepos.join(", ")}`
          : "";
        cancel(`App '${appName}' not found in .bare/${hint}`);
        process.exit(1);
      }

      // Removing deletes the bare repo and force-removes every worktree, so
      // anything not on a remote is gone for good. Check before touching it.
      if (!args.force) {
        const risks = await findUnsavedWork(git, bareRepoPath);
        if (risks.length > 0) {
          cancel(
            `Not removing '${appName}': it holds work that exists nowhere else.\n` +
              risks.map((r) => `  - ${r}`).join("\n") +
              `\n  Push or commit what you need, or re-run with --force to delete it anyway.`
          );
          process.exit(1);
        }
      }

      try {
        const s = spinner();
        s.start(`Removing ${appName}`);

        const worktrees = await git.worktreeList(bareRepoPath);
        for (const wt of worktrees) {
          try {
            await git.worktreeRemove(bareRepoPath, wt.path);
            s.message(`Cleaned up ${wt.path}`);
          } catch (error) {
            log.warn(`Could not clean up ${wt.path}: ${error}`);
          }
        }

        await git.removeBareRepo(bareRepoPath);
        s.stop(`Removed bare repository from .bare/${appName}`);

        await removeAppFromConfig(config, hub, appName);
        log.success(`Updated jade.json config`);

        outro(`Successfully removed ${appName}!`);
      } catch (error) {
        cancel(`Failed to remove repository: ${error}`);
        process.exit(1);
      }
    },
  });
}

export default makeRemoveCommand();
