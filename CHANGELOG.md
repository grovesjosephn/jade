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
- `jade publish <app>`: create the remote for a local-only app with `gh repo create` under `orgUrl`, or push to an existing empty repo with `--url`. It sets the same fetch refspec and upstream tracking `jade add` sets up. If the push fails, the app is left local-only so you can retry.
- Guards for work that exists only on disk. `jade remove` now refuses to delete an app that was never published, has unpushed commits, or has uncommitted changes, unless you pass `-f`. `jade workspace remove -d -f` no longer force-deletes unmerged branches of unpublished apps. `jade update` and `jade workspace update` skip unpublished apps, and `jade review` doesn't fetch them or search them for PRs. `jade status --json` flags them with the attention kind `unpublished`, which `jade doctor` ignores.
- `jade status`: the `main` group now expects each app's default branch (e.g. `develop`), not a branch literally named `main`. The missing-worktree fix now names the app (`jade workspace add <group> --apps <app>`). Review groups are checked against their recorded branches.

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
