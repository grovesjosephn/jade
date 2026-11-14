import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { join } from "path";
import { existsSync, readFileSync, readdirSync } from "fs";
import { $ } from "bun";
import { makeImportCommand, planImport, toGroupName } from "../import.ts";
import initCommand from "../init.ts";
import { createTempDir, expectsExit, type TempDir } from "../../test/helpers.ts";
import { realConfigBackend } from "../../core/config-backend.ts";
import { getAppNames } from "../../core/config.ts";
import { readGroupMeta } from "../../core/group-meta.ts";
import { resolveGroup } from "../../core/group.ts";
import { buildAttention, collectApps } from "../../core/health.ts";
import { realGitBackend } from "../../adapters/git-backend.ts";
import { realFileSystemBackend } from "../../adapters/fs-backend.ts";

describe("planImport", () => {
  test("a feature branch gets a group named after it", () => {
    expect(planImport({ branch: "login", dirty: true }, "main", undefined)).toEqual({
      group: "login",
      branch: "login",
      newBranch: false,
    });
    expect(planImport({ branch: "feature/login", dirty: false }, "main", undefined)).toEqual({
      group: "feature-login",
      branch: "feature/login",
      newBranch: false,
    });
  });

  test("--group renames the group but keeps a feature branch", () => {
    expect(planImport({ branch: "login", dirty: false }, "main", "auth")).toEqual({
      group: "auth",
      branch: "login",
      newBranch: false,
    });
  });

  test("work on the default branch or a detached HEAD needs --group, and goes on a new branch", () => {
    expect(planImport({ branch: "main", dirty: false }, "main", undefined)).toEqual({ group: null });
    expect(planImport({ branch: "main", dirty: true }, "main", undefined)).toHaveProperty("error");
    expect(planImport({ branch: null, dirty: true }, "main", undefined)).toHaveProperty("error");
    // A clean detached HEAD may still hold commits no branch has
    expect(planImport({ branch: null, dirty: false }, "main", undefined)).toHaveProperty("error");
    expect(planImport({ branch: null, dirty: false }, "main", "keep")).toEqual({
      group: "keep",
      branch: "keep",
      newBranch: true,
    });
    expect(planImport({ branch: "main", dirty: true }, "main", "wip")).toEqual({
      group: "wip",
      branch: "wip",
      newBranch: true,
    });
    expect(planImport({ branch: "main", dirty: true }, "main", "main")).toHaveProperty("error");
  });

  test("toGroupName flattens slashes", () => {
    expect(toGroupName("a/b/c")).toBe("a-b-c");
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
    makeImportCommand().run!({ args: { workspace: root, ...args } } as any);

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

  test("moves a feature branch and all uncommitted work into a group, leaving the source alone", async () => {
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
    const group = join(root, "workspace", "feature-login", "app");
    const bare = join(root, ".bare", "app");

    expect(await git(main, "branch", "--show-current")).toBe("main");
    expect(await git(main, "status", "--porcelain")).toBe("");
    expect(await git(group, "branch", "--show-current")).toBe("feature/login");
    expect(await git(group, "status", "--porcelain")).toBe(statusBefore.replace("?? nested/\n", ""));
    expect(readFileSync(join(group, "a.txt"), "utf8")).toBe("a\ncommitted\nstaged\nunstaged\n");
    expect(await git(group, "diff", "--cached", "--name-only")).toBe("a.txt\ngone.txt");
    expect(existsSync(join(group, "ignored"))).toBe(false);
    expect(readFileSync(join(group, ".env"), "utf8")).toBe("SECRET=1\n");
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
    expect(await readGroupMeta(join(root, "workspace", "feature-login"))).toEqual({
      kind: "import",
      branches: { app: "feature/login" },
    });

    // status and doctor see both groups as healthy, not drifted
    const config = await realConfigBackend.readConfig(root);
    for (const name of ["main", "feature-login"]) {
      const g = await resolveGroup(root, name);
      const meta = await readGroupMeta(g.path);
      const apps = await collectApps(root, g, realGitBackend, realFileSystemBackend, config, meta, true);
      const kinds = buildAttention(g, apps).map((a) => a.kind);
      expect(kinds).not.toContain("branch-drift");
      expect(kinds).not.toContain("missing-worktree");
    }
  });

  test("a group named after its branch needs no metadata", async () => {
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
    const group = join(root, "workspace", "wip", "app");
    expect(await git(group, "branch", "--show-current")).toBe("wip");
    expect(await git(group, "rev-parse", "HEAD")).toBe(await git(src, "rev-parse", "HEAD"));
    expect(await git(group, "status", "--porcelain")).toBe(" M a.txt");
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
    await expectsExit(() => makeImportCommand().run!({ args: { path: outer, workspace: inner } } as any));
    expect(existsSync(join(inner, ".bare", "outer"))).toBe(false);
  });
});
