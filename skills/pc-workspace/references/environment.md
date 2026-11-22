# Assigned execution environment

Before repository operations, resolve one absolute `working_directory` from the task or supplied
environment file. `worktree` names the same directory in existing environment outputs.
For direct invocation, an explicitly selected current checkout is an assignment too.
Before running any project command or modifying files, read `AGENTS.md` (or `CLAUDE.md` if absent)
in the assigned checkout together with any project or compute policy documents it references,
and strictly follow their execution boundaries and environment rules.

Verify the checkout root and repository identity against the assignment, the branch (or detached HEAD),
and any expected commit before work. Resolve and record omitted direct-invocation revision fields from
that checkout. Check the task's required cleanliness. An implementation self-review may intentionally
include uncommitted and new files. Report conflicting or missing environments to the caller with expected
and observed values so preparation or reconciliation can happen before work.

Bind the agent's launch directory when the platform supports it. Use an explicit working directory for
each command or an explicit `cd "<absolute-path>" && ...` in that command, and resolve file operations
against the assigned root. A directory change in one command or another agent does not set subsequent
execution context. Use `git -C` and explicit GitHub repository selection where appropriate.

Any nested agent receives the same directory, repository, branch, relevant revision, and task-specific
working-tree scope. Apply this contract recursively. Return requests for a different environment to the
caller before dispatching work there. Record the actual environment and refreshed HEAD on completion.

Resolve one fixed research entry shared across checkouts from project guidance. Pass required artifact
locations as absolute local paths or host-qualified remote paths. When `.paper-craft/workspace-config.json`
configures `shared_paths`, `pc-workspace` links those git-ignored paths from the primary checkout into
new or reused worktrees; use `environment.primary_checkout` (when supplied) to locate unlinked read-only
assets in the primary checkout. Preserve the unique research home and retained artifacts independently of
disposable code worktrees. Assigned external result files authorize writes at their exact paths.

## Artifact handoff

Resolve prior outputs from supplied delivery receipts' `artifact_locations`. Use explicit paths to read
inputs at their source when supported. For fixed worktree input paths, use configured `shared_paths`
via `pc-workspace` and route missing mappings through `pc-workspace-config` for review and approval.

### Worker delivery

Before execution, resolve run-owned scratch on the execution host for transient outputs and a
project-approved durable destination outside disposable worktrees and scratch for required non-Git
deliverables. Use a run-specific destination if later jobs could overwrite the usual path.

Before reporting success, verify each required deliverable or output set is readable at its durable
destination in the named environment. Record its absolute local or host-qualified remote path in
`artifact_locations` and the check in the receipt's verification evidence. If a required handoff
remains unresolved, report `blocked` with the current location and action needed.

### Independent verification

Use the declared artifact locations, or the caller's explicit paths for manual verification without
receipts. Inspect the durable outputs in place in the named environment. Run engineering checks and
reproduction from the assigned integrated HEAD. Direct new outputs and logs to independent run-owned
scratch on the execution host and treat delivered evidence as read-only.

### Workspace check

When a command requires fixed output paths in the worktree, inspect them before execution and track
which files or directories the run creates. At handoff, after passing or failing checks, run
`git status --short --ignored=matching` in the assigned worktree and inspect output paths on the
execution host. After the last consumer, remove only proven disposable files from this run or wholly
run-owned disposable directories. Verify a required result's durable copy before discarding its local
copy. Preserve configured `shared_paths`, `protected_ignored` paths, needed diagnostics, and paths of
uncertain ownership. Check removal and report retained paths with reasons in the worker receipt or
verifier evidence. Report cleanup findings separately from scientific acceptance.
