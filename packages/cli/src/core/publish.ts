import { resolve } from "path";
import { getBarePath } from "./layout.ts";
import { getAppDefaultBranch, type JadeConfig } from "./config.ts";
import { buildOrgRepoUrl, normalizeOrgUrl } from "./repo-url.ts";
import type { GitBackend } from "../adapters/git-backend.ts";
import { ghRepoPrefix, type GhRunner } from "../adapters/gh.ts";

export interface PublishOptions {
  /** Push to this existing, empty remote instead of creating one with gh */
  url?: string;
  visibility: "private" | "public";
  /** Push every local branch, not just the default branch */
  allBranches: boolean;
}

/**
 * Give a local-only app (from `jade create`) a remote: create the repository
 * with `gh repo create` under the workspace's orgUrl (or use `--url`), then
 * push and wire up tracking. Throws with a user-facing message on failure.
 */
export async function publishApp(
  workspaceRoot: string,
  appName: string,
  jadeConfig: JadeConfig,
  git: GitBackend,
  runGh: GhRunner,
  opts: PublishOptions
): Promise<{ url: string; pushed: string[]; unpushed: string[] }> {
  const bareRepoPath = resolve(getBarePath(workspaceRoot), appName);

  if (await git.hasOrigin(bareRepoPath)) {
    throw new Error(`'${appName}' already has an origin remote; nothing to publish`);
  }

  let url = opts.url;
  if (!url) {
    const prefix = jadeConfig.orgUrl ? ghRepoPrefix(normalizeOrgUrl(jadeConfig.orgUrl)) : null;
    if (!jadeConfig.orgUrl || !prefix) {
      throw new Error(
        `No usable orgUrl in jade.json to create the repo under.\n` +
          `  Create the repo yourself, then: jade publish ${appName} --url <clone-url>`
      );
    }
    const created = await runGh(["repo", "create", `${prefix}/${appName}`, `--${opts.visibility}`]);
    if (!created.ok) {
      throw new Error(
        `gh repo create ${prefix}/${appName} failed:\n  ${created.output}\n` +
          `  If the repo already exists and is empty: jade publish ${appName} --url <clone-url>`
      );
    }
    url = buildOrgRepoUrl(jadeConfig.orgUrl, appName);
  }

  const defaultBranch = getAppDefaultBranch(jadeConfig, appName) ?? (await git.getDefaultBranch(bareRepoPath));
  const local = await git.listBranches(bareRepoPath);
  const pushed = opts.allBranches ? local : [defaultBranch];

  try {
    await git.publish(bareRepoPath, url, pushed);
  } catch (error) {
    const hint = opts.url ? "" : `\n  The remote repo was created; retry with: jade publish ${appName} --url ${url}`;
    throw new Error(`push to ${url} failed: ${error}${hint}`);
  }

  return { url, pushed, unpushed: local.filter((b) => !pushed.includes(b)) };
}
