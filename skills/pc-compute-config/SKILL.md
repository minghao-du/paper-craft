---
name: pc-compute-config
description: Configure a project's remote CPU/GPU backends and platform skills.
disable-model-invocation: true
---

# /pc-compute-config

Write project compute policy in `.paper-craft/compute.md`, discoverable through one sentence in `AGENTS.md`.
Setup is limited to local configuration and read-only inspection; resource allocation, remote environment installation, and workload execution belong to subsequent tasks.

## 1. Resolve backends

Read the target project's agent guidance, existing `.paper-craft/` configuration, workflow entry points, environment definitions, and remote profiles.
Resolve the user's CPU/GPU choices to installed platform skills and read their instructions and relevant references.
Identify a skill by name, adding a portable source or installation reference when known rather than relying solely on a machine-specific absolute path.
Infer settings from the project and selected skills; ask only for missing decisions such as which backend to use or an unknown remote workspace.
Record unresolved settings or unavailable skills as pending; skill installation is a separate user choice.

**Done:** CPU and GPU each have a selected backend or are explicitly unconfigured, and every selected backend has its required settings identified as established values or named pending items.

## 2. Write project policy

Read [templates/compute.md](templates/compute.md) for the execution policy and backend fields to generate in `.paper-craft/compute.md`.
Preserve its execution boundary while adapting the fields to the selected platforms and project; remove template instructions and unused fields, and replace placeholders with established values or named pending items.
CPU and GPU may share a backend.
Ask for a GPU model or resource default only when the platform requires it or the user specifies one.

Reference existing scheduler profiles, dependency files, and environment documentation rather than copying their contents.
Record only the platform-specific connection and workspace fields actually needed, such as an SSH alias or remote project root.

Add or update one sentence in the project-root `AGENTS.md`:

> Before running scientific computations, read [.paper-craft/compute.md](.paper-craft/compute.md) and use its configured backend and platform skill.

On creation or rerun, preserve unrelated configuration and update the existing policy and pointer in place.
Reconcile existing routing instructions into the canonical policy while retaining platform-specific references.
Report any incompatible project requirement instead of leaving contradictory instructions active.
If Git ignores either generated file, report that it will not travel with the project; preserve the user's ignore rules.

**Done:** The policy contains a definition for every selected backend, pending items identify the affected routes, and `AGENTS.md` has one compute-policy pointer.

## 3. Verify and report

Check that the pointer resolves, each route resolves to a backend definition or is explicitly unconfigured, selected platform skills are available, and referenced project files exist.
Check that required backend fields are filled, pending items block the affected routes, and no credentials or template placeholders remain.

Use the selected platform skill's bounded, noninteractive, read-only connection/authentication checks where available.
Stop after inspection even if the platform skill's normal workflow continues into execution.
For checks requiring allocation, interactive authentication, or remote changes, report the remaining user action.
Connection success proves reachability, not that a future job has dependencies, data, or accelerator quota.

**Done:** Report configuration as complete only when every selected backend passes the local checks above and no required setting or skill is pending; otherwise report the missing items.
Report connectivity separately for each backend as verified, failed, or not checked, with the reason; an offline project can have complete configuration with connectivity not checked.
Include links to the policy and agent pointer and the CPU/GPU mapping in the completion response.
