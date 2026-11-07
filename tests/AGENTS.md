# Tests Guidance

Facts and guardrails for authoring and maintaining tests in `tests/`.

## Authoring and Runtime Budget

When adding or modifying tests:
- **Earn the test**: Every test must identify a concrete failure mode, meaningful consequence (user contract, business rule, data integrity), and a coverage gap not caught by cheaper checks. Do not add redundant or trivial tests.
- **Runtime budget ceiling**: Complete execution of a single test must strictly finish within 120 seconds. Use representative fixtures, bounded executions, and never evade the limit.
- Apply `/pc-test-budget` before adding or modifying tests.
