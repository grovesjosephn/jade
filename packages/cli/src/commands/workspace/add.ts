import { defineCommand } from "citty";
import { resolve } from "path";
import { multiselect, isCancel } from "@clack/prompts";
import { intro, outro, cancel, log, spinner, canPrompt } from "../../adapters/ui.ts";
import { getBarePath, getWorkspacePath, listBareRepos } from "../../core/layout.ts";
import { type GitBackend, realGitBackend } from "../../adapters/git-backend.ts";
import { copyEnvToWorktree } from "../../core/env.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../../adapters/fs-backend.ts";
import { hubArgs, resolveHub } from "../../core/hub.ts";
import { readWorkspaceMeta, writeWorkspaceMeta } from "../../core/workspace-meta.ts";

export type SelectAppsFn = (apps: string[]) => Promise<string[] | symbol>;

const defaultSelectApps: SelectAppsFn = (apps) => {
  if (!canPrompt()) {
    // Nothing chosen: the caller cleans up and aborts as for an empty pick.
    log.error(`No terminal to pick apps in; pass -a for every app, or --apps ${apps.slice(0, 2).join(",") || "app1,app2"}`);
    return Promise.resolve([]);
  }
  return multiselect({
    message: "Select apps to add to this workspace",
    options: apps.map((a) => ({ value: a, label: a })),
    required: true,
  }) as Promise<string[] | symbol>;
};

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

/**
 * Keep the workspace's metadata in step with the apps just added, so status
 * and doctor know which apps belong in it:
 *
 * - A workspace that already has metadata (subset, review, import) gets the new
 *   apps added to its list.
 * - A new workspace made with only some of the hub's apps gets subset metadata
 *   listing them; without it, every other app would be reported missing.
 * - Otherwise (every app, or apps added to a workspace without metadata) it keeps
 *   the default shape and nothing is written.
 *
 * Apps that were selected but couldn't be added are listed on the workspace's
 * branch, so they still show up as missing and `jade doctor --add-missing` retries them.
 */
async function recordWorkspaceApps(
  workspacePath: string,
  name: string,
  existing: boolean,
  selectedApps: string[],
  skipped: string[],
  branches: Record<string, string>,
  bareRepos: string[],
  fs: FileSystemBackend
): Promise<void> {
  const listed = { ...Object.fromEntries(skipped.map((app) => [app, name])), ...branches };
  const meta = existing ? await readWorkspaceMeta(workspacePath, fs) : null;
  if (meta) {
    await writeWorkspaceMeta(workspacePath, { ...meta, branches: { ...meta.branches, ...listed } }, fs);
  } else if (!existing && selectedApps.length < bareRepos.length) {
    await writeWorkspaceMeta(workspacePath, { kind: "subset", branches: listed }, fs);
  }
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
      from: {
        type: "string",
        description:
          "Start new branches from this branch, tag or commit (origin/<from> preferred) instead of the repo's HEAD",
      },
      ...hubArgs,
    },
    async run({ args }) {
      const hub = await resolveHub(args, fs);

      if (!hub) {
        cancel(`Not in a jade hub. Run 'jade init' first.`);
        process.exit(1);
      }

      const name = args.name as string;
      const all = args.all as boolean;
      const worktreeDirPath = getWorkspacePath(hub, name);
      const existing = await fs.pathExists(worktreeDirPath);

      intro(existing ? `Adding apps to workspace '${name}'` : `Creating workspace`);

      try {
        await fs.mkdirp(worktreeDirPath);

        const bareRepos = await listBareRepos(hub, fs);
        const barePath = getBarePath(hub);

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

        const from = args.from as string | undefined;
        const created: string[] = [];
        /** app -> the branch its worktree ended up on */
        const branches: Record<string, string> = {};
        const skipped: string[] = [];
        const s = spinner();
        s.start(`Setting up apps for '${name}'`);

        for (const appName of selectedApps) {
          const bareRepoPath = resolve(barePath, appName);
          const appWorktreePath = resolve(worktreeDirPath, appName);

          try {
            if (from && (await git.listBranches(bareRepoPath)).includes(name)) {
              log.warn(`${appName}: branch '${name}' already exists, ignoring --from ${from}`);
            }
            const actualBranch = await git.worktreeAdd(
              bareRepoPath,
              appWorktreePath,
              name,
              from ? { from } : undefined
            );
            created.push(actualBranch !== name ? `${appName} (${actualBranch})` : appName);
            branches[appName] = actualBranch ?? name;
            s.message(`Added ${appName}`);
          } catch (error) {
            log.warn(`Could not add ${appName}: ${error}`);
            skipped.push(appName);
          }
        }

        s.stop(created.length > 0 ? `Apps added` : `No apps added`);

        if (created.length === 0) {
          if (!existing) await fs.remove(worktreeDirPath);
          cancel(`Could not add any apps to '${name}'.`);
          process.exit(1);
        }

        await recordWorkspaceApps(worktreeDirPath, name, existing, selectedApps, skipped, branches, bareRepos, fs);

        const envCopied: string[] = [];
        for (const appName of selectedApps) {
          const appWorktreePath = resolve(worktreeDirPath, appName);
          if (await copyEnvToWorktree(hub, appName, appWorktreePath, fs)) {
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
