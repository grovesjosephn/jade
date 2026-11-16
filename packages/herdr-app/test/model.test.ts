import { describe, test, expect } from "bun:test";
import {
  agentsIn,
  appState,
  changes,
  inside,
  mostUrgent,
  orderWorkspaces,
  problems,
  readHubView,
  shownApps,
  spaceForWorkspace,
  summary,
  tilde,
  validWorkspaceName,
} from "../mods/jade/model.js";

const ROOT = "/w";
const app = (over: Record<string, unknown> = {}) => ({
  name: "api",
  present: true,
  path: `${ROOT}/main/api`,
  branch: "main",
  expectedBranch: "main",
  drift: false,
  detached: false,
  tree: { staged: 0, unstaged: 0, untracked: 0, clean: true },
  published: true,
  error: null,
  ...over,
});

describe("jade herdr-app model", () => {
  test("inside matches the folder itself and below it, not a sibling with the same prefix", () => {
    expect(inside("/w/main/api", "/w/main")).toBe(true);
    expect(inside("/w/main", "/w/main/")).toBe(true);
    expect(inside("/w/main-old/api", "/w/main")).toBe(false);
    expect(inside(null as any, "/w")).toBe(false);
  });

  test("workspaces: main first, features by name, review tickets last", () => {
    expect(orderWorkspaces(["JADE-42", "zeta", "main", "auth"])).toEqual(["main", "auth", "zeta", "JADE-42"]);
  });

  test("app state: drift and detached beat dirty; missing and errors are their own", () => {
    expect(appState(app()).kind).toBe("clean");
    expect(appState(app({ tree: { staged: 1, unstaged: 0, untracked: 2, clean: false } }))).toEqual({ kind: "dirty", label: "+1 ?2" });
    expect(appState(app({ drift: true, branch: "x", tree: { staged: 1, unstaged: 0, untracked: 0, clean: false } }))).toEqual({
      kind: "drift",
      label: "expected main",
    });
    expect(appState(app({ detached: true })).kind).toBe("detached");
    expect(appState(app({ present: false })).kind).toBe("missing");
    expect(appState(app({ error: "boom" }))).toEqual({ kind: "error", label: "boom" });
    expect(changes({ staged: 0, unstaged: 3, untracked: 0 })).toBe("~3");
  });

  test("agent status: the most urgent wins", () => {
    expect(mostUrgent(["idle", "working", "done"])).toBe("done");
    expect(mostUrgent(["working", "blocked"])).toBe("blocked");
    expect(mostUrgent([])).toBeNull();
  });

  test("the space for a workspace: named after it and in it first, then any local space in it", () => {
    const panes = [
      { pane: "p1", tab: "a1", cwd: "/w/workspace/feat/api" },
      { pane: "p2", tab: "b1", cwd: "/w/workspace/feat" },
      { pane: "p3", tab: "c1", cwd: "/w/workspace/feat" },
    ];
    const spaces = [
      { id: "a", name: "api", named: false, machine: null, folder: "", tabs: [{ id: "a1" }] },
      { id: "b", name: "feat", named: true, machine: null, folder: "", tabs: [{ id: "b1" }] },
      { id: "c", name: "feat", named: true, machine: "vps", folder: "", tabs: [{ id: "c1" }] },
    ];
    const workspace = { name: "feat", path: "/w/workspace/feat" };
    expect(spaceForWorkspace(workspace, spaces, panes)?.id).toBe("b");
    expect(spaceForWorkspace(workspace, spaces.slice(0, 1), panes)?.id).toBe("a");
    expect(spaceForWorkspace(workspace, [spaces[2]], panes)).toBeNull();
    expect(spaceForWorkspace({ name: "other", path: "/w/workspace/other" }, spaces, panes)).toBeNull();
  });

  test("agents in a folder go by their pane's live folder", () => {
    const panes = [
      { pane: "p1", cwd: "/w/workspace/feat/api/src" },
      { pane: "p2", cwd: "/w/main/api" },
    ];
    const agents = [
      { pane: "p1", status: "working" },
      { pane: "p2", status: "blocked" },
    ];
    expect(agentsIn("/w/workspace/feat", agents, panes).map((a) => a.status)).toEqual(["working"]);
  });

  test("unpublished isn't a problem to fix; the summary counts apps once across workspaces", () => {
    const main = {
      apps: [app(), app({ name: "web", tree: { staged: 0, unstaged: 1, untracked: 0, clean: false } })],
      attention: [{ app: "web", kind: "unpublished" }],
    };
    const feat = { apps: [app({ present: false })], attention: [{ app: "api", kind: "missing-worktree" }] };
    expect(problems(main)).toEqual([]);
    expect(summary([main, feat])).toEqual({ apps: 2, workspaces: 2, dirty: 1, needs: 1 });
  });

  test("workspace names jade workspace add accepts", () => {
    for (const ok of ["feat-auth", "JADE-42", "v1.2_fix"]) expect(validWorkspaceName(ok)).toBe(true);
    for (const bad of ["main", "-x", "a/b", "a..b", "", "with space"]) expect(validWorkspaceName(bad)).toBe(false);
  });

  test("tilde shortens paths under home only", () => {
    expect(tilde("/home/me/Projects", "/home/me")).toBe("~/Projects");
    expect(tilde("/home/meow", "/home/me")).toBe("/home/meow");
  });

  test("shownApps: none for main, only held apps for other workspaces", () => {
    const apps = [
      { name: "a", present: true },
      { name: "b", present: false },
      { name: "c", present: true },
    ];
    expect(shownApps({ workspace: "main", apps })).toEqual([]);
    expect(shownApps({ workspace: "feat-x", apps }).map((a) => a.name)).toEqual(["a", "c"]);
    expect(shownApps({ workspace: "JADE-1" })).toEqual([]);
  });

  test("readHubView reads jade 0.4's hub summary and the older root one", () => {
    const now = { view: "hub", version: "0.4.0", hub: "/h", root: "/h", orgUrl: "acme", workspaces: ["main", "x"], groups: ["main", "x"] };
    const old = { view: "root", version: "0.3.0", root: "/h", orgUrl: "acme", groups: ["main", "x"] };
    expect(readHubView(now)).toEqual({ hub: "/h", workspaces: ["main", "x"], version: "0.4.0", orgUrl: "acme" });
    expect(readHubView(old)).toEqual({ hub: "/h", workspaces: ["main", "x"], version: "0.3.0", orgUrl: "acme" });
    expect(readHubView({ view: "workspace", workspace: "x" })).toBeNull();
    expect(readHubView(null)).toBeNull();
  });
});
