# Acceptance-backed issue closure

When assigned issue finalization, use the supplied accepted verification receipts; rerun acceptance only if the integrated revision or requirements changed. Missing or failed acceptance blocks closure. If an issue was closed before failed acceptance, reopen it and read back its state.

Use `inspect` from the [Issue tree helper](../../pc-issue-plan/references/issue-tree.md) to enumerate
the assigned issue and its descendants, including closed descendants. Reconcile live hierarchy
with planning and delivery records. A child-only assignment covers only its accepted subtree.
Validate each issue's acceptance receipt. Parent acceptance requires acceptance for all descendants
and integrated verification. Root closure also requires a completed research recording receipt.
For the root issue, use the single assigned `receipt_path` from the latest valid root-level
`issue_verify` completion for the current integrated revision. For a child, use the passing
acceptance receipt that covers that child. Cite research recording separately in the finalization
receipt. Keep each acceptance reference to one path.

Use the helper's `close` with the exact accepted subtree and its receipt references. It verifies
completed state and each corresponding parent checkbox. Use `reopen` for a prematurely closed
issue after verifying failed acceptance. On partial failure preserve observed progress and
reconcile live state before trying the outstanding operations again.

Reconcile PRs and workspace preparation, delivery, and acceptance receipts, including previous runs, against local and remote refs and worktree registrations. Use the assigned issue or enumerated subtree as the inventory scope. Build task branch and detached verification candidates using the evidence and fields in the [workspace cleanup contract](../../pc-workspace/SKILL.md#5-cleanup-protocol).

- Include resources with confirmed ownership in the assigned scope in `candidates`, even if dirty or still in use. The cleanup step checks whether removal is safe and retains unsafe candidates.
- Include a resource in `unresolved` only if a specific PR, preparation, delivery, or acceptance receipt links it to the assigned scope and ownership evidence is missing or conflicting. Link that source and record the missing or conflicting fact.
- Preserve default/base branches and confirmed out-of-scope resources. Omit them and resources without a specific link to the assigned scope from both lists. A shared workspace container, a branch name, or an upstream scan list without supporting evidence is insufficient.

Return `outcome: finalized` only after live readback confirms that every issue in scope was closed
as completed with passing acceptance evidence. Use `scope: "tree"` for root reconciliation and
`scope: "issue"` for a child-only assignment. For each row in the helper's `verifiedClosed`
readback, copy `repository` and `number`, map `state: "closed"` to `state: "CLOSED"`, and copy
the helper's `receipt` into `acceptance_receipt`. Include the root and all planned issues in
a tree result.

Example `result` for a root and one child, with no cleanup candidates or unresolved ownership
items:

```json
{
  "outcome": "finalized",
  "scope": "tree",
  "root_issue_id": "100",
  "issues": [
    {
      "repository": "OWNER/REPO",
      "number": 100,
      "state": "CLOSED",
      "acceptance_receipt": "/receipts/08-stage_3_verify-issue-100-try-1.md"
    },
    {
      "repository": "OWNER/REPO",
      "number": 101,
      "state": "CLOSED",
      "acceptance_receipt": "/receipts/06-child-101-acceptance.md"
    }
  ],
  "candidates": [],
  "unresolved": []
}
```

Preserve the inventory outside disposable worktrees. If completion requests corrections,
use the assigned receipt and the same dispatch. Reconcile live state and process only outstanding
operations. Cleanup failures do not reopen accepted issues.
