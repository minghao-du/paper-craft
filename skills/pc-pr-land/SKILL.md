---
name: pc-pr-land
description: Execute a orchestrator-dispatched PR merge or post-records preservation and cleanup.
---

# /pc-pr-land

Read the supplied role contract and assignment before mutation.
The owning Run's Orchestrator dispatches one phase, `merge` or `cleanup`, with repository/PR, evaluated head, checkout and durable evidence pointers.
Execute only that assignment and return its correlated result.
Workers remain available for remediation and final records while releasing checkout ownership.
For missing assignment or resume, return to [Orchestrator intake](../pc-orchestrator/SKILL.md#1-resolve-or-start-the-run) and managed recovery.

## Merge phase

1. **Accept ownership.** Read the orchestrator's transfer record and worker release.
   Reconcile recorded ownership with supported runtime/process evidence, tmux pane paths
   and jobs using the directory. Unknown or overlapping ownership blocks mutation.
   Record acceptance in the coordination ledger and worker worklog.
   This step ends with one verified owner of the checkout.

2. **Verify the evaluated PR.** Read live GitHub state,
   evaluated SHA, applicable completion/review outcomes and every required parent/planner confirmation.
   Use `gh pr view <N> --json url,state,headRefOid,baseRefName,closingIssuesReferences`.
   Match repository, PR, local HEAD and live head to that SHA. Inspect `git status --porcelain`.
   Dirty or untracked work requires worker accounting through the orchestrator; preserve it
   in place rather than committing, moving or stashing it during landing.
   Missing/stale evidence or a closed PR blocks merge; an already merged PR moves to
   outcome reconciliation, never another merge attempt.

3. **Update and check.** Fetch origin, then rebase onto `origin/<base>` if needed.
   A conflict stops the operation: report the precise blocker, preserve the worktree
   (including any rebase state), and release ownership before worker remediation.
   If a successful rebase changes HEAD, push with `--force-with-lease`, report the new
   SHA and release. The orchestrator repeats applicable checks, planner confirmations and
   professional confirmation before another merge dispatch.
   With unchanged HEAD, verify current-base ancestry and required checks using
   `gh pr checks <N> --required`; inspect installed `gh pr checks --help` for supported
   output fields. Pending checks remain pending; failures return to the orchestrator.
   No configured required checks is acceptable only with the applicable local findings.

4. **Merge the evaluated head.** Check GitHub's `closingIssuesReferences` against the
   intended issue set; correct a defective PR body through the worker. Re-read live
   head and fetch base immediately before merging. For the recorded evaluated SHA:

   ```sh
   test "$(git rev-parse HEAD)" = "<evaluated-sha>" &&
   test "$(gh pr view <N> --json headRefOid -q .headRefOid)" = "<evaluated-sha>" &&
   git fetch -q origin <base> &&
   git merge-base --is-ancestor origin/<base> <evaluated-sha> &&
   gh pr merge <N> --squash --match-head-commit <evaluated-sha> --body "closes #<issue>"
   ```

   Use an explicit squash body containing only intended closing references (or `--body ""`).
   The match-head guard rejects a moved head; it does not make the separate base check
   atomic. A moved head returns to checks and applicable planner confirmation. A moved base
   requires current-base revalidation and, if rebase changes head, fresh quality and professional confirmation.
   Never replace a failed guard with an unguarded merge.

5. **Report merge separately.** Verify `gh pr view <N> --json state,mergedAt,mergeCommit`.
   Record the actual merge outcome and commit, including an uncertain command result
   reconciled against GitHub. A queued or auto-merge request is still pending; retain
   the checkout and revalidate evidence before reporting success. Submit the structured result:

   ```sh
   pc workflow submit-result --run <run-id> --task <task-id> --outcome completed --summary "Squash merged PR #<N> into main" --artifacts '{"merged_commit":"<merge-commit-sha>"}'
   ```

   If merge is blocked (conflicts, checks failing), submit outcome `blocked`:

   ```sh
   pc workflow submit-result --run <run-id> --task <task-id> --outcome blocked --summary "Merge blocked: <reason>" --artifacts '{"merged_commit":""}'
   ```

   The Engine confirms the actual external GitHub merge state before advancing to `finalization`.
   If merge execution was interrupted or missing result delivery, `pc workflow resume` inspects
   external GitHub state directly; an already merged PR advances to finalization without duplicate
   merge commands. Keep status, worklog, branch and directory intact, record release, and
   return to the orchestrator. The worker next owns final evaluation and records.

## Cleanup phase

Read this phase only after the orchestrator verifies merge success, final worker records
and a new worker release. A merge result alone does not dispatch cleanup.

1. **Verify prerequisites.** Accept exclusive checkout ownership using the shared transfer
   contract. Verify merged PR, all linked issues closed, terminal issue-lead comment and
   final worklog/status evidence. Account for follow-ups, local changes, unmerged commits,
   pending input, background jobs, external readers and holds. Missing records return to
   the worker through the orchestrator; unknown occupancy leaves cleanup pending.
   Run `pc fleet reclaim-check --dir <slot> --config <authoritative-config>` for fleet slots.
   It currently returns `eligible: false`, exit 2; retain the slot while that check cannot
   establish eligibility. Do not treat portable read-only checks as deletion authority.

2. **Preserve before removal.** Run:

   ```sh
   pc workflow preserve --dir <checkout> --reason "after final records for PR <N>" --config <authoritative-config>
   ```

   Require successful exit, `status: preserved`, manifest/hashes and unchanged sources.
   Record the verified archive path in the ledger and on the PR before removal.
   Missing status or failed preservation leaves originals and cleanup pending.

3. **Clean only eligible resources.** Use actual `git worktree list --porcelain` and
   config to resolve the primary checkout. Verify its owners released it before updating
   it; otherwise report primary synchronization pending. For a clone, switch to base and
   pull with `--ff-only` only after the preceding gates. For a linked worktree, operate
   outside it and use ordinary `git worktree remove <path>` before local branch deletion.
   Use ordinary `git branch -d <branch>`; squash-merge ancestry may refuse deletion,
   which leaves branch cleanup pending for explicit accounting rather than forcing it.
   Delete a remaining remote branch only after the same work-accounting gates.
   GitHub branch deletion settings are not evidence that deletion occurred.

4. **Record actual results.** Verify retained/deleted paths, local/remote branch state,
   primary synchronization and final checkout status. Report preservation and cleanup
   independently from merge success. Release ownership and notify the orchestrator; only
   verified cleanup releases a fleet resource for another task.

Managed delivery follows the current Run assignment and Engine-validated transitions.
Unknown execution occupancy or unaccounted checkout files retain the checkout.
A blocked completion resumes its persisted stages; inspect the original execution before retrying a missing receipt.
Interrupted merge recovery verifies the actual merge result on GitHub and does not repeat a successful merge.
Parent Issue closure remains a separate user decision.

## Managed completion

Submit the assigned task's outcome, summary and required artifacts through
`pc workflow submit-result`, using the supplied Run and task identities.
The role contract determines permitted outcomes and required artifacts. Merge
assignments return `merged_commit`; finalization assignments return
`release_evidence` after final records and preservation checks.
The Engine validates the result and controls resource release. Report unresolved
execution occupancy, preservation or cleanup failures as blockers.
For recovery, return the Run identity and evidence to the
[Orchestrator](../pc-orchestrator/SKILL.md#3-recover-stop-or-release).
