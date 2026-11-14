/**
 * How jade turns what the user typed (`jade add <name|url>`) into a clone URL
 * and an app name, using `orgUrl` from jade.json for bare names.
 */

/**
 * Is the positional argument a clone URL rather than a bare repo name?
 * Covers scheme URLs (https://, ssh://), scp-style SSH (git@host:org/repo), and
 * local paths — everything else is resolved against `orgUrl`.
 */
export function isRepoUrl(input: string): boolean {
  return (
    input.includes("://") ||
    input.startsWith("git@") ||
    input.startsWith("/") ||
    input.startsWith("./") ||
    input.startsWith("../")
  );
}

/**
 * Join a configured `orgUrl` with a bare repo name.
 *
 * scp-style SSH (`git@github.com:org`) needs the `.git` suffix, since without a
 * scheme git can't tell `org/repo` from a path. Scheme URLs — `https://…` and
 * `ssh://…` — resolve fine without it.
 */
export function buildOrgRepoUrl(orgUrl: string, repoName: string): string {
  const baseUrl = orgUrl.replace(/\/+$/, "");
  return baseUrl.startsWith("git@")
    ? `${baseUrl}/${repoName}.git`
    : `${baseUrl}/${repoName}`;
}

/**
 * Derive the app name from a clone URL — the last path segment, minus `.git`.
 *
 * Splits on `:` as well as `/` so scp-style SSH URLs with no path segment
 * (`git@host:repo.git`) still resolve. Returns null when there's nothing to
 * derive, and the caller must ask for --name.
 */
export function deriveAppName(url: string): string | null {
  const trimmed = url.replace(/\/+$/, "");
  const match = trimmed.match(/[/:]([^/:]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}
