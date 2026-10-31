---
name: pc-orchestrator-handoff
description: Report independent follow-up or successor work to the orchestrator for EPIC planning and scheduling
---

# /pc-orchestrator-handoff

Workers use this skill to return independent work to the orchestrator. Task-local
implementation, diagnostic, review and issue-lead helpers remain worker-controlled.
Read [the shared workflow contract](../lib/workflow.md) for durable handoff evidence.

1. Record the current issue, owning EPIC, branch/PR, evaluated head, current stopping
   point and remaining obligations in the worklog. Keep unfinished work and records.
2. If a follow-up lacks an issue, use `/pc-issue-next` to file a scoped proposal;
   retain a draft when its direction still requires EPIC or user judgment. Record
   evidence, dependencies and the proposed owner without deciding another EPIC's scope.
3. Append a successor request to the worklog and notify the registered orchestrator
   with the issue/draft and absolute evidence pointers. The orchestrator obtains EPIC
   planning and allocates resources; the worker selects no slot and launches no successor.
4. Record the request as pending until the orchestrator's durable receipt names the
   handling outcome. A sent message alone is not handoff completion. Preserve the
   current checkout until its explicit release and separately verified cleanup gates.

Done when the request is durable, delivered if supported, and its pending or handled
state is recorded. The current task's completion obligations remain independent.
