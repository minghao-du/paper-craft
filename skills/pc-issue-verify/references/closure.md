# Acceptance-backed issue closure

When assigned issue finalization, use the supplied accepted verification receipts; rerun acceptance only if the integrated revision or requirements changed. Missing or failed acceptance blocks closure. If an issue was closed before failed acceptance, reopen it and read back its state.

For a root finalization, enumerate the root and all descendants from GitHub native sub-issue relationships with pagination. Reconcile parent tasklists and planning/delivery records; resolve discrepancies rather than silently dropping issues. Include closed descendants. A child-only assignment closes only its accepted subtree. Close bottom-up after each issue's own criteria pass; parent acceptance additionally requires all descendants accepted and integrated verification. Root closure also requires research recording complete.

Use explicit repository-qualified issue operations. Read current state, close accepted open issues as completed, then read back state and reason. Update only the corresponding parent tasklist entry and verify it. Already closed accepted issues are idempotent; a not-planned closure does not substitute for acceptance. Record observed repository, number, state and acceptance receipt for every issue.

Reconcile PRs and workspace preparation, delivery, and acceptance receipts, including previous runs, against local and remote refs and worktree registrations. Use the assigned issue or enumerated subtree as the inventory scope. Build task branch and detached verification candidates using the evidence and fields in the [workspace cleanup contract](../../pc-workspace/SKILL.md#5-cleanup-protocol).

- Include resources with confirmed ownership in the assigned scope in `candidates`, even if dirty or still in use. The cleanup step checks whether removal is safe and retains unsafe candidates.
- Include a resource in `unresolved` only if a specific PR, preparation, delivery, or acceptance receipt links it to the assigned scope and ownership evidence is missing or conflicting. Link that source and record the missing or conflicting fact.
- Preserve default/base branches and confirmed out-of-scope resources. Omit them and resources without a specific link to the assigned scope from both lists. A shared workspace container, a branch name, or an upstream scan list without supporting evidence is insufficient.

Return `outcome: finalized` only after live issue readback confirms the full assigned scope closed with passing acceptance evidence. Include `root_issue_id`, `scope` (`tree` or `issue`), `issues`, `candidates`, and `unresolved` with reasons. Preserve this inventory outside disposable worktrees. Cleanup failures do not reopen accepted issues. On retry, reconcile live state and process only outstanding operations.
