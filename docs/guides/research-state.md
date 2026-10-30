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

The [optional report examples](research-state-template.md) provide starting points;
merge or remove sections freely. Existing projects adopt this convention on demand;
this guide does not move their materials or retire untransferred workflow capabilities.

## Directory reports and navigation

Mirror the meaningful directory hierarchy of `workflow/scripts/` in the research
workspace, including nested stages. A directory represents a research or computing
stage when its steps produce results worth reporting; omit utility, cache and
generated directories. Create reports as work is undertaken, rather than empty
files for every code directory. Without a scripts tree, organize by the actual
research stages and name their implementation sources.

The root entry summarizes project progress and links to module reports. Each
mirrored directory has a `README.md` reporting what its steps did, their results,
current state and next steps, with links to child reports and supporting evidence.
These are progress reports with headings chosen for their content, not mandatory
paper-style sections. Split out a report only when the material grows long or an
experiment warrants independent preservation. Folder correspondence does not
require one Markdown file per script or matching script filenames. Keep each
result in one authoritative report and link to it from other stages or summaries.

Name the repository and code root corresponding to each mirrored subtree. Keep
single-repository paths simple; add a repository level where needed to distinguish
colliding paths across repositories. Resolve code and evidence paths relative to
the named repository root; resolve report navigation relative to the linking file.
Map reported steps to actual scripts, rules, inputs, outputs and specific runs
where applicable. Several scripts may implement one step, and shared scripts may
serve several reports without duplicating their results.

Initialization, migration and explicitly requested full audits inspect the complete
recursive scripts tree and actual rule/caller relationships. Routine updates trace
changed code, configuration, inputs or results through their real dependencies,
including consumers in other directories or repositories. Expand inspection when
relationships are unclear and report remaining uncertainty; unrelated reports need
no recheck. Mark affected results pending verification or rerun when reassessment
is incomplete. A code-only refactor needs report changes only if mappings or
result-relevant information changed.

After changing a report, check its direct parent's summary and navigation. Continue
upward when that summary or stage status changes; the root changes only for
project-level progress or findings. On moves, renames or deletion, repair affected
links and mappings while retaining results with independent value; identify
historical paths and unavailable evidence explicitly.

Within the selected scope, verification accounts for each affected step's report,
checks navigation and code/evidence mappings, and confirms summaries agree with
their source reports. Unverified results and inaccessible references remain
explicit. During adoption, map existing records before moving them and retire
superseded copies only after their useful content and inbound links are integrated.

## Integrating findings and handing over

Designate one coordinating session as the sole integrator of shared scientific
state. Same-machine workers read the fixed entry; remote workers receive the
question, relevant context and evidence pointers from the coordinator. Workers
return findings, evidence locations, limitations and suggested next steps, rather
than maintaining another authoritative state. At handover explicitly name the
successor, transfer pending findings and unresolved evidence gaps, and relinquish
integration before the successor takes over. All writes inside `research-state/`,
including initialization and migration, use
[`/pc-research-state`](../../skills/pc-research-state/SKILL.md). This is the writing
role: the caller retains scientific judgments and coordination responsibility;
the writer returns evidence conflicts and unresolved decisions to it.
Re-reading before writing helps
merge edits but does not replace this responsibility; no lock service is required.

Report each step's work and results with the data identifiers, parameters, commands,
key numbers and figure pointers needed to understand or verify them. Preserve
useful explanations, limitations and unresolved questions in the same report;
these do not require separate template sections. For findings
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
