#!/usr/bin/env bash
# Change footprint: which files each reference feature touched, and which files
# keep getting touched across features (the per-feature cost of the structure).
#
# Usage: footprint.sh [options] <spec>...
#   <spec>       a commit (abc123), a range (main..feature, A..B), a PR head ref,
#                --feat (every non-merge commit whose subject starts with "feat"),
#                or --working (uncommitted changes, including untracked files)
# Options:
#   --exclude <regex>   drop matching paths (repeatable); lockfiles are always dropped
#   --max-files <n>     skip any single feature touching more than n files (default 40);
#                       big refactors and initial imports drown the signal
#   --src <regex>       only count matching paths in the cross-feature table
#                       (e.g. '^src/'), so docs don't dominate it
#   --strip <regex>     delete this prefix from every path first, so files that moved
#                       (e.g. '^packages/cli/' after a monorepo split) count as one
#
# Run from inside the repository. Prints one block per feature, then the table.
set -euo pipefail

excludes=('(^|/)(bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock)$')
max_files=40
src_filter='.'
strips=()
specs=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --exclude) excludes+=("$2"); shift 2 ;;
    --max-files) max_files="$2"; shift 2 ;;
    --src) src_filter="$2"; shift 2 ;;
    --strip) strips+=("$2"); shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) specs+=("$1"); shift ;;
  esac
done
[[ ${#specs[@]} -gt 0 ]] || { sed -n '2,18p' "$0"; exit 1; }

filter() {
  local out
  out=$(cat)
  for re in "${strips[@]+"${strips[@]}"}"; do
    out=$(sed -E "s#$re##" <<<"$out")
  done
  for re in "${excludes[@]}"; do
    out=$(grep -Ev -- "$re" <<<"$out" || true)
  done
  grep -v '^$' <<<"$out" || true
}

tally=$(mktemp)
trap 'rm -f "$tally"' EXIT

# report <label> <files...on stdin>
report() {
  local label="$1" files count
  files=$(filter | sort -u)
  count=$(grep -c . <<<"$files" || true)
  if (( count > max_files )); then
    echo "### $label  (SKIPPED: $count files > --max-files $max_files)"
    echo
    return
  fi
  echo "### $label  ($count files)"
  sed 's/^/  /' <<<"$files"
  echo
  grep -E -- "$src_filter" <<<"$files" | sed "s|$|\t$label|" >>"$tally" || true
}

for spec in "${specs[@]}"; do
  case "$spec" in
    --working)
      { git diff --name-only HEAD; git ls-files --others --exclude-standard; } | report "working tree (uncommitted)"
      ;;
    --feat)
      while read -r sha subject; do
        git show --name-only --format= "$sha" | report "$sha $subject"
      done < <(git log --no-merges --format='%h %s' | grep -Ei '^[0-9a-f]+ feat' || true)
      ;;
    *..*)
      git diff --name-only "$spec" | report "$spec"
      ;;
    *)
      git show --name-only --format= "$spec" | report "$(git log -1 --format='%h %s' "$spec")"
      ;;
  esac
done

echo "## Files touched by 2+ features (structural cost candidates)"
if [[ -s "$tally" ]]; then
  cut -f1 "$tally" | sort | uniq -c | sort -rn | awk '$1 >= 2 { printf "  %2d  %s\n", $1, $2 }'
fi
