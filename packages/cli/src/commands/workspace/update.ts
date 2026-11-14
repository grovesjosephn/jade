import { defineCommand } from "citty";
import { resolve } from "path";
import { intro, outro, cancel, log, spinner } from "../../adapters/ui.ts";
import {
  findWorkspaceRoot,
  getBarePath,
  getCurrentGroup,
  getWorktreeGroupPath,
  listBareRepos,
  listWorktreeDirs,
} from "../../core/layout.ts";
import { type GitBackend, realGitBackend } from "../../adapters/git-backend.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../../adapters/fs-backend.ts";
import { getAppDefaultBranch } from "../../core/config.ts";
import { type ConfigBackend, realConfigBackend } from "../../core/config-backend.ts";

export function makeWorkspaceUpdateCommand(
  git: GitBackend = realGitBackend,
  fs: FileSystemBackend = realFileSystemBackend,
  config: ConfigBackend = realConfigBackend
) {
  return defineCommand({
    meta: {
      name: "update",
      description: "Merge each app's latest default-branch changes into a workspace group",
    },
    args: {
      group: {
        type: "positional",
        description: "Worktree group to update (defaults to current group, or 'main')",
        required: false,
      },
      workspace: {
        type: "string",
        alias: "w",
        description: "Workspace root path",
      },
    },
    async run({ args }) {
      const workspaceRoot = args.workspace
        ? resolve(args.workspace as string)
        : await findWorkspaceRoot(process.cwd(), fs);

      if (!workspaceRoot) {
        cancel(`Not in a jade workspace. Run 'jade init' first.`);
        process.exit(1);
      }

      const groups = await listWorktreeDirs(workspaceRoot, fs);
      const group =
        (args.group as string | undefined) ||
        getCurrentGroup(workspaceRoot, process.cwd()) ||
        "main";

      if (!groups.includes(group)) {
        cancel(`Worktree group '${group}' not found. See 'jade workspace list'.`);
        process.exit(1);
      }

      const groupPath = getWorktreeGroupPath(workspaceRoot, group);
      const barePath = getBarePath(workspaceRoot);
      const bareRepos = await listBareRepos(workspaceRoot, fs);
      const jadeConfig = await config.readConfig(workspaceRoot);

      intro(`Updating workspace '${group}'`);

      const merged: string[] = [];
      const upToDate: string[] = [];
      const localOnly: string[] = [];
      const failed: { name: string; error: unknown }[] = [];
      const s = spinner();

      for (const appName of bareRepos) {
        const appWorktreePath = resolve(groupPath, appName);
        if (!await fs.pathExists(appWorktreePath)) continue;

        s.start(`Updating ${appName}`);
        try {
          const bareRepoPath = resolve(barePath, appName);
          if (!(await git.hasOrigin(bareRepoPath))) {
            localOnly.push(appName);
            s.stop(`${appName}: local only, nothing to merge from`);
            continue;
          }
          const defaultBranch =
            getAppDefaultBranch(jadeConfig, appName) ??
            (await git.getDefaultBranch(bareRepoPath));

          await git.fetch(bareRepoPath);
          const result = await git.mergeBranch(appWorktreePath, defaultBranch);

          if (result === "up-to-date") {
            upToDate.push(appName);
            s.stop(`${appName}: already up to date`);
          } else {
            merged.push(appName);
            s.stop(`${appName}: merged latest ${defaultBranch}`);
          }
        } catch (error) {
          s.stop(`${appName}: failed`);
          log.warn(`${appName}: merge failed — resolve manually in ${appWorktreePath}\n  ${error}`);
          failed.push({ name: appName, error });
        }
      }

      if (merged.length === 0 && upToDate.length === 0 && failed.length === 0 && localOnly.length === 0) {
        log.warn(`No apps found in '${group}'.`);
      } else {
        if (merged.length > 0) log.success(`Merged: ${merged.join(", ")}`);
        if (upToDate.length > 0) log.info(`Already up to date: ${upToDate.join(", ")}`);
        if (localOnly.length > 0) log.info(`Skipped, not published yet: ${localOnly.join(", ")}`);
        if (failed.length > 0) log.warn(`Failed: ${failed.map((f) => f.name).join(", ")}`);
      }

      outro(`Done`);
    },
  });
}

export const updateCommand = makeWorkspaceUpdateCommand();
