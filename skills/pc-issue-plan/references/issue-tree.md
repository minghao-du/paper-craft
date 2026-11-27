# Issue tree reconciliation

Invoke the helper from the installed paper-craft root:

```bash
node --import "<paper-craft-root>/node_modules/tsx/dist/loader.mjs" \
  "<paper-craft-root>/packages/issues/src/cli.ts" <inspect|plan|close|reopen> \
  --worktree "<absolute checkout root>" --repository "<[HOST/]OWNER/REPO>" --issue "<number>"
```

Use `OWNER/REPO` for GitHub.com and an explicit host for any other GitHub server. Use qualified
issue identities in JSON inputs, including when issue numbers overlap across repositories.

- **Inspect** reads the issue, its native parent, all pages of native descendants, and the child
  tasklist and explicit parent declarations. Compare its JSON with supplied planning records
  and accepted scope. Resolve conflicts and unreadable evidence before classifying a root or
  authorizing a write. If a legacy child is known only from another issue's tasklist, inspect
  that parent directly. Native parent lookup for a child cannot discover an arbitrary old
  checklist elsewhere. Treat unsupported or ambiguous legacy notation as manual reconciliation.
- **Plan** takes `--input <absolute JSON path>` with an array of two to five direct child
  identities such as `{"repository":"OWNER/REPO","number":101}`. Supply the entire authorized
  plan, including reused and newly filed issues. Keep filed issue numbers from pc-issue-file.
  The helper adds missing native links and tasklist rows, preserves existing progress, and reads
  both back. It reports out-of-plan or conflicting relationships without removing them.
- **Close** takes `--input <absolute JSON path>` with the exact accepted subtree identities,
  each with a nonempty `receipt` reference to its passing acceptance evidence. Establish scope,
  validate the evidence, and finish required integrated and research acceptance before invoking
  this command. The helper checks live scope and closes bottom-up, confirms completed status,
  and synchronizes each issue's corresponding parent checkbox. An edge with a corroborated
  legacy parent declaration and checklist entry can be used after explicit reconciliation.
  Include `legacyParent` with that parent's qualified identity on the child's acceptance entry.
- **Reopen** restores one explicitly assigned issue after failed acceptance and reconciles its
  corresponding parent checkbox. Invoke only after verifying the failed acceptance and the scope.

The managed checklist uses top-level Markdown checkbox items whose leading reference is `#123`,
`OWNER/REPO#123`, or a GitHub issue URL. Other prose, issue mentions, and checklists without
a leading issue reference are outside that representation. An explicit legacy declaration
uses `Parent: #123` or a qualified reference. Resolve ambiguous or duplicate entries before
mutating the tree.

On failure, preserve the diagnostic and any observed progress. Inspect live state before retrying.
A failed GitHub request can have taken effect, so readback determines which links, states, or
checkboxes still need work. GitHub issue body edits have a read-before-write and readback check.
GitHub's body update has no atomic compare-and-swap in this path; coordinate concurrent edits
to the same issue body.
