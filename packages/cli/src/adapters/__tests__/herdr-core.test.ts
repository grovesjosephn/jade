import { describe, test, expect } from "bun:test";
import { makeHerdrCoreClient, HerdrCoreError, type HerdrCoreResult, type HerdrCoreRunner } from "../herdr-core.ts";

/** Fake herdr-core: records the `hc` argv and answers from a queue of canned results (shapes copied from a live herdr-core). */
function fakeHerdrCore(...results: Partial<HerdrCoreResult>[]) {
  const calls: string[][] = [];
  const run: HerdrCoreRunner = async (args) => {
    calls.push(args);
    const r = results.shift() ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? "{}", stderr: r.stderr ?? "" };
  };
  return { calls, core: makeHerdrCoreClient(run) };
}

const notFound = {
  code: 3,
  stderr: JSON.stringify({ error: { kind: "not_found", message: 'no terminal "x"', hint: "see `hc ls --all`" } }),
};

describe("herdr-core client", () => {
  test("start runs in the background with name, cwd, labels, and argv after --", async () => {
    const { calls, core } = fakeHerdrCore({
      stdout: JSON.stringify({ address: "t2c", agent: "sh", cwd: "/w", name: "api", parent: "t10", state: "live", turn: 0 }),
    });
    const t = await core.start(["bun", "dev"], { name: "api", cwd: "/w", labels: { "jade.workspace": "feat" }, outliveParent: true });

    expect(calls[0]).toEqual([
      "run", "--json", "--bg", "--name", "api", "--cwd", "/w", "--label", "jade.workspace=feat", "--outlive-parent", "--", "bun", "dev",
    ]);
    expect(t).toMatchObject({ address: "t2c", name: "api", state: "live", status: null, labels: { "jade.workspace": "feat" } });
  });

  test("list maps terminals and passes --all", async () => {
    const { calls, core } = fakeHerdrCore({
      stdout: JSON.stringify({
        terminals: [
          { address: "t10", agent: "claude-code", cwd: "/r", state: "live", status: "working", turn: 45 },
          { address: "t19", agent: "fish", cwd: "/s", state: "live", turn: 71 },
        ],
      }),
    });
    const ts = await core.list({ all: true });
    expect(calls[0]).toEqual(["ls", "--json", "--all"]);
    expect(ts.map((t) => [t.address, t.status, t.agent, t.name])).toEqual([
      ["t10", "working", "claude-code", null],
      ["t19", null, "fish", null],
    ]);
  });

  test("get returns null for an unknown terminal, and other errors throw HerdrCoreError with kind and hint", async () => {
    const { core } = fakeHerdrCore(notFound, {
      code: 1,
      stderr: JSON.stringify({ error: { kind: "name_taken", message: "taken", hint: "pick another name" } }),
    });
    expect(await core.get("x")).toBeNull();

    const err = await core.start(["true"], { name: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(HerdrCoreError);
    expect(err).toMatchObject({ kind: "name_taken", hint: "pick another name", exitCode: 1 });
  });

  test("errors that aren't JSON keep stderr as the message", async () => {
    const { core } = fakeHerdrCore({ code: 127, stderr: "hc: command not found\n" });
    expect(await core.list().catch((e) => e)).toMatchObject({ kind: "unknown", message: "hc: command not found" });
  });

  test("get maps labels and exit code of a finished terminal", async () => {
    const { core } = fakeHerdrCore({
      stdout: JSON.stringify({ address: "t2c", cwd: "/w", name: "api", state: "finished", exit_code: 0, labels: { a: "b" } }),
    });
    expect(await core.get("api")).toMatchObject({ state: "finished", exitCode: 0, labels: { a: "b" } });
  });

  test("read returns the text, wait maps its result, and send/kill/remove pass the terminal", async () => {
    const { calls, core } = fakeHerdrCore(
      { stdout: JSON.stringify({ complete: true, how: "screen", text: "ready\n" }) },
      { stdout: JSON.stringify({ ended: false, reason: "timeout", exit_code: null, status: null, terminal: "t2c" }) },
      {},
      {},
      {}
    );
    expect(await core.read("api", { lines: 50 })).toBe("ready\n");
    expect(await core.wait("api", { output: "ready", timeoutSec: 5 })).toEqual({
      ended: false,
      reason: "timeout",
      exitCode: null,
      status: null,
    });
    await core.send("api", "hello");
    await core.kill("api");
    await core.remove("api");

    expect(calls).toEqual([
      ["read", "--json", "api", "--lines", "50"],
      ["wait", "--json", "api", "--output", "ready", "--timeout", "5"],
      ["send", "--json", "api", "hello"],
      ["kill", "--json", "api"],
      ["rm", "--json", "api"],
    ]);
  });
});
