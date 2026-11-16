import { resolve } from "path";
import { getWorkspacePath, listBareRepos } from "./layout.ts";
import { getAppNames, readConfig } from "./config.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";

/**
 * Lives in its own module rather than layout.ts: config.ts already imports
 * layout.ts, so resolving a workspace (which needs jade.json for app ordering)
 * from there would introduce a circular import.
 */

export interface ResolvedApp {
  name: string;
  /** Absolute path the app's worktree would live at, whether or not it exists */
  path: string;
  /** Whether a worktree for this app actually exists in this workspace */
  present: boolean;
}

export interface ResolvedWorkspace {
  name: string;
  path: string;
  isMain: boolean;
  /** Whether the workspace directory itself exists */
  exists: boolean;
  apps: ResolvedApp[];
}

/**
 * Resolve a workspace into its path plus the apps jade manages for it,
 * flagging which ones are actually checked out here.
 *
 * Apps are ordered by jade.json (the order they were added) so output stays
 * stable and matches the tab order `jade open` uses; any bare repo missing from
 * the config is appended alphabetically. Apps jade knows about but that have no
 * worktree in this workspace are still returned, with present: false — that gap is
 * exactly what callers want to report.
 */
export async function resolveWorkspace(
  hub: string,
  workspaceName: string,
  fs: FileSystemBackend = realFileSystemBackend
): Promise<ResolvedWorkspace> {
  const workspacePath = getWorkspacePath(hub, workspaceName);

  const configOrder = getAppNames(await readConfig(hub));
  const bareRepos = await listBareRepos(hub, fs);

  const ordered: string[] = [];
  for (const name of [...configOrder, ...bareRepos.slice().sort()]) {
    if (!ordered.includes(name)) ordered.push(name);
  }

  const apps = await Promise.all(
    ordered.map(async (name) => {
      const appPath = resolve(workspacePath, name);
      return { name, path: appPath, present: await fs.pathExists(appPath) };
    })
  );

  return {
    name: workspaceName,
    path: workspacePath,
    isMain: workspaceName === "main",
    exists: await fs.pathExists(workspacePath),
    apps,
  };
}
