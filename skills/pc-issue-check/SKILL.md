---
name: pc-issue-check
description: Review an issue draft markdown file for strategic clarity, falsifiable gates, reality-checked references, and scope discipline, then interactively apply fixes
allowed-tools: Agent, Bash, Read, Edit, Glob, Grep
---

# /pc-issue-check

Review a local GitHub issue draft markdown file (`ISSUE-*.md`) for strategic clarity, falsifiable gates, reality-checked codebase references, and scope discipline before submission, then interactively apply approved fixes.

```
/pc-issue-check ISSUE-<slug>.md
```

## Task Inputs

1. **Target file path:** Local path to the issue draft (e.g., `ISSUE-<slug>.md`).

> [!IMPORTANT]
> The target file path must be explicitly provided via `$ARGUMENTS` or the task prompt. If no file path is provided, stop and prompt the user to specify one. Never guess or infer paths silently from directory listings.

## Review Procedure

### Step 1: Validate file presence

Read the target file. If the file does not exist or cannot be read, fail fast with a descriptive error message indicating the missing path.

### Step 2: Spawn Review Subagent for repository reality checks

Launch a dedicated review subagent to explore the codebase and check external references in a fresh context window. Pass the issue draft text and current repository root.

The subagent executes the following concrete investigations:
1. **Reference & Symbol Verification**: For every file path, directory, function name, config key, and CLI flag mentioned in the draft:
   - Check file existence (`git ls-files --error-unmatch <path>` or local read).
   - Trace CLI flags to their parser definitions and consumers to ensure they exist, parse, and are not dead knobs or defaults.
2. **Code Reuse Check**: Search the existing codebase (`packages/`, `skills/`, scripts, pipelines) for helpers, utilities, or workflows that already solve part of the proposed work. Identify opportunities to simplify the draft and shrink scope.
3. **Duplicate & In-Flight Work Search**:
   - Run `gh issue list --state all --search "<keywords>" --limit 30` using 3–5 key terms from the draft. Flag open duplicates, overlapping parent/child scopes, or closed issues that already solved the deliverable.
   - Run `gh pr list --state open --limit 50` to check for open PRs touching the same components or files.
4. **Cost & Complexity Arithmetic**: For any algorithmic complexity claims (e.g., $O(N \log N)$), memory bounds, or execution runtime claims, calculate concrete numbers for expected real-world input scales. Flag claims that fail basic arithmetic by >2x or encounter scaling cliffs.

The subagent returns a consolidated fact-check report citing exact file paths, lines, and commands executed.

### Step 3: Evaluate Core Quality Dimensions

Using the draft content and the subagent's fact report, evaluate the draft across 5 core dimensions:

#### 1. Goal Clarity
- **Objective vs. Strategy**: Does the draft clearly distinguish the core deliverable / objective (what is being achieved) from the search strategy or implementation tactics (how it is achieved)?
- **Crisp Problem Statement**: Is the residual problem or motivation unambiguous, without hand-waving?
- *Flag conflation or vague goals as **CRITICAL**.*

#### 2. Scope Discipline
- **"What this is NOT" / Out of Scope**: Does the draft contain an explicit section defining boundaries and excluded work?
- **Smallest Viable Deliverable**: Does the proposal contain bloat, premature optimization, or unneeded abstractions that could be cut or deferred?
- *Missing scope boundaries or unneeded complexity flagged as **HIGH**.*

#### 3. Falsifiable Acceptance Gates & Tangible Artifacts
- **Observable Artifacts**: Does the issue specify concrete output artifacts (file paths, schema files, metric tables, figures) rather than abstract progress?
- **Automated Acceptance Commands**: Does each phase or acceptance criterion specify concrete, executable test or validation commands (e.g., CLI command, test file, benchmark run)?
- **No Qualitative Hand-Waving**: Check for words like "fast", "scalable", "robust", "clean". Every adjective must be pinned to a quantitative threshold or binary observable gate.
- *Unfalsifiable gates or missing validation commands flagged as **CRITICAL**; missing quantitative thresholds flagged as **HIGH**.*

#### 4. Reality Check & References
- **Grounding in Codebase**: Verify that referenced integration points align with the subagent's findings.
- **Duplicate Collision**: Address any overlapping issues or open PRs identified by the subagent.
- *Referencing non-existent files/flags flagged as **HIGH**; unaddressed duplicate issues flagged as **HIGH**.*

#### 5. Format & Markdown Discipline
- **Title Extraction**: Top-level `# <Title>` in imperative mood.
- **Single-Line Paragraphs**: No hard-wrapped lines inside paragraphs or bullet points (paragraphs written on a single line so GitHub's renderer wraps cleanly).
- **Robot Indicator**: Acknowledge robot emoji 🤖 as first character of body if present per project conventions.
- *Hard-wrapping or structural formatting defects flagged as **MEDIUM**; minor wording nits as **LOW**.*

### Step 4: Display Numbered Findings to User

Order all identified issues by severity: **CRITICAL ➔ HIGH ➔ MEDIUM ➔ LOW**.
Assign a single sequential number (`#1`, `#2`, ... `#[N]`) across all categories so the user can easily reference them.

Format the output for immediate user review:

```markdown
### Issue Draft Quality Review: `<file>`

Found [N] item(s) to address:

#### 1. [CRITICAL] <Title>
- **Problem**: <One-sentence summary of the flaw>
- **Quote**: `<Quoted snippet from draft>`
- **Suggested Fix**:
  ```markdown
  <Concrete replacement text>
  ```

#### 2. [HIGH] <Title>
- **Problem**: <One-sentence summary>
- **Quote**: `<Quoted snippet>`
- **Suggested Fix**:
  ```markdown
  <Concrete replacement text>
  ```

...
```

If **0 issues** are found, report:
```markdown
✅ **Draft Passed All Gates**: The draft satisfies all strategic clarity, falsifiable acceptance, and format requirements.
Ready to submit via `/pc-issue-file <file>`.
```
Halt execution if passed.

### Step 5: Wait for User Reply and Apply Fixes

If issues were found, **stop and wait for the user's instructions**. Do not apply edits prematurely.

Handle user responses:
- **"全部修复" / "All" / "Approve all"**: Apply all suggested fixes sequentially to the draft file.
- **Selective approval (e.g., "修复 1, 3")**: Apply only the approved subset of fixes.
- **Custom instruction (e.g., "第 2 条按这样改...")**: Incorporate the user's customized text for the specified items.

Apply approved edits in place using the `Edit` tool:
- Replace flagged text blocks verbatim with the approved fixes.
- Ensure all revised paragraphs are unwrap-formatted (single long lines without hard line breaks).

### Step 6: Verify and Report Handoff

After modifying the file:
1. Conduct a quick sanity check to confirm the edits applied cleanly without syntax errors or broken headings.
2. Present a concise summary of the changes made.
3. Provide the handoff command to file the issue:
   ```bash
   /pc-issue-file <file>
   ```

## Quality Requirements & Completion Criteria

1. **Explicit File Input**: Always requires user-provided file path; halts if missing.
2. **Subagent Grounding**: All referenced paths, flags, and duplicates are validated against the actual repository tree via a dedicated subagent.
3. **Sequential Numbering**: All findings across all severities are sequentially numbered (`#1` to `#[N]`) for frictionless human steering.
4. **Human-Controlled Fixes**: Edits to the draft file are applied only after explicit user confirmation or instructions.
5. **Decoupled Handoff**: The skill repairs and polishes the draft; submission is cleanly handed off to `/pc-issue-file`.
