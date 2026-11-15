import { describe, test, expect, afterEach } from "bun:test";
import { existsSync } from "fs";
import { makeCreateCommand, selectGroups } from "../create.ts";
import { makePublishCommand } from "../publish.ts";
import type { GhRunner } from "../../adapters/gh.ts";
import { makeRemoveCommand } from "../remove.ts";
import { makeWorkspaceAddCommand } from "../workspace/add.ts";
import { makeWorkspaceRemoveCommand } from "../workspace/remove.ts";
import { makeWorkspaceUpdateCommand } from "../workspace/update.ts";
import { makeUpdateCommand } from "../update.ts";
import { doctorGroup } from "../doctor.ts";
import { expectsExit } from "../../test/helpers.ts";
import { createWorkspaceFixture, type WorkspaceFixture } from "../../test/workspace-fixture.ts";
import { realConfigBackend } from "../../core/config-backend.ts";
import { realFileSystemBackend } from "../../adapters/fs-backend.ts";
import { getAppNames } from "../../core/config.ts";
import { readGroupMeta, writeGroupMeta } from "../../core/group-meta.ts";
import { resolveGroup } from "../../core/group.ts";
import { buildAttention, collectApps } from "../../core/health.ts";

function recordingGh(result = { ok: true, output: "" }) {
  const calls: string[][] = [];
  const runGh: GhRunner = async (args) => {
    calls.push(args);
    return result;
  };
  return { calls, runGh };
}

describe("selectGroups", () => {
  const existing = ["main", "feat", "other"];
  test("defaults to the current feature group, never main", () => {
    expect(selectGroups(undefined, "feat", existing)).toEqual(["feat"]);
    expect(selectGroups(undefined, "main", existing)).toEqual([]);
    expect(selectGroups(undefined, null, existing)).toEqual([]);
  });
  test("all, none and explicit lists", () => {
    expect(selectGroups("all", null, existing)).toEqual(["feat", "other"]);
    expect(selectGroups("none", "feat", existing)).toEqual([]);
    expect(selectGroups("feat, main ,x", null, existing)).toEqual(["feat", "x"]);
  });
});

describe("create / publish", () => {
  let fx: WorkspaceFixture;

  afterEach(async () => {
    if (fx) await fx.tempDir.cleanup();
  });

  const create = (args: Record<string, unknown>, runGh = recordingGh().runGh) =>
    makeCreateCommand(fx.mock.git, undefined, undefined, runGh).run!({
      args: { branch: "main", workspace: fx.root, ...args },
    } as any);

  test("creates a local-only app in .bare/ and main/ and records it in jade.json", async () => {
    fx = await createWorkspaceFixture(["api"]);
    await create({ name: "billing" });

    expect(fx.mock.calls.find((c) => c.method === "initRepo")?.args).toEqual([
      fx.barePath("billing"),
      fx.appPath("main", "billing"),
      "main",
    ]);
    expect(getAppNames(await realConfigBackend.readConfig(fx.root))).toContain("billing");
    expect(await fx.mock.git.hasOrigin(fx.barePath("billing"))).toBe(false);
    expect(fx.mock.calls.some((c) => c.method === "publish")).toBe(false);
  });

  test("records a non-main default branch in jade.json", async () => {
    fx = await createWorkspaceFixture([]);
    await create({ name: "billing", branch: "develop" });
    const cfg = await realConfigBackend.readConfig(fx.root);
    expect(cfg.apps).toContainEqual({ name: "billing", defaultBranch: "develop" });
  });

  test("--groups adds worktrees on each group's branch, and updates review metadata", async () => {
    fx = await createWorkspaceFixture(["api"]);
    await makeWorkspaceAddCommand(fx.mock.git).run!({ args: { name: "feat", apps: "api", workspace: fx.root } } as any);
    await makeWorkspaceAddCommand(fx.mock.git).run!({ args: { name: "JADE-1", apps: "api", workspace: fx.root } } as any);
    const reviewPath = fx.appPath("JADE-1", "").replace(/\/$/, "");
    await writeGroupMeta(reviewPath, { kind: "review", ticket: "JADE-1", branches: { api: "JADE-1" } });

    await create({ name: "billing", groups: "all" });

    const state = fx.mock.getState(fx.barePath("billing"))!;
    expect(state.worktrees.get(fx.appPath("feat", "billing"))).toBe("feat");
    expect(state.worktrees.get(fx.appPath("JADE-1", "billing"))).toBe("JADE-1");
    expect((await readGroupMeta(reviewPath))?.branches.billing).toBe("JADE-1");
  });

  test("refuses bad names, existing apps and unknown groups before creating anything", async () => {
    fx = await createWorkspaceFixture(["api"]);
    await expectsExit(() => create({ name: "../evil" }));
    await expectsExit(() => create({ name: "api" }));
    await expectsExit(() => create({ name: "billing", groups: "nope" }));
    expect(fx.mock.calls.some((c) => c.method === "initRepo")).toBe(false);
  });

  test("--remote creates the repo with gh under orgUrl and publishes", async () => {
    fx = await createWorkspaceFixture([]);
    await realConfigBackend.writeConfig(fx.root, {
      ...(await realConfigBackend.readConfig(fx.root)),
      orgUrl: "git@github.com:acme",
    });
    const gh = recordingGh();
    await create({ name: "billing", remote: true }, gh.runGh);

    expect(gh.calls).toEqual([["repo", "create", "acme/billing", "--private"]]);
    expect(fx.mock.getState(fx.barePath("billing"))!.originUrl).toBe("git@github.com:acme/billing.git");
  });

  test("--remote with a bare-owner orgUrl creates the repo on GitHub over https", async () => {
    fx = await createWorkspaceFixture([]);
    await realConfigBackend.writeConfig(fx.root, {
      ...(await realConfigBackend.readConfig(fx.root)),
      orgUrl: "acme",
    });
    const gh = recordingGh();
    await create({ name: "billing", remote: true }, gh.runGh);

    expect(gh.calls).toEqual([["repo", "create", "acme/billing", "--private"]]);
    expect(fx.mock.getState(fx.barePath("billing"))!.originUrl).toBe("https://github.com/acme/billing");
  });

  test("--remote without an orgUrl keeps the local app and exits non-zero", async () => {
    fx = await createWorkspaceFixture([]);
    await expectsExit(() => create({ name: "billing", remote: true }));
    expect(existsSync(fx.barePath("billing"))).toBe(true);
  });

  const publish = (args: Record<string, unknown>, runGh = recordingGh().runGh) =>
    makePublishCommand(fx.mock.git, undefined, undefined, runGh).run!({
      args: { workspace: fx.root, ...args },
    } as any);

  test("publish --url skips gh and pushes only the default branch by default", async () => {
    fx = await createWorkspaceFixture([]);
    await create({ name: "billing" });
    fx.mock.getState(fx.barePath("billing"))!.branches.add("wip");
    const gh = recordingGh();

    await publish({ name: "billing", url: "https://git.example.com/billing.git" }, gh.runGh);

    expect(gh.calls).toEqual([]);
    expect(fx.mock.calls.find((c) => c.method === "publish")?.args).toEqual([
      fx.barePath("billing"),
      "https://git.example.com/billing.git",
      ["main"],
    ]);
  });

  test("publish refuses an app that already has a remote, and reports gh failures", async () => {
    fx = await createWorkspaceFixture(["api"]);
    await expectsExit(() => publish({ name: "api", url: "x" }));

    await realConfigBackend.writeConfig(fx.root, {
      ...(await realConfigBackend.readConfig(fx.root)),
      orgUrl: "https://github.com/acme",
    });
    await create({ name: "billing" });
    await expectsExit(() => publish({ name: "billing" }, recordingGh({ ok: false, output: "name taken" }).runGh));
    expect(await fx.mock.git.hasOrigin(fx.barePath("billing"))).toBe(false);
  });
});

describe("guards for work that exists nowhere else", () => {
  let fx: WorkspaceFixture;

  afterEach(async () => {
    if (fx) await fx.tempDir.cleanup();
  });

  const remove = (args: Record<string, unknown>) =>
    makeRemoveCommand(fx.mock.git).run!({ args: { workspace: fx.root, ...args } } as any);

  test("remove refuses an unpublished app unless --force", async () => {
    fx = await createWorkspaceFixture(["api"]);
    fx.mock.getState(fx.barePath("api"))!.hasOrigin = false;

    await expectsExit(() => remove({ name: "api" }));
    expect(fx.mock.calls.some((c) => c.method === "removeBareRepo")).toBe(false);

    await remove({ name: "api", force: true });
    expect(fx.mock.calls.some((c) => c.method === "removeBareRepo")).toBe(true);
  });

  test("remove refuses unpushed commits and uncommitted changes", async () => {
    fx = await createWorkspaceFixture(["api", "web"]);
    fx.mock.getState(fx.barePath("api"))!.unpushed.add("feat");
    fx.mock.getState(fx.barePath("web"))!.statuses.set(fx.appPath("main", "web"), { staged: 0, unstaged: 1, untracked: 0 });

    await expectsExit(() => remove({ name: "api" }));
    await expectsExit(() => remove({ name: "web" }));
    expect(fx.mock.calls.some((c) => c.method === "removeBareRepo")).toBe(false);
  });

  test("workspace remove -d -f doesn't force-delete branches of unpublished apps", async () => {
    fx = await createWorkspaceFixture(["api", "web"]);
    await makeWorkspaceAddCommand(fx.mock.git).run!({ args: { name: "feat", all: true, workspace: fx.root } } as any);
    fx.mock.getState(fx.barePath("web"))!.hasOrigin = false;

    await makeWorkspaceRemoveCommand(fx.mock.git).run!({
      args: { name: "feat", deleteBranches: true, force: true, workspace: fx.root },
    } as any);

    const deletes = fx.mock.calls.filter((c) => c.method === "deleteBranch").map((c) => [c.args[0], c.args[2]]);
    expect(deletes).toContainEqual([fx.appPath("main", "api"), true]);
    expect(deletes).toContainEqual([fx.appPath("main", "web"), false]);
  });

  test("update and workspace update skip unpublished apps", async () => {
    fx = await createWorkspaceFixture(["api", "web"]);
    fx.mock.getState(fx.barePath("web"))!.hasOrigin = false;

    await makeUpdateCommand(fx.mock.git).run!({ args: { workspace: fx.root } } as any);
    await makeWorkspaceUpdateCommand(fx.mock.git).run!({ args: { group: "main", workspace: fx.root } } as any);

    const touched = fx.mock.calls
      .filter((c) => ["pullFF", "fetch", "mergeBranch"].includes(c.method))
      .map((c) => String(c.args[0]));
    expect(touched.some((p) => p.endsWith("/web"))).toBe(false);
    expect(touched.some((p) => p.endsWith("/api"))).toBe(true);
  });

  test("status flags unpublished apps; doctor doesn't count them as problems", async () => {
    fx = await createWorkspaceFixture(["api"]);
    fx.mock.getState(fx.barePath("api"))!.hasOrigin = false;
    const config = await realConfigBackend.readConfig(fx.root);
    const group = await resolveGroup(fx.root, "main", realFileSystemBackend);
    const apps = await collectApps(fx.root, group, fx.mock.git, realFileSystemBackend, config, null, true);

    expect(buildAttention(group, apps)).toContainEqual(
      expect.objectContaining({ app: "api", kind: "unpublished", fix: "jade publish api" })
    );
    const entries = await doctorGroup(fx.root, "main", fx.mock.git, realFileSystemBackend, config, {
      dryRun: false,
      addMissing: false,
    });
    expect(entries).toEqual([]);
  });
});
