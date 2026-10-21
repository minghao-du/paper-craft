# Session continuation

Read when persisting or resuming a session through a tuckin, cycle or continue skill.
The continuation is a navigation aid; issues, PRs and recorded work remain authoritative.

## Role and location

Use the explicitly assigned role: `ms`, `spawn`, `epic`, `conductor` or `generic`.
Otherwise inspect task markers: `.ms-config.json` identifies a manuscript and `.epic-status.json` identifies a worker.
When roles overlap or several continuation files fit, ask which assignment to resume.
Native session addresses are optional routing information and cannot establish role or ownership.

Write inside the assigned project or slot at `_ignore/CONTINUE-<role>.md`.
For an epic, use `CONTINUE-epic-<N>.md` to distinguish topics.
Keep this path stable so a fresh agent can locate it without the old session's memory.

## Required content

- Written-at timestamp and role.
- Absolute working directory and authoritative config path when applicable.
- Issue/PR references, branch and exact commit for any recorded approval.
- Decisions and user instructions that still apply, with their durable sources.
- Each unfinished item, its next action and a runnable `FIRST CHECK` that verifies whether it is still relevant.
- Evidence, brief, archive and worklog paths.
- Outstanding user decisions, uncertain occupancy and preservation or delivery failures.

Record enough instruction to resume; reference existing evidence rather than duplicating it.
Keep prepared work separate from confirmed startup and task completion separate from directory release.

## Completion criteria

Before reset, read the written continuation back and ensure each unfinished item has a first check and next action.
Preserve owned work and state; report unpushed commits or failed archives instead of treating them as saved.
Before resuming an item, run its first check and reconcile the result with current issue/PR and filesystem state.
Continue only within the user's recorded authorization and the current runtime's tool rules.
Keep the continuation until the next tuckin replaces it.
