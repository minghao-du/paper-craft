# Project: paper-craft Architecture Optimization (Stage Decoupling, Input Envelope, Kernel-Wrapper)

## Architecture
- **Stage-Provider Decoupling**: Separation of abstract workflow tasks (`task_type`, e.g. `workspace_prepare`, `issue_plan`, `issue_work`) from execution providers (`type: "skill"` vs `type: "script"`).
- **Task Input Envelope**: Unified JSON context file (`<receipt_root>/<step>-input.json`) containing task, provider, environment, inputs, contract, and budgets. Replaces free-text prompt concatenation and enables seamless script execution.
- **Skill Kernel-Wrapper Pattern**: Deterministic operations encapsulated in internal `scripts/` (e.g., `prepare-worktree.py` / `workspace.py`), driven by `--input-envelope <path>`, generating standard Markdown receipts and stdout `{ execution_status, result, receipt_path, summary }` reports. `SKILL.md` serves as a lean cognitive wrapper for LLM subagents.
- **Unified Receipt Contract**: Machine-enforced `{ execution_status, result, receipt_path, summary }` format across all skills and scripts.
- **Bilingual Documentation Invariant**: `docs/design/DESIGN.md` updates mirrored in `DESIGN.zh.md` and recorded in `DESIGN.i18n.yaml` (`npm run docs:check`).

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Baseline Test Bug Fix | Fix relative path resolution in `skills/pc-workspace/scripts/test_prepare_worktree.py` (`HELPER = Path(__file__).resolve().with_name(...)`) | M1 | Survey |
| 2 | Task Input Envelope Tooling | Implement schema, generation, and validation for `<receipt_root>/<step>-input.json` (`envelope.py` + tests) | M1 | R2 |
| 3 | E2E Test Suite Creation | Create comprehensive opaque-box E2E test harness covering features, boundary cases, and script substitution | M-Test | Dual Track |
| 4 | pc-workspace Kernel-Wrapper | Refactor `prepare-worktree.py` to support `--input-envelope`, markdown receipt generation, and standard JSON report | M2 | R3, R4 |
| 5 | pc-workspace Wrapper Doc | Update `skills/pc-workspace/SKILL.md` to document the wrapper pattern and envelope execution | M2 | R3 |
| 6 | Stage-Provider Decoupling Schema | Update `skills/pc-orchestrator/workflows/default.md` to decouple logical tasks from providers | M3 | R1 |
| 7 | Orchestrator Envelope Integration | Update `skills/pc-orchestrator/SKILL.md` and references for slim prompts (~15 lines) and envelope generation | M3 | R2 |
| 8 | Architectural Documentation | Update `docs/design/DESIGN.md`, `DESIGN.zh.md`, and record hashes in `DESIGN.i18n.yaml` | M4 | R5 |
| 9 | Final Acceptance & Quality Gates | Pass all unit, integration, and E2E tests (`npm test`, `npm run typecheck`, `npm run lint`, `npm run docs:check`) | M4 | R5 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Baseline Fix & Task Input Envelope Engine | Fix `test_prepare_worktree.py`; implement `skills/pc-orchestrator/scripts/envelope.py` and unit tests `test_envelope.py`; update `package.json` test script | none | DONE |
| M-Test | E2E Test Suite Creation | Requirement-driven test suite for Envelope, Provider decoupling, Workspace kernel, and publish `TEST_READY.md` | M1 | DONE |
| M2 | pc-workspace Kernel-Wrapper & Unified Receipt | Refactor `prepare-worktree.py` to consume `--input-envelope`, output markdown receipt & standard JSON report; update `SKILL.md` and tests | M1 | DONE |
| M3 | Workflow Stage-Provider Decoupling & Orchestrator Integration | Refactor `workflows/default.md` to decouple stages from providers; update `pc-orchestrator/SKILL.md` for envelope dispatch & slim prompt standard; update references | M1, M2 | DONE |
| M4 | Architectural Documentation & Full Acceptance Verification | Synchronize `docs/design/DESIGN.md` & `DESIGN.zh.md`, update `DESIGN.i18n.yaml`; verify 100% test pass on full test suite | M1, M2, M3, M-Test | DONE |

## Interface Contracts
### Workflow Engine ↔ Provider
- **Provider Resolution**:
  ```yaml
  provider:
    type: "skill" | "script"
    target: "<skill-name> | <script-path>"
    args: []
  ```
- **Task Input Envelope**: `<receipt_root>/<step>-input.json`
  ```json
  {
    "schema_version": "1.0",
    "task": { "logical_stage": string, "step_index": int, "attempt": int, "root_issue_id": string, "current_issue_id": string },
    "provider": { "type": "skill" | "script", "target": string },
    "environment": { "working_directory": string, "repository": string, "base_branch": string, "branch": string, "commit": string },
    "inputs": { "objective": string, "scope": string, "acceptance_criteria": string[], "predecessor_receipts": string[] },
    "contract": { "receipt_path": string, "receipt_template": string },
    "budgets": { ... }
  }
  ```
- **Compact Report Output**:
  ```json
  {
    "execution_status": "succeeded" | "blocked" | "failed",
    "result": object,
    "receipt_path": string,
    "summary": string
  }
  ```

## Code Layout
- `docs/design/DESIGN.md`: English architecture design document (paired)
- `docs/design/DESIGN.zh.md`: Chinese architecture design document (paired)
- `docs/design/DESIGN.i18n.yaml`: Hash mapping for bilingual documentation
- `skills/pc-orchestrator/workflows/default.md`: Workflow stage definitions with decoupled providers
- `skills/pc-orchestrator/SKILL.md`: Orchestrator guidance, slim prompt standard, envelope dispatching
- `skills/pc-orchestrator/scripts/envelope.py`: Envelope generation and validation module
- `skills/pc-orchestrator/scripts/test_envelope.py`: Unit tests for envelope engine
- `skills/pc-workspace/scripts/prepare-worktree.py`: Kernel script supporting `--input-envelope` and receipt generation
- `skills/pc-workspace/scripts/test_prepare_worktree.py`: Tests for workspace kernel
- `skills/pc-workspace/SKILL.md`: Wrapper guidance for subagent workspace operations
- `tests/`: Vitest test suites
