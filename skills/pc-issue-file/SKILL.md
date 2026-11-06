---
name: pc-issue-file
description: Create or update GitHub issue from markdown file using --body-file
allowed-tools: Bash, Read
---

# /pc-issue-file

Create or update a GitHub issue using a markdown file as the body.
This skill can be invoked directly by a human or agent with a file path, or dispatched automatically by the workflow orchestrator.

## Task Inputs

Before executing, verify the following inputs:
1. **Draft markdown file:** Path to the local issue file (e.g., `ISSUE-<slug>.md`).
2. **Target issue context (optional):** If updating an existing issue, the issue number (inferred from conversation context or command argument).
3. **Assignee (optional):** GitHub username to assign, only if explicitly requested.

## Filing Procedure

### Step 1: Determine the file path

- If `$ARGUMENTS` is provided, use that as the file path.
- Otherwise, check if the file path is clearly determinable from the current conversation context.
- If unclear, ask the user which file to use.

### Step 2: Check for existing issue context

Search the recent conversation history for:
- Issue numbers referenced in discussion (e.g., "#123", "issue 123").
- Any clear indication that the task intends to update a specific issue.

If found, this is an UPDATE operation.
Otherwise, CREATE.

### Step 3: Check for assignee context

Look for explicit mentions like:
- "this is an issue for [username]"
- "assign this to [username]"

**Do NOT auto-assign without explicit context.**

### Step 4: Extract title from file

For CREATE operations, extract the title from the file:
1. Read the first line of the file.
2. If it starts with `# ` (markdown h1 heading), strip the `# ` prefix and use as title.
3. If no markdown heading, use the filename (without extension) as the title.

### Step 5: Execute

**Update** (issue number found in context):
```bash
gh issue edit <number> --body-file <file>
```

**Create** (no issue number):
```bash
gh issue create --title "<extracted title>" --body-file <file>
```

**Create with assignee** (if explicitly mentioned):
```bash
gh issue create --title "<extracted title>" --body-file <file> --assignee <username>
```

**IMPORTANT:**
- NEVER use `--label` flags.
- NEVER ask the user for the title — extract it from the file or filename.
- Use `--body-file` (or `-F`) flag exclusively for the body.
- Only add `--assignee` if explicitly mentioned in conversation context.

### Step 6: Move the draft out of the way (CREATE only)

On a successful **create**, the source file has done its job — move it so it stops being mistaken for unfiled work by any draft sweep or confusing a future agent poking around the repository:

```bash
mkdir -p _ignore && mv <file> _ignore/
```

Skip this for **update** operations — the file is still the live source for future edits to that issue, so it stays in place.

## Quality Requirements & Completion Criteria

1. **Verbatim fidelity:** The issue body must be passed via `--body-file` without truncation or alteration.
2. **Title extraction:** Title accurately reflects the H1 heading or filename.
3. **Draft isolation:** Newly created draft files are relocated to `_ignore/`.
4. **No spurious tags:** No unapproved labels or assignees are attached.

## Task Outputs

1. **GitHub issue:** Created or updated issue number and URL.
2. **Draft location:** Location where the draft file was archived (`_ignore/<file>`) or preserved.
3. **Receipt / submission:**
   - When dispatched via workflow engine: the execution receipt is submitted via the `pc workflow submit-result` command supplied in the dispatch prompt.
   - When invoked manually or standalone: report the issue number, URL, operation type, and archived file location to the caller.
