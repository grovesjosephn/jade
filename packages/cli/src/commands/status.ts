import { defineCommand } from "citty";
import { getCurrentWorkspace, listWorktreeDirs } from "../core/layout.ts";
import { resolveWorkspace, type ResolvedWorkspace } from "../core/workspace.ts";
import { readWorkspaceMeta } from "../core/workspace-meta.ts";
import { type GitBackend, realGitBackend } from "../adapters/git-backend.ts";
import { buildAttention, collectApps, type AppReport, type Attention } from "../core/health.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";
import { type ConfigBackend, realConfigBackend } from "../core/config-backend.ts";
import { defaultRunHerdrTui, findTuiWorkspaceByLabel, type HerdrTuiRunner } from "../adapters/herdr-tui.ts";
import pkg from "../../package.json" with { type: "json" };
import { hubArgs, resolveHub } from "../core/hub.ts";

export type StatusTarget = { view: "hub" } | { view: "workspace"; name: string };

/**
 * Decide whether `jade status` reports the whole hub or a single workspace.
 *
 * Kept pure and exported so the contextual rules are testable without chdir'ing
 * the test process. An explicit name always wins — including over --summary — so
 * `jade status <name>` means the same thing wherever you run it.
 */
export function resolveStatusTarget(opts: {
  hub: string;
  explicitName?: string;
  summary: boolean;
  cwd: string;
}): StatusTarget {
  if (opts.explicitName) return { view: "workspace", name: opts.explicitName };
  if (opts.summary) return { view: "hub" };

  const current = getCurrentWorkspace(opts.hub, opts.cwd);
  if (current) return { view: "workspace", name: current };

  return { view: "hub" };
}

/** The deprecated --root flag: still means --summary, with a warning on stderr. */
function rootFlag(value: unknown): boolean {
  if (!value) return false;
  process.stderr.write("warn --root is deprecated and will be removed; use --summary\n");
  return true;
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

function printStatus(hub: string, orgUrl: string | undefined, workspaces: string[]): void {
  const lines: string[] = [
    `version: ${pkg.version}`,
    `hub: ${hub}`,
  ];
  if (orgUrl) {
    lines.push(`org: ${orgUrl}`);
  }
  lines.push("workspaces:");
  if (workspaces.length === 0) {
    lines.push("  (none)");
  } else {
    for (const name of workspaces) {
      lines.push(`  - ${name}`);
    }
  }
  console.log(lines.join("\n"));
}

function printStatusJson(hub: string, orgUrl: string | undefined, workspaces: string[]): void {
  console.log(
    // `root` and `groups` are the pre-0.4 names, kept so older readers keep working.
    JSON.stringify({ view: "hub", version: pkg.version, hub, root: hub, orgUrl, workspaces, groups: workspaces })
  );
}

/**
 * The workspace name plus the apps actually checked out here, one per line with
 * their branch. Deliberately terse — everything else (working-tree state, env
 * gaps, missing apps, herdr-tui, the actionable `attention` list) stays available
 * via --json rather than crowding the interactive view.
 */
function printWorkspaceStatus(workspace: ResolvedWorkspace, apps: AppReport[]): void {
  const lines: string[] = [`workspace: ${workspace.name}`];
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
  hub: string,
  orgUrl: string | undefined,
  workspace: ResolvedWorkspace,
  apps: AppReport[],
  herdr: HerdrTuiReport | null,
  attention: Attention[]
): void {
  console.log(
    JSON.stringify({
      view: "workspace",
      version: pkg.version,
      hub,
      root: hub,
      orgUrl,
      workspace: workspace.name,
      path: workspace.path,
      isMain: workspace.isMain,
      ...(herdr ? { herdr } : {}),
      apps,
      attention,
    })
  );
}

/**
 * Query herdr-tui for whether this workspace is open in the current session. Best
 * effort by design: status must never fail because herdr-tui is unreachable.
 */
async function collectHerdrTui(
  workspaceName: string,
  runHerdrTui: HerdrTuiRunner
): Promise<HerdrTuiReport | null> {
  if (process.env.HERDR_ENV !== "1") return null;

  try {
    const found = findTuiWorkspaceByLabel(await runHerdrTui(["workspace", "list"]), workspaceName);
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
        "Show status. Inside a workspace, reports that workspace's apps, branches and gaps; elsewhere in the hub, lists jade version, the hub, org URL and workspaces",
    },
    args: {
      name: {
        type: "positional",
        description: "Workspace to report on (defaults to the current workspace, if any)",
        required: false,
      },
      ...hubArgs,
      summary: {
        type: "boolean",
        description: "Show the hub summary even when run from inside a workspace",
        default: false,
      },
      root: {
        type: "boolean",
        description: "Deprecated: use --summary",
        default: false,
      },
      json: {
        type: "boolean",
        description: "Print machine-readable JSON instead of plain text",
        default: false,
      },
    },
    async run({ args }) {
      const hub = await resolveHub(args, fs);

      if (!hub) {
        console.error("jade status: not in a jade hub (no .bare/). Run `jade init` first.");
        process.exit(1);
      }

      try {
        const jadeConfig = await config.readConfig(hub);
        const target = resolveStatusTarget({
          hub,
          explicitName: args.name as string | undefined,
          summary: Boolean(args.summary) || rootFlag(args.root),
          cwd: process.cwd(),
        });

        if (target.view === "hub") {
          const workspaces = await listWorktreeDirs(hub, fs);
          if (args.json) {
            printStatusJson(hub, jadeConfig.orgUrl, workspaces);
          } else {
            printStatus(hub, jadeConfig.orgUrl, workspaces);
          }
          return;
        }

        const workspace = await resolveWorkspace(hub, target.name, fs);

        if (!workspace.exists) {
          throw new WorkspaceNotFoundError(target.name, await listWorktreeDirs(hub, fs));
        }

        const asJson = args.json as boolean;
        const meta = await readWorkspaceMeta(workspace.path, fs);
        const apps = await collectApps(hub, workspace, git, fs, jadeConfig, meta, asJson);

        if (!asJson) {
          printWorkspaceStatus(workspace, apps);
          return;
        }

        // Only the JSON view carries the full picture, so only it pays for the
        // extra gathering — including the herdr-tui subprocess.
        const herdr = await collectHerdrTui(workspace.name, runHerdrTui);
        printWorkspaceStatusJson(
          hub,
          jadeConfig.orgUrl,
          workspace,
          apps,
          herdr,
          buildAttention(workspace, apps)
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
