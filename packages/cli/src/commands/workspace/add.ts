import { defineCommand } from "citty";
import { resolve } from "path";
import { intro, outro, cancel, log, spinner, multiselect, isCancel } from "@clack/prompts";
import { findWorkspaceRoot, getBarePath, getWorktreeGroupPath, listBareRepos } from "../../core/layout.ts";
import { type GitBackend, realGitBackend } from "../../adapters/git-backend.ts";
import { copyEnvToWorktree } from "../../core/env.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../../adapters/fs-backend.ts";

export type SelectAppsFn = (apps: string[]) => Promise<string[] | symbol>;

const defaultSelectApps: SelectAppsFn = (apps) =>
  multiselect({
    message: "Select apps to add to this workspace",
    options: apps.map((a) => ({ value: a, label: a })),
    required: true,
  }) as Promise<string[] | symbol>;

async function resolveSelectedApps(
  bareRepos: string[],
  all: boolean,
  selectApps: SelectAppsFn
): Promise<string[] | null> {
  if (all) return bareRepos;
  const result = await selectApps(bareRepos);
  if (isCancel(result) || !Array.isArray(result) || result.length === 0) return null;
  return result;
}

export type ResolvedAppsList = {
  /** Requested apps that exist among bareRepos and aren't already in the workspace */
  selected: string[];
  /** Requested names that don't match any configured app */
  invalid: string[];
  /** Requested apps that are valid but already present in the workspace */
  alreadyPresent: string[];
};

/** Parses a comma-separated `--apps` value against the known/candidate app lists. Pure and unit-testable. */
export function resolveAppsList(rawApps: string, bareRepos: string[], candidateApps: string[]): ResolvedAppsList {
  const requested = Array.from(new Set(rawApps.split(",").map((a) => a.trim()).filter(Boolean)));
  const invalid = requested.filter((a) => !bareRepos.includes(a));
  const valid = requested.filter((a) => bareRepos.includes(a));
  return {
    selected: valid.filter((a) => candidateApps.includes(a)),
    invalid,
    alreadyPresent: valid.filter((a) => !candidateApps.includes(a)),
  };
}

export function makeWorkspaceAddCommand(
  git: GitBackend = realGitBackend,
  selectApps: SelectAppsFn = defaultSelectApps,
  fs: FileSystemBackend = realFileSystemBackend
) {
  return defineCommand({
    meta: {
      name: "add",
      description: "Create a new workspace",
    },
    args: {
      name: {
        type: "positional",
        description: "Workspace name (also used as branch name for apps)",
        required: true,
      },
      all: {
        type: "boolean",
        alias: "a",
        description: "Add all apps to the workspace without prompting",
        default: false,
      },
      apps: {
        type: "string",
        description: "Comma-separated app names to add (bypasses --all and the interactive prompt)",
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

      const name = args.name as string;
      const all = args.all as boolean;
      const worktreeDirPath = getWorktreeGroupPath(workspaceRoot, name);
      const existing = await fs.pathExists(worktreeDirPath);

      intro(existing ? `Adding apps to workspace '${name}'` : `Creating workspace`);

      try {
        await fs.mkdirp(worktreeDirPath);

        const bareRepos = await listBareRepos(workspaceRoot, fs);
        const barePath = getBarePath(workspaceRoot);

        const presentApps = existing
          ? await Promise.all(bareRepos.map(async (app) => ({ app, exists: await fs.pathExists(resolve(worktreeDirPath, app)) })))
              .then((results) => results.filter((r) => r.exists).map((r) => r.app))
          : [];

        const candidateApps = bareRepos.filter((app) => !presentApps.includes(app));

        if (bareRepos.length === 0) {
          log.success(`Created empty workspace directory workspace/${name}`);
          log.warn(`No apps found. Add apps with 'jade add <repo-url>'`);
          outro(`Done`);
          return;
        }

        if (existing && candidateApps.length === 0) {
          cancel(`All apps are already in workspace '${name}'`);
          process.exit(1);
        }

        const appsArg = args.apps as string | undefined;
        let selectedApps: string[] | null;

        if (appsArg !== undefined) {
          const { selected, invalid, alreadyPresent } = resolveAppsList(appsArg, bareRepos, candidateApps);

          if (invalid.length > 0) {
            if (!existing) await fs.remove(worktreeDirPath);
            cancel(`Unknown app(s): ${invalid.join(", ")}. Available: ${bareRepos.join(", ")}`);
            process.exit(1);
          }
          if (alreadyPresent.length > 0) {
            log.warn(`Already in workspace '${name}', skipping: ${alreadyPresent.join(", ")}`);
          }

          selectedApps = selected.length > 0 ? selected : null;
        } else {
          selectedApps = await resolveSelectedApps(candidateApps, all, selectApps);
        }

        if (!selectedApps) {
          if (!existing) await fs.remove(worktreeDirPath);
          cancel(`No apps selected. Aborting.`);
          process.exit(1);
        }

        const created: string[] = [];
        const skipped: string[] = [];
        const s = spinner();
        s.start(`Setting up apps for '${name}'`);

        for (const appName of selectedApps) {
          const bareRepoPath = resolve(barePath, appName);
          const appWorktreePath = resolve(worktreeDirPath, appName);

          try {
            const actualBranch = await git.worktreeAdd(bareRepoPath, appWorktreePath, name);
            created.push(actualBranch !== name ? `${appName} (${actualBranch})` : appName);
            s.message(`Added ${appName}`);
          } catch (error) {
            log.warn(`Could not add ${appName}: ${error}`);
            skipped.push(appName);
          }
        }

        s.stop(`Apps added`);

        const envCopied: string[] = [];
        for (const appName of selectedApps) {
          const appWorktreePath = resolve(worktreeDirPath, appName);
          if (await copyEnvToWorktree(workspaceRoot, appName, appWorktreePath, fs)) {
            envCopied.push(appName);
          }
        }

        if (created.length > 0) {
          log.success(`Created in workspace/${name}/: ${created.join(", ")}`);
        }
        if (envCopied.length > 0) {
          log.success(`Copied .env for: ${envCopied.join(", ")}`);
        }
        if (skipped.length > 0) {
          log.warn(`Skipped: ${skipped.join(", ")}`);
        }

        outro(`Workspace '${name}' ready! Next: cd workspace/${name}`);
      } catch (error) {
        cancel(`Failed to create workspace: ${error}`);
        process.exit(1);
      }
    },
  });
}

export const addCommand = makeWorkspaceAddCommand();
