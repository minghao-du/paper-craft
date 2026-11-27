---
name: pc-issue-file
description: Create or update a GitHub issue from an exact Markdown draft, or recover a partially completed create.
allowed-tools: Bash, Read
---

# /pc-issue-file

Resolve the draft, the assigned checkout, and the explicit target repository. Use CREATE for a
new issue and UPDATE for an explicitly identified issue to revise. A parent or related issue
reference supplies context. If the requested operation or target is ambiguous, resolve that
ambiguity before running a write.

Invoke the helper from the installed paper-craft root:

```bash
node --import "<paper-craft-root>/node_modules/tsx/dist/loader.mjs" \
  "<paper-craft-root>/packages/issues/src/cli.ts" <create|update|resume> \
  --worktree "<absolute checkout root>" --repository "<[HOST/]OWNER/REPO>" --draft "<path>"
```

- **Create:** Supply `--assignee <login>` only when explicitly assigned. The helper derives the title
  from a first-line H1 or the filename stem, submits the exact draft through `--body-file`, verifies
  the returned issue, and archives the draft in the checkout's `_ignore/` without overwriting files.
- **Update:** Supply `--issue <number>`. The helper submits the exact draft through `--body-file`,
  verifies the body, and leaves the file in place. Keep existing child checklist rows and explicit
  parent declarations in the draft. Use the [Issue tree helper](../pc-issue-plan/references/issue-tree.md)
  for authorized hierarchy and checklist edits.
- **Resume:** Use the original draft path and repository. A create receipt with an Issue URL allows
  retrying verification and archiving. If no URL was returned, reconcile with the live repository
  and provide `--url <verified issue URL>` only after identifying the exact issue created by that
  attempt. The helper compares the issue title and body with the recorded draft before accepting
  the URL. A failed or interrupted create is an uncertain remote outcome. Keep its receipt and
  report ambiguous candidates. Once evidence establishes that the earlier request had no remote
  effect, preserve the pending receipt under a separate filename and make a fresh authorized
  CREATE attempt.

On success, return the operation, issue URL and number, and archive or live draft path. On nonzero
exit, retain the diagnostic and any recovery receipt under `_ignore/.issue-file/`. Report the known
Issue, draft, and outstanding recovery action. An archive collision requires resolving the existing
file before a retry. A completed receipt permits a later independent create at the same draft
path after the earlier archive destination is cleared. Coordinate concurrent operations on one
draft or issue body. GitHub body updates are checked before writing and read back afterward.
