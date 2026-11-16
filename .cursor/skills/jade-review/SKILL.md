---
name: jade-review
description: >-
  Reviewing a ticket or PR across a jade multi-repo workspace with `jade
  review <ticket-id>`, which builds workspace/<ticket-id>/ containing only the
  apps with a matching branch or open PR, each on its real branch. Use when
  asked to review, check out, or pull up a ticket or PR by id across several
  apps/repos in a jade hub.
---

# Jade review

A review workspace is a normal `workspace/<ticket-id>/` workspace (see [[jade-workspace]]) whose membership comes from a search: every app is fetched and searched for the ticket id, and only the apps with exactly one match are checked out. Each one sits on its real branch, so there are no placeholder branches.

## Run it

From anywhere inside the hub (or pass `--hub <path>`):

```bash
jade review JADE-01 --dry-run   # see what matches, change nothing
jade review JADE-01
```

- **Matching:** branch names (local and `origin/*`, after a fetch) containing the id, case-insensitive and bounded, so `JADE-1` does not match `JADE-12`. When `orgUrl` is set and `gh` works, open PRs whose title contains the id add their head branch too. A missing or unauthenticated `gh` just means branch-name matching only; `--no-gh` skips it on purpose.
- **Exactly one candidate** in an app: that app is checked out on it, tracking `origin/<branch>`. A local copy left from an earlier review is fast-forwarded to the PR's latest commit; if it has diverged, it's left as is with a warning.
- **Several candidates:** the app is left out and listed as ambiguous. Don't pick one yourself; show the user the candidates and re-run with their choice: `jade review JADE-01 --pick web=JADE-01-ui`. Re-running adds to the existing review workspace and leaves apps already in it alone.
- **A PR branch that isn't on origin** (usually a fork) is reported and skipped.
- `--apps a,b` limits the search.

It exits non-zero when nothing could be created or only ambiguous matches were found. Report back which apps were checked out (with branch and PR number), which were ambiguous, and which had no match, as `jade review` prints them.

## While reviewing

The workspace records each app's expected branch in `workspace/<ticket-id>/.jade-group.json`. `jade status` and `jade doctor` use it, so the PR branches don't show as `[drift]` and left-out apps aren't reported missing. Don't edit or delete that file by hand.

Useful alongside: `jade exec -- git log --oneline origin/main..HEAD` (or any command) runs in every app of the workspace; `jade open JADE-01` opens it in herdr-tui/tmux.

If an app's branch was already checked out in another workspace, git can't check it out twice, so the review uses a suffixed branch on the same commit (`<branch>-<hash>`) and says so.

## Clean up

```bash
jade workspace remove JADE-01
```

Don't add `-d`: it deletes a branch named after the workspace (`JADE-01`), which a review doesn't create. The local tracking branches the review created stay in each bare repo; delete one with `git -C .bare/<app> branch -d <branch>` if it's no longer wanted.
