#!/usr/bin/env bash
# Change footprint: which files each reference feature touched, and which files
# keep getting touched across features (the per-feature cost of the structure).
#
# Usage: footprint.sh [options] <spec>...
#   <spec>       a commit (abc123), a range (main..feature, A..B), a PR head ref,
#                --feat (every non-merge commit whose subject starts with "feat"),
#                --working (uncommitted changes, including untracked files), or
#                @<file> (a hand-picked list of paths, one per line, for a feature
#                that shares the working tree or a commit with other work)
# Options:
#   --exclude <regex>   drop matching paths (repeatable); lockfiles are always dropped
#   --max-files <n>     skip any single feature touching more than n files (default 40);
#                       big refactors and initial imports drown the signal
#   --src <regex>       only count matching paths in the cross-feature table
#                       (e.g. '^src/'), so docs don't dominate it
#   --strip <regex>     delete this prefix from every path first, so files that moved
#                       (e.g. '^packages/cli/' after a monorepo split) count as one
#   --no-renames        don't map old paths to their current names. By default every
#                       rename git recorded is followed, so a file counts as one file
#                       across a restructure (utils/git.ts -> adapters/git.ts)
#
# Commits whose subject lists several things ("a, b and c") are marked
# "may bundle several features": one commit then stands for several features.
#
# Run from inside the repository. Prints one block per feature, then the table.
set -euo pipefail

excludes=('(^|/)(bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock)$')
max_files=40
src_filter='.'
strips=()
specs=()
follow_renames=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --exclude) excludes+=("$2"); shift 2 ;;
    --max-files) max_files="$2"; shift 2 ;;
    --src) src_filter="$2"; shift 2 ;;
    --strip) strips+=("$2"); shift 2 ;;
    --no-renames) follow_renames=0; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) specs+=("$1"); shift ;;
  esac
done
[[ ${#specs[@]} -gt 0 ]] || { sed -n '2,26p' "$0"; exit 1; }

tally=$(mktemp)
renames=$(mktemp)
trap 'rm -f "$tally" "$renames" "$renames.tmp"' EXIT

# old<TAB>new for every rename in history (oldest first) and in the index
if (( follow_renames )); then
  { git log --reverse -M --diff-filter=R --name-status --format= 2>/dev/null
    git diff --cached -M --diff-filter=R --name-status 2>/dev/null; } |
    awk -F'\t' '$1 ~ /^R/ { print $2 "\t" $3 }' >"$renames"
  # Strip both sides too, so a rename recorded under a prefix that older
  # commits didn't have (after a monorepo split) still applies to them.
  for re in "${strips[@]+"${strips[@]}"}"; do
    paste <(cut -f1 "$renames" | sed -E "s#$re##") <(cut -f2 "$renames" | sed -E "s#$re##") >"$renames.tmp"
    mv "$renames.tmp" "$renames"
  done
fi

strip_prefixes() {
  local out
  out=$(cat)
  for re in "${strips[@]+"${strips[@]}"}"; do
    out=$(sed -E "s#$re##" <<<"$out")
  done
  printf '%s\n' "$out"
}

# Map each path to the latest name it was renamed to (following chains).
current_names() {
  awk -F'\t' -v map="$renames" '
    BEGIN { while ((getline line < map) > 0) { split(line, p, "\t"); to[p[1]] = p[2] } }
    { path = $0; n = 0; while ((path in to) && n++ < 50) path = to[path]; print path }'
}

filter() {
  local out
  out=$(strip_prefixes | current_names)
  for re in "${excludes[@]}"; do
    out=$(grep -Ev -- "$re" <<<"$out" || true)
  done
  grep -v '^$' <<<"$out" || true
}

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
  local note=""
  if grep -Eq ', | and ' <<<"$label"; then note="  [may bundle several features]"; fi
  echo "### $label  ($count files)$note"
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
    @*)
      report "$(basename "${spec#@}")" <"${spec#@}"
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
