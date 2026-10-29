---
name: pc-tuckin
description: Universal tuckin dispatcher — persist session state before a context reset by delegating to the right /pc-*-tuckin (ms, spawn, epic, conductor), or a generic fallback when the session is none of those. Run before /clear; pairs with /pc-continue. `/pc-cycle` also clears and resumes the session itself.
allowed-tools: Skill, Bash, Read, Write, Edit
---

# /pc-tuckin

One entry point for persisting session state before `/clear`.
It determines the session's role, runs the matching tuckin, and that skill writes the role-keyed continuation prompt ([the continuation contract](../lib/continuation.md)) which `/pc-continue` reads in the next session.

## Choosing the tuckin

If `$ARGUMENTS` names a role — `ms`, `spawn`, `epic`, `conductor`, `landing`, or `generic` — use it.

Otherwise determine the role per [the continuation contract](../lib/continuation.md): explicit assignment or task markers (`.ms-config.json` → `ms`, `.epic-status.json` → `spawn`), then ask if ambiguous.
When native role registration is available, cross-check the exact current identity against the EPIC-keyed `.epic-sessions/<N>.json` / `.conductor-session`; do not require a Claude session listing.
Never infer the role from what the session has been discussing.

Map the role to its skill and invoke it with the harness's skill tool or read and follow its text — do not reimplement it:
`ms` → `/pc-ms-tuckin`, `spawn` → `/pc-spawn-tuckin`, `epic` → `/pc-epic-tuckin`, `conductor` → `/pc-conductor-tuckin`.

## Landing continuation

For an explicitly assigned landing agent, persist the current phase and evidence through
[Lifecycle recovery](../lib/workflow.md#lifecycle-recovery), then write the landing
continuation per the continuation contract. After checkout release, send these pointers
to the conductor to write there and report persistence pending until it acknowledges.
Resume through the conductor’s verified assignment and ownership transfer; this branch
ends with the continuation path or a concrete persistence blocker, without generic commit/push.

## Generic fallback

For a session that is none of the roles above — an ad-hoc or adjudicator session — there is no specialised tuckin, so do the minimum that makes a reset safe:

1. Commit and push anything this session owns; branch first if on `main`, and leave the pooled-slot branches a conductor manages alone. Report what is unpushed rather than forcing it.
2. Write `_ignore/CONTINUE-generic.md` per the guide.
3. Report what was committed and that the prompt is written; then it is safe to reset.

