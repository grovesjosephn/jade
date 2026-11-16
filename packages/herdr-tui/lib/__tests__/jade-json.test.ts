import { describe, test, expect } from "bun:test";
import { workspacesOf } from "../jade-json.ts";

describe("workspacesOf", () => {
  test("reads jade 0.4's workspaces, then the older groups", () => {
    expect(workspacesOf<string>({ workspaces: ["main", "x"], groups: ["main", "x"] })).toEqual(["main", "x"]);
    expect(workspacesOf<string>({ groups: ["main"] })).toEqual(["main"]);
  });

  test("an empty list for anything else", () => {
    expect(workspacesOf({})).toEqual([]);
    expect(workspacesOf(null)).toEqual([]);
  });
});
