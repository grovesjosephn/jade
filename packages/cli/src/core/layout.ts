import { resolve, dirname, relative, sep } from "path";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";

/**
 * Find the hub by walking up from cwd looking for .bare directory
 */
export async function findHub(
  startPath: string = process.cwd(),
  fs: FileSystemBackend = realFileSystemBackend
): Promise<string | null> {
  let current = resolve(startPath);
  const root = resolve("/");

  while (current !== root) {
    const barePath = resolve(current, ".bare");
    if (await fs.pathExists(barePath)) {
      return current;
    }
    current = dirname(current);
  }

  return null;
}

/**
 * Validate that a path is a hub (has a .bare directory)
 */
export async function isHub(
  path: string,
  fs: FileSystemBackend = realFileSystemBackend
): Promise<boolean> {
  return await fs.pathExists(resolve(path, ".bare"));
}

/** Names jade can use as a directory, a git remote path and a gh repo name (apps and workspaces). */
const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isUsableName(name: string): boolean {
  return APP_NAME.test(name);
}

/**
 * Get the path to the .bare directory
 */
export function getBarePath(hub: string): string {
  return resolve(hub, ".bare");
}

/**
 * Get the path to the main worktree
 */
export function getMainWorktreePath(hub: string): string {
  return resolve(hub, "main");
}

/**
 * Get the path to the workspace/ directory that contains non-main workspaces
 */
export function getWorktreeContainerPath(hub: string): string {
  return resolve(hub, "workspace");
}

/**
 * Get the full path for a named workspace.
 * "main" lives at <hub>/main; all others live under workspace/.
 */
export function getWorkspacePath(hub: string, workspaceName: string): string {
  if (workspaceName === "main") return resolve(hub, "main");
  return resolve(hub, "workspace", workspaceName);
}

/**
 * Determine which workspace a path lives in, relative to the hub.
 * "main" lives at <hub>/main; all other workspaces live at <hub>/workspace/<name>.
 * Returns null when the path is outside any workspace (e.g. the hub itself,
 * the .bare directory, or a path outside the hub).
 */
export function getCurrentWorkspace(hub: string, path: string): string | null {
  const rel = relative(hub, resolve(path));
  if (rel === "" || rel.startsWith("..")) return null;

  const parts = rel.split(sep);
  if (parts[0] === "main") return "main";
  if (parts[0] === "workspace" && parts[1]) return parts[1];
  return null;
}

/**
 * Get the path to the config file
 */
export function getConfigPath(hub: string): string {
  return resolve(hub, "jade.json");
}

/**
 * List all bare repositories in the .bare directory
 */
export async function listBareRepos(
  hub: string,
  fs: FileSystemBackend = realFileSystemBackend
): Promise<string[]> {
  const barePath = getBarePath(hub);

  if (!await fs.pathExists(barePath)) {
    return [];
  }

  return await fs.listDirectories(barePath);
}

/**
 * List all workspace names in the hub.
 * "main" is included first if it exists at the hub.
 * All other workspaces are discovered inside the workspace/ subdirectory.
 */
export async function listWorktreeDirs(
  hub: string,
  fs: FileSystemBackend = realFileSystemBackend
): Promise<string[]> {
  if (!await fs.pathExists(hub)) {
    return [];
  }

  const directories: string[] = [];

  if (await fs.pathExists(resolve(hub, "main"))) {
    directories.push("main");
  }

  const containerPath = getWorktreeContainerPath(hub);
  if (!await fs.pathExists(containerPath)) {
    return directories;
  }

  directories.push(...(await fs.listDirectories(containerPath)));

  return directories;
}
