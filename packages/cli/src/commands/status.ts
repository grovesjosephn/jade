import { defineCommand } from "citty";
import { resolve } from "path";
import { findWorkspaceRoot, getCurrentGroup, listWorktreeDirs } from "../core/layout.ts";
import { resolveGroup, type ResolvedGroup } from "../core/group.ts";
import { readGroupMeta } from "../core/group-meta.ts";
import { type GitBackend, realGitBackend } from "../adapters/git-backend.ts";
import { buildAttention, collectApps, type AppReport, type Attention } from "../core/health.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";
import { type ConfigBackend, realConfigBackend } from "../core/config-backend.ts";
import { defaultRunHerdrTui, findWorkspaceByLabel, type HerdrTuiRunner } from "../adapters/herdr-tui.ts";
import pkg from "../../package.json" with { type: "json" };

export type StatusTarget = { view: "root" } | { view: "workspace"; name: string };

/**
 * Decide whether `jade status` reports the whole root or a single workspace.
 *
 * Kept pure and exported so the contextual rules are testable without chdir'ing
 * the test process. An explicit name always wins — including over --root — so
 * `jade status <name>` means the same thing wherever you run it.
 */
export function resolveStatusTarget(opts: {
  workspaceRoot: string;
  explicitName?: string;
  forceRoot: boolean;
  cwd: string;
}): StatusTarget {
  if (opts.explicitName) return { view: "workspace", name: opts.explicitName };
  if (opts.forceRoot) return { view: "root" };

  const current = getCurrentGroup(opts.workspaceRoot, opts.cwd);
  if (current) return { view: "workspace", name: current };

  return { view: "root" };
}

interface HerdrTuiReport {
  open: boolean;
  focused: boolean;
  workspaceId: string | null;
}

/**
 * Raised for an unknown workspace name so the single catch below can render a
 * helpful message instead of a bare stringified error.
 */
class WorkspaceNotFoundError extends Error {
  constructor(readonly workspaceName: string, readonly available: string[]) {
    super(`workspace '${workspaceName}' not found`);
  }
}

function printStatus(workspaceRoot: string, orgUrl: string | undefined, groups: string[]): void {
  const lines: string[] = [
    `version: ${pkg.version}`,
    `root: ${workspaceRoot}`,
  ];
  if (orgUrl) {
    lines.push(`org: ${orgUrl}`);
  }
  lines.push("workspaces:");
  if (groups.length === 0) {
    lines.push("  (none)");
  } else {
    for (const name of groups) {
      lines.push(`  - ${name}`);
    }
  }
  console.log(lines.join("\n"));
}

function printStatusJson(workspaceRoot: string, orgUrl: string | undefined, groups: string[]): void {
  console.log(
    JSON.stringify({ view: "root", version: pkg.version, root: workspaceRoot, orgUrl, groups })
  );
}

/**
 * The workspace name plus the apps actually checked out here, one per line with
 * their branch. Deliberately terse — everything else (working-tree state, env
 * gaps, missing apps, herdr-tui, the actionable `attention` list) stays available
 * via --json rather than crowding the interactive view.
 */
function printWorkspaceStatus(group: ResolvedGroup, apps: AppReport[]): void {
  const lines: string[] = [`workspace: ${group.name}`];
  const installed = apps.filter((app) => app.present);

  if (installed.length === 0) {
    lines.push("  (none)");
  } else {
    const rows = installed.map((app) => ({
      name: app.name,
      branch: app.error ? "(error)" : (app.branch ?? "?"),
      // Only branch-level facts earn a marker here; the branch is the one thing
      // this view reports, so drift and detachment are what can contradict it.
      marker: app.detached ? "[detached]" : app.drift ? "[drift]" : "",
    }));

    const nameWidth = Math.max(...rows.map((r) => r.name.length));
    const branchWidth = Math.max(...rows.map((r) => r.branch.length));

    for (const row of rows) {
      const cells = `  ${row.name.padEnd(nameWidth)}  ${
        row.marker ? row.branch.padEnd(branchWidth) : row.branch
      }`;
      lines.push(row.marker ? `${cells}  ${row.marker}` : cells);
    }
  }

  console.log(lines.join("\n"));
}

function printWorkspaceStatusJson(
  workspaceRoot: string,
  orgUrl: string | undefined,
  group: ResolvedGroup,
  apps: AppReport[],
  herdr: HerdrTuiReport | null,
  attention: Attention[]
): void {
  console.log(
    JSON.stringify({
      view: "workspace",
      version: pkg.version,
      root: workspaceRoot,
      orgUrl,
      workspace: group.name,
      path: group.path,
      isMain: group.isMain,
      ...(herdr ? { herdr } : {}),
      apps,
      attention,
    })
  );
}

/**
 * Query herdr-tui for whether this group is open in the current session. Best
 * effort by design: status must never fail because herdr-tui is unreachable.
 */
async function collectHerdrTui(
  groupName: string,
  runHerdrTui: HerdrTuiRunner
): Promise<HerdrTuiReport | null> {
  if (process.env.HERDR_ENV !== "1") return null;

  try {
    const found = findWorkspaceByLabel(await runHerdrTui(["workspace", "list"]), groupName);
    if (!found) return { open: false, focused: false, workspaceId: null };
    return { open: true, focused: found.focused, workspaceId: found.workspaceId };
  } catch {
    return null;
  }
}

export function makeStatusCommand(
  git: GitBackend = realGitBackend,
  runHerdrTui: HerdrTuiRunner = defaultRunHerdrTui,
  fs: FileSystemBackend = realFileSystemBackend,
  config: ConfigBackend = realConfigBackend
) {
  return defineCommand({
    meta: {
      name: "status",
      description:
        "Show workspace status. Inside a workspace, reports that workspace's apps, branches and gaps; at the workspace root, lists jade version, root, org URL and workspaces",
    },
    args: {
      name: {
        type: "positional",
        description: "Workspace to report on (defaults to the current workspace, if any)",
        required: false,
      },
      workspace: {
        type: "string",
        alias: "w",
        description: "Workspace root path",
      },
      root: {
        type: "boolean",
        description: "Force the root summary even when run from inside a workspace",
        default: false,
      },
      json: {
        type: "boolean",
        description: "Print machine-readable JSON instead of plain text",
        default: false,
      },
    },
    async run({ args }) {
      const workspaceRoot = args.workspace
        ? resolve(args.workspace as string)
        : await findWorkspaceRoot(process.cwd(), fs);

      if (!workspaceRoot) {
        console.error("jade status: not in a jade workspace (no .bare/). Run `jade init` first.");
        process.exit(1);
      }

      try {
        const jadeConfig = await config.readConfig(workspaceRoot);
        const target = resolveStatusTarget({
          workspaceRoot,
          explicitName: args.name as string | undefined,
          forceRoot: args.root as boolean,
          cwd: process.cwd(),
        });

        if (target.view === "root") {
          const groups = await listWorktreeDirs(workspaceRoot, fs);
          if (args.json) {
            printStatusJson(workspaceRoot, jadeConfig.orgUrl, groups);
          } else {
            printStatus(workspaceRoot, jadeConfig.orgUrl, groups);
          }
          return;
        }

        const group = await resolveGroup(workspaceRoot, target.name, fs);

        if (!group.exists) {
          throw new WorkspaceNotFoundError(target.name, await listWorktreeDirs(workspaceRoot, fs));
        }

        const asJson = args.json as boolean;
        const meta = await readGroupMeta(group.path, fs);
        const apps = await collectApps(workspaceRoot, group, git, fs, jadeConfig, meta, asJson);

        if (!asJson) {
          printWorkspaceStatus(group, apps);
          return;
        }

        // Only the JSON view carries the full picture, so only it pays for the
        // extra gathering — including the herdr-tui subprocess.
        const herdr = await collectHerdrTui(group.name, runHerdrTui);
        printWorkspaceStatusJson(
          workspaceRoot,
          jadeConfig.orgUrl,
          group,
          apps,
          herdr,
          buildAttention(group, apps)
        );
      } catch (error) {
        if (error instanceof WorkspaceNotFoundError) {
          console.error(
            `jade status: workspace '${error.workspaceName}' not found.\n` +
              (error.available.length > 0
                ? `  Available: ${error.available.join(", ")}`
                : `  No workspaces yet. Create one with 'jade workspace add <name>'.`)
          );
        } else {
          console.error(`jade status: ${error}`);
        }
        process.exit(1);
      }
    },
  });
}

export default makeStatusCommand();
