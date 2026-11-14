#!/usr/bin/env bash
# Install the jade mod into the Herdr app: copies mods/jade/ to
# $HERDR_APP_HOME/mods/jade (default ~/.config/herdr-app). Herdr reloads it
# on its own. Re-run after editing the mod here.
#
# A copy, not a symlink: Herdr doesn't see saves through a symlinked mod
# folder, so it wouldn't reload.
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)/mods/jade"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
dest="$home/mods/jade"
[[ -d "$home/mods" ]] || { echo "No Herdr app home at $home (set HERDR_APP_HOME)." >&2; exit 1; }
if [[ -L "$dest" ]]; then rm "$dest"; fi
mkdir -p "$dest/icons"
cp "$src"/main.js "$src"/model.js "$src"/mod.json "$dest"/
cp "$src"/icons/*.svg "$dest"/icons/
echo "Installed: $dest"
if command -v herdr-app >/dev/null; then herdr-app check "$dest"; fi
