# Workspace lifecycle and dispatch

Apply this contract to every workflow, including custom stages, replanning, repairs, and nested agents.
Each stage declares its environment source, required revision, and whether it reuses or needs a new
workspace. Resolve this before dispatching its professional task.

## Preparation

Dispatch a fresh [pc-workspace](../../pc-workspace/SKILL.md) agent in the supplied source checkout
before the first professional task and whenever a new environment is needed. The preparation agent
validates the source and prepares the target. Its own `working_directory` is the existing source
checkout. Cleanup agents run in a retained checkout outside their candidates.

Before preparation, persist the requested path, branch or integrated revision, source checkout,
preparation receipt path, and status in `state.json`. Accept preparation only with a verified
`repository`, absolute `working_directory` / `worktree`, `branch`, `baseBranch`, and `commit` in
`result`, matching the assigned task. A detached environment has `branch: null`.
The preparation receipt records its source execution directory separately from the target environment
in `result`. Record whether the target was created or reused. Resolve uncertain creation ownership
after an interruption before allowing cleanup. The professional task waits for accepted preparation.

Reuse accepted environments across compatible stages, forwarding their environment receipt and the
latest professional receipt for the delivered SHA. After repairs, use the new verified SHA. A merged
feature receipt supplies historical evidence when a stage instead requires the integrated base.
For new repairs, refactors, or a newer integrated target, prepare a fresh environment from the
requested current base rather than changing an existing assignment underneath another task.

## Binding execution

Supply `working_directory` as an explicit absolute dispatch argument plus the repository, branch,
base branch, relevant expected SHA, and environment receipt. Bind the native launch directory when
supported. If the platform exposes only a prompt, inject the absolute directory and require explicit
command working directories or `cd "<absolute-directory>" && ...` for each command, plus absolute
file paths. Do not invent unsupported adapter parameters.

Inject [the environment contract](../../pc-workspace/references/environment.md) into every dispatch.
Require entry validation and the same binding for every nested agent, including read-only reviewers.
A request for another environment returns to the orchestrator for preparation. Missing or conflicting
environment state blocks professional execution and follows the existing halt protocol.

Carry the fixed research entry and task-specific absolute or host-qualified artifact locations.
Each professional agent handles its project dependencies, compute setup, and input checks in that
environment. Keep research state, receipts, and retained artifacts outside disposable workspace roots.

## Completion, cleanup, and recovery

After required delivery, acceptance, and research recording succeed, dispatch `pc-workspace` with
this run's created candidates, final SHAs, delivery/verification receipts, artifact retention evidence,
and completed-user status. Reused/manual environments require an explicit cleanup request.
Accept cleanup only with removed and retained paths and reasons. Recorded retention can complete
cleanup without deleting unsafe candidates. Failed or interrupted workflows retain their environments.

Persist active environment assignments, preparation status and receipts, creation ownership, and
cleanup results in `state.json` under `context.workspaces`. Update this state before dispatch and after
acceptance so resumption can recover the workspace decision without replaying past conversations.
Resume with the recorded assignment and validate it before further professional work. Historical
receipts keep removed paths as history and point to durable evidence for subsequent use.
