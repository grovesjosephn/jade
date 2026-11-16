import { describe, test, expect, afterEach } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import { makeReviewCommand, matchesTicket, parsePicks } from "../review.ts";
import { ghRepoPrefix, type GhRunner } from "../../adapters/gh.ts";
import { expectsExit } from "../../test/helpers.ts";
import { createHubFixture, type HubFixture } from "../../test/hub-fixture.ts";
import { readWorkspaceMeta } from "../../core/workspace-meta.ts";
import { realFileSystemBackend } from "../../adapters/fs-backend.ts";
import { realConfigBackend } from "../../core/config-backend.ts";

const noGh: GhRunner = async () => ({ ok: false, output: "gh not installed" });

describe("matchesTicket", () => {
  test("matches case-insensitively inside branch names", () => {
    expect(matchesTicket("feature/JADE-7-login", "JADE-7")).toBe(true);
    expect(matchesTicket("jade-7", "JADE-7")).toBe(true);
    expect(matchesTicket("fix(JADE-7): title", "jade-7")).toBe(true);
  });

  test("does not match a longer id or a prefixed one", () => {
    expect(matchesTicket("JADE-77", "JADE-7")).toBe(false);
    expect(matchesTicket("XJADE-7", "JADE-7")).toBe(false);
  });

  test("escapes regex characters in the ticket", () => {
    expect(matchesTicket("feat/a.b", "a.b")).toBe(true);
    expect(matchesTicket("feat/axb", "a.b")).toBe(false);
  });
});

describe("ghRepoPrefix", () => {
  test("parses https, ssh and scp-style org URLs", () => {
    expect(ghRepoPrefix("https://github.com/acme")).toBe("acme");
    expect(ghRepoPrefix("https://github.com/acme/")).toBe("acme");
    expect(ghRepoPrefix("ssh://git@github.com/acme")).toBe("acme");
    expect(ghRepoPrefix("git@github.com:acme")).toBe("acme");
  });

  test("keeps a non-github.com host for gh enterprise", () => {
    expect(ghRepoPrefix("https://git.corp.dev/team")).toBe("git.corp.dev/team");
  });

  test("returns null for something unparseable", () => {
    expect(ghRepoPrefix("not a url")).toBeNull();
  });
});

describe("parsePicks", () => {
  test("parses app=branch pairs and ignores malformed ones", () => {
    const picks = parsePicks("api=feat/JADE-1-b, web=JADE-1,bogus,=x");
    expect([...picks]).toEqual([
      ["api", "feat/JADE-1-b"],
      ["web", "JADE-1"],
    ]);
  });
});

describe("review command", () => {
  let fx: HubFixture;

  afterEach(async () => {
    if (fx) await fx.tempDir.cleanup();
  });

  const review = (gh: GhRunner, args: Record<string, unknown>) =>
    makeReviewCommand(fx.mock.git, realFileSystemBackend, realConfigBackend, gh).run!({
      args: { gh: true, hub: fx.root, ...args },
    } as any);

  test("creates the workspace with only matching apps, each on its real branch", async () => {
    fx = await createHubFixture(["api", "web", "docs"]);
    fx.mock.getState(fx.barePath("api"))!.remoteBranches.add("feature/JADE-7-login");
    fx.mock.getState(fx.barePath("web"))!.remoteBranches.add("JADE-77");

    await review(noGh, { ticket: "JADE-7" });

    const workspacePath = join(fx.root, "workspace", "JADE-7");
    expect(fx.mock.getState(fx.barePath("api"))!.worktrees.get(fx.appPath("JADE-7", "api"))).toBe(
      "feature/JADE-7-login"
    );
    expect(fx.mock.getState(fx.barePath("web"))!.worktrees.has(fx.appPath("JADE-7", "web"))).toBe(false);
    expect(await readWorkspaceMeta(workspacePath)).toEqual({
      kind: "review",
      ticket: "JADE-7",
      branches: { api: "feature/JADE-7-login" },
    });
    // Fetches before searching, and never creates a placeholder branch.
    expect(fx.mock.calls.some((c) => c.method === "fetch")).toBe(true);
    expect(fx.mock.getState(fx.barePath("api"))!.branches.has("JADE-7")).toBe(false);
  });

  test("leaves ambiguous apps out until --pick chooses one", async () => {
    fx = await createHubFixture(["api", "web"]);
    fx.mock.getState(fx.barePath("api"))!.remoteBranches.add("JADE-7-api");
    const web = fx.mock.getState(fx.barePath("web"))!;
    web.remoteBranches.add("JADE-7-ui");
    web.remoteBranches.add("jade-7-alt");

    await review(noGh, { ticket: "JADE-7" });
    expect(web.worktrees.has(fx.appPath("JADE-7", "web"))).toBe(false);

    // Re-running adds to the same review workspace.
    await review(noGh, { ticket: "JADE-7", pick: "web=JADE-7-ui" });
    expect(web.worktrees.get(fx.appPath("JADE-7", "web"))).toBe("JADE-7-ui");
    expect((await readWorkspaceMeta(join(fx.root, "workspace", "JADE-7")))!.branches).toEqual({
      api: "JADE-7-api",
      web: "JADE-7-ui",
    });
  });

  test("adds open PR head branches found with gh", async () => {
    fx = await createHubFixture(["api"]);
    await realConfigBackend.writeConfig(fx.root, { orgUrl: "https://github.com/acme" });
    fx.mock.getState(fx.barePath("api"))!.remoteBranches.add("login-rework");

    const seen: string[][] = [];
    const gh: GhRunner = async (args) => {
      seen.push(args);
      return {
        ok: true,
        output: JSON.stringify([
          { number: 42, title: "JADE-7: rework login", headRefName: "login-rework" },
          { number: 43, title: "JADE-77: unrelated", headRefName: "other" },
        ]),
      };
    };

    await review(gh, { ticket: "JADE-7" });

    expect(seen[0]).toContain("acme/api");
    expect(fx.mock.getState(fx.barePath("api"))!.worktrees.get(fx.appPath("JADE-7", "api"))).toBe(
      "login-rework"
    );
  });

  test("dry run creates nothing", async () => {
    fx = await createHubFixture(["api"]);
    fx.mock.getState(fx.barePath("api"))!.remoteBranches.add("JADE-7");

    await review(noGh, { ticket: "JADE-7", dryRun: true });

    expect(await realFileSystemBackend.pathExists(join(fx.root, "workspace", "JADE-7"))).toBe(false);
  });

  test("refuses to take over a workspace it didn't create", async () => {
    fx = await createHubFixture(["api"]);
    await mkdir(join(fx.root, "workspace", "JADE-7"), { recursive: true });

    await expectsExit(() => review(noGh, { ticket: "JADE-7" }));
  });

  test("exits non-zero when only ambiguous matches exist", async () => {
    fx = await createHubFixture(["web"]);
    const web = fx.mock.getState(fx.barePath("web"))!;
    web.remoteBranches.add("JADE-7-a");
    web.remoteBranches.add("JADE-7-b");

    await expectsExit(() => review(noGh, { ticket: "JADE-7" }));
  });
});
