# Changelog

Notable changes to `jade`, a CLI for managing multi-repo development workspaces built on git bare repos + worktrees. No git tags/releases yet, so earlier entries are grouped by rough date; the current line reflects `packages/cli`'s `package.json` version.

## Unreleased

- `jade review <ticket>`: fetches every app, then builds `workspace/<ticket>/` with only the apps whose branch names (or, with `gh`, open PR titles) match the ticket, each checked out on its real branch with no placeholder branch. Matching is bounded, so `JADE-1` doesn't match `JADE-12`. Apps with several candidates are left out and reported until you choose with `--pick app=branch`. `--dry-run` and `--no-gh` are also available. A local branch left over from an earlier review is fast-forwarded to the PR's latest commit, and one that has diverged is left alone with a warning. This replaces the manual recipe in the `jade-review` skill.
- `jade workspace add --from <branch>`: start new branches from a branch, tag or commit. For a branch, it uses `origin/<branch>` when the local branch is only behind, and the local branch when it has unpushed commits instead of the bare repo's HEAD. New branches don't track the start point, so `git push` doesn't target it. An unknown start point skips that app instead of quietly falling back to HEAD.
- `jade exec [-g group] [--apps a,b] [-p] -- <cmd...>`: run a command in every app of a group, sequentially or in parallel, with `JADE_APP`, `JADE_GROUP` and `JADE_ROOT` set.
- `jade doctor`: applies the fixes `jade status` reports. It handles branch drift, detached HEADs, missing `.env` files and, with `--add-missing`, missing worktrees. It skips dirty worktrees and branches checked out elsewhere, supports `--dry-run` and `--json`, and exits non-zero while problems remain. Under `--dry-run` that includes anything it would fix, so it works as a check.
- `workspace add` (and `review`/`doctor`) now creates a branch that exists only on origin from `origin/<branch>`, tracking it. Previously it created an empty branch from HEAD, which missed branches pushed after the clone.
- `workspace add` now fails, and removes the new group directory, when no app could be added.
- `jade create <name>`: start a new repository locally, with an empty bare repo, a `main/` worktree with an empty first commit (so feature branches have something to branch off), and a `jade.json` entry. Run it inside a feature group and the app is added there too; `--groups a,b|all|none` overrides that. `--remote` publishes right away.
- `jade import <path>`: bring an existing local clone into the workspace. Its branches, tags and `origin/*` refs are copied into `.bare/<app>` without touching the network, and origin keeps pointing at the real remote (a clone with no origin imports as local-only). `main/<app>` is checked out on the default branch. The checked-out branch goes to `workspace/<group>/<app>` along with every uncommitted change: staged stays staged, unstaged stays unstaged, untracked files are copied, and `.env` is stored for the app. The group is named after the branch, and a branch like `feature/x` becomes group `feature-x`, with the real branch recorded in `.jade-group.json`. Work on the default branch or a detached HEAD needs `--group <name>` and goes on a new branch. Linked worktrees, submodules, repos with no commits and repos mid-merge or mid-rebase are refused. The source repo is never modified, and a failed import is undone.
- `jade import` keeps every remote, not just `origin`: each remote's fetch and push URLs, its remote-tracking refs and its `<remote>/HEAD`. A relative local-path remote is made absolute so it still resolves from `.bare/`. Whether the app counts as published still depends only on `origin`.
- `jade import <path> --check` compares a source clone with its import and lists what deleting the source would lose. Blockers are branches, tags or remote refs whose objects are missing, a detached HEAD, stashes, uncommitted or untracked files whose content is in neither the bare repo nor its worktrees, untracked nested repos, submodules with local work, and linked worktrees. Notes are ignored files with sizes, hooks, per-repo git config and remotes that differ. It exits 1 on any blocker. `--remove-source` reruns the check and deletes the source only if there are no blockers. Every import now ends with the same report, replacing the generic "you can delete it" message and the separate stash and worktree warnings.
- `jade import --json` prints one JSON object instead of text: the mode (`import`, `check` or `remove-source`), the app, source and bare repo paths, `main` and `group` (path, branch, whether the branch is new), carried work, remotes, whether the app is published, and the check (`safeToRemove`, `blockers`, `notes`, the raw `check` data, and for `remove-source` whether it `removed` the source). It also includes `next`, the commands to run next. `--check` still exits 1 on blockers, after printing the object. Errors go to stderr as `{"error":{"message":...}}`, so stdout stays empty. `doctor --json` and `workspace list --json` now keep error messages off stdout the same way.
- Plain output for agents and scripts: when stdout isn't a terminal, every command prints plain lines instead of clack's boxes. There are no escape codes, spinner frames or spacer lines, and each line starts with a tag (`ok`, `info`, `warn`, `error`, `done`, or `-` for a step). The wording matches the terminal output, and errors go to stderr. `JADE_PLAIN=1` forces plain output, and `JADE_PLAIN=0` forces the terminal look. `jade workspace add` without `-a` or `--apps` and no terminal now stops with a hint instead of waiting on a prompt nobody can answer.
- `jade publish <app>`: create the remote for a local-only app with `gh repo create` under `orgUrl`, or push to an existing empty repo with `--url`. It sets the same fetch refspec and upstream tracking `jade add` sets up. If the push fails, the app is left local-only so you can retry.
- Guards for work that exists only on disk. `jade remove` now refuses to delete an app that was never published, has unpushed commits, or has uncommitted changes, unless you pass `-f`. `jade workspace remove -d -f` no longer force-deletes unmerged branches of unpublished apps. `jade update` and `jade workspace update` skip unpublished apps, and `jade review` doesn't fetch them or search them for PRs. `jade status --json` flags them with the attention kind `unpublished`, which `jade doctor` ignores.
- `jade status`: the `main` group now expects each app's default branch (e.g. `develop`), not a branch literally named `main`. The missing-worktree fix now names the app (`jade workspace add <group> --apps <app>`). Review groups are checked against their recorded branches.
- The herdr plugin package is now `packages/herdr-tui` (`jade-herdr-tui-plugin`), and jade's messages and docs call the multiplexer herdr-tui, to tell it apart from herdr-core (`hc`). Nothing to change in your setup: the plugin id (`josephgroves.jade`), the `herdr` binary, the `HERDR_*` variables and the `herdr` key in `jade status --json` stay the same. If you linked the plugin from a local checkout, re-link it from `packages/herdr-tui`.
- A herdr-app mod (`packages/herdr-app`): one card per group with its apps' branches, changes, drift and missing worktrees, the agents working in each, and buttons to open the group as a space (a root tab plus one tab per app), run `jade doctor`, run `jade update`, or create a group. Install with `packages/herdr-app/install.sh`.
- Internal: a herdr-core adapter, `adapters/herdr-core.ts` (it drives the `hc` CLI), for starting, listing, messaging, reading, waiting on and killing herdr-core terminals. No command uses it yet.

## 0.2.0 — 2026-08

- `jade workspace add --apps app1,app2` — pick an explicit, non-interactive list of apps to add, instead of `--all` or the interactive prompt. Used by the `jade-review` skill to scaffold ticket-scoped workspaces with only the relevant apps.
- `jade skills install` can now target Claude Code (`.claude/skills/`) as well as Cursor (`.cursor/skills/`), with `--target cursor|claude|all` (auto-detected by default) and `--scope project|user` (install into the home directory for use across all projects).
- Added the `jade-review` skill: a recipe for assembling a `workspace/<ticket-id>/` group containing only the apps with a matching branch or PR for a given ticket.
- `jade workspace update` — merge each app's latest default-branch changes into a workspace group.
- Internal refactor for cleaner dependency-injection seams (`GitProcessRunner`/`GitError`, `fs-backend`, `config-backend`) so commands are easier to test and extend.

## 0.1.2 — 2026-08

- `jade status` made contextual — reports a root summary outside a workspace, or a per-app report when run inside one; added `--json` output and an `attention[]` list of detected problems with fix-it commands.
- Fixed bare-clone fetch ordering so worktree upstream tracking resolves correctly, and fixed newly-added repos only landing in `.bare/` + `main/`.

## 2026-07

- Two-way [herdr](https://herdr.dev) terminal multiplexer integration (`herdr/` package): `jade open` turns a workspace group into a herdr workspace with a root tab plus one tab per app, plus a quick workspace-switcher pane.
- Dependency updates.

## 2026-05

- Added `.env` sync: a dedicated command plus auto-copy of `.env` files when adding apps to a workspace.

## 2026-03

- Introduced bundled agent skills: `jade skills install` copies skill docs (e.g. `jade-workspace`) into a project so coding agents understand the jade layout; skill text is embedded at build time so compiled binaries need no external `skills/` folder.
- Renamed "worktree" command family to "workspace" for clarity.
- Reworked workspace management with interactive (Clack) prompts and the current `main/` + `workspace/<name>/` directory layout.
- Reworked `jade status` output to be plain and machine-readable.

## 2026-02

- Initial version of `jade`: a CLI for managing multiple git repos as worktree-based workspaces (bare clone once under `.bare/`, checkout branches as worktrees).
- Added core commands: `add`, `remove`, worktree/workspace management, and branch/checkout handling.
- Introduced the `GitBackend` interface so git plumbing can be swapped for a test fake — the basis for the project's test suite.
