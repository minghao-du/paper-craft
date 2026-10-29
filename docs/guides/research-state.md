# Project research state

Each Project designates one fixed local research home, which may serve several
repositories and is independent of any Fleet or checkout. Its entry is
`<research-home>/research-state/RESEARCH-STATE.local.md`. Related repositories,
clones and worktrees resolve a discovery pointer to that same absolute entry;
never copy the authority into each checkout. Use ordinary files and startup
instructions, without a new CLI or configuration service.

When establishing the home, add `/research-state/` to the home repository's Git
ignore rules (or ignore the entire workspace if the home is outside a repository).
The whole workspace, including detailed records, is local-only. Check for already
tracked files: ignore rules alone do not untrack them. Use `git rm --cached` on
those files, preserving local contents. Neither backup nor synchronization is
required; losing the files may lose scientific judgments that evidence alone
cannot fully reconstruct. Structured references, Projects and repositories retain
the JSONL/nexus architecture; this Markdown workspace is its explicit exception.

The entry expresses current scientific understanding: goals, important progress,
findings, current explanations, unresolved questions, necessary route and next
steps. Distinguish plans, hypotheses, observations, interpretations and conclusions.
Update topics rather than append chat history. Keep each complete analysis in one
authoritative place; the entry and any cross-experiment threads use short summaries
and links. Split complex experiments or threads only when needed. Raw evidence
stays at its original location; live task status stays in its task system.

Research planning and discussion both read this entry and task-relevant details.
Preserve a route's question, method, expected output, stage dependencies and
conditions for advancing or changing direction. A plan does not authorize execution.
The designated coordinating session integrates scientific updates; other sessions
return findings to it. Preserve useful unfinished scientific discussion there rather
than only in chat. A manuscript is not required to begin.

If a pointer, entry or linked record is missing, report the gap and sources available.
Reconstruct only from accessible records and evidence, naming unverified content
and missing information; never imply that the original full state was recovered.

Use this discovery sentence in each related repository's agent/startup guidance,
replacing the placeholder with the same absolute path:

> Before interpreting research goals, planning, discussing or updating findings,
> read `<absolute-research-home>/research-state/RESEARCH-STATE.local.md` and the
> relevant linked records; submit findings to the designated coordinator for integration.

An [optional entry template](research-state-template.md) is a starting point;
merge or remove sections freely. Existing projects adopt this convention on demand;
this guide does not move their materials or retire untransferred workflow capabilities.

## Integrating findings and handing over

Designate one coordinating session as the sole integrator of shared scientific
state. Same-machine workers read the fixed entry; remote workers receive the
question, relevant context and evidence pointers from the coordinator. Workers
return findings, evidence locations, limitations and suggested next steps, rather
than maintaining another authoritative state. At handover explicitly name the
successor, transfer pending findings and unresolved evidence gaps, and relinquish
integration before the successor takes over. Re-reading before writing helps
merge edits but does not replace this responsibility; no lock service is required.

For an important experiment, keep its question, data identifiers, necessary
parameters and commands, key numbers and figure pointers, interpretation, scope
and unresolved questions together in its authoritative analysis. For findings
that affect direction or manuscript claims, distinguish the specific run: record
code version and result-relevant uncommitted changes, data version, configuration
and output locations as needed. A replaceable `latest` path alone is insufficient;
use a run identifier and evidence that still distinguishes that run. Remote
locations include host and path. Raw outputs stay where produced; checksums for
every file are not required.

The coordinator integrates returned evidence as follows:

1. Inspect the evidence supporting the claim, distinguishing previously verified
   findings from evidence checked this time. Report inaccessible evidence and
   broken links, with their effect on what can be established. Inaccessibility
   alone neither disproves a past finding nor confirms it anew.
2. When text conflicts with data or runs disagree, check conditions and
   comparability before revising the interpretation. Preserve unresolved
   disagreements. Promote or revise conclusions on inspectable evidence within
   its stated scope; no universal human approval gate applies. Insufficient
   evidence remains an observation, interpretation or open question.
3. Update the authoritative detailed analysis, related current analyses, entry
   summaries and necessary references, including the route and next steps.
   Mark affected content pending review when it cannot yet be reassessed;
   this is an editing responsibility, not an automatic dependency system.
4. Retain negative results, rejected explanations and method limits when useful
   to future judgment. Remove valueless duplication; keep a brief reason for
   important changes of direction. Ordinary execution errors and live task
   status belong in the original run or task system.

For cross-repository updates or remote result retrieval, use
[`/pc-ms-poll`](../../skills/pc-ms-poll/SKILL.md). Despite its legacy name, it
works before a manuscript exists and submits evidence to this same coordinator.

## Adopting the convention in an existing project

Choose the single research home and update discovery pointers in related repository
and startup guidance. Apply the whole-workspace ignore and tracked-file handling
above before moving state: `git rm --cached` removes tracked copies from the index
while retaining local files. Do not create one workspace per clone.

Read old research summaries, `RESEARCH-PLAN.md`, onboarding and continuation notes
for content worth keeping. Integrate scientific judgments, necessary route and
useful unfinished discussion into the entry or its linked analysis; preserve a
brief reason for consequential changes of direction. Leave setup and operating
instructions in project docs, live progress in its task system, and manuscript
editing tasks beside the relevant text. Retire parallel scientific entry requirements
and remove only duplicates with no independent value after their useful content
has been integrated. A provenance marker can retain an evidence pointer without
becoming the authority for the underlying scientific judgment.

Writing consumes this same state. When writing or review requires further research,
update scientific understanding through the coordinator before revising the paper.
Migration is adopted on demand; it requires no backup, synchronization, historical
archive or complete reconstruction of lost judgments.
