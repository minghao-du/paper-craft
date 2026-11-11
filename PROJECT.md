# Project: paper-craft

## Architecture

Skills are the sole execution interface. The orchestrator selects specialist skills and routes results; fixed TypeScript helpers maintain lifecycle state and enforce input and receipt contracts. Project-defined configuration and structured snapshots use JSON; append-only logs may use JSONL. External tool formats follow their own contracts.

## Code layout

- `docs/design/DESIGN.md` and `DESIGN.zh.md`: paired architecture decisions; `DESIGN.i18n.json` records reviewed section hashes.
- `packages/orchestrator/src/`: lifecycle operations, task input envelopes, and thin helper entry points.
- `packages/workspace-config/src/`: configuration resolution and validation for orchestrator helpers.
- `skills/pc-orchestrator/`: LLM dispatch guidance, `workflows/default.json`, and receipt templates.
- `skills/pc-workspace/scripts/`: existing Python worktree preparation and cleanup helpers.
- `scripts/docs/`: bilingual documentation tools using `docs-i18n.json` and sibling `*.i18n.json` records.
- `tests/`: Vitest checks; existing specialist Python checks remain alongside their helpers.
