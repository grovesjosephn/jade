import { describe, test, expect, afterEach } from "bun:test";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { doctorGroup, makeDoctorCommand } from "../doctor.ts";
import { makeWorkspaceAddCommand } from "../workspace/add.ts";
import { expectsExit, withCapturedConsole } from "../../test/helpers.ts";
import { createWorkspaceFixture, type WorkspaceFixture } from "../../test/workspace-fixture.ts";
import { realFileSystemBackend } from "../../adapters/fs-backend.ts";
import { realConfigBackend } from "../../core/config-backend.ts";
import { writeGroupMeta } from "../../core/group-meta.ts";

describe("doctor", () => {
  let fx: WorkspaceFixture;

  afterEach(async () => {
    if (fx) await fx.tempDir.cleanup();
  });

  async function addGroup(name: string, apps: string) {
    await makeWorkspaceAddCommand(fx.mock.git).run!({ args: { name, apps, workspace: fx.root } } as any);
  }

  const run = async (group: string, opts: { dryRun?: boolean; addMissing?: boolean } = {}) =>
    doctorGroup(fx.root, group, fx.mock.git, realFileSystemBackend, await realConfigBackend.readConfig(fx.root), {
      dryRun: false,
      addMissing: false,
      ...opts,
    });

  test("puts a drifted app back on the group branch", async () => {
    fx = await createWorkspaceFixture(["api"]);
    await addGroup("feat", "api");
    const state = fx.mock.getState(fx.barePath("api"))!;
    state.worktrees.set(fx.appPath("feat", "api"), "side");

    const entries = await run("feat");

    expect(entries).toEqual([
      expect.objectContaining({ app: "api", kind: "branch-drift", outcome: { status: "fixed", detail: "checked out feat" } }),
    ]);
    expect(state.worktrees.get(fx.appPath("feat", "api"))).toBe("feat");
  });

  test("dry run reports without checking out", async () => {
    fx = await createWorkspaceFixture(["api"]);
    await addGroup("feat", "api");
    const state = fx.mock.getState(fx.barePath("api"))!;
    state.worktrees.set(fx.appPath("feat", "api"), "side");

    const entries = await run("feat", { dryRun: true });

    expect(entries[0]!.outcome.status).toBe("would-fix");
    expect(state.worktrees.get(fx.appPath("feat", "api"))).toBe("side");
  });

  test("won't check out over uncommitted changes", async () => {
    fx = await createWorkspaceFixture(["api"]);
    await addGroup("feat", "api");
    const state = fx.mock.getState(fx.barePath("api"))!;
    state.worktrees.set(fx.appPath("feat", "api"), "side");
    state.statuses.set(fx.appPath("feat", "api"), { staged: 0, unstaged: 1, untracked: 0 });

    const entries = await run("feat");

    expect(entries[0]!.outcome).toEqual(
      expect.objectContaining({ status: "skipped", detail: expect.stringContaining("uncommitted changes") })
    );
    expect(state.worktrees.get(fx.appPath("feat", "api"))).toBe("side");
  });

  test("won't steal a branch checked out in another worktree", async () => {
    fx = await createWorkspaceFixture(["api"]);
    await addGroup("feat", "api");
    const state = fx.mock.getState(fx.barePath("api"))!;
    state.worktrees.set(fx.appPath("feat", "api"), "feat-mock");
    state.worktrees.set(join(fx.root, "elsewhere"), "feat");

    const entries = await run("feat");

    expect(entries[0]!.outcome).toEqual(
      expect.objectContaining({ status: "skipped", detail: expect.stringContaining("is checked out at") })
    );
  });

  test("copies a missing .env", async () => {
    fx = await createWorkspaceFixture(["api"]);
    await addGroup("feat", "api");
    await mkdir(join(fx.root, ".env", "api"), { recursive: true });
    await writeFile(join(fx.root, ".env", "api", ".env"), "K=1\n");

    const entries = await run("feat");

    expect(entries.map((e) => [e.kind, e.outcome.status])).toEqual([["missing-env", "fixed"]]);
    expect(await realFileSystemBackend.pathExists(join(fx.appPath("feat", "api"), ".env"))).toBe(true);
  });

  test("adds missing worktrees only with --add-missing", async () => {
    fx = await createWorkspaceFixture(["api", "web"]);
    await addGroup("feat", "api");

    expect((await run("feat"))[0]!.outcome.status).toBe("skipped");

    const entries = await run("feat", { addMissing: true });
    expect(entries[0]!.outcome.status).toBe("fixed");
    expect(fx.mock.getState(fx.barePath("web"))!.worktrees.get(fx.appPath("feat", "web"))).toBe("feat");
  });

  test("a review group expects its recorded branches and no other apps", async () => {
    fx = await createWorkspaceFixture(["api", "web"]);
    const state = fx.mock.getState(fx.barePath("api"))!;
    state.remoteBranches.add("feature/JADE-7");
    await fx.mock.git.worktreeAdd(fx.barePath("api"), fx.appPath("JADE-7", "api"), "feature/JADE-7");
    await writeGroupMeta(join(fx.root, "workspace", "JADE-7"), {
      kind: "review",
      ticket: "JADE-7",
      branches: { api: "feature/JADE-7" },
    });

    expect(await run("JADE-7", { addMissing: true })).toEqual([]);
  });

  test("main expects each app's configured default branch", async () => {
    fx = await createWorkspaceFixture(["api"]);
    await realConfigBackend.writeConfig(fx.root, { apps: [{ name: "api", defaultBranch: "develop" }] });
    fx.mock.getState(fx.barePath("api"))!.worktrees.set(fx.appPath("main", "api"), "develop");

    expect(await run("main")).toEqual([]);
  });

  test("command exits 1 while problems remain and 0 when clear", async () => {
    fx = await createWorkspaceFixture(["api", "web"]);
    await addGroup("feat", "api");
    const cmd = makeDoctorCommand(fx.mock.git);

    await expectsExit(async () => {
      await withCapturedConsole(() => cmd.run!({ args: { name: "feat", workspace: fx.root, json: true } } as any));
    });

    const out = await withCapturedConsole(() =>
      cmd.run!({ args: { name: "feat", workspace: fx.root, json: true, addMissing: true } } as any)
    );
    const report = JSON.parse(out.join(""));
    expect(report.entries).toEqual([
      expect.objectContaining({ app: "web", kind: "missing-worktree", outcome: expect.objectContaining({ status: "fixed" }) }),
    ]);
  });
});
