# jade for herdr-app

A [herdr-app](https://herdr.dev) mod that shows a jade root's groups and apps
next to your spaces and agents, and opens them as spaces.

- **One card per group:** `main`, feature groups, and review groups (ticket names like `JADE-42`, marked "review").
- **One row per app in the group** (main lists none: its card just opens it; other groups list only the apps they have a worktree of): its branch, uncommitted changes (`+staged ~unstaged ?untracked`), drift or a detached HEAD in red, a missing worktree, and a "local" pill for apps not published yet.
- **Live agents:** a spinner while an agent in that group or app is working, a pulsing "Needs you" when one is blocked, and a dot when one finished. A card's left stripe follows the same order, then yellow for problems, then the accent color when the group is open.
- **Open / Go:** opens the group as a space named after it, with a root tab (an agent there sees every app) and one tab per app. When the space already exists, it goes there. Clicking an app opens or selects that app's tab.
- **Fix** runs `jade doctor <group>`. **Update** runs `jade update`. **New group** runs `jade workspace add <name> --all`.

It finds the root from the focused terminal's folder, then the shown space's,
then the last root it used. When none of those is in a root, it offers a
folder picker. It reads again every 20 seconds, and after each action.

## Install

```bash
packages/herdr-app/install.sh     # copies mods/jade/ into ~/.config/herdr-app/mods/jade
```

Re-run it after editing the mod. It copies rather than symlinks because
herdr-app doesn't reload a symlinked mod folder when its files change.

## Show it

- As a popup: `herdr-app do mod.open '{"name":"jade"}'`. Bind it to a key in `~/.config/herdr-app/keys.json`, for example `"global": { "ctrl-shift-j": "mod.open:jade" }`.
- As a tab: `herdr-app do tab.new '{"name":"jade","mod":"jade"}'`.
- In your layout: a block with `"content": { "mod": "jade" }`.

Optional props: `root` (a jade root to show instead of looking for one) and
`bin` (the jade program; default `jade` on your PATH).

## Develop

`mods/jade/model.js` holds the logic and has no imports, so `test/model.test.ts`
runs under `bun test`. `main.js` is the view. Check a change with
`herdr-app check ~/.config/herdr-app/mods/jade` after installing it.
