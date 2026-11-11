# Agent Guidelines

## Testing and Runtime Budget

Applies to all tests across `packages/*/tests/`, `scripts/**/tests/`, and `tests/`:
- **Earn the test**: Every test must identify a concrete failure mode, meaningful consequence (user contract, business rule, data integrity), and a coverage gap not caught by cheaper checks. Do not add redundant or trivial tests.
- **Runtime budget ceiling**: Complete execution of a single test must strictly finish within 120 seconds. Use representative fixtures, bounded executions, and never evade the limit.
- Apply `/pc-test-budget` before adding or modifying tests.

## Architecture

Skills are the sole execution interface. The orchestrator selects specialist skills and routes results; fixed TypeScript helpers maintain lifecycle state and enforce input and receipt contracts. Project-defined configuration and structured snapshots use JSON; append-only logs may use JSONL. External tool formats follow their own contracts.

## Code layout

- `docs/design/DESIGN.md` and `DESIGN.zh.md`: paired architecture decisions; `DESIGN.i18n.json` records reviewed section hashes.
- `packages/orchestrator/src/`: lifecycle operations, task input envelopes, and thin helper entry points (`cli.ts`, `envelope-cli.ts`). Tests in `packages/orchestrator/tests/`.
- `packages/workspace/src/`: workspace creation, reuse, isolation, and task IO helpers (`cli.ts`). Tests in `packages/workspace/tests/`.
- `packages/workspace-config/src/`: configuration resolution, initialization, and validation for orchestrator helpers (`cli.ts`). Tests in `packages/workspace-config/tests/`.
- `skills/pc-orchestrator/`: LLM dispatch guidance, `workflows/default.json`, and receipt templates.
- `skills/pc-workspace/`: workspace agent instructions and cognitive wrapper over `packages/workspace`.
- `scripts/docs/`: bilingual documentation tools using `docs-i18n.json` and sibling `*.i18n.json` records. Tests in `scripts/docs/tests/`.
- `tests/`: cross-package end-to-end flows (`tests/e2e/workspace-flow.test.ts`) and shared test utilities (`tests/support/`). Single-module unit and CLI tests reside in their respective package directories.
