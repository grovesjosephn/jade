import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { join } from "path";
import { existsSync } from "fs";
import { $ } from "bun";
import {
  gitHasOrigin,
  gitInitRepo,
  gitPublish,
  gitUnpushedBranches,
  gitWorktreeAdd,
} from "../git.ts";
import { createTempDir } from "../../test/helpers.ts";

/**
 * Real-git coverage for `jade create` / `jade publish` and the remove guard.
 */
describe("local-first repos", () => {
  let tempDir: Awaited<ReturnType<typeof createTempDir>>;
  const KEYS = [
    "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
    "GIT_CONFIG_GLOBAL", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
  ];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

  beforeEach(() => {
    // gitInitRepo commits; give it an identity that doesn't depend on the machine.
    Object.assign(process.env, {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    });
  });

  afterEach(async () => {
    // Restore key by key: replacing process.env would detach it from child processes.
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (tempDir) await tempDir.cleanup();
  });

  const git = (cwd: string, ...args: string[]) => $`git ${args}`.cwd(cwd).quiet().nothrow();
  const out = async (cwd: string, ...args: string[]) => (await git(cwd, ...args)).stdout.toString().trim();

  async function created() {
    tempDir = await createTempDir();
    const bare = join(tempDir.path, ".bare", "billing");
    const main = join(tempDir.path, "main", "billing");
    await gitInitRepo(bare, main, "main");
    return { bare, main };
  }

  test("init makes a bare repo, a worktree on the branch, and a first commit", async () => {
    const { bare, main } = await created();
    expect(await out(main, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await out(main, "rev-list", "--count", "HEAD")).toBe("1");
    expect(await gitHasOrigin(bare)).toBe(false);
  });

  test("a feature branch added afterwards shares history with main (not an orphan)", async () => {
    const { bare, main } = await created();
    const feat = join(tempDir.path, "workspace", "feat", "billing");
    await gitWorktreeAdd(bare, feat, "feat");
    expect(await out(feat, "rev-parse", "HEAD")).toBe(await out(main, "rev-parse", "HEAD"));
  });

  test("init rolls back completely when the commit can't be made", async () => {
    tempDir = await createTempDir();
    for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
      delete process.env[k];
    }
    // No global config and no guessing from the hostname: there is no identity.
    Object.assign(process.env, {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.useConfigOnly",
      GIT_CONFIG_VALUE_0: "true",
    });
    const bare = join(tempDir.path, ".bare", "billing");
    const main = join(tempDir.path, "main", "billing");

    await expect(gitInitRepo(bare, main, "main")).rejects.toThrow();
    expect(existsSync(bare)).toBe(false);
    expect(existsSync(main)).toBe(false);
  });

  test("everything is unpushed until published; publish pushes, tracks and fetches", async () => {
    const { bare, main } = await created();
    expect(await gitUnpushedBranches(bare)).toEqual(["main"]);

    const remote = join(tempDir.path, "remote.git");
    await $`git init --quiet --bare ${remote}`.quiet();
    await gitPublish(bare, remote, ["main"]);

    expect(await gitHasOrigin(bare)).toBe(true);
    expect(await gitUnpushedBranches(bare)).toEqual([]);
    expect(await out(main, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");
    expect(await out(remote, "rev-parse", "main")).toBe(await out(main, "rev-parse", "HEAD"));
    // Same fetch refspec jade add sets on clone, so origin/* refs keep updating.
    expect(await out(bare, "config", "--get", "remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
  });

  test("a new local commit after publishing counts as unpushed again", async () => {
    const { bare, main } = await created();
    const remote = join(tempDir.path, "remote.git");
    await $`git init --quiet --bare ${remote}`.quiet();
    await gitPublish(bare, remote, ["main"]);

    await git(main, "commit", "--quiet", "--allow-empty", "-m", "more");
    expect(await gitUnpushedBranches(bare)).toEqual(["main"]);
  });

  test("a failed push removes origin again, so publish can be retried", async () => {
    const { bare } = await created();
    await expect(gitPublish(bare, join(tempDir.path, "does-not-exist.git"), ["main"])).rejects.toThrow();
    expect(await gitHasOrigin(bare)).toBe(false);
  });
});
