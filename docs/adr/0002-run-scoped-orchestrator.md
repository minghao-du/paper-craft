# Run-scoped Orchestrator replaces Conductor

[简体中文](0002-run-scoped-orchestrator.zh.md)

Decision for [spec #71](https://github.com/minghao-du/paper-craft/issues/71).

## Authority

An **Orchestrator** is the single scheduling authority of a Run, materialized by exactly one active **Orchestrator attempt**: a managed execution belonging to that Run. Replacement retains prior attempts as history and requires verified termination; unknown occupancy blocks reuse. An interactive session cannot hold this authority until an explicit registration mechanism exists.

A **Fleet** is a configuration and resource boundary containing Runs and working directories. It has no scheduling agent. Operator input sets cross-Run priority; the Run Registry arbitrates reservations, locks and ownership deterministically. A **Coordinator** organizes Project-scoped research reports; it is not a Run scheduler.

Provider is recorded once at Run intake and read from that Run thereafter. Missing, unsupported or mismatched providers fail explicitly. Managed start, inspect and recovery require a Run; batch recovery invokes the same per-Run path. Legacy work without Run ownership is reported blocked, never resumed automatically.

## Hard cut

Remove the Fleet-wide Conductor, its CLI group, runtime API, skill names and global record paths. Ship no compatibility entry points, runtime read-compatibility or deprecation window. Old global records are archived by the operator and never adopted. No migration command ships: the cutover assumes one operator with no in-flight Runs or legacy attempts.

Land behavior changes before mechanical renaming. The Run Registry schema stays unchanged. Dashboard redesign, Fleet/Run skill content separation and interactive-session registration remain separate work.

## Rejected alternatives

- Keeping Conductor as an interactive role would preserve two competing ownership vocabularies without a registration contract.
- A deprecation window would keep duplicate entry points and compatibility branches alive.
- Retaining a Fleet-wide agent would reintroduce ambiguous authority and exclusion between independent Runs.

## Vocabulary guard

Scan tracked files case-insensitively for retired Conductor vocabulary. Allow only this ADR pair, the guard test itself and explicitly identified migration-checklist artifacts. Historical ADRs remain immutable; any historical occurrence needs an explicit allow-list entry rather than an edit. Git history, ignored files, untracked files and dependencies are outside the scan. CLI help snapshots and skill catalog/install checks protect the renamed public surface.

## Operator cutover checklist

Complete these steps before running the new workflow. Retain backup location and verification results as cutover evidence outside the procedure; stop the switch if a precondition cannot be verified.

1. Freeze spawning and end live agent sessions before replacing installed skill links.
2. Stop recovery watchers and verify they cannot restart work during the switch.
3. Back up the workflow state tree and record the backup location.
4. Verify there are no in-flight Runs or legacy global Conductor records or attempts. Archive any old global records; do not resume or import them.
5. Remove stale session registration files so dead addresses cannot receive completion pushes.
6. Switch to the new version; relink installed skills and remove every stale old-name link.
7. Verify only the new skill names are installed and the CLI help matches the new command surface, then restart watchers and unfreeze spawning.
