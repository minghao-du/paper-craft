---
name: pc-research-state
description: Write research-state/ when research findings, agreed plans, or discussions need recording, when adopting an existing project's research state, or when another skill needs shared research records updated
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# /pc-research-state

Authoritative writer for the project's shared research state. All writes inside `research-state/` go through this skill, including initialization and migration.
The calling session or human owns scientific judgments and research direction; this skill checks supporting materials and edits the record. It does not become the research coordinator or authorize experiments. Use the project's language.

This skill can be invoked directly by a human or agent with an update brief.

## Working directory

Follow [the environment contract](../pc-workspace/references/environment.md) in the prepared
working directory supplied by the caller. For manual use, select an existing checkout or prepare
one with [pc-workspace](../pc-workspace/SKILL.md) before starting. Resolve the shared research
entry independently of that checkout and write to its fixed home.

## Task Inputs

Before executing, verify the following inputs:
1. **Designated research entry:** Fixed entry point from project agent/startup guidance (`research-state/RESEARCH-STATE.local.md` or external designated project home).
2. **Delivery evidence & writing brief:** The caller's findings, agreed plan, hypotheses, or explicit delivery evidence (commit SHAs, test results, benchmark summaries) to record, along with limitations.
3. **Artifact locations:** Specific file and directory paths for produced analytical artifacts, figures, models, or processed datasets.
4. **Reproduction entry points:** Concrete commands, execution scripts, or pipeline targets required to reproduce the findings.
5. **Supporting materials:** Relevant run logs, benchmark tables, pipeline output files, or source code paths with specific identities.

## Recording Procedure

### Step 1: Resolve the writing brief

Read [the research-state convention](references/convention.md).
Resolve the fixed entry from project agent/startup guidance and read it with the records relevant to the update.
**Progressive disclosure & context hygiene:** For large research state files (>10KB such as `RESEARCH-STATE.local.md`), avoid dumping the entire file into context at once. Use outline discovery (e.g. `grep -n "^## "` or table of contents) and section slicing (`StartLine`/`EndLine`) to read only the sections relevant to the update brief (e.g., core conclusions, specific model phase, evidence tables).
Obtain the caller's findings or agreed plan, evidence locations, limitations, and intended changes. Use accessible materials to fill factual gaps; return missing scientific decisions to the caller.
If another session coordinates this project, route proposed scientific changes through it before writing; invoking this skill does not transfer coordination.

For initialization or migration, resolve one designated research home, apply the convention's ignore and tracked-file handling, and establish its discovery pointer.
Ask for the home only when it cannot be resolved unambiguously. Read existing materials before moving useful content; label reconstructed and unverified state.

**Done:** The unique destination, requested update, available sources, and gaps are explicit, and the caller is responsible for any required scientific decisions.

### Step 2: Check the material

Apply the convention's evidence and integration rules to each consequential claim.
Distinguish evidence inspected now from previously verified findings. Keep specific run identities and evidence locations sufficient to distinguish the reported run; remote evidence includes host and path. A successful workflow exit establishes execution success, not a scientific conclusion.

When evidence conflicts with proposed wording or existing findings, inspect conditions and comparability. Return the contradiction and supporting sources to the caller for interpretation; keep the disputed conclusion unresolved. Record independent supported updates without waiting on unrelated gaps. Inaccessible evidence retains its stated verification status and an explicit access gap.

**Done:** Every proposed claim has an evidence status; contradictions and missing scientific decisions are either resolved by the caller or explicitly pending.

### Step 3: Edit the shared state

Re-read affected records before editing. Apply the convention's directory reports and navigation rules: establish the recursive folder mapping during initialization or migration; for routine updates trace only the affected steps and consumers.
Update their reports in place and check parent summaries as changes propagate.
Read and apply the [report requirements and default template](references/report-template.md) for every report written or updated. Content coverage is mandatory; headings may adapt to the analysis. Keep raw evidence at its source.

Verify the caller's mapping to repositories, scripts, workflow rules, inputs, outputs, and specific runs in the affected reports. Preserve useful existing records and repair inbound links when reorganizing them.

Maintain a coherent account of current understanding by integrating new findings into the relevant sections. When a conclusion changes, retain its consequential evidence and the reason for revision; leave unresolved conflicts explicit. Update related summaries and references; flag affected interpretations pending reassessment when the caller has not resolved them. Keep live task status in its task system.

During migration, retire parallel scientific entries only after their useful content has been integrated. Preserve unrelated operating instructions and local files when removing tracked copies from Git.

**Done:** Each requested update is recorded or explicitly deferred with its reason; affected steps have report locations, folder mappings and links are current, and parent summaries and dependent reports agree or explicitly await verification. Reports explain the findings and their meaning at the depth required by the template.

### Step 4: Verify and return

Read the changed records, verify affected folder/code/evidence mappings, follow local links, and check the discovery pointer. Check dependent reports and parent summaries within the impact scope for stale results.
Apply the template's coverage check against the analysis questions and major evidence artifacts, including results absent from the caller's summary. Return newly discovered scientific interpretation questions to the caller. Confirm that an uninvolved reader can understand the results through research-state reports alone; mark any remaining evidence or coverage gaps.
Confirm that the entire workspace is ignored and no research-state files remain tracked in Git. Check that unsupported conclusions were not promoted and that unresolved questions remain visible. Report inaccessible remote references as unchecked.

Return the entry and changed record paths, what was integrated, evidence checked, and pending contradictions or decisions to the caller. Leave research direction and any experiment execution with the caller.

**Done:** The written state matches the brief, result coverage and independent readability checks pass within the declared scope, navigation resolves or has reported gaps, and every deferred update is accounted for. Unavailable evidence leaves an explicit coverage gap rather than a claim of complete verification.

## Quality Requirements & Completion Criteria

1. **Epistemological clarity:** Strict distinction maintained between plans, hypotheses, observations, interpretations, and conclusions.
2. **Evidence traceability:** Consequential claims cite specific run identities, data paths, host environments, or benchmark metrics.
3. **Workspace hygiene:** Research-state workspace is entirely gitignored; zero research-state files are tracked in Git.
4. **Navigation integrity:** Directory reports, relative links, and discovery pointer in agent startup guidance resolve without broken references.
5. **Result completeness:** All consequential findings within the declared scope are explained or explicitly unresolved under the report requirements; raw artifacts serve verification and reproduction rather than supplying missing result explanations.

## Task Outputs

1. **Updated research records:** Added or modified files under `research-state/` (or designated project home).
2. **Summary:** Changed record paths, integrated content, evidence and coverage status, and pending contradictions or unresolved decisions.
