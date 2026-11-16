import { defineCommand } from "citty";
import { resolve } from "path";
import { intro, outro, cancel, log, spinner } from "../adapters/ui.ts";
import {
  getBarePath,
  getCurrentWorkspace,
  getWorkspacePath,
  isUsableName,
  listWorktreeDirs,
} from "../core/layout.ts";
import { addAppToConfig } from "../core/config.ts";
import { type GitBackend, realGitBackend } from "../adapters/git-backend.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";
import { type ConfigBackend, realConfigBackend } from "../core/config-backend.ts";
import { recordAppBranch } from "../core/workspace-meta.ts";
import { runGh as defaultRunGh, type GhRunner } from "../adapters/gh.ts";
import { publishApp } from "../core/publish.ts";
import { hubArgs, resolveHub } from "../core/hub.ts";

/**
 * Which feature workspaces get a worktree for the new app. Default: the workspace the
 * command runs from (you're usually creating the repo mid-feature), never
 * `main`, which always gets one.
 */
export function selectWorkspaces(workspacesArg: string | undefined, current: string | null, existing: string[]): string[] {
  const features = existing.filter((g) => g !== "main");
  if (workspacesArg === undefined) return current && current !== "main" ? [current] : [];
  if (workspacesArg === "none") return [];
  if (workspacesArg === "all") return features;
  return workspacesArg
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
        description: "Feature workspaces to add the app to: a,b | all | none (default: the current workspace)",
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
      ...hubArgs,
    },
    async run({ args }) {
      const hub = await resolveHub(args, fs);

      if (!hub) {
        cancel(`Not in a jade hub. Run 'jade init' first.`);
        process.exit(1);
      }

      const appName = args.name as string;
      const branch = args.branch as string;
      if (!isUsableName(appName)) {
        cancel(`'${appName}' isn't a usable app name (letters, digits, '.', '_' and '-')`);
        process.exit(1);
      }

      const bareRepoPath = resolve(getBarePath(hub), appName);
      if (await fs.pathExists(bareRepoPath)) {
        cancel(`App '${appName}' already exists in .bare/`);
        process.exit(1);
      }

      const existingWorkspaces = await listWorktreeDirs(hub, fs);
      const workspaces = selectWorkspaces(
        args.groups as string | undefined,
        getCurrentWorkspace(hub, process.cwd()),
        existingWorkspaces
      );
      const unknown = workspaces.filter((g) => !existingWorkspaces.includes(g));
      if (unknown.length > 0) {
        cancel(`Unknown workspace(s): ${unknown.join(", ")}. See 'jade workspace list'.`);
        process.exit(1);
      }

      intro(`Creating ${appName}`);
      const s = spinner();

      s.start(`Initialising repository`);
      const mainWorkspacePath = getWorkspacePath(hub, "main");
      try {
        await fs.mkdirp(mainWorkspacePath);
        await git.initRepo(bareRepoPath, resolve(mainWorkspacePath, appName), branch);
      } catch (error) {
        s.stop(`Could not create the repository`);
        cancel(
          `${error}\n  (The first commit needs a git identity: ` +
            `git config --global user.name / user.email)`
        );
        process.exit(1);
      }
      await addAppToConfig(config, hub, appName, branch === "main" ? undefined : branch);
      s.stop(`Created .bare/${appName} and main/${appName} on '${branch}'`);

      for (const workspace of workspaces) {
        const workspacePath = getWorkspacePath(hub, workspace);
        try {
          const actual = await git.worktreeAdd(bareRepoPath, resolve(workspacePath, appName), workspace);
          // A review workspace lists the apps it expects; record the new one so
          // status and doctor don't treat it as stray. In a plain workspace a
          // uniquified branch stays reported as drift.
          if (actual) await recordAppBranch(workspacePath, workspace, appName, actual, fs);
          log.success(`Added to workspace/${workspace}/ on '${actual}'`);
        } catch (error) {
          log.warn(`Could not add to workspace/${workspace}/: ${error}`);
        }
      }

      if (args.remote) {
        s.start(`Publishing`);
        try {
          const result = await publishApp(hub, appName, await config.readConfig(hub), git, runGh, {
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
