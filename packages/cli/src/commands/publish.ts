import { defineCommand } from "citty";
import { resolve } from "path";
import { intro, outro, cancel, log, spinner } from "../adapters/ui.ts";
import { findWorkspaceRoot, listBareRepos } from "../core/layout.ts";
import { type GitBackend, realGitBackend } from "../adapters/git-backend.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";
import { type ConfigBackend, realConfigBackend } from "../core/config-backend.ts";
import { runGh as defaultRunGh, type GhRunner } from "../adapters/gh.ts";
import { publishApp } from "../core/publish.ts";

export function makePublishCommand(
  git: GitBackend = realGitBackend,
  fs: FileSystemBackend = realFileSystemBackend,
  config: ConfigBackend = realConfigBackend,
  runGh: GhRunner = defaultRunGh
) {
  return defineCommand({
    meta: {
      name: "publish",
      description: "Create the remote for a local-only app (from `jade create`) and push it",
    },
    args: {
      name: {
        type: "positional",
        description: "App to publish",
        required: true,
      },
      url: {
        type: "string",
        description: "Push to this existing empty remote instead of running `gh repo create`",
      },
      public: {
        type: "boolean",
        description: "Create a public repository (default: private)",
        default: false,
      },
      allBranches: {
        type: "boolean",
        description: "Push every local branch, not just the default branch",
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
      if (!(await listBareRepos(workspaceRoot, fs)).includes(appName)) {
        cancel(`App '${appName}' not found in .bare/`);
        process.exit(1);
      }

      intro(`Publishing ${appName}`);
      const s = spinner();
      s.start(`Creating remote and pushing`);
      try {
        const result = await publishApp(workspaceRoot, appName, await config.readConfig(workspaceRoot), git, runGh, {
          url: args.url as string | undefined,
          visibility: args.public ? "public" : "private",
          allBranches: args.allBranches as boolean,
        });
        s.stop(`Pushed ${result.pushed.join(", ")} to ${result.url}`);
        if (result.unpushed.length > 0) {
          log.info(
            `Not pushed: ${result.unpushed.join(", ")}. Push each when ready with ` +
              `'git push -u origin <branch>' (or re-run with --all-branches next time).`
          );
        }
        outro(`${appName} is published`);
      } catch (error) {
        s.stop(`Publish failed`);
        cancel(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    },
  });
}

export default makePublishCommand();
