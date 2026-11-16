import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { mkdir } from "fs/promises";
import { readWorkspaceMeta, recordAppBranch, writeWorkspaceMeta } from "../workspace-meta.ts";
import { createTempDir } from "../../test/helpers.ts";

describe("recordAppBranch", () => {
  let tempDir: Awaited<ReturnType<typeof createTempDir>>;

  afterEach(async () => {
    if (tempDir) await tempDir.cleanup();
  });

  async function workspace() {
    tempDir = await createTempDir();
    const path = join(tempDir.path, "workspace", "feat");
    await mkdir(path, { recursive: true });
    return path;
  }

  test("adds the app to a workspace that has metadata", async () => {
    const path = await workspace();
    await writeWorkspaceMeta(path, { kind: "review", ticket: "JADE-1", branches: { api: "JADE-1-api" } });
    expect(await recordAppBranch(path, "feat", "web", "JADE-1-web")).toBe("recorded");
    expect((await readWorkspaceMeta(path))?.branches).toEqual({ api: "JADE-1-api", web: "JADE-1-web" });
  });

  test("writes nothing for a plain workspace, and says whether the branch matches it", async () => {
    const path = await workspace();
    expect(await recordAppBranch(path, "feat", "api", "feat")).toBe("default");
    expect(await recordAppBranch(path, "feat", "api", "feat-a1b2c3d")).toBe("mismatch");
    expect(await readWorkspaceMeta(path)).toBeNull();
  });
});
