# Tests Guidance

Facts and guardrails for root test suite in `tests/`:

- `tests/e2e/`: End-to-end integration across multiple packages (e.g. workspace-config + workspace CLI + orchestrator lifecycle).
- `tests/support/`: Shared test helpers, process execution utilities, temporary directories, and contract interfaces.
- For package-level unit and CLI tests, place tests in the respective package's `tests/` directory (`packages/*/tests/`).
- General test authoring and budget rules are defined in the repository root `AGENTS.md`.
