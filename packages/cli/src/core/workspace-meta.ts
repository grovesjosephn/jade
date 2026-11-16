import { resolve } from "path";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";

/**
 * Optional metadata a workspace carries about what it is *supposed* to
 * look like, stored inside the workspace directory so `jade workspace remove`
 * deletes it along with the workspace.
 *
 * Without it, every check assumes the default shape: each app on a branch named
 * after the workspace, every app present. A review workspace breaks both on purpose (its
 * apps sit on their real PR branches, and unmatched apps are left out), so it
 * records the expected branch per app instead.
 */
export interface WorkspaceMeta {
  /**
   * review: built by `jade review` from a ticket. import: made by `jade
   * import` for a branch whose name can't be a workspace name (e.g. `feature/x`).
   */
  kind: "review" | "import";
  /** For review workspaces, the id the workspace was built from, e.g. JADE-01 */
  ticket?: string;
  /** app name -> the branch it should be on; apps not listed are expected absent */
  branches: Record<string, string>;
}

const WORKSPACE_META_FILE = ".jade-group.json";

function getWorkspaceMetaPath(workspacePath: string): string {
  return resolve(workspacePath, WORKSPACE_META_FILE);
}

/**
 * Read a workspace's metadata. Missing or unreadable metadata means "default
 * shape" — a corrupt file must not break status or doctor.
 */
export async function readWorkspaceMeta(
  workspacePath: string,
  fs: FileSystemBackend = realFileSystemBackend
): Promise<WorkspaceMeta | null> {
  const raw = await fs.readFile(getWorkspaceMetaPath(workspacePath));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if ((parsed?.kind === "review" || parsed?.kind === "import") && typeof parsed.branches === "object" && parsed.branches) {
      return parsed as WorkspaceMeta;
    }
  } catch {
    // fall through
  }
  return null;
}

export async function writeWorkspaceMeta(
  workspacePath: string,
  meta: WorkspaceMeta,
  fs: FileSystemBackend = realFileSystemBackend
): Promise<void> {
  await fs.writeFile(getWorkspaceMetaPath(workspacePath), JSON.stringify(meta, null, 2) + "\n");
}

/**
 * The branch an app is expected to be on in this workspace, or null when the workspace
 * doesn't expect the app at all.
 */
export function expectedBranch(workspaceName: string, appName: string, meta: WorkspaceMeta | null): string | null {
  if (!meta) return workspaceName;
  return meta.branches[appName] ?? null;
}

/**
 * Record that `appName` belongs on `branch` in this workspace, where status and
 * doctor will look for it:
 *
 * - "recorded": the workspace has metadata, and now lists the app on `branch`.
 * - "default": no metadata, and `branch` is the workspace's name, which is what a
 *   workspace without metadata expects anyway. Nothing written.
 * - "mismatch": no metadata, and `branch` differs from the workspace's name.
 *   Nothing written; status will report the app as drifted unless the caller
 *   writes metadata for the workspace itself.
 */
export async function recordAppBranch(
  workspacePath: string,
  workspaceName: string,
  appName: string,
  branch: string,
  fs: FileSystemBackend = realFileSystemBackend
): Promise<"recorded" | "default" | "mismatch"> {
  const meta = await readWorkspaceMeta(workspacePath, fs);
  if (meta) {
    meta.branches[appName] = branch;
    await writeWorkspaceMeta(workspacePath, meta, fs);
    return "recorded";
  }
  return branch === workspaceName ? "default" : "mismatch";
}
