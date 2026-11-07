# Subagent Receipt

- root_issue_id: <root_issue_id>
- current_issue_id: <current_issue_id>
- task_type: <pc-issue-plan | pc-issue-verify | pc-issue-work | pc-pr-land | pc-pipeline-refactor | pc-research-state>
- attempt: <1 | 2 | 3>
- outcome: <completed | rework_needed | blocked | failed>

## Artifacts
- repository: <owner/repo_or_N/A>
- worktree: <absolute_worktree_path_or_N/A>
- baseBranch: <base_branch_or_N/A>
- branch: <branch_name_or_N/A>
- commit: <commit_sha_or_N/A>
- pr: <pr_url_or_N/A>

## Summary
<One-sentence result. Persist detailed environment, evidence, and feedback in this file.>

## Verification
<Commands, results, and evidence needed by the next specialist.>

## Task Result
<Full skill-specific outputs, including planning decisions and dependency graph, PR or merge details, and predecessor receipt paths when relevant.>

## Feedback
<Required when outcome is rework_needed (list review findings/defects) or blocked (explain missing prerequisites and required human action). Leave empty when completed.>
