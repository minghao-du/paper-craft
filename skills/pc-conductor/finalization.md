# EPIC post-merge finalization

Use after required children are delivered, PR merges and landing records are verified,
and the EPIC Agent has assessed the original goal. This is part of EPIC completion;
standalone Issues do not acquire these steps.

## 1. Establish scope and ownership

Conductor supplies actual merged PRs, per-PR base/head and merge SHAs, changed paths,
Worker results and evidence. Bind each round to an integrated SHA and a safe detached
checkout. The EPIC Agent confirms the evidence-based applicability of each specialist;
uncertainty remains blocked. Infrastructure delivery alone is not research progress.
The designated Project coordinator supplies scientific judgments and the writing brief;
invoking a writer transfers neither scientific authority nor coordination.

**Done:** Both applicability decisions have reasons; research work has the unique
absolute research entry, named coordinator, confirmed judgments and evidence pointers.

## 2. Dispatch specialists sequentially

Use existing managed turns and attempts, attributed to the original EPIC, rather than
Worker intake (`pc-issue-work`). Each applicable specialist gets a fresh window in the
verified existing fleet tmux session and its own file brief. No window is needed for a
confirmed skip. The configured Runner owns input delivery and acknowledgement.

First invoke `/pc-pipeline-snakemake` using its finalization branch. Technical blocking
findings return to the existing EPIC/Worker/PR repair flow. After verified completion or
skip, pass its full result to `/pc-research-state`. The Project coordinator serializes
writers across repositories and Fleets: wait for the previous writer's return before
starting another. Ambiguous coordination or handover blocks writing.

**Done:** Every applicable task has a distinct window, startup receipt and collected
result bound to the evaluated SHA. A window, process exit or missing error is insufficient.

## 3. Verify and recover

Managed completion retains context, applicability, results and turns in its existing
`completion.json`; Runner directories retain briefs, logs and result files. Structured
specialist receipts contain `head`, `status` (`completed` or `blocked`), `evidence`,
`blockers`, `scope`, `checks`, `artifacts`, and `limitations`. Explain checks not run.
Conductor records confirmed skips with their reasons. Preserve old rounds and attempts.
Use `pc workflow conductor recover` with the authoritative config to reconcile original receipts
and collect results; inspect that command's help for continuation options.

For an explicit fresh round after a resolved failure, use
`pc workflow conductor finalize-epic <number> --repository <owner/name> --config <file> --retry`.
Without `--retry`, that command resumes the original round. It never supplies human
closure confirmation. Retry verifies that all prior specialist executions have stopped,
retains their records, and invalidates prior final acceptance and closure confirmation.

Timeout ends waiting, not execution. Unknown occupancy blocks replacement and closure.
Confirm termination and release of writing/checkout ownership before a new attempt;
otherwise retain the blocker and escalate. Never delete failed evidence to retry.
Artifacts belong outside the immutable source checkout, in the attempt directory or
an isolated validation root. Preserve snapshots until their evidence is no longer needed.

If integration advances, compare added changes against prior scope and evidence. The
EPIC Agent may confirm reuse with concrete unaffected-scope evidence; relevant repairs
require updated scope and checks. A new round retains the old results. Never apply a
human closure decision from a superseded baseline.

**Done:** Both tasks are verified completed or confirmed skipped, with no unresolved
blocking findings or required-delivery evidence gaps.

## 4. Return to acceptance

Obtain the EPIC Agent's final acceptance of the original objective at the current
baseline with both receipts. Conductor presents the evidence and requests explicit
human EPIC closure. Managed completion enforces these gates before its close operation.

**Done:** Final professional acceptance and human confirmation refer to this EPIC and
current baseline. Conductor has performed scheduling and evidence checks only.
