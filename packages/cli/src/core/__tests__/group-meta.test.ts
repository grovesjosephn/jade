import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { mkdir } from "fs/promises";
import { readGroupMeta, recordAppBranch, writeGroupMeta } from "../group-meta.ts";
import { createTempDir } from "../../test/helpers.ts";

describe("recordAppBranch", () => {
  let tempDir: Awaited<ReturnType<typeof createTempDir>>;

  afterEach(async () => {
    if (tempDir) await tempDir.cleanup();
  });

  async function group() {
    tempDir = await createTempDir();
    const path = join(tempDir.path, "workspace", "feat");
    await mkdir(path, { recursive: true });
    return path;
  }

  test("adds the app to a group that has metadata", async () => {
    const path = await group();
    await writeGroupMeta(path, { kind: "review", ticket: "JADE-1", branches: { api: "JADE-1-api" } });
    expect(await recordAppBranch(path, "feat", "web", "JADE-1-web")).toBe("recorded");
    expect((await readGroupMeta(path))?.branches).toEqual({ api: "JADE-1-api", web: "JADE-1-web" });
  });

  test("writes nothing for a plain group, and says whether the branch matches it", async () => {
    const path = await group();
    expect(await recordAppBranch(path, "feat", "api", "feat")).toBe("default");
    expect(await recordAppBranch(path, "feat", "api", "feat-a1b2c3d")).toBe("mismatch");
    expect(await readGroupMeta(path)).toBeNull();
  });
});
