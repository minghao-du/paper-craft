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
