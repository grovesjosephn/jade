import { resolve } from "path";
import type { ResolvedGroup } from "./group.ts";
import { getAppEnvSourcePath } from "./env.ts";
import type { GitBackend, WorktreeStatus } from "../adapters/git-backend.ts";
import type { FileSystemBackend } from "../adapters/fs-backend.ts";
import { getAppDefaultBranch, type JadeConfig } from "./config.ts";
import { getBarePath } from "./layout.ts";
import { expectedBranch, type GroupMeta } from "./group-meta.ts";

/**
 * Per-app health checks for one worktree group, shared by `jade status`
 * (which reports them) and `jade doctor` (which acts on them).
 */

type AttentionKind =
  | "branch-drift"
  | "detached-head"
  | "missing-worktree"
  | "missing-env"
  | "git-error"
  | "unpublished";

export interface Attention {
  app: string;
  kind: AttentionKind;
  message: string;
  fix?: string;
}

export interface AppReport {
  name: string;
  present: boolean;
  path: string;
  branch: string | null;
  /** The branch this group expects the app on; null when the app isn't expected here */
  expectedBranch: string | null;
  drift: boolean;
  detached: boolean;
  tree: (WorktreeStatus & { clean: boolean }) | null;
  env: { present: boolean; sourceAvailable: boolean } | null;
  /** Whether the app has an origin remote; null when not checked (terse view, or not present) */
  published: boolean | null;
  error: string | null;
}

/**
 * The branch an app should be on in a group. `main` tracks each app's default
 * branch (which isn't necessarily called "main"); other groups follow their
 * metadata, else the group name.
 */
async function resolveExpectedBranch(
  workspaceRoot: string,
  group: ResolvedGroup,
  appName: string,
  git: GitBackend,
  config: JadeConfig,
  meta: GroupMeta | null
): Promise<string | null> {
  if (group.isMain) {
    const configured = getAppDefaultBranch(config, appName);
    if (configured) return configured;
    try {
      return await git.getDefaultBranch(resolve(getBarePath(workspaceRoot), appName));
    } catch {
      return "main";
    }
  }
  return expectedBranch(group.name, appName, meta);
}

/**
 * Gather per-app state for one workspace. Runs the apps concurrently: this is
 * the only view that makes git calls, so per-app latency is what the user feels.
 *
 * `detailed` gates the work the terse text view never renders — a status call
 * and two stats per app — so the interactive path costs one git call per app.
 */
export async function collectApps(
  workspaceRoot: string,
  group: ResolvedGroup,
  git: GitBackend,
  fs: FileSystemBackend,
  config: JadeConfig,
  meta: GroupMeta | null,
  detailed: boolean
): Promise<AppReport[]> {
  return await Promise.all(
    group.apps.map(async (app): Promise<AppReport> => {
      const expected = await resolveExpectedBranch(workspaceRoot, group, app.name, git, config, meta);

      if (!app.present) {
        return {
          name: app.name,
          present: false,
          path: app.path,
          branch: null,
          expectedBranch: expected,
          drift: false,
          detached: false,
          tree: null,
          env: null,
          published: null,
          error: null,
        };
      }

      const env = detailed
        ? {
            present: await fs.pathExists(resolve(app.path, ".env")),
            sourceAvailable: await fs.pathExists(getAppEnvSourcePath(workspaceRoot, app.name)),
          }
        : null;
      // A config read, not a network call; still gated, to keep the terse view at one git call per app.
      const published = detailed
        ? await git.hasOrigin(resolve(getBarePath(workspaceRoot), app.name)).catch(() => null)
        : null;

      try {
        const [branch, tree] = await Promise.all([
          git.currentBranch(app.path),
          detailed ? git.status(app.path) : null,
        ]);

        // `rev-parse --abbrev-ref HEAD` reports the literal "HEAD" when detached;
        // that isn't branch drift, it's a different problem worth naming.
        const detached = branch === "HEAD";

        return {
          name: app.name,
          present: true,
          path: app.path,
          branch,
          expectedBranch: expected,
          drift: !detached && expected !== null && branch !== expected,
          detached,
          tree: tree
            ? { ...tree, clean: tree.staged === 0 && tree.unstaged === 0 && tree.untracked === 0 }
            : null,
          env,
          published,
          error: null,
        };
      } catch (error) {
        // One broken worktree must not sink the whole report.
        return {
          name: app.name,
          present: true,
          path: app.path,
          branch: null,
          expectedBranch: expected,
          drift: false,
          detached: false,
          tree: null,
          env,
          published,
          error: String(error),
        };
      }
    })
  );
}

export function buildAttention(group: ResolvedGroup, apps: AppReport[]): Attention[] {
  const attention: Attention[] = [];

  for (const app of apps) {
    if (!app.present) {
      // A group with metadata (e.g. a review) leaves some apps out on purpose.
      if (app.expectedBranch !== null) {
        attention.push({
          app: app.name,
          kind: "missing-worktree",
          message: "no worktree in this workspace",
          fix: `jade workspace add ${group.name} --apps ${app.name}`,
        });
      }
      continue;
    }

    if (app.error) {
      attention.push({
        app: app.name,
        kind: "git-error",
        message: `could not read git state: ${app.error}`,
      });
      continue;
    }

    const target = app.expectedBranch ?? group.name;

    if (app.detached) {
      attention.push({
        app: app.name,
        kind: "detached-head",
        message: "detached HEAD, not on a branch",
        // `jade checkout --app` resolves the app relative to cwd.
        fix: `cd ${group.path} && jade checkout ${target} --app ${app.name}`,
      });
    } else if (app.drift) {
      attention.push({
        app: app.name,
        kind: "branch-drift",
        message:
          `on '${app.branch}', not '${target}' ` +
          `(the branch was likely already checked out in another workspace)`,
        fix: `cd ${group.path} && jade checkout ${target} --app ${app.name}`,
      });
    }

    if (app.published === false) {
      attention.push({
        app: app.name,
        kind: "unpublished",
        message: "no remote yet; .bare/ holds the only copy",
        fix: `jade publish ${app.name}`,
      });
    }

    if (app.env && !app.env.present && app.env.sourceAvailable) {
      attention.push({
        app: app.name,
        kind: "missing-env",
        message: ".env missing, source available",
        fix: "jade env sync",
      });
    }
  }

  return attention;
}
