# Subagent Receipt

- root_issue_id: <root_issue_id>
- current_issue_id: <current_issue_id>
- task_type: <professional_task_or_replan>
- dispatch_id: <unique_receipt_basename>
- original_dispatch_id: <predecessor_dispatch_id_for_rework_or_N/A>
- origin_stage: <stable_stage_identity>
- attempt: <task_attempt>
- delivery_attempts_used: <count_for_this_delivery>
- replans_used: <count_for_origin_stage_and_current_issue>
- execution_status: <succeeded | blocked | failed>

## Compact Report

```json
{
  "execution_status": "succeeded",
  "result": { "outcome": "verified", "evaluatedHead": "<evaluated_commit>" },
  "receipt_path": "<assigned_absolute_receipt_path>",
  "summary": "<One-sentence result>"
}
```

Replace the example result with the assigned task's native conclusion and routing facts.
The compact report and receipt must agree. Include a result object for blocked or failed
execution too, preserving partial findings and an explicit reason when no conclusion is available.

## Artifacts

- repository: <owner/repo_or_N/A>
- worktree: <absolute_worktree_path_or_N/A>
- baseBranch: <base_branch_or_N/A>
- branch: <branch_name_or_N/A>
- commit: <implementation_sha_or_N/A>
- pr: <pr_url_or_N/A>

## Verification

<Commands, results, evaluated revision, and evidence required for acceptance and handoff.>

## Task Result

<Full professional output, including planning decisions, dependency graph, findings,
merge details, record paths, and absolute predecessor receipt references as applicable.>

## Current State and Feedback

<Known side effects, partial changes, consistency checks, and remaining work. For rework,
list defects. For out_of_scope, explain affected objectives and the required scope change.
For blocked or failed execution, record the cause, missing evidence, and required intervention.>

## Recovery and Budgets

<Original dispatch identity, originating stage, and consumed delivery and replanning allowances.
For rework, reference the predecessor receipt and summarize defects being resolved.
For replanning, record prior alternatives, proposed changes, and any invalidated acceptance gates.>
