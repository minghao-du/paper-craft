---
name: pc-ms-tuckin
description: Preserve manuscript work and research-state coordination before context reset.
---

# /pc-ms-tuckin

Before manuscript session end or reset:

1. Read [the research-state convention](../../docs/guides/research-state.md).
   Submit new scientific judgments, evidence and useful unfinished discussion to
   the designated coordinator; if this session is the coordinator, integrate them
   there. Explicitly transfer integration responsibility when handing it over,
   reporting any pending transfer or unintegrated findings. Research state stays
   local and ignored by Git; no commit, push or backup is required for it.
2. Update project environment/operation docs only when their instructions changed.
   Existing onboarding notes may retain setup, working practices and peer remits.
   Keep live issue/PR status in GitHub. Preserve paper editing tasks at their
   relevant manuscript locations, with links to scientific records where useful.
3. Inspect manuscript changes with `git diff --stat` and `git diff --cached --stat`.
   Follow the user's existing commit authorization; ask only if a manuscript commit
   needs authorization. Report any uncommitted manuscript work. Do not commit
   unrelated files or ignored research state. Use the project's normal manuscript
   build when the session changed TeX or figures and report any unresolved failure.
4. Keep existing `.ms-config.json` source/fetch locations current when necessary;
   retain operational configuration without creating a scientific summary there.
5. Write `_ignore/CONTINUE-ms.md` per [the continuation contract](../lib/continuation.md).
   Point to the fixed research entry, coordinator responsibility, project operation
   docs and manuscript editing tasks. Resume in the manuscript repo via `/pc-ms`.
   Include evidence pointers and unresolved access gaps rather than copying analysis.
6. Report manuscript preservation, research integration or handover gaps, pending
   editorial work and the continuation path. A pending handover remains pending.
