import { $ } from "bun";

/**
 * The GitHub CLI. Every gh call in jade goes through a GhRunner so commands
 * can be tested with a fake, and so a missing or logged-out gh is an ordinary
 * `ok: false` result instead of a thrown error.
 */
interface GhResult {
  ok: boolean;
  /** stdout on success, stderr (or why gh couldn't run) on failure */
  output: string;
}

export type GhRunner = (args: string[]) => Promise<GhResult>;

export const runGh: GhRunner = async (args) => {
  try {
    const result = await $`gh ${args}`.quiet().nothrow();
    return {
      ok: result.exitCode === 0,
      output: (result.exitCode === 0 ? result.stdout : result.stderr).toString().trim(),
    };
  } catch (error) {
    return { ok: false, output: `could not run gh: ${error}` };
  }
};

/**
 * The `gh --repo` prefix ([HOST/]OWNER) for an orgUrl, or null if it can't be
 * parsed. Accepts https://, ssh:// and scp-style git@host:org forms.
 */
export function ghRepoPrefix(orgUrl: string): string | null {
  const trimmed = orgUrl.replace(/\/+$/, "").replace(/\.git$/, "");
  const match =
    trimmed.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i) ??
    trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (!match) return null;
  const [, host, owner] = match;
  if (!host || !owner) return null;
  return host === "github.com" ? owner : `${host}/${owner}`;
}
