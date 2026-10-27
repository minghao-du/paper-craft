# Antigravity CLI wake-up

Follow the shared [handoff and wake-up contract](../workflow.md#active-role-handoff-and-wake-up).

When the current session exposes the built-in `schedule` tool, use its one-shot form:

```json
{
  "DurationSeconds": 60,
  "TimerCondition": "any",
  "Prompt": "Continue the registered role and bound EPIC using skills/lib/workflow.md. Reconcile durable handoffs and current state, handle changes within existing authority, then re-arm one wake-up. Stay quiet if unchanged."
}
```

Fill the prompt with the current role, absolute config path, absolute shared-contract path
and EPIC number (for the EPIC role). Finish other tool work first: scheduling returns
immediately and must be the last tool call before yielding. Require a successful result and
task identity before reporting wake-up armed. `TimerCondition: any` cancels the timer on an
incoming message, which wakes the agent; that turn must also reconcile and re-arm.
See the [native schedule contract](https://antigravity.google/docs/commands/schedule/).
