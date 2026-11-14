import { defineCommand } from "citty";
import { resolve } from "path";
import { intro, outro, cancel, log, setJsonMode } from "../../adapters/ui.ts";
import { findWorkspaceRoot, getWorktreeGroupPath, listBareRepos, listWorktreeDirs } from "../../core/layout.ts";
import { type GitBackend, realGitBackend } from "../../adapters/git-backend.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../../adapters/fs-backend.ts";

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
      workspace: {
        type: "string",
        alias: "w",
        description: "Workspace root path",
      },
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

      const workspaceRoot = args.workspace
        ? resolve(args.workspace as string)
        : await findWorkspaceRoot(process.cwd(), fs);

      if (!workspaceRoot) {
        cancel(`Not in a jade workspace. Run 'jade init' first.`);
        process.exit(1);
      }

      try {
        const worktreeDirs = await listWorktreeDirs(workspaceRoot, fs);
        const bareRepos = await listBareRepos(workspaceRoot, fs);

        if (worktreeDirs.length === 0) {
          if (asJson) {
            console.log(JSON.stringify({ groups: [] }));
          } else {
            outro(`No workspaces found.`);
          }
          return;
        }

        const groups: { name: string; apps: { name: string; branch: string }[] }[] = [];

        for (const dirName of worktreeDirs) {
          const lines: string[] = [];
          const apps: { name: string; branch: string }[] = [];
          for (const appName of bareRepos) {
            const appPath = resolve(getWorktreeGroupPath(workspaceRoot, dirName), appName);
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
          groups.push({ name: dirName, apps });

          if (!asJson) {
            if (lines.length > 0) {
              log.message(`${dirName}/\n${lines.map((l) => `  ${l}`).join("\n")}`);
            } else {
              log.message(`${dirName}/ (empty)`);
            }
          }
        }

        if (asJson) {
          console.log(JSON.stringify({ groups }));
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
