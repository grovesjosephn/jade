import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { $ } from "bun";
import { gitFastForwardToOrigin, gitFetch, gitListBranches, gitWorktreeAdd, resolveStartPoint } from "../git.ts";
import { createTempDir, createLocalGitRepo, createBareClone } from "../../test/helpers.ts";

/**
 * Real-git coverage for the branch behaviour `workspace add --from` and
 * `jade review` depend on — the mock backend can't tell us what git does.
 */
describe("git branches and start points", () => {
  let tempDir: Awaited<ReturnType<typeof createTempDir>>;

  afterEach(async () => {
    if (tempDir) await tempDir.cleanup();
  });

  async function setup() {
    tempDir = await createTempDir();
    const source = await createLocalGitRepo(join(tempDir.path, "source"));
    await $`git checkout -q -b develop`.cwd(source);
    await Bun.write(join(source, "DEV"), "dev\n");
    await $`git add DEV`.cwd(source);
    await $`git commit -q -m dev`.cwd(source);
    await $`git checkout -q -`.cwd(source);
    const bare = await createBareClone(source, join(tempDir.path, "bare"));
    return { source, bare };
  }

  const head = (cwd: string) => $`git rev-parse HEAD`.cwd(cwd).text().then((s) => s.trim());
  const upstream = (cwd: string) =>
    $`git rev-parse --abbrev-ref @{upstream}`.cwd(cwd).nothrow().quiet().text().then((s) => s.trim());

  test("a branch pushed after the clone is checked out with its real content, tracking origin", async () => {
    const { source, bare } = await setup();
    await $`git checkout -q -b feature/late`.cwd(source);
    await Bun.write(join(source, "LATE"), "late\n");
    await $`git add LATE`.cwd(source);
    await $`git commit -q -m late`.cwd(source);
    await gitFetch(bare);

    const wt = join(tempDir.path, "wt");
    expect(await gitWorktreeAdd(bare, wt, "feature/late")).toBe("feature/late");

    expect(await head(wt)).toBe(await head(source));
    expect(await upstream(wt)).toBe("origin/feature/late");
  });

  test("from: starts a new branch at origin/<from> without tracking it", async () => {
    const { source, bare } = await setup();
    const developSha = (await $`git rev-parse develop`.cwd(source).text()).trim();

    const wt = join(tempDir.path, "wt");
    expect(await gitWorktreeAdd(bare, wt, "feat-x", { from: "develop" })).toBe("feat-x");

    expect(await head(wt)).toBe(developSha);
    // Tracking origin/develop would make a bare `git push` target develop.
    expect(await upstream(wt)).not.toBe("origin/develop");
    expect(await $`git rev-parse --abbrev-ref HEAD`.cwd(wt).text()).toBe("feat-x\n");
  });

  test("from: an unknown start point throws instead of falling back to HEAD", async () => {
    const { bare } = await setup();
    await expect(gitWorktreeAdd(bare, join(tempDir.path, "wt"), "feat-x", { from: "nope" })).rejects.toThrow(
      "start point 'nope' not found"
    );
  });

  test("resolveStartPoint prefers origin/<name>, and accepts other commit-ish values", async () => {
    const { bare } = await setup();
    expect(await resolveStartPoint(bare, "develop")).toBe("origin/develop");
    expect(await resolveStartPoint(bare, "HEAD~0")).toBe("HEAD~0");
  });

  test("gitListBranches merges local and origin names without origin/HEAD", async () => {
    const { bare } = await setup();
    const branches = await gitListBranches(bare);
    expect(branches).toContain("develop");
    expect(branches).not.toContain("HEAD");
    expect(new Set(branches).size).toBe(branches.length);
  });

  async function commitIn(cwd: string, file: string) {
    await Bun.write(join(cwd, file), `${file}\n`);
    await $`git add ${file}`.cwd(cwd).quiet();
    await $`git -c user.email=t@t -c user.name=t commit -q -m ${file}`.cwd(cwd).quiet();
  }

  test("from: keeps unpushed commits on the local branch", async () => {
    const { bare } = await setup();
    const work = join(tempDir.path, "work");
    await gitWorktreeAdd(bare, work, "develop");
    await commitIn(work, "UNPUSHED");

    const wt = join(tempDir.path, "wt");
    await gitWorktreeAdd(bare, wt, "feat-y", { from: "develop" });

    expect(await head(wt)).toBe(await head(work));
  });

  test("from: uses origin when the local branch is only behind", async () => {
    const { source, bare } = await setup();
    await $`git checkout -q develop`.cwd(source);
    await commitIn(source, "NEWER");
    await gitFetch(bare);

    expect(await resolveStartPoint(bare, "develop")).toBe("origin/develop");
  });

  test("gitFastForwardToOrigin moves a behind branch and leaves others alone", async () => {
    const { source, bare } = await setup();
    const wt = join(tempDir.path, "wt");
    await gitWorktreeAdd(bare, wt, "develop");
    expect(await gitFastForwardToOrigin(wt, "develop")).toBe("up-to-date");

    await $`git checkout -q develop`.cwd(source);
    await commitIn(source, "PR-UPDATE");
    await gitFetch(bare);
    expect(await gitFastForwardToOrigin(wt, "develop")).toBe("updated");
    expect(await head(wt)).toBe(await head(source));

    await commitIn(wt, "LOCAL");
    await commitIn(source, "REMOTE");
    await gitFetch(bare);
    expect(await gitFastForwardToOrigin(wt, "develop")).toBe("diverged");

    expect(await gitFastForwardToOrigin(wt, "no-such-branch")).toBe("no-upstream");
  });
});
