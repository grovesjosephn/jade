import { defineCommand } from "citty";
import { resolve } from "path";
import { intro, outro, cancel, log, spinner } from "../../adapters/ui.ts";
import { getBarePath, getWorkspacePath, listBareRepos } from "../../core/layout.ts";
import { type GitBackend, realGitBackend } from "../../adapters/git-backend.ts";
import { GitError } from "../../adapters/git-process.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../../adapters/fs-backend.ts";
import { hubArgs, resolveHub } from "../../core/hub.ts";

export function makeWorkspaceRemoveCommand(
  git: GitBackend = realGitBackend,
  fs: FileSystemBackend = realFileSystemBackend
) {
  return defineCommand({
    meta: {
      name: "remove",
      description: "Remove a workspace",
    },
    args: {
      name: {
        type: "positional",
        description: "Workspace name to remove",
        required: true,
      },
      deleteBranches: {
        type: "boolean",
        alias: "d",
        description: "Delete branches with the same name in all apps",
        default: false,
      },
      force: {
        type: "boolean",
        alias: "f",
        description: "Force delete branches (use with --delete-branches)",
        default: false,
      },
      ...hubArgs,
    },
    async run({ args }) {
      intro(`Removing workspace`);

      const hub = await resolveHub(args, fs);

      if (!hub) {
        cancel(`Not in a jade hub. Run 'jade init' first.`);
        process.exit(1);
      }

      const name = args.name as string;
      const deleteBranches = args.deleteBranches as boolean;
      const force = args.force as boolean;

      if (name === "main") {
        cancel(`Cannot remove the main workspace`);
        process.exit(1);
      }

      const worktreeDirPath = getWorkspacePath(hub, name);

      if (!await fs.pathExists(worktreeDirPath)) {
        cancel(`Workspace '${name}' not found`);
        process.exit(1);
      }

      try {
        const bareRepos = await listBareRepos(hub, fs);
        const barePath = getBarePath(hub);
        const s = spinner();
        s.start(`Removing workspace '${name}'`);

        for (const appName of bareRepos) {
          const bareRepoPath = resolve(barePath, appName);
          const appWorktreePath = resolve(worktreeDirPath, appName);

          if (await fs.pathExists(appWorktreePath)) {
            try {
              await git.worktreeRemove(bareRepoPath, appWorktreePath);
              s.message(`Removed ${appName}`);
            } catch (error) {
              log.warn(`Could not remove ${appName}: ${error}`);
            }
          }
        }

        await fs.remove(worktreeDirPath);
        s.stop(`Removed directory workspace/${name}/`);

        if (deleteBranches) {
          const branchSpinner = spinner();
          branchSpinner.start(`Deleting branch '${name}' in all apps`);
          const deleted: string[] = [];
          const skipped: string[] = [];
          const notForced: string[] = [];
          const failed: string[] = [];

          // Only apps that have the branch locally; the rest have nothing to delete.
          const withBranch: string[] = [];
          for (const appName of bareRepos) {
            if (await git.hasLocalBranch(resolve(barePath, appName), name)) withBranch.push(appName);
          }

          for (const appName of withBranch) {
            const mainAppPath = resolve(hub, "main", appName);
            if (await fs.pathExists(mainAppPath)) {
              // An unpublished app has no other copy of the branch, so -f would
              // destroy unmerged work outright. Fall back to a safe delete there.
              const unpublished = force && !(await git.hasOrigin(resolve(barePath, appName)));
              try {
                await git.deleteBranch(mainAppPath, name, force && !unpublished);
                deleted.push(appName);
              } catch (error) {
                const reason =
                  error instanceof GitError
                    ? (error.stderr.trim().split("\n")[0] ?? "")
                    : error instanceof Error
                      ? error.message
                      : String(error);
                if (/not fully merged/.test(reason)) (unpublished ? notForced : skipped).push(appName);
                else failed.push(`${appName} (${reason.replace(/^error:\s*/, "")})`);
              }
            }
          }

          branchSpinner.stop(
            withBranch.length > 0 ? `Branch deletion complete` : `No app has a local branch '${name}'`
          );

          if (deleted.length > 0) {
            log.success(`Deleted branch '${name}' in: ${deleted.join(", ")}`);
          }
          if (skipped.length > 0) {
            log.warn(
              `Skipped (unmerged changes): ${skipped.join(", ")}` +
              (!force ? `\n  Use -f to force delete` : "")
            );
          }
          if (failed.length > 0) {
            log.warn(`Could not delete branch '${name}' in: ${failed.join(", ")}`);
          }
          if (notForced.length > 0) {
            log.warn(
              `Kept, unmerged and never published (no other copy): ${notForced.join(", ")}\n` +
              `  Delete by hand if you're sure: git -C .bare/<app> branch -D ${name}`
            );
          }
        }

        outro(`Workspace '${name}' removed!`);
      } catch (error) {
        cancel(`Failed to remove workspace: ${error}`);
        process.exit(1);
      }
    },
  });
}

export const removeCommand = makeWorkspaceRemoveCommand();
