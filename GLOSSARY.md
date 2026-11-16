# Glossary

The words jade's code, docs and output use, and what each one means. Names in
`code` are the identifiers you'll find in `packages/cli/src`.

## Hub and workspace

jade has two levels: one **hub** holds your apps, and each **workspace** in it is
a folder of those apps checked out side by side, usually all on one branch.

Before 0.4 these were called the **root** (or "workspace root") and a **group**.
A few old names stay on purpose so existing scripts and hubs keep working:

| Old name | Where | Now |
|---|---|---|
| `-w, --workspace <path>` | every command | `--hub <path>`. The old flag still works, with a warning. |
| `jade status --root` | status | `--summary`. The old flag still works, with a warning. |
| `root`, `groups`, `group` | `--json` output | Printed beside `hub`, `workspaces`, `workspace`. Read the new keys. |
| `view: "root"` | `jade status --json` | `view: "hub"`. This one can't hold both, so it changed. |
| `JADE_ROOT`, `JADE_GROUP` | `jade exec` | Set beside `JADE_HUB`, `JADE_WORKSPACE`. |
| `-g, --group` and `--groups` | `exec`, `open`, `import`, `create`, `workspace update` | Unchanged flag names; their values are workspaces. `--workspace` can take over once `-w/--workspace` is removed. |
| `.jade-group.json` | in a workspace | Unchanged, so older jade versions can still read it. |

"Workspace" also means a **herdr-tui workspace**, the multiplexer's own idea of
one (`HerdrTuiWorkspace`, `workspaceId`, `findTuiWorkspaceByLabel`). `jade open`
opens a jade workspace as a herdr-tui workspace of the same name. Say
"herdr-tui workspace" in full when you mean that one.

## Layout

**Hub.** The directory holding `.bare/` and `jade.json`: everything jade
manages lives under it. Commands find it by walking up from the current
directory until they see `.bare/` (`findHub`), or take it from `--hub`
(`resolveHub`, with the shared `hubArgs` flags in `core/hub.ts`). The code calls
it `hub`.

**`jade.json`.** The hub's config (`JadeConfig`): `version`, the `apps` list
(`AppItem`: a name, or `{ name, defaultBranch }`) and optional `orgUrl`. The
order of `apps` is the order jade lists apps and opens tabs.

**`.bare/`.** One bare clone per app (`.bare/<app>`). It holds the app's real git
data. Every checkout is a worktree of it, so history is stored once.

**App.** One repository: a bare clone at `.bare/<app>` and an entry in
`jade.json`. Elsewhere this would be called a repo. An app may have a worktree in
any number of workspaces.

**Worktree.** A `git worktree` of an app's bare clone: the checked-out files you
work in. Each worktree lives in a workspace, at `<workspace>/<app>/`.

**Workspace.** A directory with one worktree per app, usually all on the same
branch. `main/` and every `workspace/<name>/` are workspaces, and the
`jade workspace …` commands manage them. The code uses `workspace`,
`workspaceName`, `workspacePath` and `ResolvedWorkspace`.

- **main workspace** (`main/`): each app on its default branch. It can't be removed.
- **feature workspace** (`workspace/<name>/`): made by `jade workspace add <name>`. Each app is on branch `<name>`.
- **review workspace** (`workspace/<ticket>/`): made by `jade review <ticket>`. It holds only the apps with a matching branch or PR, each on its real branch.
- **import workspace**: made by `jade import` for a branch whose name can't be a folder name, such as `feature/x`, which becomes workspace `feature-x`.

**`workspace/`.** The folder in the hub that holds every workspace except `main`.

**Workspace metadata** (`.jade-group.json`, `WorkspaceMeta`). Stored in a review
or import workspace to record what it's *supposed* to look like: its `kind`
(`review` or `import`), the `ticket`, and the expected branch for each app.
Without it, jade assumes the default shape: every app present, each on a branch
named after the workspace. The file keeps its old name for compatibility.

**Present / missing.** Whether an app has a worktree in a workspace
(`ResolvedApp.present`). A missing worktree is an app in `jade.json` with no
worktree in the workspace. `jade status` reports it as a problem unless the
workspace's metadata leaves that app out on purpose, as a review workspace does.

**`.env/`.** Per-app env templates at `.env/<app>/.env`. `jade workspace add`
copies one into each new worktree, and `jade env sync` copies them into every
worktree of the app.

## Branches

**Default branch.** An app's main line, such as `main` or `develop`, detected
from the remote or set with `jade add --branch` (`defaultBranch` in `jade.json`).
The main workspace checks it out.

**Expected branch.** The branch an app should be on in a workspace: the default
branch in `main/`, the workspace's name in a feature workspace, or the branch recorded
in workspace metadata.

**Start point.** What a new branch starts from. By default it's the bare repo's
HEAD. `jade workspace add --from <branch|tag|commit>` sets another.

**Suffixed branch.** When git won't check out the expected branch, because
another worktree has it or a name like `test/x` clashes with `test`, jade
creates `<branch>-<short sha>` instead. That app is then in drift.

## Health

**Drift** (`branch-drift`). An app that's on a different branch from the one
expected.

**Detached HEAD** (`detached-head`). An app worktree that isn't on any branch.

**Dirty / clean.** Whether a worktree has staged, unstaged or untracked changes
(shown as `+staged ~unstaged ?untracked`).

**Attention.** The list of problems `jade status --json` reports (`Attention`,
`buildAttention`). Each item has a `kind` and the command that fixes it. The kinds
are `missing-worktree`, `git-error`, `detached-head`, `branch-drift`,
`unpublished` and `missing-env`. `jade doctor` applies the fixes, except for
`unpublished`, which is a fact rather than a problem.

## Remotes and publishing

**`orgUrl`.** Where `jade add <name>` looks for repos and where `jade publish`
creates them. It can be a full URL, a bare GitHub owner (`acme`) or `host/owner`
(`gitlab.com/acme`).

**Published / unpublished (local-only).** An app is published once it has an
`origin` remote. Apps made with `jade create` aren't published until
`jade publish`. jade refuses to delete unpublished work without `-f`, and
`jade update` skips unpublished apps.

## Commands' own terms

**Ticket.** The id `jade review` is given, such as `JADE-42`. Branches and PR titles
match it on a word boundary, so `JADE-1` doesn't match `JADE-12`.

**Candidate / ambiguous.** In `jade review`, a branch or PR that matches the
ticket is a candidate. An app with more than one candidate is ambiguous. It's left
out until you choose with `--pick app=branch`.

**Source.** In `jade import`, the existing clone being brought in. It's never
modified.

**Carried work.** The uncommitted changes `jade import` moves from the source
into the workspace's worktree: staged, unstaged, untracked and `.env`.

**Blockers / notes.** What `jade import --check` reports. A blocker is something
deleting the source would lose (for example a stash or an unpushed branch), and
it makes the check fail. A note is worth knowing but loses nothing (ignored
files, hooks, local git config).

## Output

**Plain output.** What jade prints when stdout isn't a terminal: tagged lines
(`ok`, `info`, `warn`, `error`, `done`, `-`) with no boxes, spinners or escape
codes. `JADE_PLAIN=1|0` forces it on or off. The terminal look comes from clack
(`@clack/prompts`), and `adapters/ui.ts` switches between the two.

**JSON mode** (`setJsonMode`). Commands with `--json` print exactly one JSON object
to stdout and send everything else to stderr.

**`canPrompt`.** Whether jade can ask a question: stdin and stdout are both a
terminal. When it can't, a command that would prompt stops with a hint instead.

## Code structure

**Command.** One CLI command, one file in `commands/`, built by a
`make*Command(...)` factory. The path matches the invocation:
`commands/workspace/add.ts` is `jade workspace add`.

**Core.** `core/` holds jade's own concepts: layout, finding the hub, config,
workspaces, workspace metadata, health, `.env`, import checks and publishing. There are no prompts and
no `process.exit` in it.

**Adapter.** `adapters/` holds wrappers around outside programs and the
filesystem: git, gh, fs, herdr-tui, herdr-core, tmux and the UI.

**Backend.** An injectable interface that commands get their side effects
through: `GitBackend`, `FileSystemBackend`, `ConfigBackend`. Tests pass in the
mocks from `src/test/` instead of starting real git processes.

**Bundled skills.** The agent skills `jade skills install` writes into
`.claude/skills/` and `.cursor/skills/`. They're compiled into the binary from
`packages/cli/skills/` (`bundled-skills/registry.ts`).

## Around jade

**herdr-tui.** The `herdr` terminal multiplexer. `jade open` opens a workspace as a
herdr-tui workspace. `packages/herdr-tui` is jade's plugin for it (id
`josephgroves.jade`), with actions and overlay panes.

**herdr-core.** The separate terminal runtime, driven by the `hc` CLI. Call it
herdr-core in code and docs, and `hc` only for the command itself. jade has an
adapter for it (`adapters/herdr-core.ts`) that no command uses yet.

**herdr-app.** The desktop app built on herdr-core. `packages/herdr-app/mods/jade`
is jade's **mod** for it: the Jade panel, with one card per workspace.

**Space.** herdr-app's word for what herdr-tui calls a workspace. The mod's
Open/Go button opens a workspace as a space, with a root tab plus one tab per app.

**Root tab.** The tab or window `jade open` (and the mod) opens at the workspace's
own directory. Every app is a subfolder there, so an agent started in it sees
all of them.

**tmux session.** What `jade open` makes outside herdr-tui, or with `--tmux`. It's
named after the workspace, with a root window plus one window per app.
