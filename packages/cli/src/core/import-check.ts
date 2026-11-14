import type { ImportCheck } from "../adapters/git-import.ts";

/**
 * Reading an ImportCheck: blockers are data that exists only in the source,
 * so deleting it would lose them. Notes are things jade never copies, which
 * are usually fine to lose but worth a look first.
 */

/** How many ignored entries to list before "and N more" */
const IGNORED_SHOWN = 8;

export function importBlockers(c: ImportCheck): string[] {
  const out: string[] = [];
  if (c.missingRefs.length > 0) out.push(`refs not in the import: ${c.missingRefs.join(", ")}`);
  if (c.unsavedFiles.length > 0) out.push(`uncommitted files not in the import: ${c.unsavedFiles.join(", ")}`);
  if (c.stashCount > 0) out.push(`${c.stashCount} stash entr${c.stashCount === 1 ? "y" : "ies"}`);
  if (c.nestedRepos.length > 0) out.push(`nested git repositories: ${c.nestedRepos.join(", ")}`);
  if (c.submodules.length > 0) out.push(`submodules with local work: ${c.submodules.join(", ")}`);
  if (c.linkedWorktrees.length > 0) out.push(`other worktrees use this repo: ${c.linkedWorktrees.join(", ")}`);
  return out;
}

export function importNotes(c: ImportCheck): string[] {
  const out: string[] = [];
  if (c.remotes.length > 0) out.push(`remotes differ: ${c.remotes.join("; ")}`);
  if (c.ignored.length > 0) {
    const bySize = [...c.ignored].sort((a, b) => (b.kib ?? 0) - (a.kib ?? 0));
    const total = c.ignored.reduce((sum, e) => sum + (e.kib ?? 0), 0);
    const shown = bySize.slice(0, IGNORED_SHOWN).map((e) => `${e.path} (${formatKib(e.kib)})`);
    const more = bySize.length - shown.length;
    out.push(
      [`ignored files, not copied (${formatKib(total)} in all):`, ...shown, ...(more > 0 ? [`and ${more} more`] : [])].join(
        "\n"
      )
    );
  }
  if (c.hooks.length > 0) out.push(`git hooks, not copied: ${c.hooks.join(", ")}`);
  if (c.config.length > 0) out.push(`per-repo git config, not copied: ${c.config.join(", ")}`);
  return out;
}

function formatKib(kib: number | null): string {
  if (kib === null) return "size unknown";
  if (kib < 1024) return `${kib} KB`;
  if (kib < 1024 * 1024) return `${(kib / 1024).toFixed(kib < 10 * 1024 ? 1 : 0)} MB`;
  return `${(kib / 1024 / 1024).toFixed(1)} GB`;
}
