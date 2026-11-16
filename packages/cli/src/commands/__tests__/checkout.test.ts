import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { realpath } from "fs/promises";
import { makeCheckoutCommand } from "../checkout.ts";
import { makeAddCommand } from "../add.ts";
import { createTempDir } from "../../test/helpers.ts";
import { createMockGitBackend } from "../../test/mock-git-backend.ts";
import { createMockFileSystemBackend } from "../../test/mock-filesystem-backend.ts";
import { createMockConfigBackend } from "../../test/mock-config-backend.ts";
import { makeInitCommand } from "../init.ts";

describe("checkout command", () => {
  let tempDir: Awaited<ReturnType<typeof createTempDir>>;
  let originalCwd: string;

  afterEach(async () => {
    if (originalCwd) process.chdir(originalCwd);
    if (tempDir) await tempDir.cleanup();
  });

  async function setupWorkspaceWithApp(appName = "app") {
    // Resolve symlinks (macOS /var -> /private/var) so paths match process.cwd()
    const realTmpPath = await realpath(tempDir.path);
    const hubPath = join(realTmpPath, "ws");
    const { fs } = createMockFileSystemBackend();
    const { config } = createMockConfigBackend();
    const initCmd = makeInitCommand(fs, config);
    await initCmd.run!({ args: { path: hubPath } } as any);
    const { git } = createMockGitBackend();
    const addCmd = makeAddCommand(git, fs, config);

    await addCmd.run!({
      args: {
        repoNameOrUrl: `https://github.com/org/${appName}`,
        name: appName,
        hub: hubPath,
      },
    } as any);

    return { hubPath, git, fs };
  }

  test("checks out existing branch", async () => {
    tempDir = await createTempDir();
    originalCwd = process.cwd();
    const { hubPath, git, fs } = await setupWorkspaceWithApp();

    // The worktree directory itself is real (created for real by the git
    // fake's worktreeAdd), so process.chdir into it works regardless of the
    // injected filesystem fake — intentionally still real disk here.
    process.chdir(join(hubPath, "main", "app"));

    const checkoutCmd = makeCheckoutCommand(git, fs);
    await checkoutCmd.run!({
      args: { branch: "feat-b", hub: hubPath },
    } as any);

    const branch = await git.currentBranch(join(hubPath, "main", "app"));
    expect(branch).toBe("feat-b");
  });

  test("creates and checks out new branch with -c", async () => {
    tempDir = await createTempDir();
    originalCwd = process.cwd();
    const { hubPath, git, fs } = await setupWorkspaceWithApp();

    process.chdir(join(hubPath, "main", "app"));

    const checkoutCmd = makeCheckoutCommand(git, fs);
    await checkoutCmd.run!({
      args: { branch: "feat-new", create: true, hub: hubPath },
    } as any);

    const branch = await git.currentBranch(join(hubPath, "main", "app"));
    expect(branch).toBe("feat-new");
  });

  test("scopes to single app when --app provided", async () => {
    tempDir = await createTempDir();
    originalCwd = process.cwd();
    const { hubPath, git, fs } = await setupWorkspaceWithApp();

    process.chdir(join(hubPath, "main"));

    const checkoutCmd = makeCheckoutCommand(git, fs);
    await checkoutCmd.run!({
      args: { branch: "feat-x", app: "app", hub: hubPath },
    } as any);

    const branch = await git.currentBranch(join(hubPath, "main", "app"));
    expect(branch).toBe("feat-x");
  });
});
