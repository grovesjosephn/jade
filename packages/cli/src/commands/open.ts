import { defineCommand } from "citty";
import { resolve } from "path";
import { intro, outro, cancel, log } from "../adapters/ui.ts";
import {
  getCurrentWorkspace,
  getWorkspacePath,
  listBareRepos,
} from "../core/layout.ts";
import { getAppNames } from "../core/config.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";
import { type ConfigBackend, realConfigBackend } from "../core/config-backend.ts";
import { defaultRunHerdrTui, findTuiWorkspaceByLabel, type HerdrTuiRunner } from "../adapters/herdr-tui.ts";
import {
  defaultRunTmux,
  defaultAttachTmux,
  tmuxSessionExists,
  type TmuxRunner,
  type TmuxAttacher,
} from "../adapters/tmux.ts";
import { hubArgs, resolveHub } from "../core/hub.ts";

export type { HerdrTuiRunner, TmuxRunner, TmuxAttacher };

/** Find an existing herdr-tui workspace's id by its label, from `workspace list` JSON. */
function findWorkspaceIdByLabel(listOutput: string, label: string): string | null {
  return findTuiWorkspaceByLabel(listOutput, label)?.workspaceId ?? null;
}

/** Pull the new workspace id and its initial tab id out of `workspace create` JSON. */
function parseCreatedTuiWorkspace(createOutput: string): { workspaceId: string | null; rootTabId: string | null } {
  try {
    const parsed = JSON.parse(createOutput);
    const result = parsed?.result ?? {};
    return {
      workspaceId: result.workspace?.workspace_id ?? result.workspace_id ?? null,
      rootTabId: result.tab?.tab_id ?? result.root_pane?.tab_id ?? null,
    };
  } catch {
    return { workspaceId: null, rootTabId: null };
  }
}

/**
 * tmux backend for `jade open`. Mirrors the herdr-tui flow (focus an existing
 * session, else create one) but addresses everything by name — tmux has no
 * opaque ids to parse out of JSON like herdr-tui does. Has no precondition of its
 * own (unlike herdr-tui's `HERDR_ENV` requirement) — it works from anywhere,
 * handing off to the session differently depending on where "anywhere" is:
 *
 * - Already attached to a tmux client (`$TMUX` set): a quick, non-blocking
 *   `switch-client` — you're already looking at a tmux client, just point it
 *   at the new session.
 * - Inside a herdr-tui pane (`--tmux` forced the tmux backend despite
 *   `HERDR_ENV=1`): create/find the session and stop there. There's no plain
 *   terminal to hand off to, and attaching would nest a tmux client inside
 *   the herdr-tui pane, so it's left running in the background instead.
 * - Otherwise (a plain terminal, no multiplexer at all): hand the terminal
 *   over to an interactive `attach-session` via `attachTmux`.
 *
 * Returns the tmux client's exit code when it does that interactive attach,
 * or `undefined` for the other two (non-blocking) cases. Callers must
 * `process.exit()` with a defined result themselves, and only *outside* any
 * try/catch around this call — a caught rethrow followed by `process.exit(1)`
 * would otherwise stomp a real (e.g. 0) exit code from a successful attach.
 */
async function openWithTmux(
  runTmux: TmuxRunner,
  attachTmux: TmuxAttacher,
  workspace: string,
  workspacePath: string,
  apps: string[]
): Promise<number | undefined> {
  const attachedToTmux = Boolean(process.env.TMUX);
  const inHerdrTui = process.env.HERDR_ENV === "1";

  const existed = await tmuxSessionExists(runTmux, workspace);

  if (!existed) {
    const created = await runTmux(["new-session", "-d", "-s", workspace, "-n", workspace, "-c", workspacePath]);
    if (created.exitCode !== 0) {
      cancel(`Failed to create tmux session '${workspace}': ${created.stderr || created.stdout}`);
      process.exit(1);
    }

    for (const app of apps) {
      // Trailing colon forces a session-only target — the root window shares
      // its name with the session, so a bare `-t workspace` is ambiguous and tmux
      // resolves it to that window instead of "append to this session".
      await runTmux(["new-window", "-t", `${workspace}:`, "-n", app, "-c", resolve(workspacePath, app)]);
    }

    // Creating windows leaves the last one selected; bring focus back to root.
    await runTmux(["select-window", "-t", `${workspace}:${workspace}`]);

    if (apps.length > 0) {
      log.success(`Opened tmux session '${workspace}' with windows: ${workspace} (root), ${apps.join(", ")}`);
    } else {
      log.warn(`No apps found in '${workspace}'. Opened the '${workspace}' tmux session with a root window only.`);
    }
  }

  if (attachedToTmux) {
    await runTmux(["switch-client", "-t", workspace]);
    outro(
      existed
        ? `Focused existing '${workspace}' tmux session. Run claude in its root window for cross-app context.`
        : `Ready — run claude in the '${workspace}' root window for cross-app context.`
    );
    return undefined;
  }

  if (inHerdrTui) {
    outro(
      existed
        ? `tmux session '${workspace}' is already running in the background. Attach from a terminal with 'tmux attach -t ${workspace}'.`
        : `tmux session '${workspace}' created in the background. Attach from a terminal with 'tmux attach -t ${workspace}'.`
    );
    return undefined;
  }

  outro(
    existed
      ? `Attaching to existing '${workspace}' tmux session. Run claude in its root window for cross-app context.`
      : `Ready — run claude in the '${workspace}' root window for cross-app context.`
  );
  return await attachTmux(workspace);
}

export function makeOpenCommand(
  runHerdrTui: HerdrTuiRunner = defaultRunHerdrTui,
  fs: FileSystemBackend = realFileSystemBackend,
  config: ConfigBackend = realConfigBackend,
  runTmux: TmuxRunner = defaultRunTmux,
  attachTmux: TmuxAttacher = defaultAttachTmux
) {
  return defineCommand({
    meta: {
      name: "open",
      description:
        "Open a workspace as a dedicated herdr-tui workspace or tmux session (labeled with the workspace name), with a root tab/window plus one per app",
    },
    args: {
      group: {
        type: "positional",
        description: "Workspace to open (defaults to the current workspace, or 'main')",
        required: false,
      },
      ...hubArgs,
      tmux: {
        type: "boolean",
        description: "Force the tmux backend, even inside a herdr-tui pane (HERDR_ENV=1)",
        default: false,
      },
    },
    async run({ args }) {
      const hub = await resolveHub(args, fs);

      if (!hub) {
        cancel(`Not in a jade hub. Run 'jade init' first.`);
        process.exit(1);
      }

      // herdr-tui wins when both are active, unless --tmux forces the tmux
      // backend; otherwise tmux is the universal fallback — it needs no
      // pre-existing session (see openWithTmux).
      const useHerdrTui = process.env.HERDR_ENV === "1" && !args.tmux;

      const workspace =
        (args.group as string | undefined) ||
        getCurrentWorkspace(hub, process.cwd()) ||
        "main";
      const workspacePath = getWorkspacePath(hub, workspace);

      if (!(await fs.pathExists(workspacePath))) {
        cancel(`Workspace '${workspace}' not found. See 'jade workspace list'.`);
        process.exit(1);
      }

      // Which apps are physically present in this workspace.
      const bareRepos = await listBareRepos(hub, fs);
      const present = new Set<string>();
      for (const app of bareRepos) {
        if (await fs.pathExists(resolve(workspacePath, app))) present.add(app);
      }

      // Order tabs by jade.json (the order apps were added) for a stable, intuitive
      // layout; append any present-but-unlisted apps alphabetically as a fallback.
      const configOrder = getAppNames(await config.readConfig(hub));
      const apps = [
        ...configOrder.filter((app) => present.has(app)),
        ...[...present].filter((app) => !configOrder.includes(app)).sort(),
      ];

      intro(`Opening '${workspace}' in ${useHerdrTui ? "herdr-tui" : "tmux"}`);

      if (!useHerdrTui) {
        let tmuxExitCode: number | undefined;
        try {
          tmuxExitCode = await openWithTmux(runTmux, attachTmux, workspace, workspacePath, apps);
        } catch (error) {
          cancel(`Failed to drive tmux: ${error}`);
          process.exit(1);
        }
        // Exit outside the try/catch so a real attach exit code (e.g. 0)
        // can't be mistaken for — and overwritten by — the failure path above.
        if (tmuxExitCode !== undefined) process.exit(tmuxExitCode);
        return;
      }

      try {
        // If a herdr-tui workspace for this jade workspace already exists, just focus it —
        // re-running jade open shouldn't pile up duplicate workspaces/tabs.
        const existingId = findWorkspaceIdByLabel(await runHerdrTui(["workspace", "list"]), workspace);
        if (existingId) {
          await runHerdrTui(["workspace", "focus", existingId]);
          outro(`Focused existing '${workspace}' workspace. Run claude in its root tab for cross-app context.`);
          return;
        }

        // Create a dedicated, focused herdr-tui workspace for this jade workspace so the
        // sidebar shows which workspace you're in. `workspace create` also spawns
        // an initial tab at workspacePath — that's our root tab; rename it to the
        // workspace so it reads clearly.
        const { workspaceId, rootTabId } = parseCreatedTuiWorkspace(
          await runHerdrTui(["workspace", "create", "--cwd", workspacePath, "--label", workspace, "--focus"])
        );

        if (!workspaceId) {
          cancel(`herdr-tui did not return a workspace id for '${workspace}'.`);
          process.exit(1);
        }

        if (rootTabId) {
          await runHerdrTui(["tab", "rename", rootTabId, workspace]);
        }

        // One tab per app inside the new workspace, without stealing focus so
        // the root tab stays active.
        for (const app of apps) {
          await runHerdrTui([
            "tab",
            "create",
            "--workspace",
            workspaceId,
            "--cwd",
            resolve(workspacePath, app),
            "--label",
            app,
            "--no-focus",
          ]);
        }
      } catch (error) {
        cancel(`Failed to drive herdr-tui: ${error}`);
        process.exit(1);
      }

      if (apps.length > 0) {
        log.success(`Opened workspace '${workspace}' with tabs: ${workspace} (root), ${apps.join(", ")}`);
      } else {
        log.warn(`No apps found in '${workspace}'. Opened the '${workspace}' workspace with a root tab only.`);
      }

      outro(`Ready — run claude in the '${workspace}' root tab for cross-app context.`);
    },
  });
}

export default makeOpenCommand();
