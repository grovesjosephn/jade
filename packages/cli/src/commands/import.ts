import { defineCommand } from "citty";
import { basename, relative, resolve } from "path";
import { intro, outro, cancel, log, spinner, setJsonMode } from "../adapters/ui.ts";
import { getBarePath, getWorkspacePath, isUsableName } from "../core/layout.ts";
import { addAppToConfig } from "../core/config.ts";
import { adoptEnv, copyEnvToWorktree } from "../core/env.ts";
import { readWorkspaceMeta, recordAppBranch, writeWorkspaceMeta } from "../core/workspace-meta.ts";
import { importBlockers, importNotes } from "../core/import-check.ts";
import { type GitBackend, realGitBackend } from "../adapters/git-backend.ts";
import { type CarriedWork, type ImportCheck, type ImportSource, originOf } from "../adapters/git-import.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";
import { type ConfigBackend, realConfigBackend } from "../core/config-backend.ts";
import { hubArgs, resolveHub } from "../core/hub.ts";

/** Where the source's checked-out work goes: a feature workspace, or nowhere */
export type ImportPlan =
  | { workspace: null }
  | {
      workspace: string;
      branch: string;
      /** The branch doesn't exist yet: create it at the source's HEAD */
      newBranch: boolean;
    }
  | { error: string };

/**
 * Turn a branch name into a workspace directory name: `feature/login` would
 * otherwise nest as workspace/feature/login/.
 */
export function toWorkspaceName(branch: string): string {
  return branch.replace(/\//g, "-");
}

/**
 * Decide which workspace gets the source's current branch and uncommitted work.
 * The work never goes into main/: that workspace stays on the default branch.
 *
 * - On a feature branch: a workspace named after it (or --group), on that branch.
 * - On the default branch or a detached HEAD: only with --group, as a new
 *   branch of that name at HEAD. Required for a detached HEAD, and when
 *   there's uncommitted work.
 */
export function planImport(
  source: Pick<ImportSource, "branch" | "dirty">,
  defaultBranch: string,
  workspaceArg: string | undefined
): ImportPlan {
  const onFeature = source.branch !== null && source.branch !== defaultBranch;
  if (workspaceArg !== undefined) {
    if (workspaceArg === "main") return { error: "--group can't be main; uncommitted work goes to a feature workspace" };
    if (!isUsableName(workspaceArg)) return { error: `'${workspaceArg}' isn't a usable workspace name` };
    return onFeature
      ? { workspace: workspaceArg, branch: source.branch!, newBranch: false }
      : { workspace: workspaceArg, branch: workspaceArg, newBranch: true };
  }
  if (onFeature) {
    const workspace = toWorkspaceName(source.branch!);
    if (!isUsableName(workspace)) {
      return { error: `branch '${source.branch}' can't be a workspace name; pass --group <name>` };
    }
    return { workspace: workspace, branch: source.branch!, newBranch: false };
  }
  // A detached HEAD may hold commits no branch has; without a workspace for them
  // they'd be lost once the source is deleted.
  if (source.branch === null) {
    return { error: "HEAD is detached; pass --group <name> to keep it on a new branch" };
  }
  if (source.dirty) {
    return {
      error: `the uncommitted work is on the default branch '${defaultBranch}'; pass --group <name> to put it on a new branch`,
    };
  }
  return { workspace: null };
}

/** The comparison part of `jade import --json` output, shared by every mode */
function checkJson(check: ImportCheck) {
  const blockers = importBlockers(check);
  return { safeToRemove: blockers.length === 0, blockers, notes: importNotes(check), check };
}

const removeCommand = (source: string, app: string) => `jade import ${source} --name ${app} --remove-source`;

/** Print a check's blockers and notes; returns whether the source is safe to delete */
function reportCheck(check: ImportCheck): boolean {
  const blockers = importBlockers(check);
  for (const b of blockers) log.warn(`Only in the source: ${b}`);
  for (const n of importNotes(check)) log.info(n);
  return blockers.length === 0;
}

export function makeImportCommand(
  git: GitBackend = realGitBackend,
  fs: FileSystemBackend = realFileSystemBackend,
  config: ConfigBackend = realConfigBackend
) {
  return defineCommand({
    meta: {
      name: "import",
      description:
        "Import an existing local clone as an app: bare repo, main/ worktree, and its current branch and uncommitted work in a workspace",
    },
    args: {
      path: {
        type: "positional",
        description: "Path to the git working copy to import",
        required: true,
      },
      name: {
        type: "string",
        description: "App name (defaults to the directory name)",
      },
      branch: {
        type: "string",
        alias: "b",
        description: "Default branch for main/ (detected from origin/HEAD, then main/master)",
      },
      group: {
        type: "string",
        alias: "g",
        description: "Workspace for the current branch and uncommitted work (default: named after the branch)",
      },
      ...hubArgs,
      check: {
        type: "boolean",
        description:
          "Don't import: compare <path> with its existing import and list what deleting it would lose (exits 1 if anything)",
      },
      "remove-source": {
        type: "boolean",
        description: "Don't import: run --check, and delete <path> only if nothing would be lost",
      },
      json: {
        type: "boolean",
        description: "Print the result as one JSON object instead of text; errors go to stderr as {\"error\":{...}}",
      },
    },
    async run({ args }) {
      const asJson = Boolean(args.json);
      setJsonMode(asJson);
      const hub = await resolveHub(args, fs);

      if (!hub) {
        cancel(`Not in a jade hub. Run 'jade init' first.`);
        process.exit(1);
      }

      const sourcePath = resolve(args.path as string);
      const source = await git.inspectImportSource(sourcePath);
      if (!source) {
        cancel(`${sourcePath} isn't inside a git working copy`);
        process.exit(1);
      }
      const rel = relative(hub, source.root);
      if (rel === "" || !rel.startsWith("..")) {
        cancel(`${source.root} is already inside this jade hub`);
        process.exit(1);
      }
      if (!relative(source.root, hub).startsWith("..")) {
        cancel(`This jade hub is inside ${source.root}; move one of them first`);
        process.exit(1);
      }
      const appName = (args.name as string | undefined) ?? basename(source.root);

      if (args.check || args["remove-source"]) {
        const bare = resolve(getBarePath(hub), appName);
        if (!isUsableName(appName) || !(await fs.pathExists(bare))) {
          cancel(`No app '${appName}' in .bare/ to compare ${source.root} with; pass --name <app>`);
          process.exit(1);
        }
        intro(`Comparing ${source.root} with ${appName}`);
        const check = await git.checkImport(source.root, bare);
        const safe = reportCheck(check);
        const removing = Boolean(args["remove-source"]);
        if (asJson) {
          if (removing && safe) await fs.remove(source.root);
          console.log(
            JSON.stringify({
              mode: removing ? "remove-source" : "check",
              app: appName,
              source: source.root,
              bare,
              removed: removing && safe,
              ...checkJson(check),
              next: safe && !removing ? [removeCommand(source.root, appName)] : [],
            })
          );
          if (!safe) process.exit(1);
          return;
        }
        if (!safe) {
          cancel(
            args["remove-source"]
              ? `Not removed: ${source.root} has work the import doesn't`
              : `${source.root} has work the import doesn't; deleting it would lose it`
          );
          process.exit(1);
        }
        if (!args["remove-source"]) {
          const what = importNotes(check).length > 0 ? "Only what's listed above, which jade never copies, is" : "Nothing is";
          outro(
            `${what} left only in ${source.root}. Delete it with: ${removeCommand(source.root, appName)}`
          );
          return;
        }
        await fs.remove(source.root);
        outro(`Removed ${source.root}`);
        return;
      }

      if (source.problem) {
        cancel(`Can't import ${source.root}: ${source.problem}`);
        process.exit(1);
      }

      if (!isUsableName(appName)) {
        cancel(`'${appName}' isn't a usable app name (letters, digits, '.', '_' and '-'); pass --name`);
        process.exit(1);
      }
      const bareRepoPath = resolve(getBarePath(hub), appName);
      if (await fs.pathExists(bareRepoPath)) {
        cancel(`App '${appName}' already exists in .bare/`);
        process.exit(1);
      }

      const defaultBranch = (args.branch as string | undefined) ?? source.defaultBranch ?? source.branch;
      if (!defaultBranch) {
        cancel(`Could not tell the default branch; pass --branch <name>`);
        process.exit(1);
      }
      if (!(await git.sourceHasBranch(source.root, defaultBranch))) {
        cancel(`${source.root} has no branch '${defaultBranch}'; pass --branch <name>`);
        process.exit(1);
      }

      const plan = planImport(source, defaultBranch, args.group as string | undefined);
      if ("error" in plan) {
        cancel(`Can't place the current work: ${plan.error}`);
        process.exit(1);
      }
      if (plan.workspace && plan.newBranch && (await git.sourceHasBranch(source.root, plan.branch))) {
        cancel(`Branch '${plan.branch}' already exists in ${source.root}; pick another --group`);
        process.exit(1);
      }

      // A workspace whose name isn't its branch needs metadata saying so, or
      // status and doctor report the app as drifted (and doctor would move it).
      const workspacePath = plan.workspace ? getWorkspacePath(hub, plan.workspace) : null;
      const workspaceExisted = workspacePath ? await fs.pathExists(workspacePath) : false;
      const workspaceMeta = workspacePath && workspaceExisted ? await readWorkspaceMeta(workspacePath, fs) : null;
      if (plan.workspace && workspacePath) {
        if (await fs.pathExists(resolve(workspacePath, appName))) {
          cancel(`workspace/${plan.workspace}/${appName} already exists`);
          process.exit(1);
        }
        if (workspaceExisted && !workspaceMeta && plan.branch !== plan.workspace) {
          cancel(
            `workspace/${plan.workspace}/ expects its apps on branch '${plan.workspace}', not '${plan.branch}'; ` +
              `pass --group <another-name>`
          );
          process.exit(1);
        }
      }

      intro(`Importing ${appName} from ${source.root}`);
      const s = spinner();
      const mainPath = resolve(getWorkspacePath(hub, "main"), appName);
      const workspaceAppPath = workspacePath ? resolve(workspacePath, appName) : null;
      let carried: CarriedWork | null = null;

      try {
        s.start(`Copying branches and tags into .bare/${appName}`);
        await git.importBare(source.root, bareRepoPath, defaultBranch, source.remotes);

        s.message(`Creating main/${appName}`);
        await fs.mkdirp(getWorkspacePath(hub, "main"));
        await git.worktreeAdd(bareRepoPath, mainPath, defaultBranch);

        if (plan.workspace && workspacePath && workspaceAppPath) {
          s.message(`Creating workspace/${plan.workspace}/${appName}`);
          await fs.mkdirp(workspacePath);
          const actual = await git.worktreeAdd(
            bareRepoPath,
            workspaceAppPath,
            plan.branch,
            plan.newBranch ? { from: source.head } : undefined
          );
          if (actual !== plan.branch) {
            throw new Error(`expected branch '${plan.branch}' in workspace/${plan.workspace}/, got '${actual}'`);
          }
          if (source.dirty) {
            s.message(`Moving uncommitted work`);
            carried = await git.carryWork(source.root, bareRepoPath, workspaceAppPath);
          }
        }
        s.stop(`Imported ${appName}`);
      } catch (error) {
        s.stop(`Import failed; undoing`);
        if (workspaceAppPath) await fs.remove(workspaceAppPath);
        if (workspacePath && !workspaceExisted) await fs.remove(workspacePath);
        await fs.remove(mainPath);
        await git.removeBareRepo(bareRepoPath);
        cancel(`${error}\n  ${source.root} was not changed.`);
        process.exit(1);
      }

      await addAppToConfig(config, hub, appName, defaultBranch === "main" ? undefined : defaultBranch);

      if (plan.workspace && workspacePath) {
        // Only a workspace made by this import can get here with a mismatch: an
        // existing plain workspace was refused above.
        const recorded = await recordAppBranch(workspacePath, plan.workspace, appName, plan.branch, fs);
        if (recorded === "mismatch") {
          await writeWorkspaceMeta(workspacePath, { kind: "import", branches: { [appName]: plan.branch } }, fs);
        }
      }

      // .env is gitignored, so it isn't part of the carried work.
      if (await adoptEnv(hub, appName, source.root, fs)) {
        log.success(`Stored ${appName}'s .env in .env/${appName}/`);
      }
      for (const path of [mainPath, workspaceAppPath]) {
        if (path) await copyEnvToWorktree(hub, appName, path, fs);
      }

      log.success(`main/${appName} on '${defaultBranch}'`);
      if (plan.workspace) {
        log.success(
          `workspace/${plan.workspace}/${appName} on '${plan.branch}'` + (plan.newBranch ? ` (new, from HEAD)` : "")
        );
      }
      if (carried) {
        const parts = [
          carried.tracked ? "staged and unstaged changes" : null,
          carried.untracked.length > 0 ? `${carried.untracked.length} untracked file(s)` : null,
        ].filter(Boolean);
        if (parts.length > 0) log.success(`Moved ${parts.join(" and ")}`);
      }
      if (!originOf(source)) {
        log.info(`No origin remote: ${appName} is local only. Run 'jade publish ${appName}' when ready.`);
      }
      if (source.hasSubmodules) {
        log.warn(`Submodules aren't set up; run 'git submodule update --init' in each worktree`);
      }

      // Same comparison as --check, so the source's leftovers are listed now.
      const check = await git.checkImport(source.root, bareRepoPath);
      const safe = reportCheck(check);
      if (asJson) {
        const workspaceJson =
          plan.workspace && workspaceAppPath
            ? { name: plan.workspace, path: workspaceAppPath, branch: plan.branch, newBranch: plan.newBranch }
            : null;
        console.log(
          JSON.stringify({
            mode: "import",
            app: appName,
            source: source.root,
            bare: bareRepoPath,
            main: { path: mainPath, branch: defaultBranch },
            workspace: workspaceJson,
            // The pre-0.4 name for `workspace`, kept so older readers keep working.
            group: workspaceJson,
            carried: carried && { tracked: carried.tracked, untracked: carried.untracked },
            remotes: source.remotes.map((r) => r.name),
            published: originOf(source) !== null,
            submodules: source.hasSubmodules,
            ...checkJson(check),
            next: [
              ...(workspaceAppPath ? [`cd ${workspaceAppPath}`] : []),
              ...(originOf(source) ? [] : [`jade publish ${appName}`]),
              ...(source.hasSubmodules ? ["git submodule update --init"] : []),
              ...(safe ? [removeCommand(source.root, appName)] : []),
            ],
          })
        );
        return;
      }
      const next = plan.workspace ? `\nNext: cd workspace/${plan.workspace}/${appName}` : "";
      outro(
        safe
          ? `${source.root} is unchanged. Once the import builds, delete it with: ${removeCommand(source.root, appName)}${next}`
          : `${source.root} is unchanged, and has work the import doesn't (listed above): keep it until that's dealt with.${next}`
      );
    },
  });
}

export default makeImportCommand();
