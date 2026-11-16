# jade for herdr-app

A [herdr-app](https://herdr.dev) mod that shows a jade hub's workspaces and apps
next to your spaces and agents, and opens them as spaces. Version 0.3.0; see
the [changelog](../../CHANGELOG.md).

- **One card per workspace:** `main` first, then feature workspaces under "Workspaces" and review workspaces (ticket names like `JADE-42`) under "Reviews". Each card's header has the workspace's name over a summary line (its apps, its agents, and whether it's open as a space).
- **Only the workspace's own apps:** main's card lists none, since it's just a way to open main. Other workspaces list only the apps they have a worktree of, each with its branch, uncommitted changes (`+staged ~unstaged ?untracked`), drift or a detached HEAD in red, and a "local" pill for apps not published yet.
- **Live agents:** a dot by each workspace's name shows a spinner while an agent in it is working, a pulsing "Needs you" when one is blocked, and a dot when one finished. Otherwise the dot is filled with the accent color when the workspace is open as a space and hollow when it isn't. App rows show their own agents the same way, and the workspace you're looking at has an accent border.
- **Open / Go:** opens the workspace as a space named after it, with a root tab (an agent there sees every app) and one tab per app. When the space already exists, it goes there. Clicking an app opens or selects that app's tab.
- **Fix** runs `jade doctor <workspace>`. **Update** runs `jade update`. **New workspace** runs `jade workspace add <name> --all`.

It finds the hub from the focused terminal's folder, then the shown space's,
then the last hub it used. When none of those is in a hub, it offers a
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
- In your layout: a block with `"content": { "mod": "jade" }`. To make it a side
  panel beside Files and Changes, add that block as another child of the
  `panel-body` stack, and show it with `layout.select {stack: "panel-body", child: "<id>"}`
  plus `layout.show {id: "panel"}`.
- Its jade icon uses the layout's `accent` color.

Optional props: `hub` (a jade hub to show instead of looking for one; `root`
is its old name and still works) and
`bin` (the jade program; default `jade` on your PATH).

## Develop

`mods/jade/model.js` holds the logic and has no imports, so `test/model.test.ts`
runs under `bun test`. `main.js` is the view. Check a change with
`herdr-app check ~/.config/herdr-app/mods/jade` after installing it.
