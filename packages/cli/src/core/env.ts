import { dirname, resolve } from "path";
import { getWorkspacePath } from "./layout.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";

export function getEnvDirPath(hub: string): string {
  return resolve(hub, ".env");
}

export function getAppEnvSourcePath(hub: string, appName: string): string {
  return resolve(hub, ".env", appName, ".env");
}

export async function copyEnvToWorktree(
  hub: string,
  appName: string,
  worktreePath: string,
  fs: FileSystemBackend = realFileSystemBackend
): Promise<boolean> {
  const sourcePath = getAppEnvSourcePath(hub, appName);
  if (!await fs.pathExists(sourcePath)) return false;

  const destPath = resolve(worktreePath, ".env");
  await fs.copyFile(sourcePath, destPath);
  return true;
}

/**
 * Make `sourceDir/.env` the app's stored .env (the one copied into new
 * worktrees), unless the app already has one. Returns whether it stored it.
 */
export async function adoptEnv(
  hub: string,
  appName: string,
  sourceDir: string,
  fs: FileSystemBackend = realFileSystemBackend
): Promise<boolean> {
  const store = getAppEnvSourcePath(hub, appName);
  const source = resolve(sourceDir, ".env");
  if ((await fs.pathExists(store)) || !(await fs.pathExists(source))) return false;
  await fs.mkdirp(dirname(store));
  await fs.copyFile(source, store);
  return true;
}

export interface SyncResult {
  copied: string[];
  skipped: string[];
}

export async function syncEnvToWorkspace(
  hub: string,
  workspaceName: string,
  appNames: readonly string[],
  fs: FileSystemBackend = realFileSystemBackend
): Promise<SyncResult> {
  const workspacePath = getWorkspacePath(hub, workspaceName);
  const copied: string[] = [];
  const skipped: string[] = [];

  for (const appName of appNames) {
    const worktreePath = resolve(workspacePath, appName);
    if (!await fs.pathExists(worktreePath)) continue;

    const didCopy = await copyEnvToWorktree(hub, appName, worktreePath, fs);
    if (didCopy) {
      copied.push(`${workspaceName}/${appName}`);
    } else {
      skipped.push(appName);
    }
  }

  return { copied, skipped };
}
