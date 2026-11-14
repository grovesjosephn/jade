import { defineCommand } from "citty";
import { basename, relative, resolve } from "path";
import { intro, outro, cancel, log, spinner } from "@clack/prompts";
import { findWorkspaceRoot, getBarePath, getWorktreeGroupPath, isUsableName } from "../core/layout.ts";
import { addAppToConfig } from "../core/config.ts";
import { adoptEnv, copyEnvToWorktree } from "../core/env.ts";
import { readGroupMeta, recordAppBranch, writeGroupMeta } from "../core/group-meta.ts";
import { type GitBackend, realGitBackend } from "../adapters/git-backend.ts";
import type { CarriedWork, ImportSource } from "../adapters/git-import.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";
import { type ConfigBackend, realConfigBackend } from "../core/config-backend.ts";

/** Where the source's checked-out work goes: a feature group, or nowhere */
export type ImportPlan =
  | { group: null }
  | {
      group: string;
      branch: string;
      /** The branch doesn't exist yet: create it at the source's HEAD */
      newBranch: boolean;
    }
  | { error: string };

/**
 * Turn a branch name into a group directory name: `feature/login` would
 * otherwise nest as workspace/feature/login/.
 */
export function toGroupName(branch: string): string {
  return branch.replace(/\//g, "-");
}

/**
 * Decide which group gets the source's current branch and uncommitted work.
 * The work never goes into main/: that group stays on the default branch.
 *
 * - On a feature branch: a group named after it (or --group), on that branch.
 * - On the default branch or a detached HEAD: only with --group, as a new
 *   branch of that name at HEAD. Required for a detached HEAD, and when
 *   there's uncommitted work.
 */
export function planImport(
  source: Pick<ImportSource, "branch" | "dirty">,
  defaultBranch: string,
  groupArg: string | undefined
): ImportPlan {
  const onFeature = source.branch !== null && source.branch !== defaultBranch;
  if (groupArg !== undefined) {
    if (groupArg === "main") return { error: "--group can't be main; uncommitted work goes to a feature group" };
    if (!isUsableName(groupArg)) return { error: `'${groupArg}' isn't a usable group name` };
    return onFeature
      ? { group: groupArg, branch: source.branch!, newBranch: false }
      : { group: groupArg, branch: groupArg, newBranch: true };
  }
  if (onFeature) {
    const group = toGroupName(source.branch!);
    if (!isUsableName(group)) {
      return { error: `branch '${source.branch}' can't be a group name; pass --group <name>` };
    }
    return { group, branch: source.branch!, newBranch: false };
  }
  // A detached HEAD may hold commits no branch has; without a group for them
  // they'd be lost once the source is deleted.
  if (source.branch === null) {
    return { error: "HEAD is detached; pass --group <name> to keep it on a new branch" };
  }
  if (source.dirty) {
    return {
      error: `the uncommitted work is on the default branch '${defaultBranch}'; pass --group <name> to put it on a new branch`,
    };
  }
  return { group: null };
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
        "Import an existing local clone as an app: bare repo, main/ worktree, and its current branch and uncommitted work in a workspace group",
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
        description: "Group for the current branch and uncommitted work (default: named after the branch)",
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

      const sourcePath = resolve(args.path as string);
      const source = await git.inspectImportSource(sourcePath);
      if (!source) {
        cancel(`${sourcePath} isn't inside a git working copy`);
        process.exit(1);
      }
      const rel = relative(workspaceRoot, source.root);
      if (rel === "" || !rel.startsWith("..")) {
        cancel(`${source.root} is already inside this jade workspace`);
        process.exit(1);
      }
      if (!relative(source.root, workspaceRoot).startsWith("..")) {
        cancel(`This jade workspace is inside ${source.root}; move one of them first`);
        process.exit(1);
      }
      if (source.problem) {
        cancel(`Can't import ${source.root}: ${source.problem}`);
        process.exit(1);
      }

      const appName = (args.name as string | undefined) ?? basename(source.root);
      if (!isUsableName(appName)) {
        cancel(`'${appName}' isn't a usable app name (letters, digits, '.', '_' and '-'); pass --name`);
        process.exit(1);
      }
      const bareRepoPath = resolve(getBarePath(workspaceRoot), appName);
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
      if (plan.group && plan.newBranch && (await git.sourceHasBranch(source.root, plan.branch))) {
        cancel(`Branch '${plan.branch}' already exists in ${source.root}; pick another --group`);
        process.exit(1);
      }

      // A group whose name isn't its branch needs metadata saying so, or
      // status and doctor report the app as drifted (and doctor would move it).
      const groupPath = plan.group ? getWorktreeGroupPath(workspaceRoot, plan.group) : null;
      const groupExisted = groupPath ? await fs.pathExists(groupPath) : false;
      const groupMeta = groupPath && groupExisted ? await readGroupMeta(groupPath, fs) : null;
      if (plan.group && groupPath) {
        if (await fs.pathExists(resolve(groupPath, appName))) {
          cancel(`workspace/${plan.group}/${appName} already exists`);
          process.exit(1);
        }
        if (groupExisted && !groupMeta && plan.branch !== plan.group) {
          cancel(
            `workspace/${plan.group}/ expects its apps on branch '${plan.group}', not '${plan.branch}'; ` +
              `pass --group <another-name>`
          );
          process.exit(1);
        }
      }

      intro(`Importing ${appName} from ${source.root}`);
      const s = spinner();
      const mainPath = resolve(getWorktreeGroupPath(workspaceRoot, "main"), appName);
      const groupAppPath = groupPath ? resolve(groupPath, appName) : null;
      let carried: CarriedWork | null = null;

      try {
        s.start(`Copying branches and tags into .bare/${appName}`);
        await git.importBare(source.root, bareRepoPath, defaultBranch, source.originUrl);

        s.message(`Creating main/${appName}`);
        await fs.mkdirp(getWorktreeGroupPath(workspaceRoot, "main"));
        await git.worktreeAdd(bareRepoPath, mainPath, defaultBranch);

        if (plan.group && groupPath && groupAppPath) {
          s.message(`Creating workspace/${plan.group}/${appName}`);
          await fs.mkdirp(groupPath);
          const actual = await git.worktreeAdd(
            bareRepoPath,
            groupAppPath,
            plan.branch,
            plan.newBranch ? { from: source.head } : undefined
          );
          if (actual !== plan.branch) {
            throw new Error(`expected branch '${plan.branch}' in workspace/${plan.group}/, got '${actual}'`);
          }
          if (source.dirty) {
            s.message(`Moving uncommitted work`);
            carried = await git.carryWork(source.root, bareRepoPath, groupAppPath);
          }
        }
        s.stop(`Imported ${appName}`);
      } catch (error) {
        s.stop(`Import failed; undoing`);
        if (groupAppPath) await fs.remove(groupAppPath);
        if (groupPath && !groupExisted) await fs.remove(groupPath);
        await fs.remove(mainPath);
        await git.removeBareRepo(bareRepoPath);
        cancel(`${error}\n  ${source.root} was not changed.`);
        process.exit(1);
      }

      await addAppToConfig(config, workspaceRoot, appName, defaultBranch === "main" ? undefined : defaultBranch);

      if (plan.group && groupPath) {
        // Only a group made by this import can get here with a mismatch: an
        // existing plain group was refused above.
        const recorded = await recordAppBranch(groupPath, plan.group, appName, plan.branch, fs);
        if (recorded === "mismatch") {
          await writeGroupMeta(groupPath, { kind: "import", branches: { [appName]: plan.branch } }, fs);
        }
      }

      // .env is gitignored, so it isn't part of the carried work.
      if (await adoptEnv(workspaceRoot, appName, source.root, fs)) {
        log.success(`Stored ${appName}'s .env in .env/${appName}/`);
      }
      for (const path of [mainPath, groupAppPath]) {
        if (path) await copyEnvToWorktree(workspaceRoot, appName, path, fs);
      }

      log.success(`main/${appName} on '${defaultBranch}'`);
      if (plan.group) {
        log.success(
          `workspace/${plan.group}/${appName} on '${plan.branch}'` + (plan.newBranch ? ` (new, from HEAD)` : "")
        );
      }
      if (carried) {
        const parts = [
          carried.tracked ? "staged and unstaged changes" : null,
          carried.untracked.length > 0 ? `${carried.untracked.length} untracked file(s)` : null,
        ].filter(Boolean);
        if (parts.length > 0) log.success(`Moved ${parts.join(" and ")}`);
        if (carried.skipped.length > 0) {
          log.warn(`Not copied (nested repositories): ${carried.skipped.join(", ")}`);
        }
      }
      if (!source.originUrl) {
        log.info(`No origin remote: ${appName} is local only. Run 'jade publish ${appName}' when ready.`);
      }
      if (source.hasSubmodules) {
        log.warn(`Submodules aren't set up; run 'git submodule update --init' in each worktree`);
      }
      if (source.stashCount > 0) {
        log.warn(`${source.stashCount} stash entr${source.stashCount === 1 ? "y" : "ies"} in the source weren't copied`);
      }
      if (source.linkedWorktrees.length > 0) {
        log.warn(
          `The source has other worktrees, whose uncommitted work wasn't copied: ${source.linkedWorktrees.join(", ")}`
        );
      }
      log.info(`Not copied: ignored files (node_modules, build output), hooks and per-repo git config.`);

      outro(
        `${source.root} is unchanged. Once you've checked the import, you can delete it.` +
          (plan.group ? ` Next: cd workspace/${plan.group}/${appName}` : "")
      );
    },
  });
}

export default makeImportCommand();
