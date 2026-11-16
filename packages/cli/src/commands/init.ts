import { defineCommand } from "citty";
import { resolve } from "path";
import { intro, outro, cancel, log } from "../adapters/ui.ts";
import { getBarePath, getMainWorktreePath, getWorktreeContainerPath } from "../core/layout.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";
import { type ConfigBackend, realConfigBackend } from "../core/config-backend.ts";

export function makeInitCommand(
  fs: FileSystemBackend = realFileSystemBackend,
  config: ConfigBackend = realConfigBackend
) {
  return defineCommand({
    meta: {
      name: "init",
      description: "Initialize a new hub",
    },
    args: {
      path: {
        type: "positional",
        description: "Hub directory path",
        required: true,
      },
      orgUrl: {
        type: "string",
        description: "GitHub organization URL",
      },
    },
    async run({ args }) {
      const hub = resolve(args.path as string);
      const barePath = getBarePath(hub);
      const mainPath = getMainWorktreePath(hub);
      const worktreeContainerPath = getWorktreeContainerPath(hub);

      intro(`Initializing hub at: ${hub}`);

      if (!await fs.pathExists(hub)) {
        await fs.mkdirp(hub);
        log.success(`Created hub directory`);
      } else {
        if (await fs.pathExists(barePath)) {
          cancel(`Hub already initialized at ${hub}`);
          process.exit(1);
        }
      }

      await fs.mkdirp(barePath);
      log.success(`Created .bare/ directory`);

      await fs.mkdirp(mainPath);
      log.success(`Created main/ directory`);

      await fs.mkdirp(worktreeContainerPath);
      log.success(`Created workspace/ directory`);

      await config.writeConfig(hub, {
        version: "1.0",
        apps: [],
        orgUrl: args.orgUrl as string | undefined,
      });
      log.success(`Created jade.json config`);

      outro(`Workspace initialized! Next: cd ${args.path} && jade add <repo-url>`);
    },
  });
}

export default makeInitCommand();
