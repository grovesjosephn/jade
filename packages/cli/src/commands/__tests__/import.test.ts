import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { join } from "path";
import { existsSync, readFileSync, readdirSync } from "fs";
import { $ } from "bun";
import { makeImportCommand, planImport, toWorkspaceName } from "../import.ts";
import initCommand from "../init.ts";
import { createTempDir, expectsExit, withCapturedConsole, type TempDir } from "../../test/helpers.ts";
import { realConfigBackend } from "../../core/config-backend.ts";
import { getAppNames } from "../../core/config.ts";
import { readWorkspaceMeta } from "../../core/workspace-meta.ts";
import { resolveWorkspace } from "../../core/workspace.ts";
import { buildAttention, collectApps } from "../../core/health.ts";
import { realGitBackend } from "../../adapters/git-backend.ts";
import { realFileSystemBackend } from "../../adapters/fs-backend.ts";
import { gitCheckImport } from "../../adapters/git-import.ts";
import { importBlockers } from "../../core/import-check.ts";

describe("planImport", () => {
  test("a feature branch gets a workspace named after it", () => {
    expect(planImport({ branch: "login", dirty: true }, "main", undefined)).toEqual({
      workspace: "login",
      branch: "login",
      newBranch: false,
    });
    expect(planImport({ branch: "feature/login", dirty: false }, "main", undefined)).toEqual({
      workspace: "feature-login",
      branch: "feature/login",
      newBranch: false,
    });
  });

  test("--group renames the workspace but keeps a feature branch", () => {
    expect(planImport({ branch: "login", dirty: false }, "main", "auth")).toEqual({
      workspace: "auth",
      branch: "login",
      newBranch: false,
    });
  });

  test("work on the default branch or a detached HEAD needs --group, and goes on a new branch", () => {
    expect(planImport({ branch: "main", dirty: false }, "main", undefined)).toEqual({ workspace: null });
    expect(planImport({ branch: "main", dirty: true }, "main", undefined)).toHaveProperty("error");
    expect(planImport({ branch: null, dirty: true }, "main", undefined)).toHaveProperty("error");
    // A clean detached HEAD may still hold commits no branch has
    expect(planImport({ branch: null, dirty: false }, "main", undefined)).toHaveProperty("error");
    expect(planImport({ branch: null, dirty: false }, "main", "keep")).toEqual({
      workspace: "keep",
      branch: "keep",
      newBranch: true,
    });
    expect(planImport({ branch: "main", dirty: true }, "main", "wip")).toEqual({
      workspace: "wip",
      branch: "wip",
      newBranch: true,
    });
    expect(planImport({ branch: "main", dirty: true }, "main", "main")).toHaveProperty("error");
  });

  test("toWorkspaceName flattens slashes", () => {
    expect(toWorkspaceName("a/b/c")).toBe("a-b-c");
  });
});

/** Real git, real filesystem: the command end to end. */
describe("jade import", () => {
  let tmp: TempDir;
  let root: string;
  const KEYS = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

  beforeEach(async () => {
    Object.assign(process.env, {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    });
    tmp = await createTempDir();
    root = join(tmp.path, "ws");
    await initCommand.run!({ args: { path: root } } as any);
  });

  afterEach(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await tmp.cleanup();
  });

  const git = async (cwd: string, ...args: string[]) => {
    const r = await $`git ${args}`.cwd(cwd).quiet().nothrow();
    return r.stdout.toString().trimEnd();
  };
  const run = (args: Record<string, unknown>) =>
    makeImportCommand().run!({ args: { hub: root, ...args } } as any);

  /** An upstream repo and a clone of it at <tmp>/<name>, like a normal checkout */
  async function sourceClone(name = "app") {
    const upstream = join(tmp.path, "upstream");
    await $`git init -q -b main ${upstream}`.quiet();
    await Bun.write(join(upstream, "a.txt"), "a\n");
    await Bun.write(join(upstream, "b.txt"), "b\n");
    await Bun.write(join(upstream, "gone.txt"), "x\n");
    await Bun.write(join(upstream, ".gitignore"), "ignored/\n.env\n");
    await git(upstream, "add", ".");
    await git(upstream, "commit", "-qm", "init");
    const src = join(tmp.path, name);
    await $`git clone -q ${upstream} ${src}`.quiet();
    return { upstream, src };
  }

  test("moves a feature branch and all uncommitted work into a workspace, leaving the source alone", async () => {
    const { upstream, src } = await sourceClone();
    await git(src, "checkout", "-qb", "feature/login");
    await Bun.write(join(src, "a.txt"), "a\ncommitted\n");
    await git(src, "commit", "-qam", "feature work");
    await Bun.write(join(src, "a.txt"), "a\ncommitted\nstaged\n");
    await git(src, "add", "a.txt");
    await Bun.write(join(src, "a.txt"), "a\ncommitted\nstaged\nunstaged\n");
    await Bun.write(join(src, "b.txt"), "b changed\n");
    await git(src, "rm", "-q", "gone.txt");
    await Bun.write(join(src, "new/untracked.txt"), "new\n");
    await Bun.write(join(src, "ignored/big.bin"), "x");
    await Bun.write(join(src, ".env"), "SECRET=1\n");
    await $`git init -q ${join(src, "nested")}`.quiet(); // listed as "nested/", not copied

    const statusBefore = await git(src, "status", "--porcelain");
    const refsBefore = await git(src, "for-each-ref");

    await run({ path: src });

    const main = join(root, "main", "app");
    const workspace = join(root, "workspace", "feature-login", "app");
    const bare = join(root, ".bare", "app");

    expect(await git(main, "branch", "--show-current")).toBe("main");
    expect(await git(main, "status", "--porcelain")).toBe("");
    expect(await git(workspace, "branch", "--show-current")).toBe("feature/login");
    expect(await git(workspace, "status", "--porcelain")).toBe(statusBefore.replace("?? nested/\n", ""));
    expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("a\ncommitted\nstaged\nunstaged\n");
    expect(await git(workspace, "diff", "--cached", "--name-only")).toBe("a.txt\ngone.txt");
    expect(existsSync(join(workspace, "ignored"))).toBe(false);
    expect(readFileSync(join(workspace, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(readFileSync(join(main, ".env"), "utf8")).toBe("SECRET=1\n");

    // origin points at the real upstream, with its remote-tracking refs and HEAD
    expect(await git(bare, "remote", "get-url", "origin")).toBe(upstream);
    expect(await git(bare, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(await git(bare, "symbolic-ref", "refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main");
    expect(await git(main, "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/main");
    expect(await git(bare, "for-each-ref", "refs/jade-import")).toBe("");

    // The source is untouched
    expect(await git(src, "status", "--porcelain")).toBe(statusBefore);
    expect(await git(src, "for-each-ref")).toBe(refsBefore);
    expect(await git(src, "stash", "list")).toBe("");

    expect(getAppNames(await realConfigBackend.readConfig(root))).toContain("app");
    expect(await readWorkspaceMeta(join(root, "workspace", "feature-login"))).toEqual({
      kind: "import",
      branches: { app: "feature/login" },
    });

    // status and doctor see both workspaces as healthy, not drifted
    const config = await realConfigBackend.readConfig(root);
    for (const name of ["main", "feature-login"]) {
      const g = await resolveWorkspace(root, name);
      const meta = await readWorkspaceMeta(g.path);
      const apps = await collectApps(root, g, realGitBackend, realFileSystemBackend, config, meta, true);
      const kinds = buildAttention(g, apps).map((a) => a.kind);
      expect(kinds).not.toContain("branch-drift");
      expect(kinds).not.toContain("missing-worktree");
    }
  });

  test("a workspace named after its branch needs no metadata", async () => {
    const { src } = await sourceClone();
    await git(src, "checkout", "-qb", "login");
    await run({ path: src });
    expect(await git(join(root, "workspace", "login", "app"), "branch", "--show-current")).toBe("login");
    expect(existsSync(join(root, "workspace", "login", ".jade-group.json"))).toBe(false);
  });

  test("a clean default branch imports into main/ only", async () => {
    const { src } = await sourceClone();
    await run({ path: src });
    expect(await git(join(root, "main", "app"), "branch", "--show-current")).toBe("main");
    expect(readdirSync(join(root, "workspace"))).toEqual([]);
  });

  test("dirty work on the default branch goes to a new --group branch at HEAD", async () => {
    const { src } = await sourceClone();
    await Bun.write(join(src, "a.txt"), "dirty\n");
    await expectsExit(() => run({ path: src }));
    expect(existsSync(join(root, ".bare", "app"))).toBe(false);

    await run({ path: src, group: "wip" });
    const workspace = join(root, "workspace", "wip", "app");
    expect(await git(workspace, "branch", "--show-current")).toBe("wip");
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(await git(src, "rev-parse", "HEAD"));
    expect(await git(workspace, "status", "--porcelain")).toBe(" M a.txt");
    expect(await git(join(root, "main", "app"), "status", "--porcelain")).toBe("");
  });

  test("a repo with no origin imports as local only", async () => {
    const src = join(tmp.path, "solo");
    await $`git init -q -b trunk ${src}`.quiet();
    await Bun.write(join(src, "f"), "f\n");
    await git(src, "add", ".");
    await git(src, "commit", "-qm", "init");
    // No origin/HEAD and no main/master: the checked-out branch is the default
    await run({ path: src });
    const bare = join(root, ".bare", "solo");
    expect(await git(bare, "remote")).toBe("");
    const cfg = await realConfigBackend.readConfig(root);
    expect(cfg.apps).toContainEqual({ name: "solo", defaultBranch: "trunk" });
  });

  test("refuses linked worktrees, mid-merge repos, and paths inside the workspace", async () => {
    const { src } = await sourceClone();
    const linked = join(tmp.path, "linked");
    await git(src, "worktree", "add", "-q", "-b", "side", linked);
    await expectsExit(() => run({ path: linked }));

    await run({ path: src, name: "app" });
    await expectsExit(() => run({ path: join(root, "main", "app"), name: "again" }));
    await expectsExit(() => run({ path: src })); // app already exists
  });

  test("refuses a source that contains the workspace", async () => {
    const outer = join(tmp.path, "outer");
    await $`git init -q -b main ${outer}`.quiet();
    await Bun.write(join(outer, "f"), "f\n");
    await git(outer, "add", ".");
    await git(outer, "commit", "-qm", "init");
    const inner = join(outer, "ws");
    await initCommand.run!({ args: { path: inner } } as any);
    await expectsExit(() => makeImportCommand().run!({ args: { path: outer, hub: inner } } as any));
    expect(existsSync(join(inner, ".bare", "outer"))).toBe(false);
  });
  test("keeps every remote: URLs, push URLs, remote-tracking refs and <remote>/HEAD", async () => {
    const { src } = await sourceClone();
    // A second remote with its own branch and HEAD, reached by a relative path
    const fork = join(tmp.path, "fork");
    await $`git clone -q --bare ${join(tmp.path, "upstream")} ${fork}`.quiet();
    await $`git --git-dir=${fork} branch side main`.quiet();
    await git(src, "remote", "add", "upstream", "../fork");
    await git(src, "fetch", "-q", "upstream");
    await git(src, "remote", "set-head", "upstream", "main");
    await git(src, "remote", "set-url", "--push", "origin", "git@example.com:me/app.git");

    await run({ path: src });
    const bare = join(root, ".bare", "app");
    expect((await git(bare, "remote")).split("\n").sort()).toEqual(["origin", "upstream"]);
    expect(await git(bare, "remote", "get-url", "upstream")).toBe(fork);
    expect(await git(bare, "remote", "get-url", "--push", "origin")).toBe("git@example.com:me/app.git");
    expect(await git(bare, "rev-parse", "refs/remotes/upstream/side")).toBe(await git(src, "rev-parse", "upstream/side"));
    expect(await git(bare, "symbolic-ref", "refs/remotes/upstream/HEAD")).toBe("refs/remotes/upstream/main");
    expect(await git(bare, "config", "remote.upstream.fetch")).toBe("+refs/heads/*:refs/remotes/upstream/*");
  });

  test("a placeholder push URL such as no_push stays as written", async () => {
    const { src } = await sourceClone();
    await git(src, "remote", "set-url", "--push", "origin", "no_push");

    await run({ path: src });
    const bare = join(root, ".bare", "app");
    expect(await git(bare, "remote", "get-url", "--push", "origin")).toBe("no_push");
  });

  describe("--json", () => {
    /** Run with --json and parse stdout, which must be exactly one JSON object */
    const runJson = async (args: Record<string, unknown>) => {
      const lines = await withCapturedConsole(() => run({ ...args, json: true }));
      expect(lines).toHaveLength(1);
      return JSON.parse(lines[0]!);
    };

    test("an import prints one object: paths, workspace, carried work, remotes, check and next steps", async () => {
      const { src } = await sourceClone();
      await git(src, "checkout", "-qb", "feature/login");
      await Bun.write(join(src, "a.txt"), "dirty\n");
      await Bun.write(join(src, "ignored/x"), "x");
      const out = await runJson({ path: src });
      expect(out).toMatchObject({
        mode: "import",
        app: "app",
        main: { path: join(root, "main", "app"), branch: "main" },
        workspace: { name: "feature-login", branch: "feature/login", newBranch: false },
        // The pre-0.4 name, kept beside `workspace` for older readers.
        group: { name: "feature-login", branch: "feature/login", newBranch: false },
        carried: { tracked: true, untracked: [] },
        remotes: ["origin"],
        published: true,
        safeToRemove: true,
        blockers: [],
      });
      expect(out.check.ignored.map((e: { path: string }) => e.path)).toEqual(["ignored/"]);
      expect(out.next).toEqual([
        `cd ${join(root, "workspace", "feature-login", "app")}`,
        `jade import ${src} --name app --remove-source`,
      ]);
    });

    test("--check with blockers prints the object, then exits 1; --remove-source reports removed", async () => {
      const { src } = await sourceClone();
      await run({ path: src });
      await Bun.write(join(src, "b.txt"), "stash me\n");
      await git(src, "stash", "-q");

      const lines = await withCapturedConsole(() => expectsExit(() => run({ path: src, check: true, json: true })));
      expect(lines).toHaveLength(1);
      let out = JSON.parse(lines[0]!);
      expect(out).toMatchObject({ mode: "check", safeToRemove: false, removed: false, next: [] });
      expect(out.blockers).toEqual(["1 stash entry"]);

      await git(src, "stash", "drop", "-q");
      out = await runJson({ path: src, "remove-source": true });
      expect(out).toMatchObject({ mode: "remove-source", safeToRemove: true, removed: true });
      expect(existsSync(src)).toBe(false);
    });

    test("errors go to stderr as JSON, leaving stdout empty", async () => {
      const errors: string[] = [];
      const origError = console.error;
      console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
      let lines: string[] = [];
      try {
        await expectsExit(async () => {
          lines = await withCapturedConsole(() => run({ path: join(tmp.path, "nowhere"), json: true }));
        });
      } finally {
        console.error = origError;
      }
      expect(lines).toEqual([]);
      expect(JSON.parse(errors[0]!).error.message).toContain("isn't inside a git working copy");
    });
  });

  describe("--check and --remove-source", () => {
    const check = (src: string) => gitCheckImport(src, join(root, ".bare", "app"));

    test("a fresh import loses nothing; --remove-source deletes the source", async () => {
      const { src } = await sourceClone();
      await git(src, "checkout", "-qb", "login");
      await Bun.write(join(src, "a.txt"), "dirty\n");
      await Bun.write(join(src, "new.txt"), "untracked\n");
      await Bun.write(join(src, "ignored/big.bin"), "x");
      await Bun.write(join(src, ".git/hooks/pre-commit"), "#!/bin/sh\n");
      await git(src, "config", "user.name", "Someone");
      await run({ path: src });

      const c = await check(src);
      expect(importBlockers(c)).toEqual([]);
      expect(c.ignored.map((e) => e.path)).toEqual(["ignored/"]);
      expect(c.hooks).toEqual(["pre-commit"]);
      expect(c.config).toEqual(["user.name"]);

      await run({ path: src, check: true });
      await run({ path: src, "remove-source": true });
      expect(existsSync(src)).toBe(false);
    });

    test("work committed in the import after carrying it still counts", async () => {
      const { src } = await sourceClone();
      await git(src, "checkout", "-qb", "login");
      await Bun.write(join(src, "a.txt"), "dirty\n");
      await Bun.write(join(src, "new.txt"), "untracked\n");
      await run({ path: src });
      const workspace = join(root, "workspace", "login", "app");
      await git(workspace, "add", ".");
      await git(workspace, "commit", "-qm", "carried work");
      await Bun.write(join(workspace, "a.txt"), "edited again\n");
      expect(importBlockers(await check(src))).toEqual([]);
    });

    test("blocks on a branch, stash, nested repo or file the import doesn't have", async () => {
      const { src } = await sourceClone();
      await run({ path: src });
      expect(importBlockers(await check(src))).toEqual([]);

      await git(src, "checkout", "-qb", "later");
      await Bun.write(join(src, "a.txt"), "later\n");
      await git(src, "commit", "-qam", "after the import");
      await Bun.write(join(src, "b.txt"), "stashed\n");
      await git(src, "stash", "-q");
      await $`git init -q ${join(src, "nested")}`.quiet();
      await Bun.write(join(src, "fresh.txt"), "only here\n");

      const c = await check(src);
      expect(c.missingRefs).toEqual(["later"]);
      expect(c.stashCount).toBe(1);
      expect(c.nestedRepos).toEqual(["nested/"]);
      expect(c.unsavedFiles).toEqual(["fresh.txt"]);

      await expectsExit(() => run({ path: src, check: true }));
      await expectsExit(() => run({ path: src, "remove-source": true }));
      expect(existsSync(src)).toBe(true);
    });

    test("a branch deleted in the import blocks, even though its objects remain", async () => {
      const { src } = await sourceClone();
      await git(src, "branch", "spare");
      await git(src, "checkout", "-q", "spare");
      await Bun.write(join(src, "a.txt"), "spare\n");
      await git(src, "commit", "-qam", "only on spare");
      await git(src, "checkout", "-q", "main");
      await run({ path: src });
      expect(importBlockers(await check(src))).toEqual([]);
      await git(join(root, ".bare", "app"), "branch", "-D", "spare");
      expect((await check(src)).missingRefs).toEqual(["spare"]);
    });

    test("blocks on linked worktrees, a detached HEAD the import lacks, and submodule work", async () => {
      const { src } = await sourceClone();
      // A submodule whose checkout has a commit no remote has
      const lib = join(tmp.path, "lib");
      await $`git init -q -b main ${lib}`.quiet();
      await Bun.write(join(lib, "l.txt"), "l\n");
      await git(lib, "add", ".");
      await git(lib, "commit", "-qm", "lib");
      await git(src, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "lib");
      await git(src, "commit", "-qm", "add lib");
      await run({ path: src });
      expect(importBlockers(await check(src))).toEqual([]);

      await Bun.write(join(src, "lib", "l.txt"), "local\n");
      await git(join(src, "lib"), "commit", "-qam", "local only");
      await git(src, "worktree", "add", "-q", "--detach", join(tmp.path, "side"));
      await git(src, "checkout", "-q", "--detach");
      await Bun.write(join(src, "a.txt"), "detached\n");
      await git(src, "commit", "-qam", "detached work");

      const c = await check(src);
      expect(c.submodules).toEqual(["lib (commits on no remote)"]);
      expect(c.linkedWorktrees).toEqual([join(tmp.path, "side")]);
      expect(c.missingRefs.some((r) => r.startsWith("HEAD (detached"))).toBe(true);
      // The source's submodule pointer changed too, so lib shows as modified
      expect(c.unsavedFiles).toEqual([]);
    });

    test("a renamed source needs --name to find its app", async () => {
      const { src } = await sourceClone("app.old");
      await run({ path: src, name: "app" });
      await expectsExit(() => run({ path: src, check: true }));
      await run({ path: src, name: "app", check: true });
    });
  });
});
