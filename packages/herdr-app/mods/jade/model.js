// What the jade panel shows, worked out from `jade status --json` and Herdr's
// live spaces, panes and agents. No imports: the mod and its tests share it.

/** Status words, most urgent first (Herdr's own order). */
const URGENCY = ["blocked", "done", "working", "idle"];

const trim = (p) => p.replace(/\/+$/, "");
export const inside = (path, dir) => Boolean(path && dir) && (trim(path) === trim(dir) || path.startsWith(trim(dir) + "/"));

export function mostUrgent(statuses) {
  for (const s of URGENCY) if (statuses.includes(s)) return s;
  return null;
}

/** `~/x` for paths under home. */
export const tilde = (path, home) => (home && inside(path, home) ? `~${path.slice(home.replace(/\/+$/, "").length)}` : path);

/** A review group's name: a ticket id like JADE-42. */
export const isTicket = (name) => /^[A-Z][A-Z0-9]+-\d+$/.test(name);

/** main first, then feature groups by name, then review groups. */
export function orderGroups(names) {
  return [...names].sort((a, b) => (b === "main") - (a === "main") || isTicket(a) - isTicket(b) || a.localeCompare(b));
}

/** Where a space is now: its first terminal's live folder, else where it was made. */
export function placeOf(space, paneList) {
  const tabs = new Set((space.tabs ?? []).map((t) => t.id));
  return paneList.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder || null;
}

/**
 * The Herdr space showing a group: one named after it whose terminals are in
 * it, else any whose first terminal is in it. Local spaces only: jade runs here.
 */
export function spaceForGroup(group, spaceList, paneList) {
  const local = spaceList.filter((s) => !s.machine);
  const at = (s) => placeOf(s, paneList);
  return (
    local.find((s) => s.named && s.name === group.name && inside(at(s), group.path)) ??
    local.find((s) => inside(at(s), group.path)) ??
    null
  );
}

/** Agents whose pane sits in `dir`, with the pane's folder. */
export function agentsIn(dir, agentList, paneList) {
  const cwd = new Map(paneList.map((p) => [p.pane, p.cwd]));
  return agentList.filter((a) => inside(cwd.get(a.pane), dir));
}

/** One app row: what to draw, from its status entry. */
export function appState(app) {
  if (!app.present) return { kind: "missing", label: "not in this group" };
  if (app.error) return { kind: "error", label: app.error };
  if (app.detached) return { kind: "detached", label: "detached HEAD" };
  if (app.drift) return { kind: "drift", label: `expected ${app.expectedBranch}` };
  const t = app.tree ?? { staged: 0, unstaged: 0, untracked: 0, clean: true };
  if (!t.clean) return { kind: "dirty", label: changes(t) };
  return { kind: "clean", label: "" };
}

/** "+1 ~2 ?3": staged, unstaged, untracked; zeros left out. */
export function changes(tree) {
  return [
    tree.staged ? `+${tree.staged}` : "",
    tree.unstaged ? `~${tree.unstaged}` : "",
    tree.untracked ? `?${tree.untracked}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Problems `jade doctor` can act on. `unpublished` isn't one: it's a fact about
 * an app made with `jade create`, shown as a "local" pill instead.
 */
export const problems = (report) => (report?.attention ?? []).filter((a) => a.kind !== "unpublished");

/**
 * The app rows a group's card lists. main lists none: its card is just a way
 * to open it. Other groups list only the apps they hold a worktree of, not
 * every app in the root.
 */
export const shownApps = (report) => (report.workspace === "main" ? [] : (report.apps ?? []).filter((a) => a.present));

/** Totals for the header line. */
export function summary(reports) {
  const apps = new Set();
  let dirty = 0;
  let needs = 0;
  for (const r of reports) {
    for (const a of r.apps ?? []) {
      apps.add(a.name);
      if (a.present && a.tree && !a.tree.clean) dirty++;
    }
    if (problems(r).length) needs++;
  }
  return { apps: apps.size, groups: reports.length, dirty, needs };
}

/** A group name `jade workspace add` will take (the same rule as branch-safe folder names). */
export const validGroupName = (name) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes("..") && name !== "main";
