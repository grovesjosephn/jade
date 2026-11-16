import { defineCommand } from "citty";
import { resolve } from "path";
import { intro, outro, cancel, log, setJsonMode } from "../../adapters/ui.ts";
import { getWorkspacePath, listBareRepos, listWorktreeDirs } from "../../core/layout.ts";
import { type GitBackend, realGitBackend } from "../../adapters/git-backend.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../../adapters/fs-backend.ts";
import { hubArgs, resolveHub } from "../../core/hub.ts";

export function makeWorkspaceListCommand(
  git: GitBackend = realGitBackend,
  fs: FileSystemBackend = realFileSystemBackend
) {
  return defineCommand({
    meta: {
      name: "list",
      description: "List all workspaces",
    },
    args: {
      ...hubArgs,
      json: {
        type: "boolean",
        description: "Print machine-readable JSON instead of plain text",
        default: false,
      },
    },
    async run({ args }) {
      const asJson = args.json as boolean;
      setJsonMode(asJson);
      if (!asJson) intro(`Workspaces`);

      const hub = await resolveHub(args, fs);

      if (!hub) {
        cancel(`Not in a jade hub. Run 'jade init' first.`);
        process.exit(1);
      }

      try {
        const worktreeDirs = await listWorktreeDirs(hub, fs);
        const bareRepos = await listBareRepos(hub, fs);

        if (worktreeDirs.length === 0) {
          if (asJson) {
            console.log(JSON.stringify({ workspaces: [], groups: [] }));
          } else {
            outro(`No workspaces found.`);
          }
          return;
        }

        const workspaces: { name: string; apps: { name: string; branch: string }[] }[] = [];

        for (const dirName of worktreeDirs) {
          const lines: string[] = [];
          const apps: { name: string; branch: string }[] = [];
          for (const appName of bareRepos) {
            const appPath = resolve(getWorkspacePath(hub, dirName), appName);
            if (await fs.pathExists(appPath)) {
              try {
                const branch = await git.currentBranch(appPath);
                lines.push(`${appName.padEnd(30)} (${branch})`);
                apps.push({ name: appName, branch });
              } catch {
                lines.push(`${appName.padEnd(30)} (error reading branch)`);
                apps.push({ name: appName, branch: "" });
              }
            }
          }
          workspaces.push({ name: dirName, apps });

          if (!asJson) {
            if (lines.length > 0) {
              log.message(`${dirName}/\n${lines.map((l) => `  ${l}`).join("\n")}`);
            } else {
              log.message(`${dirName}/ (empty)`);
            }
          }
        }

        if (asJson) {
          // `groups` is the pre-0.4 name, kept so older readers keep working.
          console.log(JSON.stringify({ workspaces, groups: workspaces }));
        } else {
          outro(`Done`);
        }
      } catch (error) {
        cancel(`Failed to list workspaces: ${error}`);
        process.exit(1);
      }
    },
  });
}

export const listCommand = makeWorkspaceListCommand();
