# Subagent Receipt

- root_issue_id: <root_issue_id>
- current_issue_id: <current_issue_id>
- task_type: <pc-issue-plan | pc-issue-verify | pc-issue-work | pc-pr-land | pc-pipeline-refactor | pc-research-state>
- attempt: <1 | 2 | 3>
- outcome: <completed | rework_needed | blocked | failed>

## Artifacts
- branch: <branch_name_or_N/A>
- commit: <commit_sha_or_N/A>
- pr: <pr_url_or_N/A>

## Feedback
<Required when outcome is rework_needed (list review findings/defects) or blocked (explain missing prerequisites and required human action). Leave empty when completed.>
