---
name: improve-codebase
description: >-
  Review a codebase's structure for readability and change cost, then propose
  (and, when asked, carry out) step-by-step restructuring. Measures how many
  files past features had to touch, whether those were the files you'd expect,
  how easy the dependencies of a change are to follow, and whether the file
  tree alone shows what the application does. Use when asked to improve
  architecture, structure, layout, readability or maintainability, to make a
  codebase easier to navigate or extend, or to review "how hard is it to add a
  feature here".
---

# Improve codebase

The goal is a codebase where **a new feature touches few files, and only the
ones you'd expect**, the **dependencies of a change can be read from the
imports**, and **the file tree tells you what the application does** without
opening any file.

Work report-first. Change code only when the user asks, and then follow
[Carrying out changes](#carrying-out-changes).

## 1. Pick reference features

Real changes are the evidence. Ask the user for 2–4 reference features (commits,
ranges, PR branches), or use what's there:

- `feat:`-style commits (`scripts/footprint.sh --feat`)
- uncommitted work in progress (`--working`), which is often the most recent feature
- recent merged PRs (`main~N..main`, or each PR's merge-base range)

Leave out commits that aren't features: initial imports, mass reformatting, and
big refactors. They touch everything and say nothing about change cost.
`--max-files` (default 40) skips them automatically.

## 2. Measure the footprint

```bash
<skill-dir>/scripts/footprint.sh [--exclude <regex>] [--strip <prefix>] [--src <regex>] <spec>...
```

- `--exclude` generated or copied files: build output, vendored code, installed
  copies of skills or configs. Lockfiles are always dropped.
- `--strip` a prefix that changed during history (e.g. `'^packages/cli/'` after a
  monorepo split). Otherwise moved files count as different files.
- `--src` limits the cross-feature table to source, so docs don't dominate it.

Then sort every touched file of every feature into one of three kinds:

| Kind | Meaning | Example |
|---|---|---|
| **Expected** | You'd predict it from the feature's name | the new command, its test, the README row |
| **Tax** | Needed only because of how the code is structured, the same files for every feature | interface + implementation + registry + mock for each new git call |
| **Surprise** | You wouldn't predict it, and it needs reading to explain | a terminal-pane plugin changed by a merge command |

The table of "files touched by 2+ features" lists the candidates for tax. Each
tax file is a recurring cost; each surprise points to a hidden dependency.
Record the counts: they're the before numbers for step 6.

## 3. Read the tree cold

Run a fresh subagent on **only** the tree (e.g. `tree -I node_modules src/` or
`git ls-files src/`), with no file contents, and ask: *what does this
application do, and what are its commands, features or endpoints?* Compare the
answer with the README, `--help` or the routes. Whatever it got wrong or missed
is a finding. Use the same prompt again after restructuring.

Things that make a tree hard to read cold:

- **Several features in one file**, e.g. `commands/workspace.ts` holding four
  subcommands. The rule worth proposing: *paths mirror the surface* (the
  commands, routes or pages a user sees).
- **Junk-drawer folders** (`utils/`, `helpers/`, `lib/`, `common/`) that mix
  domain concepts, wrappers around external tools and one feature's internals.
  Split them by role: domain or core, adapters (one per external system), and
  feature-owned code next to its feature.
- **Overloaded terms**: one word for several things (e.g. "workspace" as the root
  directory, a folder and a group). Propose one meaning per word and a short
  glossary in the agent instructions file (CLAUDE.md or AGENTS.md).
- **Near-identical names with different meanings**, e.g. `update` vs
  `workspace update`. That's a product question: report it, don't rename
  user-facing things.

## 4. Check how easy dependencies are to follow

Answer these with grep (or `madge` or dependency-cruiser if the project already
has them):

- **Do siblings import each other?** One command, route or page importing
  another hides shared logic. That logic belongs in core or an adapter.
- **Does anything bypass an abstraction it should go through?** For example a
  module calling `readConfig` directly when everything else uses the injected
  config backend.
- **Is the same fact recomputed in several places?** ("Is this app published?",
  "What's the default branch?") These spread small features across many files;
  centralise them in one module for that concept.
- **Are there two versions of the same thing?** Two wrappers around the same
  external tool, or duplicate type definitions.
- **Is dependency injection getting out of hand?** Constructors taking a growing
  list of positional arguments (`make(git, fs, config, gh)`) and tests passing
  `undefined` to skip some. A single deps or context object fixes it.

## 5. Count the boilerplate

Count repeated setup code in each entry point: resolving context, parsing
common flags, error handling and exiting, opening and closing spinners. Report
the totals (e.g. "13 commands repeat the root lookup, 71 `process.exit`
calls"). A small wrapper that every entry point goes through usually fixes
this, and tests get simpler as a result.

## 6. Report

Rank findings by **files saved per future feature**, not by how ugly they look.
Include:

1. **The footprint table**: each reference feature with its expected, tax and
   surprise files.
2. **Findings**, each with evidence (file:line, counts) and the specific features
   it made harder.
3. **The current tree vs the proposed tree**, side by side.
4. **A hypothetical feature walkthrough**: pick a likely next feature and list
   the files it would touch now vs under the proposal.
5. **A migration plan in steps** (format below).

Each step in the plan:

- **Changes one kind of thing.** Moves, renames, extracting code and changing
  behaviour are separate steps. A step that only moves files can be reviewed as
  a list of renames; mixing in edits makes it unreviewable.
- **Leaves the tests green and can be committed on its own.**
- **States what it costs:** how many files it touches, and whether it can change
  behaviour.

Put the steps that only move files first: they're cheap and safe, and they make
the later ones easier to see.

## Carrying out changes

Before the first step:

- **Take a baseline** that the type checker won't cover: CLI `--help` output for
  every command, route listings, the list of exported symbols or dead code
  (knip, ts-prune, vulture), and test counts including known failures.
- **Check whether there's uncommitted work.** Moving files that also have
  uncommitted edits stops git from seeing them as renames. Offer to commit the
  existing work first, or say clearly that the diff will be mixed.

For each step:

- **Move with `git mv`** so history follows the file. It fails on untracked
  files; use plain `mv` for those.
- **Rewrite imports with a script driven by the move map**, not by hand: resolve
  each relative import against the file's old location, then recompute it from
  the new one. Also cover non-code references: docs, configs, build scripts,
  embedded asset paths and skill text.
- **Don't let the next step slip in.** No identifier renames during a move step,
  and no interface redesign during a split.
- **After each step, diff against the baseline**: tests, types, the dead-code
  report and the surface snapshot. A command that silently dropped out of a
  registry shows up only in the surface diff.
- **Re-run the footprint walkthrough** at the end, so the summary has before and
  after numbers.

Never rename user-facing commands, routes, flags or config keys as part of a
restructure without the user's explicit go-ahead.

## Worked example (jade, a Bun/TypeScript CLI)

The footprint over its `feat` commits put `status.ts` ×6, `git.ts` ×5,
`workspace.ts` ×5, and `git-backend.ts` and the mock git ×4 each at the top.
Reading the features explained why:

- Each git operation cost 4 edits: the implementation, the interface, the
  registry and the mock.
- A "did the user publish this?" check was spread over 6 commands.
- `workspace.ts` held four subcommands.

The proposal was `commands/` mirroring the CLI (`commands/workspace/add.ts` for
`jade workspace add`), with `utils/` split into `core/` (jade's concepts) and
`adapters/` (git, gh, fs, herdr, tmux, one file each). It went in in this order:
moves first, then the cross-command imports, then the interface changes.
