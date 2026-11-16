import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { isHub } from "../../core/layout.ts";
import { makeInitCommand } from "../init.ts";
import { createTempDir, expectsExit } from "../../test/helpers.ts";
import { createMockFileSystemBackend } from "../../test/mock-filesystem-backend.ts";
import { createMockConfigBackend } from "../../test/mock-config-backend.ts";

describe("init command", () => {
  let tempDir: Awaited<ReturnType<typeof createTempDir>>;

  afterEach(async () => {
    if (tempDir) await tempDir.cleanup();
  });

  test("creates workspace directory structure", async () => {
    tempDir = await createTempDir();
    const hubPath = join(tempDir.path, "workspace");
    const { fs } = createMockFileSystemBackend();
    const { config, getState } = createMockConfigBackend();
    const initCmd = makeInitCommand(fs, config);

    await initCmd.run!({ args: { path: hubPath } } as any);

    expect(await isHub(hubPath, fs)).toBe(true);
    expect(await fs.pathExists(join(hubPath, "main"))).toBe(true);
    // jade.json is written via ConfigBackend, not FileSystemBackend — verify
    // through the config fake's state rather than fs.pathExists.
    expect(getState(hubPath)).toBeDefined();
  });

  test("jade.json contains correct version and empty apps array", async () => {
    tempDir = await createTempDir();
    const hubPath = join(tempDir.path, "workspace");
    const { fs } = createMockFileSystemBackend();
    const { config } = createMockConfigBackend();
    const initCmd = makeInitCommand(fs, config);

    await initCmd.run!({ args: { path: hubPath } } as any);

    const jadeConfig = await config.readConfig(hubPath);
    expect(jadeConfig.version).toBe("1.0");
    expect(jadeConfig.apps).toEqual([]);
  });

  test("stores orgUrl when provided", async () => {
    tempDir = await createTempDir();
    const hubPath = join(tempDir.path, "workspace");
    const { fs } = createMockFileSystemBackend();
    const { config } = createMockConfigBackend();
    const initCmd = makeInitCommand(fs, config);

    await initCmd.run!({
      args: { path: hubPath, orgUrl: "https://github.com/myorg" },
    } as any);

    const jadeConfig = await config.readConfig(hubPath);
    expect(jadeConfig.orgUrl).toBe("https://github.com/myorg");
  });

  test("errors when workspace already exists", async () => {
    tempDir = await createTempDir();
    const hubPath = join(tempDir.path, "workspace");
    const { fs } = createMockFileSystemBackend();
    const { config } = createMockConfigBackend();
    const initCmd = makeInitCommand(fs, config);

    await fs.mkdirp(join(hubPath, ".bare"));

    await expectsExit(() =>
      initCmd.run!({ args: { path: hubPath } } as any)
    );
  });
});
