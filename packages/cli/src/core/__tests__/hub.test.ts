import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { mkdir } from "fs/promises";
import { join, resolve } from "path";
import { resolveHub, WORKSPACE_FLAG_DEPRECATED } from "../hub.ts";
import { createTempDir } from "../../test/helpers.ts";

describe("resolveHub", () => {
  let tempDir: Awaited<ReturnType<typeof createTempDir>>;
  afterEach(async () => {
    if (tempDir) await tempDir.cleanup();
  });

  const stderr = () => spyOn(process.stderr, "write").mockImplementation(() => true);

  test("--hub wins, without a warning", async () => {
    const err = stderr();
    expect(await resolveHub({ hub: "/a/hub", workspace: "/old" })).toBe(resolve("/a/hub"));
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  test("-w/--workspace still works, with a deprecation warning on stderr", async () => {
    const err = stderr();
    expect(await resolveHub({ workspace: "/old/hub" })).toBe(resolve("/old/hub"));
    expect(err).toHaveBeenCalledWith(WORKSPACE_FLAG_DEPRECATED);
    err.mockRestore();
  });

  test("with neither, finds the hub above the current directory", async () => {
    tempDir = await createTempDir();
    await mkdir(join(tempDir.path, ".bare"), { recursive: true });
    await mkdir(join(tempDir.path, "workspace", "feat-x", "app"), { recursive: true });
    const err = stderr();
    expect(await resolveHub({}, undefined, join(tempDir.path, "workspace", "feat-x", "app"))).toBe(tempDir.path);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
