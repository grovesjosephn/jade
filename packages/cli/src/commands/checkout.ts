import { defineCommand } from "citty";
import { resolve } from "path";
import { intro, outro, cancel, spinner } from "../adapters/ui.ts";
import { type GitBackend, realGitBackend } from "../adapters/git-backend.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";
import { hubArgs, resolveHub } from "../core/hub.ts";

export function makeCheckoutCommand(
  git: GitBackend = realGitBackend,
  fs: FileSystemBackend = realFileSystemBackend
) {
  return defineCommand({
    meta: {
      name: "checkout",
      description: "Checkout or create a branch in a specific app",
    },
    args: {
      branch: {
        type: "positional",
        description: "Branch name",
        required: true,
      },
      app: {
        type: "string",
        description: "App name (if checking out in a specific app)",
      },
      create: {
        type: "boolean",
        alias: "c",
        description: "Create a new branch",
        default: false,
      },
      ...hubArgs,
    },
    async run({ args }) {
      intro(`Checkout`);

      const hub = await resolveHub(args, fs);

      if (!hub) {
        cancel(`Not in a jade hub. Run 'jade init' first.`);
        process.exit(1);
      }

      const branch = args.branch as string;
      const create = args.create as boolean;
      const app = args.app as string | undefined;

      let targetPath: string;
      let targetDescription: string;

      if (app) {
        targetPath = resolve(process.cwd(), app);
        targetDescription = `app '${app}'`;

        if (!await fs.pathExists(targetPath)) {
          cancel(`App '${app}' not found in current directory`);
          process.exit(1);
        }
      } else {
        targetPath = process.cwd();
        targetDescription = "current directory";
      }

      const s = spinner();
      s.start(`${create ? "Creating and checking out" : "Checking out"} branch '${branch}' in ${targetDescription}`);

      try {
        await git.checkout(targetPath, branch, create);
        s.stop(`${create ? "Created and checked out" : "Checked out"} branch '${branch}'`);
        outro(`Done`);
      } catch (error) {
        s.stop(`Failed`);
        cancel(`Failed to checkout branch: ${error}`);
        process.exit(1);
      }
    },
  });
}

export default makeCheckoutCommand();
