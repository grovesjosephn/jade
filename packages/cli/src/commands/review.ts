import { defineCommand } from "citty";
import { resolve } from "path";
import { intro, outro, cancel, log, spinner } from "../adapters/ui.ts";
import { findWorkspaceRoot, getBarePath, getWorktreeGroupPath } from "../core/layout.ts";
import { resolveGroup } from "../core/group.ts";
import { type GitBackend, realGitBackend } from "../adapters/git-backend.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";
import { type ConfigBackend, realConfigBackend } from "../core/config-backend.ts";
import { readGroupMeta, writeGroupMeta, type GroupMeta } from "../core/group-meta.ts";
import { copyEnvToWorktree } from "../core/env.ts";
import { ghRepoPrefix, runGh as defaultRunGh, type GhRunner } from "../adapters/gh.ts";

/**
 * Does a branch name or PR title reference the ticket? Case-insensitive, and
 * bounded on both sides so JADE-1 doesn't match JADE-12 or XJADE-1.
 */
export function matchesTicket(text: string, ticket: string): boolean {
  const escaped = ticket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(text);
}

interface PrMatch {
  number: number;
  title: string;
  branch: string;
}

async function findPrMatches(
  runGh: GhRunner,
  repoPrefix: string,
  appName: string,
  ticket: string
): Promise<PrMatch[]> {
  const out = await runGh([
    "pr",
    "list",
    "--repo",
    `${repoPrefix}/${appName}`,
    "--state",
    "open",
    "--search",
    `${ticket} in:title`,
    "--json",
    "headRefName,title,number",
  ]);
  // PR search is an extra on top of branch-name matching: if gh is missing,
  // logged out or fails, fall back to branch names only.
  if (!out.ok) return [];
  try {
    const prs = JSON.parse(out.output) as { headRefName?: string; title?: string; number?: number }[];
    return prs
      .filter((pr) => pr.headRefName && pr.title && matchesTicket(pr.title, ticket))
      .map((pr) => ({ number: pr.number ?? 0, title: pr.title!, branch: pr.headRefName! }));
  } catch {
    return [];
  }
}

/** Parse `app=branch,app2=branch2` into a map; malformed pairs are ignored. */
export function parsePicks(raw: string): Map<string, string> {
  const picks = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const app = pair.slice(0, eq).trim();
    const branch = pair.slice(eq + 1).trim();
    if (app && branch) picks.set(app, branch);
  }
  return picks;
}

export interface AppMatch {
  app: string;
  /** Distinct candidate branches (from branch names and PR head refs) */
  branches: string[];
  prs: PrMatch[];
  /** PR head branches that don't exist on origin (e.g. opened from a fork) */
  unreachable: string[];
}

export function makeReviewCommand(
  git: GitBackend = realGitBackend,
  fs: FileSystemBackend = realFileSystemBackend,
  config: ConfigBackend = realConfigBackend,
  runGh: GhRunner = defaultRunGh
) {
  return defineCommand({
    meta: {
      name: "review",
      description:
        "Build workspace/<ticket>/ with only the apps that have a branch or open PR for a ticket, each on its real branch",
    },
    args: {
      ticket: {
        type: "positional",
        description: "Ticket id to search for in branch names and PR titles (e.g. JADE-01)",
        required: true,
      },
      apps: {
        type: "string",
        description: "Comma-separated apps to search (default: all apps)",
      },
      pick: {
        type: "string",
        description: "Resolve ambiguous apps: comma-separated app=branch pairs (e.g. api=feat/JADE-01-b)",
      },
      gh: {
        type: "boolean",
        description: "Also search open PR titles with gh (use --no-gh to skip)",
        default: true,
      },
      dryRun: {
        type: "boolean",
        description: "Report matches without creating anything",
        default: false,
      },
      workspace: {
        type: "string",
        alias: "w",
        description: "Workspace root path",
      },
    },
    async run({ args }) {
      const workspaceRoot = args.workspace
        ? resolve(args.workspace as string)
        : await findWorkspaceRoot(process.cwd(), fs);

      if (!workspaceRoot) {
        cancel(`Not in a jade workspace. Run 'jade init' first.`);
        process.exit(1);
      }

      const ticket = (args.ticket as string).trim();
      if (!ticket || ticket === "main" || /[/\\]/.test(ticket)) {
        cancel(`Invalid ticket id '${ticket}'`);
        process.exit(1);
      }

      const dryRun = args.dryRun as boolean;
      const groupPath = getWorktreeGroupPath(workspaceRoot, ticket);
      const group = await resolveGroup(workspaceRoot, ticket, fs);
      const existingMeta = group.exists ? await readGroupMeta(groupPath, fs) : null;

      if (group.exists && !existingMeta) {
        cancel(
          `workspace/${ticket}/ already exists and wasn't created by 'jade review'. ` +
            `Remove it first or pick another name.`
        );
        process.exit(1);
      }

      const knownApps = group.apps.map((a) => a.name);
      let searchApps = knownApps;
      if (args.apps !== undefined) {
        const requested = (args.apps as string).split(",").map((a) => a.trim()).filter(Boolean);
        const unknown = requested.filter((a) => !knownApps.includes(a));
        if (unknown.length > 0) {
          cancel(`Unknown app(s): ${unknown.join(", ")}. Available: ${knownApps.join(", ")}`);
          process.exit(1);
        }
        searchApps = knownApps.filter((a) => requested.includes(a));
      }

      if (searchApps.length === 0) {
        cancel(`No apps found. Add apps with 'jade add <repo-url>'`);
        process.exit(1);
      }

      intro(`Review ${ticket}`);

      const jadeConfig = await config.readConfig(workspaceRoot);
      const repoPrefix = args.gh && jadeConfig.orgUrl ? ghRepoPrefix(jadeConfig.orgUrl) : null;
      const barePath = getBarePath(workspaceRoot);

      // 1. Search every app. Fetch first: a bare clone's branch list is only as
      //    fresh as its last fetch, and PR branches are usually recent pushes.
      const s = spinner();
      s.start(`Searching ${searchApps.length} app(s) for '${ticket}'`);
      const matches: AppMatch[] = [];

      for (const app of searchApps) {
        const bareRepoPath = resolve(barePath, app);
        s.message(`Searching ${app}`);
        // An unpublished app has nothing to fetch and no PRs; its local
        // branches can still match.
        const published = await git.hasOrigin(bareRepoPath);
        if (published) {
          try {
            await git.fetch(bareRepoPath);
          } catch (error) {
            log.warn(`${app}: fetch failed, searching cached branches only\n  ${error}`);
          }
        }

        let allBranches: string[] = [];
        try {
          allBranches = await git.listBranches(bareRepoPath);
        } catch (error) {
          log.warn(`${app}: could not list branches: ${error}`);
        }

        const prs = repoPrefix && published ? await findPrMatches(runGh, repoPrefix, app, ticket) : [];
        const candidates = new Set(allBranches.filter((b) => matchesTicket(b, ticket)));
        const unreachable: string[] = [];
        for (const pr of prs) {
          if (allBranches.includes(pr.branch)) candidates.add(pr.branch);
          else unreachable.push(pr.branch);
        }

        matches.push({ app, branches: [...candidates].sort(), prs, unreachable });
      }
      s.stop(`Search complete`);

      // --pick narrows an ambiguous app to the branch the user chose.
      const picks = parsePicks((args.pick as string | undefined) ?? "");
      for (const m of matches) {
        const picked = picks.get(m.app);
        if (!picked) continue;
        if (m.branches.includes(picked)) {
          m.branches = [picked];
        } else {
          log.warn(`${m.app}: --pick '${picked}' isn't one of its candidates (${m.branches.join(", ") || "none"})`);
        }
      }

      const matched = matches.filter((m) => m.branches.length === 1);
      const ambiguous = matches.filter((m) => m.branches.length > 1);
      const none = matches.filter((m) => m.branches.length === 0);

      for (const m of ambiguous) {
        log.warn(`${m.app}: ambiguous, ${m.branches.length} candidates: ${m.branches.join(", ")}`);
      }
      for (const m of matches) {
        for (const branch of m.unreachable) {
          log.warn(`${m.app}: PR branch '${branch}' isn't on origin (fork?), skipped`);
        }
      }

      if (matched.length === 0) {
        if (ambiguous.length === 0) log.info(`No branch or open PR matches '${ticket}'.`);
        outro(`Nothing to create`);
        if (ambiguous.length > 0) process.exit(1);
        return;
      }

      // Apps already in a previous run of this review stay as they are.
      const toCreate = matched.filter((m) => !group.apps.find((a) => a.name === m.app)?.present);
      const alreadyPresent = matched.filter((m) => !toCreate.includes(m));

      if (dryRun) {
        for (const m of matched) {
          const pr = m.prs.find((p) => p.branch === m.branches[0]);
          log.info(`${m.app}: ${m.branches[0]}${pr ? ` (PR #${pr.number})` : ""}`);
        }
        outro(`Dry run: would create workspace/${ticket}/ with ${toCreate.length} app(s)`);
        return;
      }

      // 2. Create worktrees directly on the matched branches — no placeholder.
      await fs.mkdirp(groupPath);
      const meta: GroupMeta = existingMeta ?? { kind: "review", ticket, branches: {} };
      const created: string[] = [];
      const failed: string[] = [];

      const s2 = spinner();
      s2.start(`Creating workspace/${ticket}/`);
      for (const m of toCreate) {
        const branch = m.branches[0]!;
        try {
          const actual = await git.worktreeAdd(resolve(barePath, m.app), resolve(groupPath, m.app), branch);
          meta.branches[m.app] = actual ?? branch;
          if (actual && actual !== branch) {
            log.warn(
              `${m.app}: '${branch}' is checked out in another workspace, so this one is on '${actual}' (same commit)`
            );
          } else {
            // A local branch left from an earlier review (or the user's own
            // checkout) isn't moved by fetch; bring it up to the PR's latest.
            const ff = await git.fastForwardToOrigin(resolve(groupPath, m.app), branch);
            if (ff === "updated") log.info(`${m.app}: fast-forwarded ${branch} to origin/${branch}`);
            if (ff === "diverged") {
              log.warn(`${m.app}: local '${branch}' has diverged from origin/${branch}; left as is`);
            }
          }
          created.push(m.app);
          await copyEnvToWorktree(workspaceRoot, m.app, resolve(groupPath, m.app), fs);
        } catch (error) {
          log.warn(`${m.app}: could not create worktree on '${branch}': ${error}`);
          failed.push(m.app);
        }
      }
      s2.stop(`Done`);

      if (Object.keys(meta.branches).length > 0) {
        await writeGroupMeta(groupPath, meta, fs);
      } else if (!group.exists) {
        await fs.remove(groupPath);
      }

      // 3. Report.
      const describe = (m: AppMatch) => {
        const branch = meta.branches[m.app] ?? m.branches[0]!;
        const pr = m.prs.find((p) => p.branch === m.branches[0]);
        return `${m.app} → ${branch}${pr ? ` (PR #${pr.number})` : ""}`;
      };
      if (created.length > 0) {
        log.success(`Checked out:\n${matched.filter((m) => created.includes(m.app)).map((m) => `  ${describe(m)}`).join("\n")}`);
      }
      if (alreadyPresent.length > 0) {
        log.info(`Already in this review: ${alreadyPresent.map((m) => m.app).join(", ")}`);
      }
      if (ambiguous.length > 0) {
        log.warn(
          `Ambiguous, left out: ${ambiguous.map((m) => m.app).join(", ")}\n` +
            `  Choose with: jade review ${ticket} --pick ${ambiguous.map((m) => `${m.app}=<branch>`).join(",")}`
        );
      }
      if (none.length > 0) log.info(`No match: ${none.map((m) => m.app).join(", ")}`);

      if (failed.length > 0 || created.length + alreadyPresent.length === 0) {
        outro(`Finished with problems`);
        process.exit(1);
      }
      outro(`Review ready: cd workspace/${ticket}`);
    },
  });
}

export default makeReviewCommand();
