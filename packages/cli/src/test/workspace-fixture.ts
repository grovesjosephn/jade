import { join } from "path";
import { createTempDir, type TempDir } from "./helpers.ts";
import { createMockGitBackend, type MockGitBackend } from "./mock-git-backend.ts";
import { makeAddCommand } from "../commands/add.ts";
import initCommand from "../commands/init.ts";

export interface WorkspaceFixture {
  tempDir: TempDir;
  root: string;
  mock: MockGitBackend;
  barePath(app: string): string;
  appPath(group: string, app: string): string;
}

/**
 * A real on-disk workspace (real fs + jade.json) whose git is the mock
 * backend, with the given apps added to main/. Call tempDir.cleanup() after.
 */
export async function createWorkspaceFixture(apps: string[]): Promise<WorkspaceFixture> {
  const tempDir = await createTempDir();
  const root = join(tempDir.path, "ws");
  await initCommand.run!({ args: { path: root } } as any);

  const mock = createMockGitBackend();
  const add = makeAddCommand(mock.git);
  for (const app of apps) {
    await add.run!({
      args: { repoNameOrUrl: `https://github.com/org/${app}`, name: app, workspace: root },
    } as any);
  }

  return {
    tempDir,
    root,
    mock,
    barePath: (app) => join(root, ".bare", app),
    appPath: (group, app) =>
      group === "main" ? join(root, "main", app) : join(root, "workspace", group, app),
  };
}
