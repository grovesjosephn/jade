---
name: jade-workspace
description: >-
  Documents the Jade CLI multi-repo workspace layout (bare repos under .bare/,
  main and named worktree groups), discovery by walking up to .bare/, and
  commands for init, add, contextual status, and workspace add/list/remove. Use when
  working in a Jade-managed tree, automating Jade, or when the user mentions
  jade, multi-app workspaces, git worktrees, or .bare/.
---

# Jade workspace

## Mental model

Jade keeps **one bare clone per app** under `.bare/<app>/`. Each **worktree group** is a directory of **git worktrees** (one per app) so every app can sit on the same branch name for a feature. The **`main`** group tracks default branches; other groups live under **`workspace/<name>/`** and usually use branch `<name>` across apps.

## Directory layout (ground truth)

Paths are relative to the **workspace root** (the directory that contains `.bare/`).

```
<workspace-root>/
  jade.json              # config: apps[], optional orgUrl
  .bare/
    <app>/               # bare clone (single source of truth for git objects)
  main/
    <app>/               # worktree on default branch (for main)
  workspace/
    <name>/              # named group (feature workspace)
      <app>/             # worktree; branch typically matches <name>
```

**Every non-`main` group is under `workspace/<name>/`** (`getWorktreeGroupPath` in `packages/cli/src/core/layout.ts`).

## Discovery

Commands resolve the workspace root by **walking up from cwd** until a `.bare/` directory exists (`findWorkspaceRoot`). Pass **`-w <path>`** (or `--workspace`) to use an explicit root when cwd is outside the tree.

## Command cheat sheet

| Command | Purpose |
|--------|---------|
| `jade init <path> [--orgUrl <url>]` | Create `.bare/`, `main/`, `workspace/`, and `jade.json`. |
| `jade add <repo-or-url> [--name <app>] [-b branch] [-w path]` | Bare-clone app into `.bare/<app>`, then add a worktree in **`main/<app>` only** (default branch). Existing feature groups are not touched; backfill with `jade workspace add <group> --apps <app>`. |
| `jade import <path> [--name <app>] [-b branch] [-g group]` | Bring an **existing local clone** into jade: `.bare/<app>` gets its branches, tags and `origin/*` refs (origin URL kept; no origin means local-only, like `jade create`), `main/<app>` sits on the default branch, and the checked-out branch plus **all uncommitted work** (staged, unstaged, untracked; `.env` too) goes to `workspace/<group>/<app>`. Group defaults to the branch name (`/` becomes `-`, recorded in `.jade-group.json`). Dirty work on the default branch or a detached HEAD needs `-g <name>` and goes on a new branch `<name>`. Every remote is kept with its URLs and refs. The source is never modified; the import ends by listing anything only the source has. |
| `jade import <path> [--name <app>] --check` | Don't import: compare a source with its existing import. Lists **blockers** (refs, stashes, uncommitted files, nested repos, submodule work or linked worktrees the import lacks) and **notes** (ignored files with sizes, hooks, per-repo git config, remotes that differ). Exits 1 on any blocker. `--name` is needed when the folder name isn't the app name. |
| `jade import <path> [--name <app>] --remove-source` | Rerun the check and delete the source only if there are no blockers. Notes don't block, so read them first. |
| `jade import … --json` | Any import mode as one JSON object: `mode`, paths (`source`, `bare`, `main`, `group`), `carried`, `remotes`, `published`, `safeToRemove`, `blockers`, `notes`, the raw `check`, `removed`, and `next` (commands to run next). Errors go to stderr as `{"error":{"message":...}}`. |
| `jade create <name> [-b branch] [--groups a,b\|all\|none] [--remote]` | Start a **new** repo locally: `.bare/<name>`, `main/<name>` with an empty first commit, and a jade.json entry. Also added to the current feature group (or `--groups`). No remote until `jade publish`. |
| `jade publish <app> [--url <url>] [--public] [--all-branches]` | Create the remote for a local-only app (`gh repo create` under `orgUrl`, or an existing empty repo via `--url`), push the default branch, and set up tracking. |
| `jade status [<group>] [--root] [--json] [-w path]` | **Contextual — output shape depends on cwd.** See "Reading `jade status`" below. |
| `jade skills install [--project <dir>] [--target cursor\|claude\|all] [--scope project\|user]` | Copy bundled skills into `.cursor/skills/` and/or `.claude/skills/`, project-local or under the home directory. |
| `jade workspace add <name> [-a] [--apps app1,app2] [--from <branch>] [-w path]` | Create `workspace/<name>/` (or add missing apps). `-a` adds all apps without prompting; `--apps` adds exactly the named apps non-interactively (bypasses both `-a` and the prompt). New branches start from the bare repo's HEAD, or from `--from` (whichever of local `<from>` and `origin/<from>` is further ahead; an app where it doesn't exist is skipped). A branch that exists only on origin is checked out from it. |
| `jade workspace list [-w path]` | List groups and each app's current branch. |
| `jade review <ticket> [--pick app=branch] [--no-gh] [--dry-run]` | Build `workspace/<ticket>/` from the apps whose branch or open PR matches the ticket, each on its real branch. See [[jade-review]]. |
| `jade exec [-g group] [--apps a,b] [-p] -- <cmd...>` | Run a command in every app of a group (current group by default), with `JADE_APP`/`JADE_GROUP`/`JADE_ROOT` set; exits non-zero if any app failed. |
| `jade doctor [group] [--dry-run] [--add-missing] [--json]` | Apply the fixes `jade status` reports (drift, detached HEAD, missing `.env`; missing worktrees with `--add-missing`). Skips dirty worktrees and branches checked out elsewhere; exits non-zero while problems remain (with `--dry-run`, while anything would be fixed). |
| `jade workspace remove <name> [-d] [-f] [-w path]` | Remove group worktrees and delete `workspace/<name>/`. **Cannot remove `main`.** `-d` deletes branch `<name>` in the apps that have it locally (from `main/<app>` as reference), and says which ones it skipped as unmerged and which failed for another reason; `-f` force-deletes branches. |

## Reading `jade status`

`jade status` reports **two different things** depending on where it runs. Always know which one you asked for.

| Invocation | Output |
|---|---|
| From the workspace root (or any path outside a group) | **Root summary**: jade version, root, optional `org`, group names. |
| From inside `main/` or `workspace/<name>/` (at any depth) | **Workspace view** for that group: the group name, then one line per **installed** app with its branch. |
| `jade status <group>` | Workspace view for `<group>` from anywhere. Wins over `--root`. |
| `jade status --root` | Forces the root summary even from inside a group. |

The text workspace view is deliberately terse — group name plus installed apps and branches:

```
workspace: feat-auth
  cms       feat-auth
  frontend  feat-auth-a1b2c3d  [drift]
```

Markers cover only what can contradict the branch: `[drift]` (branch ≠ group name) and `[detached]` (detached HEAD). Apps with **no worktree in this group are omitted** from the text view.

**`--json` is the full report — use it for anything beyond eyeballing branches.** It adds, per app, `tree` (staged/unstaged/untracked + `clean`), `env` (`present`/`sourceAvailable`), and `present: false` rows for apps missing from the group; plus `herdr` (herdr-tui) open/focused state and an `attention[]` array pairing each problem with the command that fixes it. `attention[].kind` is one of `branch-drift`, `detached-head`, `missing-worktree`, `missing-env`, `git-error`, `unpublished` (no remote yet; `jade doctor` leaves this one alone). Each app's `expectedBranch` is what drift is measured against: the default branch in `main`, the branch recorded in `.jade-group.json` for a review or import group, else the group name.

```
--json (root)      → {view:"root", version, root, orgUrl, groups:[...]}
--json (workspace) → {view:"workspace", workspace, path, isMain, apps:[...], attention:[...], herdr?}
```

**When scripting or parsing, always pass `--root` or an explicit `<group>`** — never rely on cwd. Branch on the `view` field, don't assume a shape.

Cost: root view is a pure directory scan; the text workspace view is one git call per app; `--json` is two plus a herdr-tui query. Ahead/behind vs upstream is **not** reported — it would need a fetch to be truthful.

## Agent workflow

When output isn't a terminal (as when an agent runs jade), it's plain lines tagged `ok`, `info`, `warn`, `error`, `done` or `-`, with errors on stderr. Prefer `--json` where a command has it (`status`, `doctor`, `workspace list`, `import`). Commands that would prompt need their flags instead, for example `jade workspace add <name> -a` or `--apps a,b`.

1. Run **`jade status --root`** (or **`jade status --root -w <workspace-root>`**) for root, version, org, and group names.
2. Run **`jade status <group>`** to see one group's apps and branches; add **`--json`** when you need dirty state, `.env` gaps, missing apps, or fix commands. Prefer it over **`jade workspace list`** when you care about *one* group; `jade workspace list` remains the way to see branches across *all* groups at once.
3. Treat **"workspace"** in Jade as a **group**: either **`main/`** or **`workspace/<name>/`**.
4. Edit and run git **inside** `main/<app>/` or `workspace/<name>/<app>/`, not inside `.bare/`.
5. After **`jade workspace add`**, run **`jade status <name>`** — it flags a uniquified branch as `[drift]`; `jade doctor <name> --dry-run` shows the fix, and `jade doctor <name>` applies it.

## Migrating an existing project

Use this checklist whenever a project already exists on disk, whatever shape it's in.

1. **Look at the source before touching it.** Note its current branch, uncommitted work, stashes, other worktrees, submodules, nested repos, remotes beyond `origin`, and any merge or rebase in progress. Also find terminals, editors or agents whose working folder is inside it (`hc ls` in herdr), because those will need to move.
2. **Get it into an importable shape.** Stop and ask the user when this would change the source:
   - Not a git repo, or a repo with no commits: `jade import` refuses it. Ask before running `git init` or making a first commit. Commit with the identity the user's other repos use, and check that `.gitignore` keeps out secrets and build output.
   - A merge, rebase, cherry-pick or bisect in progress: ask the user to finish or abort it.
   - Inside the jade root (but not under `.bare/`, `main/` or `workspace/`): import refuses it, so move it outside the root first.
   - A linked worktree: import the main checkout instead.
3. **Choose where the work goes.** The checked-out branch and its uncommitted work go to `workspace/<branch>/`. Work on the default branch or a detached HEAD needs `-g <name>`. Pass `--name` when the folder name isn't the app name you want.
4. **Import:** `jade import <path> [--name <app>] [-g <group>] --json`. Read `blockers`, `notes` and `next` in the result: they already list what only the source has.
5. **Rebuild in the new worktree.** Ignored files aren't copied, so install dependencies and build following the project's own README, Makefile or package scripts, then run its tests. If something fails, run the same step in the source too, so you can tell whether the import caused it.
6. **Check:** `jade import <path> [--name <app>] --check --json`. Each blocker is data only the source has. Deal with it (push or import the branch, apply or export the stash, move the nested repo) and check again. Don't delete around a blocker.
7. **Review the notes with the user.** Ignored files are usually `node_modules` and build output, but they can also hold hand-made logs, local config or data. Ask before losing anything that isn't clearly regenerable. Recreate any hooks or per-repo config (`user.*`, LFS settings) the user wants.
8. **Remove the source:** `jade import <path> [--name <app>] --remove-source`. Never `rm -rf` it yourself.
9. **Repoint anything that used the old path.** That includes shells, editor workspaces, scripts and herdr spaces (`cd` their terminals into `main/<app>` or `workspace/<group>/<app>`).

## Pitfalls

- **`main` is special**: listed with other groups but lives at **`main/`** at the root; **`jade workspace remove main`** is rejected.
- **`jade add short-name`** requires **`orgUrl`** in `jade.json`; otherwise use a full git URL.
- **Folder name vs branch**: the group directory name is the *intended* branch for non-`main` groups; collisions can produce a different branch name—**`jade status <group>`** shows the real branch and flags it `[drift]`.
- **`jade status` is cwd-sensitive**: the same command prints a group list at the root and a per-app report inside a group. Pass **`--root`** or an explicit **`<group>`** whenever the shape matters.
- **A workspace can silently lack an app**: **`jade add`** only creates worktrees in `.bare/` and `main/`, so groups created earlier miss it. The terse text view **omits** such apps — use **`jade status <group> --json`** to see them (`present: false`); **`jade workspace add <group> --apps <app>`** or **`jade doctor <group> --add-missing`** backfills.

- **Unpublished apps have no other copy**: an app from `jade create` lives only in `.bare/` until `jade publish`. `jade remove` refuses it (and apps with unpushed commits or uncommitted changes) without `-f`. Don't pass `-f` for the user; tell them what would be lost. `jade update`, `jade workspace update` and `jade review` skip fetching unpublished apps.

## Where to install this skill

- **Project**: from the target repo root, run **`jade skills install`** (optional **`--project <dir>`**, **`--target cursor|claude|all`**) — auto-detects and copies bundled skills into **`.cursor/skills/`** and/or **`.claude/skills/`**.
- **Personal**: run **`jade skills install --scope user`** to install into **`~/.cursor/skills/`** and/or **`~/.claude/skills/`** for use across all projects.

Do not place custom skills under `~/.cursor/skills-cursor/` (reserved for Cursor).

## Out of scope here

For **`jade checkout`**, **`jade update`**, **`jade remove`** (app removal), and opinionated multi-app workflows, read the CLI help or a follow-up skill—this skill covers workspace **layout and lifecycle** only.
