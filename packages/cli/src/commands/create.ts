import { defineCommand } from "citty";
import { resolve } from "path";
import { intro, outro, cancel, log, spinner } from "../adapters/ui.ts";
import {
  findWorkspaceRoot,
  getBarePath,
  getCurrentGroup,
  getWorktreeGroupPath,
  isUsableName,
  listWorktreeDirs,
} from "../core/layout.ts";
import { addAppToConfig } from "../core/config.ts";
import { type GitBackend, realGitBackend } from "../adapters/git-backend.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";
import { type ConfigBackend, realConfigBackend } from "../core/config-backend.ts";
import { recordAppBranch } from "../core/group-meta.ts";
import { runGh as defaultRunGh, type GhRunner } from "../adapters/gh.ts";
import { publishApp } from "../core/publish.ts";

/**
 * Which feature groups get a worktree for the new app. Default: the group the
 * command runs from (you're usually creating the repo mid-feature), never
 * `main`, which always gets one.
 */
export function selectGroups(groupsArg: string | undefined, current: string | null, existing: string[]): string[] {
  const features = existing.filter((g) => g !== "main");
  if (groupsArg === undefined) return current && current !== "main" ? [current] : [];
  if (groupsArg === "none") return [];
  if (groupsArg === "all") return features;
  return groupsArg
    .split(",")
    .map((g) => g.trim())
    .filter((g) => g && g !== "main");
}

export function makeCreateCommand(
  git: GitBackend = realGitBackend,
  fs: FileSystemBackend = realFileSystemBackend,
  config: ConfigBackend = realConfigBackend,
  runGh: GhRunner = defaultRunGh
) {
  return defineCommand({
    meta: {
      name: "create",
      description: "Create a new, local-only repository as an app (publish it later with `jade publish`)",
    },
    args: {
      name: {
        type: "positional",
        description: "App (and repository) name",
        required: true,
      },
      branch: {
        type: "string",
        alias: "b",
        description: "Default branch name",
        default: "main",
      },
      groups: {
        type: "string",
        description: "Feature groups to add the app to: a,b | all | none (default: the current group)",
      },
      remote: {
        type: "boolean",
        description: "Publish right away (same as running `jade publish` afterwards)",
        default: false,
      },
      public: {
        type: "boolean",
        description: "With --remote: create a public repository (default: private)",
        default: false,
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

      const appName = args.name as string;
      const branch = args.branch as string;
      if (!isUsableName(appName)) {
        cancel(`'${appName}' isn't a usable app name (letters, digits, '.', '_' and '-')`);
        process.exit(1);
      }

      const bareRepoPath = resolve(getBarePath(workspaceRoot), appName);
      if (await fs.pathExists(bareRepoPath)) {
        cancel(`App '${appName}' already exists in .bare/`);
        process.exit(1);
      }

      const existingGroups = await listWorktreeDirs(workspaceRoot, fs);
      const groups = selectGroups(
        args.groups as string | undefined,
        getCurrentGroup(workspaceRoot, process.cwd()),
        existingGroups
      );
      const unknown = groups.filter((g) => !existingGroups.includes(g));
      if (unknown.length > 0) {
        cancel(`Unknown group(s): ${unknown.join(", ")}. See 'jade workspace list'.`);
        process.exit(1);
      }

      intro(`Creating ${appName}`);
      const s = spinner();

      s.start(`Initialising repository`);
      const mainGroupPath = getWorktreeGroupPath(workspaceRoot, "main");
      try {
        await fs.mkdirp(mainGroupPath);
        await git.initRepo(bareRepoPath, resolve(mainGroupPath, appName), branch);
      } catch (error) {
        s.stop(`Could not create the repository`);
        cancel(
          `${error}\n  (The first commit needs a git identity: ` +
            `git config --global user.name / user.email)`
        );
        process.exit(1);
      }
      await addAppToConfig(config, workspaceRoot, appName, branch === "main" ? undefined : branch);
      s.stop(`Created .bare/${appName} and main/${appName} on '${branch}'`);

      for (const group of groups) {
        const groupPath = getWorktreeGroupPath(workspaceRoot, group);
        try {
          const actual = await git.worktreeAdd(bareRepoPath, resolve(groupPath, appName), group);
          // A review group lists the apps it expects; record the new one so
          // status and doctor don't treat it as stray. In a plain group a
          // uniquified branch stays reported as drift.
          if (actual) await recordAppBranch(groupPath, group, appName, actual, fs);
          log.success(`Added to workspace/${group}/ on '${actual}'`);
        } catch (error) {
          log.warn(`Could not add to workspace/${group}/: ${error}`);
        }
      }

      if (args.remote) {
        s.start(`Publishing`);
        try {
          const result = await publishApp(workspaceRoot, appName, await config.readConfig(workspaceRoot), git, runGh, {
            visibility: args.public ? "public" : "private",
            allBranches: false,
          });
          s.stop(`Published to ${result.url}`);
        } catch (error) {
          s.stop(`Publish failed; ${appName} was created locally`);
          log.warn(error instanceof Error ? error.message : String(error));
          log.info(`Retry with: jade publish ${appName}`);
          process.exit(1);
        }
        outro(`${appName} is ready`);
        return;
      }

      outro(`${appName} is local only (.bare/${appName} is the only copy). Run 'jade publish ${appName}' when ready.`);
    },
  });
}

export default makeCreateCommand();
