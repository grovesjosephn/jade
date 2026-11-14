import { dirname, resolve } from "path";
import { getWorktreeGroupPath } from "./layout.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";

export function getEnvDirPath(workspaceRoot: string): string {
  return resolve(workspaceRoot, ".env");
}

export function getAppEnvSourcePath(workspaceRoot: string, appName: string): string {
  return resolve(workspaceRoot, ".env", appName, ".env");
}

export async function copyEnvToWorktree(
  workspaceRoot: string,
  appName: string,
  worktreePath: string,
  fs: FileSystemBackend = realFileSystemBackend
): Promise<boolean> {
  const sourcePath = getAppEnvSourcePath(workspaceRoot, appName);
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
  workspaceRoot: string,
  appName: string,
  sourceDir: string,
  fs: FileSystemBackend = realFileSystemBackend
): Promise<boolean> {
  const store = getAppEnvSourcePath(workspaceRoot, appName);
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

export async function syncEnvToGroup(
  workspaceRoot: string,
  groupName: string,
  appNames: readonly string[],
  fs: FileSystemBackend = realFileSystemBackend
): Promise<SyncResult> {
  const groupPath = getWorktreeGroupPath(workspaceRoot, groupName);
  const copied: string[] = [];
  const skipped: string[] = [];

  for (const appName of appNames) {
    const worktreePath = resolve(groupPath, appName);
    if (!await fs.pathExists(worktreePath)) continue;

    const didCopy = await copyEnvToWorktree(workspaceRoot, appName, worktreePath, fs);
    if (didCopy) {
      copied.push(`${groupName}/${appName}`);
    } else {
      skipped.push(appName);
    }
  }

  return { copied, skipped };
}
