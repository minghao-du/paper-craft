# Workspace lifecycle and dispatch

Apply this contract to every workflow, including custom stages, replanning, repairs, and nested agents.
Each stage in the workflow defines an abstract logical stage (e.g., `workspace_prepare`, `issue_plan`,
`issue_work`, `issue_verify`, `pipeline_refactor`, `workspace_cleanup`), completely decoupled from its
execution provider (`type: "skill"`).
Every stage's execution context is explicitly materialized as a Task Input Envelope file
(`<receipt_root>/<step_index>-input.json`) before dispatch, and every provider adheres to the unified
Receipt Contract (`{ execution_status, result, receipt_path, summary }` + Markdown receipt).

Resolve `<workspace-skill-dir>` and `<orchestrator-skill-dir>` to the absolute installed directories
of `pc-workspace` and `pc-orchestrator`, following installation symlinks. `<paper-craft-root>` is
the real checkout root two levels above `<orchestrator-skill-dir>`.

---

## Workspace layout and artifact hygiene

Workflows maintain a strict three-tier layout separating persistent state, disposable code environments,
and durable execution receipts:

```text
<project_root>/                         # Main repository checkout (persistent)
├── .agents/                            # Teamwork and agent configurations
├── research-state/                     # Durable research records (NEVER inside disposable worktrees)
└── ...

<worktree_parent_dir>/                  # Worktree container (e.g. <project_root>-worktrees/)
├── issue-<root_issue_id>/              # Isolated feature worktree (disposable)
│   ├── .git                            # Git worktree reference file
│   └── <codebase_files>                # Source files under development
├── verify-<commit_sha>/                # Detached worktree pinned to base commit (disposable)
└── .paper-craft/receipts/issue-<root_issue_id>/  # <receipt_root> (DURABLE)
    ├── state.json                      # Authoritative state machine snapshot
    ├── 01-input.json                   # Step 1 Task Input Envelope
    ├── 01-workspace-prepare-receipt.md # Step 1 Receipt
    ├── 02-input.json                   # Step 2 Task Input Envelope
    ├── 02-issue-plan-receipt.md        # Step 2 Receipt
    └── ...
```

### Layout Invariants
1. **Receipt Root Isolation**: Resolve `<receipt_root>` once during workflow initialization, defaulting to
   `<initial-checkout>-worktrees/.paper-craft/receipts/issue-<root_issue_id>/`. `<receipt_root>` MUST reside
   outside disposable worktree roots so that branch switches, worktree pruning, or resets never delete
   envelopes, receipts, or `state.json`.
2. **Atomic Writes**: Envelopes and state files are written atomically using temporary files, buffer flush,
   filesystem sync (`fsync`), and atomic replace to prevent partial-write corruption.
3. **Step Indexing**: Use monotonically increasing step indices (`<step_index>-input.json` and
   `<step_index>-<task_name>-issue-<current_issue_id>-try-<attempt>.md`). The receipt basename serves as `dispatch_id`.
4. **Research State Durability**: Keep project research state (`research-state/`) and permanent documentation
   exclusively within persistent repository checkouts. Disposable worktrees never hold uncommitted research records.

---

## Preparation (`workspace_prepare`)

Before executing any professional stage that requires codebase access, execute the `workspace_prepare` stage
in the supplied source checkout to validate the source and prepare the target environment.

### Execution Provider Resolution
The `workspace_prepare` stage is executed via a specialized skill subagent:
- **Skill Provider**:
  ```json
  {
    "provider": {
      "type": "skill",
      "target": "pc-workspace",
      "args": []
    }
  }
  ```
  The Orchestrator uses the [dispatch and launch step](../SKILL.md#3-execution-loop) to start `pc-workspace`. The subagent validates source checkout, creates or reuses the target
  worktree, writes the receipt, and returns the compact JSON report.

### Acceptance Gate & Explicit Environment Passing
Accept preparation only when:
1. `execution_status` is `"succeeded"`.
2. `result` contains verified environment properties matching the assigned task:
   - `worktree` / `working_directory`: Absolute path to the prepared environment.
   - `repository`: Verified repository identifier.
   - `branch`: Feature branch name, or `null` for detached environments.
   - `baseBranch`: Integrated base branch (e.g. `main`).
   - `commit`: Verified commit SHA.
   - `outcome`: `prepared` (newly created) or `reused` (compatible existing environment).
3. The physical receipt exists at `contract.receipt_path` and is non-empty.

The preparation receipt records its source execution directory separately from the target environment in `result`. Record whether the target was created or reused. Request/envelope and completion records preserve explicit environment assignments and preparation evidence (there is no `context.workspaces` registry): callers pass the chosen `workdir`/`branch`/`commit` explicitly on each dispatch and link relevant preparation receipts via `predecessor_receipts`. Resolve uncertain creation ownership after an interruption before allowing cleanup. Professional tasks proceed only after accepted preparation.

### Environment Reuse Rules
- **Compatible Stages**: Reuse accepted feature environments across compatible sequential stages (e.g., `issue_work`
  and implementation self-review), forwarding their environment receipt and latest verified SHA.
- **Repairs & Rework**: After code repairs, update the recorded SHA to the new verified commit.
- **Integrated Base / Detached Verification**: For integrated acceptance (`issue_verify`), prepare a fresh detached
  worktree pinned to the integrated base commit (`branch: null`). Feature-branch receipts provide historical delivery evidence.
- **New Features or Refactors**: Prepare a fresh worktree from the requested current base rather than mutating an
  existing environment assigned to another task.

---

## Task Input Envelope & binding execution

Context passing is fully structured and file-based. The Orchestrator NEVER concatenates large natural language prompts.
The [lifecycle dispatch operation](../SKILL.md#lifecycle-operations) writes the Task Input Envelope before granting launch authorization.

### Task Input Envelope Schema (v1.0)
The envelope encapsulates 7 mandatory sections:
1. `task`: `{ logical_stage, step_index, attempt, root_issue_id, current_issue_id }`
2. `provider`: `{ type: "skill", target, args }`
3. `environment`: `{ working_directory, repository, base_branch, branch, commit }`
4. `inputs`: `{ objective, scope, acceptance_criteria, predecessor_receipts, parameters }`
5. `contract`: `{ receipt_path, receipt_template }`
6. `budgets`: `{ delivery_attempts_used, delivery_attempts_max, replans_used, replans_max }`
7. `schema_version`: `"1.0"`

### Binding Execution Across Providers
- **Skill Providers (Subagents)**:
  Dispatched with the Standardized Slim Prompt directing the agent to read the envelope:
  ```markdown
  You are the specialist agent executing stage: `<logical_stage>`.
  Task Input Envelope: `<receipt_root>/<step_index>-input.json`

  Instructions:
  1. Read the Task Input Envelope at the path above to obtain your full task context, inputs, predecessor receipts, environment, and contract requirements.
  2. Bind your execution to `environment.working_directory` (using `environment.primary_checkout` when referencing unlinked primary-repo assets), read `AGENTS.md` (or `CLAUDE.md` if absent) there plus any project/compute policies it references before running domain commands or editing repository files, and follow the specialized instructions in the installed `<skill_name>` skill’s `SKILL.md`. Project language rules do not override deterministic CLI-generated mechanical receipts.
  3. Complete the assigned objective adhering to `inputs.acceptance_criteria`.
  4. Ensure a durable Markdown receipt exists at `contract.receipt_path` matching `contract.receipt_template` — if the skill's CLI kernel already wrote it (e.g. `pc-workspace`), preserve that file verbatim without translating, enriching, or rewriting it.
  5. Return ONLY the standard compact JSON execution report:
  ```json
  {
    "execution_status": "succeeded" | "blocked" | "failed",
    "result": { "outcome": "<domain_outcome>", ... },
    "receipt_path": "<assigned_receipt_path>",
    "summary": "<one_sentence_summary>"
  }
  ```
  ```

### Directory Binding Contract
Supply `environment.working_directory` as an explicit absolute directory. Bind the native launch directory when
supported by the platform adapter. If the platform exposes only a prompt, require explicit command working directories
or `cd "<absolute-directory>" && ...` for each command, plus absolute file paths.
Inject [the environment contract](../../pc-workspace/references/environment.md) into every dispatch.
Require entry validation and the same binding for every nested agent, including read-only reviewers.
A request for another environment returns to the orchestrator for preparation. Missing or conflicting environment
state blocks professional execution and follows the fail-fast halt protocol.

---

## Unified Receipt Contract

Every execution provider (Specialist Subagent) MUST adhere to the Unified Receipt Contract upon completing execution.

### Compact Execution Report (stdout)
Return only this compact JSON object on standard output:
```json
{
  "execution_status": "succeeded" | "blocked" | "failed",
  "result": {
    "outcome": "<domain_outcome>",
    "worktree": "/path/to/worktree",
    "commit": "<commit_sha>"
  },
  "receipt_path": "/absolute/path/to/receipt.md",
  "summary": "<one-sentence summary of work performed and result>"
}
```

- `succeeded`: The assigned evaluation or work produced a valid professional conclusion. Review findings, unmet
  acceptance criteria, and `out_of_scope` can all be valid conclusions.
- `blocked`: A missing prerequisite, access barrier, or environment conflict prevents completing the assigned task.
  Preserves partial findings and identifies required intervention.
- `failed`: An execution error or unrecoverable defect prevents a reliable result.

### Physical Markdown Receipt
The provider must ensure a complete Markdown receipt exists at `contract.receipt_path` conforming to `contract.receipt_template`.
When a deterministic skill CLI (such as `pc-workspace`) writes `contract.receipt_path` directly, keep that CLI-generated receipt verbatim without manual rewriting or translation. Otherwise, the specialist subagent writes the receipt capturing full execution logs, git status, environment verification, artifacts created, and verification evidence.

### Protocol Verification Gate
The Orchestrator checks all 4 report fields (`execution_status`, `result`, `receipt_path`, `summary`) and verifies the
physical presence of the receipt file. If the report is unparseable, missing, or contradictory, the Orchestrator
immediately records the defect via the lifecycle kernel helper (`packages/orchestrator/src/cli.ts complete`) and halts to the Blocker Decision Board without guessing missing conclusions.

---

## Completion, cleanup, and recovery (`workspace_cleanup`)

After required delivery, acceptance, and research recording succeed, execute the `workspace_cleanup` stage.

### Cleanup Resolution
- **Skill Provider**: `provider: { type: "skill", target: "pc-workspace", args: ["--cleanup"] }`

The Task Input Envelope forwards `inputs.parameters.candidates` and `inputs.parameters.unresolved` from tree finalization under the [workspace cleanup contract](../../pc-workspace/SKILL.md#5-cleanup-protocol). Unresolved inventory items keep cleanup incomplete.

1. If a stage other than cleanup completed after the latest successful tree `issue_finalize`, repeat tree finalization before obtaining new cleanup evidence. For the first cleanup after each successful tree finalization, including a repeat, dispatch `pc-workspace` with the full candidate inventory from that finalization, including already-absent candidates, so the receipt records their absence. Apply the existing cleanup policy to every candidate.
2. Run `complete` with the verbatim `pc-workspace` compact report to preserve all removed and retained path and branch evidence, including retention reasons. Check `execution_status` before interpreting `result`. Route `blocked` or `failed` to [Halt & Escalation](../SKILL.md#halt--escalation-protocol). Failed or interrupted workflows retain their environments for diagnosis.
3. On `succeeded` with `result.outcome: incomplete`, keep the workflow open and preserve retained resources. Route all removals through the configured `pc-workspace` cleanup stage under the existing policy. Retry only when evidence shows the blocker has cleared within that authority. If ownership or disposition requires user judgment, pause with `resolve --decision wait_user` and present the specific resource, why it was retained, and the decision needed.
4. For subsequent retries under the same finalization, compare its inventory with successful cleanup records since that finalization. Keep each original candidate with a target still retained in the latest report or missing removal evidence for an applicable worktree path, local branch, or remote branch. Match removal evidence by path for worktrees and by name and scope for branches, including the candidate's push remote for remote removals. Preserve candidate metadata. If the records are too incomplete to identify a reliable subset, reuse the full authorized inventory for an idempotent retry. Run `resolve --decision continue --next-stage workspace_cleanup` (or use the configured stage ID) and dispatch `pc-workspace` through the workflow with a new `request_id` and those `parameters.candidates`.
5. After `complete`, require `inspect` to return `finish_check.status: ready` before `resolve --decision finish`.

### Completion Records & Resumption Evidence
Request/envelope files, completion records, and runtime `context` preserve explicit environment assignments, preparation receipts, and cleanup results across restarts. Resume by inspecting state (`cli.ts inspect`) and recorded preparation/cleanup receipts, supply explicit `workdir`, `branch`, and `commit` fields on subsequent dispatches, and validate live workspace state before further professional work. Historical receipts retain removed paths as audit history and point to durable evidence for subsequent use.
