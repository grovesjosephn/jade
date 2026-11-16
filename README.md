<div align="center">

# 💎 jade

**Multi-repo workspaces built on git bare repos and worktrees.**

Clone each repo once. Work on many branches across many repos at the same time.

![Bun](https://img.shields.io/badge/runtime-bun-f9f1e1?logo=bun&logoColor=black)
![TypeScript](https://img.shields.io/badge/lang-typescript-3178c6?logo=typescript&logoColor=white)
![Git](https://img.shields.io/badge/git-%E2%89%A52.5-f05032?logo=git&logoColor=white)
![Version](https://img.shields.io/badge/version-0.3.0-2e8b57)

[Why jade?](#-why-jade) ·
[Install](#-install) ·
[Quick start](#-quick-start) ·
[Layout](#-how-it-works) ·
[Commands](#-commands) ·
[herdr-tui & tmux](#-herdr-tui--tmux) ·
[Agent skills](#-agent-skills) ·
[Development](#-development)

</div>

---

## ✨ Why jade?

A feature that touches a frontend, a backend, and a shared library usually means
juggling three clones, three branch switches, and a lot of `git stash`. jade turns
that into one command:

```bash
jade workspace add feat-auth
```

That gives you `workspace/feat-auth/` with **every app checked out on a
`feat-auth` branch**, side by side, with `.env` files already in place. Your
`main/` checkouts stay untouched, so you can keep working on other branches
while a review is open.

- 🪶 **One clone per repo.** Every checkout is a `git worktree` of a single bare clone, so history is never duplicated.
- 🌿 **A workspace per branch.** A *hub* holds your apps; each *workspace* in it is a folder of those apps, all on one branch.
- 🧭 **Contextual.** Commands work out which hub and workspace you're in by walking up from your current directory.
- 🩺 **Self-diagnosing.** `jade status` flags branch drift, detached HEADs, dirty trees, and missing `.env` files, and suggests the command that fixes each one.
- 🖥️ **Terminal-native.** `jade open` turns a workspace into a [herdr-tui](https://herdr.dev) workspace or a tmux session, with one tab per app.
- 🤖 **Agent-ready.** It ships skills that teach Claude Code and Cursor how a jade hub is laid out.

## 📦 Install

Requires [Bun](https://bun.sh) ≥ 1.0 and Git ≥ 2.5.

```bash
bun install                 # install workspace dependencies

# Option A: compile a standalone binary to ~/.local/bin/jade
bun run install-global

# Option B: link the TypeScript entry point for development
cd packages/cli && bun link
```

Check the install with `jade --help`. To remove the compiled binary, run `bun run uninstall`.

## 🚀 Quick start

```bash
# 1. Create a hub and point it at your GitHub org
jade init ~/work/acme --orgUrl https://github.com/acme
cd ~/work/acme

# 2. Add repos by name (resolved against orgUrl) or by full URL
jade add frontend
jade add backend
jade add git@github.com:other-org/shared-lib.git --name shared

# 3. Start a feature: a workspace with every app on branch feat-navigation
jade workspace add feat-navigation --all
cd workspace/feat-navigation

# 4. Hack, commit, push in each app as usual
cd frontend && git commit -am "nav" && git push -u origin HEAD

# 5. Check on everything
jade status

# 6. Pull in the latest main while you work
jade workspace update

# 7. Done? Remove the workspace (and its merged branches)
cd ~/work/acme
jade workspace remove feat-navigation -d
```

## 🧱 How it works

Each repository is cloned **once**, as a bare repo, into `.bare/`. Every checkout
you work in is a git worktree of that bare repo. The folder that holds it all is
the **hub**, and each folder of checkouts sharing a branch is a **workspace**
(see the [glossary](GLOSSARY.md)):

```
acme/                       # the hub
├── .bare/                  # one bare clone per app (the real git data)
│   ├── frontend/
│   └── backend/
├── main/                   # the "main" workspace: each app on its default branch
│   ├── frontend/
│   └── backend/
├── workspace/              # every other workspace lives here
│   └── feat-navigation/
│       ├── frontend/       # on branch feat-navigation
│       └── backend/        # on branch feat-navigation
├── .env/                   # optional per-app env templates
│   ├── frontend/.env
│   └── backend/.env
└── jade.json               # workspace config
```

A few details worth knowing:

- **Hub discovery.** Any jade command run from inside the tree walks up until it finds `.bare/`, so you can run it from any workspace or app directory. Pass `--hub <path>` to point at a hub explicitly.
- **Upstream tracking.** `git clone --bare` leaves out the fetch refspec. jade adds it back and does an initial fetch, so new worktrees track `origin/<branch>` automatically.
- **Branch collisions.** Git won't check out one branch in two worktrees, and it can't hold both `test` and `test/x`. When either happens, jade creates a uniquely suffixed branch instead (e.g. `feat-x-a1b2c3d`), and `jade status` reports that app as `[drift]`.
- **`.env` templates.** Files in `.env/<app>/.env` are copied into new worktrees by `workspace add`, and into every worktree by `jade env sync`.

### `jade.json`

`jade init` creates this file, and `add`/`remove` keep it up to date:

```json
{
  "version": "1.0",
  "orgUrl": "https://github.com/acme",
  "apps": [
    "frontend",
    { "name": "backend", "defaultBranch": "develop" },
    "shared"
  ]
}
```

| Field | Purpose |
|---|---|
| `orgUrl` | Lets you `jade add <repo-name>` instead of typing full URLs, and is where `jade publish` creates repos. Accepts `https://`, `ssh://`, scp-style `git@host:org`, a bare GitHub owner (`acme`, read as `https://github.com/acme`), or `host/owner` (`gitlab.com/acme`, read as https). |
| `apps` | The managed apps, in the order they were added. That order is also the tab order for `jade open`. |
| `defaultBranch` | Optional per-app override, set by `jade add --branch`. Otherwise jade detects it from the remote. |

## 🛠️ Commands

Every command that works in a hub accepts `--hub <path>` to target a hub other
than the one jade finds from your current directory. (`-w, --workspace <path>`
still works for now, with a deprecation warning.)

**Output for scripts and agents.** When stdout isn't a terminal, jade prints plain
lines instead of boxes and spinners: no escape codes, and each line starts with a
tag (`ok`, `info`, `warn`, `error`, `done`, or `-` for a step). Errors go to stderr.
`JADE_PLAIN=1` forces plain output and `JADE_PLAIN=0` forces the terminal look.
Commands that would prompt stop with a hint instead when there's no terminal.

### Setup

| Command | Description |
|---|---|
| `jade init <path> [--orgUrl <url>]` | Create a hub with `.bare/`, `main/`, `workspace/`, and `jade.json`. |
| `jade add <name\|url> [--name <app>] [-b <branch>]` | Bare-clone a repo into `.bare/` and check it out in `main/`. |
| `jade import <path> [--name <app>] [-b <branch>] [-g <workspace>]` | Move an existing local clone into the hub. Its branches, tags and origin are copied into `.bare/<app>`, `main/<app>` is checked out on the default branch, and the branch you were on (with its staged, unstaged and untracked changes, and its `.env`) lands in `workspace/<workspace>/<app>`. The workspace is named after the branch unless you pass `-g`. Uncommitted work on the default branch needs `-g <name>` and goes on a new branch of that name. The original directory isn't touched. `--check` lists what deleting it would lose (exiting 1 if anything would be), `--remove-source` deletes it only when nothing would, and `--json` prints one JSON object for scripts. |
| `jade create <name> [-b <branch>] [--groups a,b\|all\|none] [--remote [--public]]` | Start a brand-new repo locally: an empty bare repo in `.bare/`, `main/<name>` with one empty first commit, and a `jade.json` entry. Run it from inside a workspace and the app is added there too (or choose with `--groups`). No remote is created unless you pass `--remote`. The first commit needs a git identity (`user.name` / `user.email`). |
| `jade publish <app> [--url <url>] [--public] [--all-branches]` | Give a local-only app a remote. It runs `gh repo create <org>/<app>` (private by default) under `orgUrl`, or uses `--url` for an existing empty repo on any host. Then it pushes the default branch with tracking and sets up fetching the way `jade add` does. Other local branches are listed so you can push them yourself, or push them all with `--all-branches`. |
| `jade remove <app> [-f]` | Remove an app's worktrees from every workspace, delete its bare clone, and drop it from `jade.json`. It refuses when that would lose work: an app that was never published, commits that aren't on origin, or uncommitted changes. `-f` removes it anyway. |

### Workspaces

| Command | Description |
|---|---|
| `jade workspace add <name>` | Create `workspace/<name>/` with each chosen app on branch `<name>`. Choose apps with `-a/--all`, `--apps a,b`, or the interactive picker. Re-running it on an existing workspace adds the apps that are missing. `--from <branch>` starts new branches from that branch, tag or commit. For a branch, it uses whichever of the local branch and `origin/<branch>` is further ahead, so unpushed commits aren't dropped instead of the repo's HEAD. |
| `jade review <ticket> [--pick app=branch] [--no-gh] [--dry-run]` | Fetch every app, then create `workspace/<ticket>/` with only the apps that have a branch (or, via `gh`, an open PR title) matching the ticket, each checked out on its real branch. Apps with several candidates are left out until you choose one with `--pick`. |
| `jade workspace list [--json]` | List every workspace and the branch each app is on. |
| `jade workspace update [workspace]` | Merge each app's latest default branch into a workspace (the current one by default, or `main`). |
| `jade workspace remove <name> [-d] [-f]` | Remove a workspace's worktrees. `-d` also deletes branch `<name>` in the apps that have it, skipping unmerged ones unless you add `-f`, and reports any other refusal with git's reason. Unpublished apps' unmerged branches are never force-deleted. |

### Day-to-day

| Command | Description |
|---|---|
| `jade status [name] [--summary] [--json]` | Inside a workspace, show its apps and branches. Outside one, show the hub summary. |
| `jade update [-v]` | Fast-forward every app in `main/` to the latest from origin. |
| `jade checkout <branch> [--app <app>] [-c]` | Check out a branch (or create one with `-c`) in an app. |
| `jade exec [-g workspace] [--apps a,b] [-p] -- <cmd...>` | Run a command in every app of a workspace (the current one by default), with `JADE_APP`, `JADE_WORKSPACE` and `JADE_HUB` set (and their old names `JADE_GROUP` and `JADE_ROOT`). Keeps going past failures and exits non-zero if any app failed. `-p` runs all apps at once. A single quoted argument runs through `sh -c`. |
| `jade doctor [workspace] [--dry-run] [--add-missing] [--json]` | Fix what `jade status` flags: put drifted or detached apps back on their branch, and copy missing `.env` files. With `--add-missing`, it also creates missing worktrees. It never checks out over uncommitted changes or takes a branch another worktree has checked out. Outside a workspace, it checks every workspace. |
| `jade env sync` | Copy `.env/<app>/.env` into every worktree of that app. |
| `jade open [workspace] [--tmux]` | Open a workspace as a herdr-tui workspace or tmux session. See [below](#-herdr-tui--tmux). |
| `jade skills install` | Install the bundled agent skills. See [below](#-agent-skills). |

> **Adding a new app to an existing workspace:** `jade add` only checks the
> app out in `main/`. To pull it into a workspace, run
> `jade workspace add <workspace> --apps <app>`.

### Checking on a workspace

`jade status` adapts to where you run it. Inside a workspace, it lists each app and its
branch, and marks anything that doesn't match:

```console
$ cd ~/work/acme/workspace/feat-navigation
$ jade status
workspace: feat-navigation
  frontend  feat-navigation
  backend   feat-navigation-a1b2c3d  [drift]
```

Pass a name (`jade status feat-auth`) to report on a workspace from anywhere, or
`--summary` to force the hub summary (`--root` is its old name). `--json` returns the full report: working-tree
counts, `.env` gaps, missing worktrees, herdr-tui open state, and an `attention[]` list
that pairs each problem with the command that fixes it. `jade doctor` applies the
safe fixes for you.

A workspace made by `jade review` records each app's expected branch in
`workspace/<ticket>/.jade-group.json`. That way `status` and `doctor` don't count
its PR branches as drift, or its left-out apps as missing.

## 🖥️ herdr-tui & tmux

`jade open` lays a workspace out in your terminal multiplexer like this:

- 🏠 A **root tab or window** at the workspace's folder. Every app is a direct subdirectory there, so an agent like `claude` started in this tab can see all of them at once.
- 📁 **One tab or window per app**, opened in that app's directory, in `jade.json` order.
- ♻️ **No duplicates.** If the workspace is already open, `jade open` focuses or reuses it instead of creating it again.

```bash
cd workspace/feat-navigation
jade open              # open the current workspace
jade open feat-auth    # or name one (defaults to main when outside a workspace)
```

### herdr-tui

When jade runs inside a [herdr-tui](https://herdr.dev) session (`HERDR_ENV=1`), the
workspace becomes a **dedicated herdr-tui workspace** labeled with its name, and it
gets focus. jade drives herdr-tui through its `herdr` CLI and uses `HERDR_BIN_PATH` when it's set.

### tmux

Outside herdr-tui, or when you pass `--tmux`, jade creates a **tmux session** named
after the workspace. How it hands control to you depends on where you run it:

| Where you run it | What happens |
|---|---|
| A plain terminal | The session is created (or found), then attached with `tmux attach-session`. |
| Inside a tmux client (`$TMUX` set) | jade runs a non-blocking `switch-client` to the session. |
| Inside a herdr-tui pane, with `--tmux` | The session is created and left running in the background, so tmux isn't nested inside herdr-tui. |

jade uses `TMUX_BIN_PATH` when it's set, and otherwise `tmux` on your `PATH`.

### herdr-tui plugin

[`packages/herdr-tui`](packages/herdr-tui) is a [herdr-tui plugin](https://herdr.dev/docs/plugins/)
that puts jade into herdr-tui's UI:

| Entry point | Kind | What it does |
|---|---|---|
| **Jade: Open workspace** | action | Runs `jade open` for the focused pane's workspace. |
| **Jade: Sync env files** | action | Runs `jade env sync`. |
| **Jade board** | overlay pane | Lists every workspace with its per-app branches. Pick one to open it, or create a new feature workspace. |
| **Jade: Switch workspace** | overlay pane | A fast switcher. Workspaces that are already open float to the top and get focused instantly. Picking a closed one runs `jade open`. |

```bash
herdr plugin link /path/to/jade/packages/herdr-tui   # local development
herdr plugin install <org>/jade/packages/herdr-tui   # once published
```

To bind the switcher to a key, add this to `~/.config/herdr/config.toml`, then run
`herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+shift+s"
type = "shell"
command = 'herdr plugin pane open --plugin josephgroves.jade --entrypoint switcher --placement overlay --focus --env JADE_CWD="$HERDR_ACTIVE_PANE_CWD"'
description = "Jade: switch workspace"
```

The `JADE_CWD` part passes along the focused pane's directory, so the switcher
finds the right hub no matter what the plugin's own working directory is.

Each plugin script is a thin wrapper around the `jade` binary on your `PATH`
(override it with `JADE_BIN_PATH`), so none of jade's logic is duplicated in the
plugin. The panes get their data from `jade status --json --root` and
`jade workspace list --json`.

See its [README](packages/herdr-tui/README.md).

### herdr-app mod

[`packages/herdr-app`](packages/herdr-app) is a mod for [herdr-app](https://herdr.dev),
the desktop app. It shows `main` and every workspace as a card: each one lists
only the apps it has a worktree of, with their branches, changes and drift, plus
the agents working in it. From a card you can open the workspace as a space (a root
tab plus a tab per app), run `jade doctor` on it, or create a new workspace. Install
it with `packages/herdr-app/install.sh`, then show it as a side panel in your
layout, a tab, or a popup (`herdr-app do mod.open '{"name":"jade"}'`).
See its [README](packages/herdr-app/README.md).

## 🤖 Agent skills

jade ships skills that help coding agents work with a jade hub:

| Skill | Teaches the agent |
|---|---|
| `jade-workspace` | The layout, hub discovery, and the core commands. |
| `jade-review` | How to review a ticket across repos with `jade review`: reading its report, resolving ambiguous apps, and cleaning up. |

```bash
jade skills install                        # auto-detect .claude/ and/or .cursor/ in the cwd
jade skills install --target claude        # force a target: cursor | claude | all
jade skills install --scope user           # install to ~/.claude/skills, ~/.cursor/skills
jade skills install --project ../other-repo
```

The skill text is imported at build time, so a binary built with `bun build --compile`
contains the skills and doesn't need a `skills/` folder next to it.

## 🧑‍💻 Development

This repo is a Bun workspace with three packages:

| Package | Version | Description |
|---|---|---|
| [`packages/cli`](packages/cli) | 0.3.0 | The `jade` CLI (citty + @clack/prompts). This README is its documentation. |
| [`packages/herdr-tui`](packages/herdr-tui) | 0.1.0 | The herdr-tui plugin. See its [README](packages/herdr-tui/README.md). |
| [`packages/herdr-app`](packages/herdr-app) | 0.2.0 | The herdr-app mod. See its [README](packages/herdr-app/README.md). |

```bash
bun test                # run the test suite
bun run typecheck       # type-check every package
bun run jade status     # run the CLI from source
bun run build           # compile packages/cli/jade
```

Commands are written as `make*Command(...)` factories that take injectable
`GitBackend`, `FileSystemBackend`, and `ConfigBackend` implementations. Tests pass in
the mocks from `packages/cli/src/test/` instead of starting real git processes.

To check that compiled binaries embed the skill text, run
`bun run --cwd packages/cli test:embed`. It's left out of the default `bun test`
because some environments block creating `.cursor` in spawned processes.

See [CHANGELOG.md](CHANGELOG.md) for release history.
