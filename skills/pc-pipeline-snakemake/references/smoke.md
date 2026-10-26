# Smoke validation

A smoke run sends small raw inputs through the production workflow to its final deliverables. It checks integration, not production runtime, memory sizing, or scientific accuracy.

## Fixture and configuration

Keep small, deterministic raw inputs in `tests/data/smoke/`, with their origin or generation command documented beside them. Reuse existing fixtures where suitable; stage-specific fixtures remain useful for unit tests.

Use `config/test.yaml` to select those inputs, reduce sample counts, replicates, and iterations, and route generated files to `processed/smoke/`, `results/smoke/`, and `logs/smoke/`. Route stage receipts to `results/smoke/summary/` so smoke runs preserve production receipts. Retain the normal stage hierarchy beneath each smoke root.

Use the production rules, scripts, environments, launcher, and scheduler route. Change workload and paths through configuration. Start with raw fixtures and generate intermediates through the DAG; a separate smoke implementation or precomputed downstream outputs would bypass the integration being checked. Include enough data to satisfy each stage's input requirements and exercise the relevant branches.

## Execute and inspect

1. Read the project's `.paper-craft/compute.md`, when present, and the selected platform skill before execution. Its execution boundary applies to smoke tests too.
2. Resolve the smoke DAG with the production launcher and test configuration. For a direct uv workflow, the planning command is `uv run snakemake -n --configfile config/test.yaml <target>`; add `--software-deployment-method conda` when needed. Check that every generated path, including receipts and ledgers, is isolated from production outputs.
3. Execute the same target without `-n`, through the production launch route. Establish the initial full smoke run from empty smoke output roots. During development, rerun the affected chain; before a production batch, run the relevant chain from its raw fixtures through final aggregation with fresh smoke outputs so cached artifacts cannot hide a broken step. Cover relevant configuration branches without enumerating the entire production parameter grid.
4. Check successful task and workflow exits and every required final output, including attempt ledgers, evaluations, and summary receipts. Open the artifacts and validate their expected format, identities, and counts; file existence alone is insufficient. Account for intermediates intentionally removed by `temp()` through their downstream artifacts and execution logs.

**Done:** Record the command, execution environment, fixture/configuration, stages executed, and artifact-check results. Dry-runs and unit-test counts alone leave smoke validation pending. A failed or unavailable execution route leaves the check pending rather than moving it to another machine.
