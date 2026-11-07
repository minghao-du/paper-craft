# Dispatch Reservation

- root_issue_id: <root_issue_id>
- current_issue_id: <current_issue_id>
- task_type: <professional_task_or_report_repair_or_replan>
- dispatch_id: <task_receipt_basename>
- original_dispatch_id: <original_invocation_id_for_report_repair_or_N/A>
- origin_stage: <stable_stage_identity>
- attempt: <task_attempt>
- delivery_attempts_used: <count_for_this_delivery>
- replans_used: <count_for_origin_stage_and_current_issue>
- report_repair_used: <true_or_false_for_original_invocation>
- task_receipt_path: <assigned_absolute_task_receipt_path>

## Recording Requirements

For a task receipt at `<receipt_root>/<name>.md`, write this reservation to
`<receipt_root>/<name>-dispatch.md`. Use the task receipt basename as `dispatch_id`.
Copy the assigned identity and budgets, including the allowance consumed by this dispatch.
The task's result receipt copies these fields and references this reservation.

After writing, read the reservation back and verify every field against the assignment.
Return `succeeded` only when the saved reservation matches. The compact report's
`receipt_path` identifies the reservation, and `result.task_receipt_path` identifies
the upcoming task's receipt.

## Confirmation

```json
{
  "execution_status": "succeeded",
  "result": {
    "dispatch_id": "<task_receipt_basename>",
    "task_receipt_path": "<assigned_absolute_task_receipt_path>"
  },
  "receipt_path": "<assigned_absolute_reservation_path>",
  "summary": "Dispatch identity and consumed budgets saved and verified"
}
```

For `blocked` or `failed`, return the same envelope with the corresponding status and
an explicit reason in `result`, preserving any partial record for recovery.
