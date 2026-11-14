import { defineCommand } from "citty";
import { resolve } from "path";
import { intro, outro, cancel, log, setJsonMode } from "../adapters/ui.ts";
import { findWorkspaceRoot, getBarePath, getCurrentGroup, listWorktreeDirs } from "../core/layout.ts";
import { resolveGroup, type ResolvedGroup } from "../core/group.ts";
import { type GitBackend, realGitBackend } from "../adapters/git-backend.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";
import { type ConfigBackend, realConfigBackend } from "../core/config-backend.ts";
import { readGroupMeta } from "../core/group-meta.ts";
import { copyEnvToWorktree } from "../core/env.ts";
import { buildAttention, collectApps, type AppReport, type Attention } from "../core/health.ts";
import type { JadeConfig } from "../core/config.ts";

type FixOutcome =
  | { status: "fixed"; detail: string }
  | { status: "would-fix"; detail: string }
  | { status: "skipped"; detail: string };

export interface DoctorEntry {
  group: string;
  app: string;
  kind: Attention["kind"];
  message: string;
  outcome: FixOutcome;
}

interface FixContext {
  workspaceRoot: string;
  group: ResolvedGroup;
  git: GitBackend;
  fs: FileSystemBackend;
  dryRun: boolean;
  addMissing: boolean;
}

/**
 * Put a drifted or detached app back on the branch its group expects.
 *
 * Refuses when the worktree is dirty (checkout could carry or clash with the
 * changes) and when the target branch is checked out in another worktree —
 * which is usually *why* the app drifted, and git would refuse anyway.
 */
async function fixBranch(ctx: FixContext, app: AppReport): Promise<FixOutcome> {
  const target = app.expectedBranch;
  if (!target) return { status: "skipped", detail: "no expected branch for this group" };

  if (app.tree && !app.tree.clean) {
    return {
      status: "skipped",
      detail: `uncommitted changes; commit or stash, then: jade checkout ${target} --app ${app.name}`,
    };
  }

  const bareRepoPath = resolve(getBarePath(ctx.workspaceRoot), app.name);
  const holder = (await ctx.git.worktreeList(bareRepoPath)).find(
    (wt) => wt.branch === target && resolve(wt.path) !== resolve(app.path)
  );
  if (holder) {
    return { status: "skipped", detail: `'${target}' is checked out at ${holder.path}; free it there first` };
  }

  if (ctx.dryRun) return { status: "would-fix", detail: `checkout ${target}` };
  try {
    await ctx.git.checkout(app.path, target);
    return { status: "fixed", detail: `checked out ${target}` };
  } catch (error) {
    return { status: "skipped", detail: `checkout ${target} failed: ${error}` };
  }
}

async function fixMissingWorktree(ctx: FixContext, app: AppReport): Promise<FixOutcome> {
  const branch = app.expectedBranch ?? ctx.group.name;
  if (!ctx.addMissing) {
    return { status: "skipped", detail: `pass --add-missing, or: jade workspace add ${ctx.group.name} --apps ${app.name}` };
  }
  if (ctx.dryRun) return { status: "would-fix", detail: `add worktree on ${branch}` };
  try {
    const actual = await ctx.git.worktreeAdd(resolve(getBarePath(ctx.workspaceRoot), app.name), app.path, branch);
    await copyEnvToWorktree(ctx.workspaceRoot, app.name, app.path, ctx.fs);
    return {
      status: "fixed",
      detail: actual && actual !== branch ? `added worktree on ${actual} (${branch} was taken)` : `added worktree on ${branch}`,
    };
  } catch (error) {
    return { status: "skipped", detail: `could not add worktree: ${error}` };
  }
}

async function fixMissingEnv(ctx: FixContext, app: AppReport): Promise<FixOutcome> {
  if (ctx.dryRun) return { status: "would-fix", detail: "copy .env" };
  const copied = await copyEnvToWorktree(ctx.workspaceRoot, app.name, app.path, ctx.fs);
  return copied ? { status: "fixed", detail: "copied .env" } : { status: "skipped", detail: "could not copy .env" };
}

/**
 * Diagnose one group and apply the safe fixes. Each attention kind maps to a
 * direct function call — the `fix` strings `jade status --json` prints are
 * for humans, not something to shell out.
 */
export async function doctorGroup(
  workspaceRoot: string,
  groupName: string,
  git: GitBackend,
  fs: FileSystemBackend,
  config: JadeConfig,
  opts: { dryRun: boolean; addMissing: boolean }
): Promise<DoctorEntry[]> {
  const group = await resolveGroup(workspaceRoot, groupName, fs);
  const meta = await readGroupMeta(group.path, fs);
  const apps = await collectApps(workspaceRoot, group, git, fs, config, meta, true);
  const attention = buildAttention(group, apps);
  const ctx: FixContext = { workspaceRoot, group, git, fs, ...opts };

  const entries: DoctorEntry[] = [];
  for (const item of attention) {
    // Not publishing yet is a choice, not a fault doctor should keep failing on.
    if (item.kind === "unpublished") continue;
    const app = apps.find((a) => a.name === item.app)!;
    let outcome: FixOutcome;
    switch (item.kind) {
      case "branch-drift":
      case "detached-head":
        outcome = await fixBranch(ctx, app);
        break;
      case "missing-worktree":
        outcome = await fixMissingWorktree(ctx, app);
        break;
      case "missing-env":
        outcome = await fixMissingEnv(ctx, app);
        break;
      case "git-error":
        outcome = { status: "skipped", detail: "inspect the worktree by hand" };
        break;
    }
    entries.push({ group: groupName, app: item.app, kind: item.kind, message: item.message, outcome });
  }
  return entries;
}

const ICON: Record<FixOutcome["status"], string> = { fixed: "✔", "would-fix": "→", skipped: "✖" };

export function makeDoctorCommand(
  git: GitBackend = realGitBackend,
  fs: FileSystemBackend = realFileSystemBackend,
  config: ConfigBackend = realConfigBackend
) {
  return defineCommand({
    meta: {
      name: "doctor",
      description:
        "Find and fix workspace problems: branch drift, detached HEADs, missing .env files and (with --add-missing) missing worktrees",
    },
    args: {
      name: {
        type: "positional",
        description: "Group to check (defaults to the current group; every group when run outside one)",
        required: false,
      },
      dryRun: {
        type: "boolean",
        description: "Show what would be fixed without changing anything",
        default: false,
      },
      addMissing: {
        type: "boolean",
        description: "Also create worktrees for apps missing from a group",
        default: false,
      },
      json: {
        type: "boolean",
        description: "Print machine-readable JSON instead of plain text",
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

      const allGroups = await listWorktreeDirs(workspaceRoot, fs);
      const explicit = args.name as string | undefined;
      const current = getCurrentGroup(workspaceRoot, process.cwd());
      const targets = explicit ? [explicit] : current ? [current] : allGroups;

      for (const name of targets) {
        if (!allGroups.includes(name)) {
          cancel(`Worktree group '${name}' not found. See 'jade workspace list'.`);
          process.exit(1);
        }
      }

      const asJson = args.json as boolean;
      const opts = { dryRun: args.dryRun as boolean, addMissing: args.addMissing as boolean };
      const jadeConfig = await config.readConfig(workspaceRoot);

      setJsonMode(asJson);
      if (!asJson) intro(opts.dryRun ? `jade doctor (dry run)` : `jade doctor`);

      const entries: DoctorEntry[] = [];
      for (const name of targets) {
        entries.push(...(await doctorGroup(workspaceRoot, name, git, fs, jadeConfig, opts)));
      }

      const unresolved = entries.filter((e) => e.outcome.status === "skipped");

      if (asJson) {
        console.log(JSON.stringify({ root: workspaceRoot, groups: targets, dryRun: opts.dryRun, entries }));
      } else if (entries.length === 0) {
        log.success(`No problems in ${targets.length === 1 ? `'${targets[0]}'` : `${targets.length} groups`}`);
      } else {
        for (const name of targets) {
          const forGroup = entries.filter((e) => e.group === name);
          if (forGroup.length === 0) continue;
          log.message(
            `${name}\n` +
              forGroup
                .map((e) => `  ${ICON[e.outcome.status]} ${e.app}: ${e.message}\n      ${e.outcome.detail}`)
                .join("\n")
          );
        }
      }

      if (!asJson) {
        const fixed = entries.filter((e) => e.outcome.status === "fixed").length;
        const would = entries.filter((e) => e.outcome.status === "would-fix").length;
        const parts = [
          fixed ? `${fixed} fixed` : "",
          would ? `${would} would be fixed` : "",
          unresolved.length ? `${unresolved.length} need attention` : "",
        ].filter(Boolean);
        outro(parts.length > 0 ? parts.join(", ") : `All clear`);
      }

      // Non-zero while anything is still wrong, including what a dry run
      // would fix, so `jade doctor --dry-run` works as a check.
      const pending = entries.filter((e) => e.outcome.status !== "fixed").length;
      if (pending > 0) process.exit(1);
    },
  });
}

export default makeDoctorCommand();
