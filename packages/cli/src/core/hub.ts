import { resolve } from "path";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";
import { findHub } from "./layout.ts";

/**
 * The flags every command that works in a hub takes. `--hub` names the hub
 * explicitly; `-w/--workspace` is the old name for it, kept for scripts until
 * it's removed (and `--workspace` can then mean a workspace).
 */
export const hubArgs = {
  hub: {
    type: "string",
    description: "Hub path: the folder with .bare/ and jade.json (default: found from the current directory)",
  },
  workspace: {
    type: "string",
    alias: "w",
    description: "Deprecated: use --hub",
  },
} as const;

export const WORKSPACE_FLAG_DEPRECATED = "warn -w/--workspace is deprecated and will be removed; use --hub <path>\n";

/**
 * The hub a command works in: `--hub`, else the deprecated `-w/--workspace`
 * (with a warning on stderr, so `--json` output stays clean), else the nearest
 * hub above the current directory. null when there's none.
 */
export async function resolveHub(
  args: { hub?: unknown; workspace?: unknown },
  fs: FileSystemBackend = realFileSystemBackend,
  cwd: string = process.cwd()
): Promise<string | null> {
  if (typeof args.hub === "string" && args.hub) return resolve(args.hub);
  if (typeof args.workspace === "string" && args.workspace) {
    process.stderr.write(WORKSPACE_FLAG_DEPRECATED);
    return resolve(args.workspace);
  }
  return findHub(cwd, fs);
}
