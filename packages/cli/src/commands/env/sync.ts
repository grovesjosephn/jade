import { defineCommand } from "citty";
import { intro, outro, cancel, log, spinner } from "../../adapters/ui.ts";
import { listBareRepos, listWorktreeDirs } from "../../core/layout.ts";
import { getEnvDirPath, syncEnvToWorkspace } from "../../core/env.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../../adapters/fs-backend.ts";
import { hubArgs, resolveHub } from "../../core/hub.ts";

export function makeEnvSyncCommand(fs: FileSystemBackend = realFileSystemBackend) {
  return defineCommand({
    meta: {
      name: "sync",
      description: "Copy .env files from .env/<app>/.env to all worktrees",
    },
    args: {
      ...hubArgs,
    },
    async run({ args }) {
      const hub = await resolveHub(args, fs);

      if (!hub) {
        cancel(`Not in a jade hub. Run 'jade init' first.`);
        process.exit(1);
      }

      intro(`Syncing env files`);

      const envDir = getEnvDirPath(hub);
      const envDirExists = await fs.pathExists(envDir);
      if (!envDirExists) {
        cancel(`No .env/ directory found at ${envDir}`);
        process.exit(1);
      }

      const workspaces = await listWorktreeDirs(hub, fs);
      const apps = await listBareRepos(hub, fs);

      if (workspaces.length === 0 || apps.length === 0) {
        log.warn(`No worktrees found to sync.`);
        outro(`Done`);
        return;
      }

      const s = spinner();
      s.start(`Copying env files`);

      const allCopied: string[] = [];
      const allSkipped = new Set<string>();

      for (const workspace of workspaces) {
        const result = await syncEnvToWorkspace(hub, workspace, apps, fs);
        allCopied.push(...result.copied);
        result.skipped.forEach((a) => allSkipped.add(a));
      }

      s.stop(`Sync complete`);

      if (allCopied.length > 0) {
        log.success(`Copied:\n${allCopied.map((c) => `  ${c}/.env`).join("\n")}`);
      }
      if (allSkipped.size > 0) {
        log.info(`No source .env for: ${[...allSkipped].join(", ")}`);
      }

      outro(`Done`);
    },
  });
}

export const syncCommand = makeEnvSyncCommand();
