import { resolve } from "path";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";

/**
 * Optional metadata a worktree group carries about what it is *supposed* to
 * look like, stored inside the group directory so `jade workspace remove`
 * deletes it along with the group.
 *
 * Without it, every check assumes the default shape: each app on a branch named
 * after the group, every app present. A review group breaks both on purpose (its
 * apps sit on their real PR branches, and unmatched apps are left out), so it
 * records the expected branch per app instead.
 */
export interface GroupMeta {
  /**
   * review: built by `jade review` from a ticket. import: made by `jade
   * import` for a branch whose name can't be a group name (e.g. `feature/x`).
   */
  kind: "review" | "import";
  /** For review groups, the id the group was built from, e.g. JADE-01 */
  ticket?: string;
  /** app name -> the branch it should be on; apps not listed are expected absent */
  branches: Record<string, string>;
}

const GROUP_META_FILE = ".jade-group.json";

function getGroupMetaPath(groupPath: string): string {
  return resolve(groupPath, GROUP_META_FILE);
}

/**
 * Read a group's metadata. Missing or unreadable metadata means "default
 * shape" — a corrupt file must not break status or doctor.
 */
export async function readGroupMeta(
  groupPath: string,
  fs: FileSystemBackend = realFileSystemBackend
): Promise<GroupMeta | null> {
  const raw = await fs.readFile(getGroupMetaPath(groupPath));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if ((parsed?.kind === "review" || parsed?.kind === "import") && typeof parsed.branches === "object" && parsed.branches) {
      return parsed as GroupMeta;
    }
  } catch {
    // fall through
  }
  return null;
}

export async function writeGroupMeta(
  groupPath: string,
  meta: GroupMeta,
  fs: FileSystemBackend = realFileSystemBackend
): Promise<void> {
  await fs.writeFile(getGroupMetaPath(groupPath), JSON.stringify(meta, null, 2) + "\n");
}

/**
 * The branch an app is expected to be on in this group, or null when the group
 * doesn't expect the app at all.
 */
export function expectedBranch(groupName: string, appName: string, meta: GroupMeta | null): string | null {
  if (!meta) return groupName;
  return meta.branches[appName] ?? null;
}

/**
 * Record that `appName` belongs on `branch` in this group, where status and
 * doctor will look for it:
 *
 * - "recorded": the group has metadata, and now lists the app on `branch`.
 * - "default": no metadata, and `branch` is the group's name, which is what a
 *   group without metadata expects anyway. Nothing written.
 * - "mismatch": no metadata, and `branch` differs from the group's name.
 *   Nothing written; status will report the app as drifted unless the caller
 *   writes metadata for the group itself.
 */
export async function recordAppBranch(
  groupPath: string,
  groupName: string,
  appName: string,
  branch: string,
  fs: FileSystemBackend = realFileSystemBackend
): Promise<"recorded" | "default" | "mismatch"> {
  const meta = await readGroupMeta(groupPath, fs);
  if (meta) {
    meta.branches[appName] = branch;
    await writeGroupMeta(groupPath, meta, fs);
    return "recorded";
  }
  return branch === groupName ? "default" : "mismatch";
}
