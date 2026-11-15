# jade for herdr-tui

A [herdr-tui](https://herdr.dev) plugin (`josephgroves.jade`) that puts jade
into herdr-tui's UI. Version 0.1.0; see the [changelog](../../CHANGELOG.md).

| Entry point | Kind | What it does |
|---|---|---|
| **Jade: Open workspace group** | action | Runs `jade open` for the focused pane's group. |
| **Jade: Sync env files** | action | Runs `jade env sync`. |
| **Jade board** | overlay pane | Lists every group with its per-app branches. Pick one to open it, or create a new feature workspace. |
| **Jade: Switch workspace** | overlay pane | A fast switcher. Groups that are already open float to the top and get focused instantly. Picking a closed group runs `jade open`. |

Each script is a thin wrapper around the `jade` binary on your `PATH` (override
it with `JADE_BIN_PATH`), so none of jade's logic is duplicated here. The panes
get their data from `jade status --json --root` and `jade workspace list --json`.
It needs herdr-tui 0.7.0 or later and [Bun](https://bun.sh).

## Install

```bash
herdr plugin link /path/to/jade/packages/herdr-tui   # local development
herdr plugin install <org>/jade/packages/herdr-tui   # once published
```

## Bind the switcher to a key

Add this to `~/.config/herdr/config.toml`, then run `herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+shift+s"
type = "shell"
command = 'herdr plugin pane open --plugin josephgroves.jade --entrypoint switcher --placement overlay --focus --env JADE_CWD="$HERDR_ACTIVE_PANE_CWD"'
description = "Jade: switch workspace"
```

`JADE_CWD` passes along the focused pane's directory, so the switcher finds the
right workspace root whatever the plugin's own working directory is.

## Layout

- `herdr-plugin.toml`: the plugin's id, version, actions and panes.
- `actions/`: `open-group.ts` and `sync-env.ts`.
- `panes/`: `board.ts` and `switcher.ts`.
- `lib/`: finding the jade root and driving herdr-tui, with tests in `lib/__tests__/`.

When you bump the version, change it in both `package.json` and `herdr-plugin.toml`.

## Develop

```bash
bun test             # from this folder, or from the repo root for everything
bun run typecheck
```
