# Pull request evidence commands

Run all commands in the assigned checkout. Invoke the helper from the installed paper-craft root:

```bash
node --import "<paper-craft-root>/node_modules/tsx/dist/loader.mjs" \
  "<paper-craft-root>/packages/pr-evidence/src/cli.ts" <capture|verify|readback|land> \
  --worktree "<absolute checkout root>" --repository "<[HOST/]OWNER/REPO>" --pr "<number>"
```

The workspace configuration selects the base remote by default. Use `--base-remote` to specify
its name explicitly. Pass `--base`, `--branch`, `--head-repository` and `--commit` for any assigned values.
For forks, `--repository` identifies the destination repository and `--head-repository` identifies
the fork. GitHub.com accepts the short `OWNER/REPO` form. Pass an explicit host for other servers.

- **`capture`** validates the clean local checkout and reads the open PR and current base revision
  from GitHub. Keep its JSON output in the review result. Fetch the recorded base branch separately
  and compare its fetched SHA with `baseCommit` before reviewing the exact diff. If the branch moved,
  capture again and review the refreshed revision.
- **`verify --review "<absolute capture JSON path>"`** rechecks the reviewed PR identity and head
  revision against the current clean checkout and GitHub, then verifies the live required checks.
  A successful result reports `passed` or `none_configured` and includes the explicit PR number,
  repository and head SHA for the guarded merge. No local workflow files are needed to check
  GitHub's branch rules. Pending, failed, missing or unverifiable required checks block landing.
- **`readback --review "<absolute capture JSON path>"`** verifies the remote PR identity and reads
  its current merge state. When reconciling an already-merged PR without a capture file, supply
  all of `--base`, `--branch`, `--head-repository` and `--commit`. Only `merged: true` with a
  verified `mergedCommit` establishes the remote merge result.

- **`land --review "<absolute capture JSON path>" [--issue <number>]`** is the writing operation for
  the landing skill. It requires a passing review from the caller. It verifies the reviewed version and live checks
  before attempting a guarded squash merge. Readback resolves the outcome, including an already
  merged PR or an interrupted merge command. The JSON outcome is `landed`, `rework_needed`, or `blocked`.
  Only a confirmed merge exits zero. If remote readback fails after an attempt, the result
  carries `mergeState: "unknown"` and the diagnostic.

An unsuccessful evidence command emits a diagnostic and exits nonzero. Preserve the diagnostic in the
review or landing result. Repeat with refreshed evidence when a revision moved. Resolve access
and GitHub evidence failures before proceeding to a merge.
