import { describe, test, expect, afterEach } from "bun:test";
import { makeExecCommand, parseExecCommand, type ExecRunner } from "../exec.ts";
import { makeWorkspaceAddCommand } from "../workspace/add.ts";
import { expectsExit, withCapturedConsole } from "../../test/helpers.ts";
import { createWorkspaceFixture, type WorkspaceFixture } from "../../test/workspace-fixture.ts";
import { realFileSystemBackend } from "../../adapters/fs-backend.ts";

describe("parseExecCommand", () => {
  test("takes everything after the first --", () => {
    expect(parseExecCommand(["-g", "x", "--", "git", "status", "--", "y"])).toEqual(["git", "status", "--", "y"]);
  });

  test("treats one argument with whitespace as a shell string", () => {
    expect(parseExecCommand(["--", "bun install && bun test"])).toEqual(["sh", "-c", "bun install && bun test"]);
  });

  test("returns null without -- or without a command", () => {
    expect(parseExecCommand(["git", "status"])).toBeNull();
    expect(parseExecCommand(["--"])).toBeNull();
  });
});

describe("exec command", () => {
  let fx: WorkspaceFixture;

  afterEach(async () => {
    if (fx) await fx.tempDir.cleanup();
  });

  function recordingRunner(failFor: string[] = []) {
    const runs: { argv: string[]; cwd: string; env: Record<string, string>; capture: boolean }[] = [];
    const runner: ExecRunner = async (argv, opts) => {
      runs.push({ argv, ...opts });
      return { exitCode: failFor.includes(opts.env.JADE_APP!) ? 2 : 0, output: "ok\n" };
    };
    return { runs, runner };
  }

  const exec = (runner: ExecRunner, args: Record<string, unknown>, command: string[]) =>
    makeExecCommand(realFileSystemBackend, runner).run!({
      args: { workspace: fx.root, parallel: false, ...args },
      rawArgs: ["--", ...command],
    } as any);

  test("runs in every present app of the group, in order, with JADE_* env", async () => {
    fx = await createWorkspaceFixture(["api", "web"]);
    const { runs, runner } = recordingRunner();

    await withCapturedConsole(() => exec(runner, { group: "main" }, ["git", "status"]));

    expect(runs.map((r) => r.cwd)).toEqual([fx.appPath("main", "api"), fx.appPath("main", "web")]);
    expect(runs[0]!.argv).toEqual(["git", "status"]);
    expect(runs[0]!.env).toEqual({ JADE_APP: "api", JADE_GROUP: "main", JADE_ROOT: fx.root });
    expect(runs[0]!.capture).toBe(false);
  });

  test("--apps limits the run and skips apps absent from the group", async () => {
    fx = await createWorkspaceFixture(["api", "web"]);
    await makeWorkspaceAddCommand(fx.mock.git).run!({
      args: { name: "feat", apps: "web", workspace: fx.root },
    } as any);
    const { runs, runner } = recordingRunner();

    await withCapturedConsole(() => exec(runner, { group: "feat" }, ["ls"]));
    expect(runs.map((r) => r.env.JADE_APP)).toEqual(["web"]);

    await expectsExit(() => exec(runner, { group: "feat", apps: "api" }, ["ls"]));
  });

  test("keeps going after a failure, then exits 1", async () => {
    fx = await createWorkspaceFixture(["api", "web"]);
    const { runs, runner } = recordingRunner(["api"]);

    await expectsExit(async () => {
      await withCapturedConsole(() => exec(runner, { group: "main" }, ["false"]));
    });
    expect(runs).toHaveLength(2);
  });

  test("--parallel captures output per app", async () => {
    fx = await createWorkspaceFixture(["api", "web"]);
    const { runs, runner } = recordingRunner();

    const out = await withCapturedConsole(() => exec(runner, { group: "main", parallel: true }, ["ls"]));

    expect(runs.every((r) => r.capture)).toBe(true);
    expect(out.filter((l) => l === "ok")).toHaveLength(2);
  });

  test("exits 1 without a command or for an unknown group", async () => {
    fx = await createWorkspaceFixture(["api"]);
    const { runner } = recordingRunner();

    await expectsExit(() => exec(runner, { group: "main" }, []));
    await expectsExit(() => exec(runner, { group: "nope" }, ["ls"]));
  });
});
