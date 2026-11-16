import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { join } from "path";
import { mkdir, rm } from "fs/promises";
import { makeStatusCommand, resolveStatusTarget } from "../status.ts";
import { makeAddCommand } from "../add.ts";
import { makeWorkspaceAddCommand, type SelectAppsFn } from "../workspace/add.ts";

const selectAll: SelectAppsFn = async (apps) => apps;
import {
  createTempDir,
  withCapturedConsole,
  expectsExit,
} from "../../test/helpers.ts";
import { createMockGitBackend } from "../../test/mock-git-backend.ts";
import initCommand from "../init.ts";
import pkg from "../../../package.json" with { type: "json" };
import type { HerdrTuiRunner } from "../../adapters/herdr-tui.ts";

describe("status command", () => {
  let tempDir: Awaited<ReturnType<typeof createTempDir>>;

  afterEach(async () => {
    if (tempDir) await tempDir.cleanup();
  });

  test("prints version, hub, and workspaces", async () => {
    tempDir = await createTempDir();
    const hubPath = join(tempDir.path, "ws");
    await initCommand.run!({ args: { path: hubPath } } as any);

    const statusCmd = makeStatusCommand();

    const logs = await withCapturedConsole(() =>
      statusCmd.run!({ args: { hub: hubPath } } as any)
    );

    const out = logs.join("\n");
    expect(out).toContain(`version: ${pkg.version}`);
    expect(out).toContain(`hub: ${hubPath}`);
    expect(out).toContain("workspaces:");
    expect(out).toContain("- main");
    expect(out).not.toContain("org:");
  });

  test("prints org when configured", async () => {
    tempDir = await createTempDir();
    const hubPath = join(tempDir.path, "ws");
    await initCommand.run!({
      args: { path: hubPath, orgUrl: "https://github.com/acme" },
    } as any);

    const statusCmd = makeStatusCommand();
    const logs = await withCapturedConsole(() =>
      statusCmd.run!({ args: { hub: hubPath } } as any)
    );

    expect(logs.join("\n")).toContain("org: https://github.com/acme");
  });

  test("lists multiple workspaces", async () => {
    tempDir = await createTempDir();
    const hubPath = join(tempDir.path, "ws");
    await initCommand.run!({ args: { path: hubPath } } as any);

    const { git } = createMockGitBackend();
    const addCmd = makeAddCommand(git);
    const workspaceAddCmd = makeWorkspaceAddCommand(git, selectAll);
    const statusCmd = makeStatusCommand();

    await addCmd.run!({
      args: { repoNameOrUrl: "https://github.com/org/app1", name: "app1", hub: hubPath },
    } as any);
    await addCmd.run!({
      args: { repoNameOrUrl: "https://github.com/org/app2", name: "app2", hub: hubPath },
    } as any);
    await workspaceAddCmd.run!({
      args: { name: "feat-auth", hub: hubPath },
    } as any);

    const logs = await withCapturedConsole(() =>
      statusCmd.run!({ args: { hub: hubPath } } as any)
    );

    const out = logs.join("\n");
    expect(out).toContain("- main");
    expect(out).toContain("- feat-auth");
  });

  test("--json prints machine-readable status", async () => {
    tempDir = await createTempDir();
    const hubPath = join(tempDir.path, "ws");
    await initCommand.run!({
      args: { path: hubPath, orgUrl: "https://github.com/acme" },
    } as any);

    const statusCmd = makeStatusCommand();
    const logs = await withCapturedConsole(() =>
      statusCmd.run!({ args: { hub: hubPath, json: true } } as any)
    );

    const parsed = JSON.parse(logs.join(""));
    expect(parsed).toEqual({
      view: "hub",
      version: pkg.version,
      hub: hubPath,
      root: hubPath,
      orgUrl: "https://github.com/acme",
      workspaces: ["main"],
      groups: ["main"],
    });
  });

  test("--summary forces the hub summary", async () => {
    tempDir = await createTempDir();
    const hubPath = join(tempDir.path, "ws");
    await initCommand.run!({ args: { path: hubPath } } as any);

    const statusCmd = makeStatusCommand();
    const logs = await withCapturedConsole(() =>
      statusCmd.run!({ args: { hub: hubPath, summary: true, json: true } } as any)
    );

    expect(JSON.parse(logs.join("")).view).toBe("hub");
  });

  test("the deprecated --root still means --summary, with a warning on stderr", async () => {
    tempDir = await createTempDir();
    const hubPath = join(tempDir.path, "ws");
    await initCommand.run!({ args: { path: hubPath } } as any);

    const err = spyOn(process.stderr, "write").mockImplementation(() => true);
    const logs = await withCapturedConsole(() =>
      makeStatusCommand().run!({ args: { hub: hubPath, root: true, json: true } } as any)
    );
    const warned = err.mock.calls.some(([m]) => String(m).includes("--root is deprecated"));
    err.mockRestore();

    expect(JSON.parse(logs.join("")).view).toBe("hub");
    expect(warned).toBe(true);
  });
});

describe("resolveStatusTarget", () => {
  const root = "/ws";

  test("an explicit name selects that workspace", () => {
    expect(
      resolveStatusTarget({ hub: root, explicitName: "feat-x", summary: false, cwd: root })
    ).toEqual({ view: "workspace", name: "feat-x" });
  });

  test("an explicit name beats --root", () => {
    expect(
      resolveStatusTarget({ hub: root, explicitName: "feat-x", summary: true, cwd: root })
    ).toEqual({ view: "workspace", name: "feat-x" });
  });

  test("--root beats the current directory's workspace", () => {
    expect(
      resolveStatusTarget({ hub: root, summary: true, cwd: "/ws/workspace/feat-x/app1" })
    ).toEqual({ view: "hub" });
  });

  test("a cwd inside a named workspace selects it", () => {
    expect(
      resolveStatusTarget({ hub: root, summary: false, cwd: "/ws/workspace/feat-x/app1" })
    ).toEqual({ view: "workspace", name: "feat-x" });
  });

  test("a cwd inside main selects main", () => {
    expect(
      resolveStatusTarget({ hub: root, summary: false, cwd: "/ws/main/app1" })
    ).toEqual({ view: "workspace", name: "main" });
  });

  test("the hub itself falls back to the root view", () => {
    expect(resolveStatusTarget({ hub: root, summary: false, cwd: root })).toEqual({
      view: "hub",
    });
  });

  test("a cwd outside the workspace falls back to the root view", () => {
    expect(
      resolveStatusTarget({ hub: root, summary: false, cwd: "/somewhere/else" })
    ).toEqual({ view: "hub" });
  });
});

describe("status command — workspace view", () => {
  let tempDir: Awaited<ReturnType<typeof createTempDir>>;
  const origHerdrEnv = process.env.HERDR_ENV;

  afterEach(async () => {
    if (tempDir) await tempDir.cleanup();
    if (origHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = origHerdrEnv;
  });

  /**
   * Build a workspace with `apps` added, plus a workspace containing `workspaceApps`
   * (all apps when omitted). Returns the shared mock backend so tests can seed
   * per-worktree git state the status command will then read back.
   */
  async function setup(opts: {
    apps?: string[];
    workspace?: string;
    workspaceApps?: string[];
    orgUrl?: string;
  }) {
    tempDir = await createTempDir();
    const hubPath = join(tempDir.path, "ws");
    await initCommand.run!({
      args: { path: hubPath, orgUrl: opts.orgUrl },
    } as any);

    const mock = createMockGitBackend();
    const addCmd = makeAddCommand(mock.git);

    for (const app of opts.apps ?? []) {
      await addCmd.run!({
        args: {
          repoNameOrUrl: `https://github.com/org/${app}`,
          name: app,
          hub: hubPath,
        },
      } as any);
    }

    if (opts.workspace) {
      const pick: SelectAppsFn = async (apps) =>
        opts.workspaceApps ? apps.filter((a) => opts.workspaceApps!.includes(a)) : apps;
      await makeWorkspaceAddCommand(mock.git, pick).run!({
        args: { name: opts.workspace, hub: hubPath },
      } as any);
    }

    return {
      hubPath,
      mock,
      barePath: (app: string) => join(hubPath, ".bare", app),
      appPath: (app: string) => join(hubPath, "workspace", opts.workspace!, app),
    };
  }

  function runStatus(
    hubPath: string,
    name: string,
    mock: ReturnType<typeof createMockGitBackend>,
    extra: Record<string, unknown> = {},
    runHerdrTui?: HerdrTuiRunner
  ) {
    const cmd = makeStatusCommand(mock.git, runHerdrTui ?? (async () => "{}"));
    return withCapturedConsole(() =>
      cmd.run!({ args: { name, hub: hubPath, ...extra } } as any)
    );
  }

  test("reports the workspace name and its installed apps with branches", async () => {
    const { hubPath, mock } = await setup({ apps: ["app1", "app2"], workspace: "feat-x" });

    const logs = await runStatus(hubPath, "feat-x", mock);
    const out = logs.join("\n");

    expect(out).toContain("workspace: feat-x");
    expect(out).toContain("app1");
    expect(out).toContain("app2");
    expect(out).toContain("feat-x");
  });

  test("stays terse: no version, root, path, herdr-tui or attention block", async () => {
    const { hubPath, mock } = await setup({ apps: ["app1"], workspace: "feat-x" });

    const logs = await runStatus(hubPath, "feat-x", mock);
    const out = logs.join("\n");

    expect(out).not.toContain("version:");
    expect(out).not.toContain("root:");
    expect(out).not.toContain("path:");
    expect(out).not.toContain("herdr:");
    expect(out).not.toContain("attention:");
    // workspace line + one app line
    expect(logs).toHaveLength(2);
  });

  test("reports (none) for a workspace with no apps checked out", async () => {
    const { hubPath, mock } = await setup({ workspace: "feat-x" });

    const out = (await runStatus(hubPath, "feat-x", mock)).join("\n");
    expect(out).toContain("workspace: feat-x");
    expect(out).toContain("(none)");
  });

  test("flags branch drift and offers a checkout fix", async () => {
    const { hubPath, mock, barePath, appPath } = await setup({
      apps: ["app1"],
      workspace: "feat-x",
    });

    // Simulate gitWorktreeAdd's uniquified-branch fallback.
    mock.getState(barePath("app1"))!.worktrees.set(appPath("app1"), "feat-x-a1b2c3d");

    // The terse view shows the actual branch and marks it; the fix hint is JSON-only.
    const out = (await runStatus(hubPath, "feat-x", mock)).join("\n");
    expect(out).toContain("feat-x-a1b2c3d");
    expect(out).toContain("[drift]");

    const json = JSON.parse(
      (await runStatus(hubPath, "feat-x", mock, { json: true })).join("")
    );
    expect(json.apps[0].drift).toBe(true);
    expect(json.attention).toContainEqual(
      expect.objectContaining({
        app: "app1",
        kind: "branch-drift",
        fix: expect.stringContaining("jade checkout feat-x --app app1"),
      })
    );
  });

  test("reports a detached HEAD as detached rather than drift", async () => {
    const { hubPath, mock, barePath, appPath } = await setup({
      apps: ["app1"],
      workspace: "feat-x",
    });

    mock.getState(barePath("app1"))!.worktrees.set(appPath("app1"), "HEAD");

    const json = JSON.parse(
      (await runStatus(hubPath, "feat-x", mock, { json: true })).join("")
    );
    expect(json.apps[0].detached).toBe(true);
    expect(json.apps[0].drift).toBe(false);
    expect(json.attention).toContainEqual(
      expect.objectContaining({ app: "app1", kind: "detached-head" })
    );
  });

  test("reports a dirty working tree in --json only", async () => {
    const { hubPath, mock, barePath, appPath } = await setup({
      apps: ["app1"],
      workspace: "feat-x",
    });

    mock
      .getState(barePath("app1"))!
      .statuses.set(appPath("app1"), { staged: 2, unstaged: 3, untracked: 1 });

    const out = (await runStatus(hubPath, "feat-x", mock)).join("\n");
    expect(out).not.toContain("staged");
    expect(out).not.toContain("untracked");

    const json = JSON.parse(
      (await runStatus(hubPath, "feat-x", mock, { json: true })).join("")
    );
    expect(json.apps[0].tree).toEqual({ staged: 2, unstaged: 3, untracked: 1, clean: false });
  });

  test("skips the git status call when rendering text", async () => {
    const { hubPath, mock } = await setup({ apps: ["app1"], workspace: "feat-x" });

    mock.calls.length = 0;
    await runStatus(hubPath, "feat-x", mock);
    expect(mock.calls.map((c) => c.method)).toContain("currentBranch");
    expect(mock.calls.map((c) => c.method)).not.toContain("status");

    mock.calls.length = 0;
    await runStatus(hubPath, "feat-x", mock, { json: true });
    expect(mock.calls.map((c) => c.method)).toContain("status");
  });

  test("a workspace made with only some apps doesn't report the others missing", async () => {
    const { hubPath, mock } = await setup({
      apps: ["app1", "app2"],
      workspace: "feat-x",
      workspaceApps: ["app1"],
    });

    const json = JSON.parse((await runStatus(hubPath, "feat-x", mock, { json: true })).join(""));
    expect(json.apps.find((a: { name: string }) => a.name === "app2").expectedBranch).toBeNull();
    expect(json.attention).toEqual([]);
  });

  test("omits an app with no worktree from text but keeps it in --json", async () => {
    const { hubPath, mock } = await setup({
      apps: ["app1", "app2"],
      workspace: "feat-x",
      workspaceApps: ["app1"],
    });
    // Back to the default shape (as if app2 joined the hub after the workspace was made),
    // so app2 is expected and missing.
    await rm(join(hubPath, "workspace", "feat-x", ".jade-group.json"), { force: true });

    const out = (await runStatus(hubPath, "feat-x", mock)).join("\n");
    expect(out).toContain("app1");
    expect(out).not.toContain("app2");
    expect(out).not.toContain("missing");

    const json = JSON.parse(
      (await runStatus(hubPath, "feat-x", mock, { json: true })).join("")
    );
    const app2 = json.apps.find((a: { name: string }) => a.name === "app2");
    expect(app2.present).toBe(false);
    expect(app2.tree).toBeNull();
    expect(json.attention).toContainEqual(
      expect.objectContaining({ app: "app2", kind: "missing-worktree" })
    );
  });

  test("flags a missing .env in --json only", async () => {
    const { hubPath, mock } = await setup({ apps: ["app1"], workspace: "feat-x" });

    // Written after the workspace exists, so `workspace add` didn't copy it in.
    await mkdir(join(hubPath, ".env", "app1"), { recursive: true });
    await Bun.write(join(hubPath, ".env", "app1", ".env"), "KEY=value\n");

    const out = (await runStatus(hubPath, "feat-x", mock)).join("\n");
    expect(out).not.toContain(".env");

    const json = JSON.parse(
      (await runStatus(hubPath, "feat-x", mock, { json: true })).join("")
    );
    expect(json.apps[0].env).toEqual({ present: false, sourceAvailable: true });
    expect(json.attention).toContainEqual(
      expect.objectContaining({ app: "app1", kind: "missing-env", fix: "jade env sync" })
    );
  });

  test("does not flag a missing .env when there is no source to sync from", async () => {
    const { hubPath, mock } = await setup({ apps: ["app1"], workspace: "feat-x" });

    const json = JSON.parse(
      (await runStatus(hubPath, "feat-x", mock, { json: true })).join("")
    );
    expect(json.apps[0].env).toEqual({ present: false, sourceAvailable: false });
    expect(json.attention).toEqual([]);
  });

  test("reports the main workspace", async () => {
    const { hubPath, mock } = await setup({ apps: ["app1"] });

    const json = JSON.parse(
      (await runStatus(hubPath, "main", mock, { json: true })).join("")
    );
    expect(json.workspace).toBe("main");
    expect(json.isMain).toBe(true);
    expect(json.apps[0].present).toBe(true);
  });

  test("exits 1 for an unknown workspace", async () => {
    const { hubPath, mock } = await setup({ apps: ["app1"], workspace: "feat-x" });

    await expectsExit(() =>
      makeStatusCommand(mock.git, async () => "{}").run!({
        args: { name: "nope", hub: hubPath },
      } as any)
    );
  });

  test("survives an app whose git state cannot be read", async () => {
    const { hubPath, mock } = await setup({ apps: ["app1"], workspace: "feat-x" });

    const failing = {
      ...mock.git,
      currentBranch: async () => {
        throw new Error("boom");
      },
    };
    const cmd = makeStatusCommand(failing, async () => "{}");
    const out = (
      await withCapturedConsole(() =>
        cmd.run!({ args: { name: "feat-x", hub: hubPath } } as any)
      )
    ).join("\n");

    expect(out).toContain("workspace: feat-x");
    expect(out).toContain("(error)");
  });

  describe("herdr-tui state", () => {
    const listOutput = JSON.stringify({
      result: { workspaces: [{ label: "feat-x", workspace_id: "ws_1", focused: true }] },
    });

    test("is absent from --json outside a herdr-tui session", async () => {
      delete process.env.HERDR_ENV;
      const { hubPath, mock } = await setup({ apps: ["app1"], workspace: "feat-x" });

      const json = JSON.parse(
        (
          await runStatus(hubPath, "feat-x", mock, { json: true }, async () => listOutput)
        ).join("")
      );
      expect(json.herdr).toBeUndefined();
    });

    test("reports open and focused in --json inside a herdr-tui session", async () => {
      process.env.HERDR_ENV = "1";
      const { hubPath, mock } = await setup({ apps: ["app1"], workspace: "feat-x" });

      const json = JSON.parse(
        (
          await runStatus(hubPath, "feat-x", mock, { json: true }, async () => listOutput)
        ).join("")
      );
      expect(json.herdr).toEqual({ open: true, focused: true, workspaceId: "ws_1" });
    });

    test("reports not open when herdr-tui has no workspace for the workspace", async () => {
      process.env.HERDR_ENV = "1";
      const { hubPath, mock } = await setup({ apps: ["app1"], workspace: "other" });

      const json = JSON.parse(
        (
          await runStatus(hubPath, "other", mock, { json: true }, async () => listOutput)
        ).join("")
      );
      expect(json.herdr).toEqual({ open: false, focused: false, workspaceId: null });
    });

    test("--json still renders when herdr-tui is unreachable", async () => {
      process.env.HERDR_ENV = "1";
      const { hubPath, mock } = await setup({ apps: ["app1"], workspace: "feat-x" });

      const json = JSON.parse(
        (
          await runStatus(hubPath, "feat-x", mock, { json: true }, async () => {
            throw new Error("herdr-tui not running");
          })
        ).join("")
      );
      expect(json.workspace).toBe("feat-x");
      expect(json.herdr).toBeUndefined();
    });

    test("the text view never spawns herdr-tui", async () => {
      process.env.HERDR_ENV = "1";
      const { hubPath, mock } = await setup({ apps: ["app1"], workspace: "feat-x" });

      let spawned = false;
      const out = (
        await runStatus(hubPath, "feat-x", mock, {}, async () => {
          spawned = true;
          return listOutput;
        })
      ).join("\n");

      expect(spawned).toBe(false);
      expect(out).toContain("workspace: feat-x");
    });
  });
});
