---
name: pc-compute-config
description: Configure or change a project's CPU/GPU backends and platform skills, storing execution policy in .paper-craft/ with an AGENTS.md pointer. Use for project compute setup, not job execution.
---

# /pc-compute-config

Configure where a project's scientific computations run.
paper-craft owns project configuration; each selected platform skill owns connection, environment setup, transfers, scheduling, monitoring, and result retrieval.
This skill writes instructions for agents, not an enforced execution sandbox or a cross-platform workflow scheduler.

## Discover

Read the target project's agent guidance, existing `.paper-craft/` configuration, workflow entry points, environment definitions, and remote profiles.
Reuse established paths and settings rather than adding a parallel configuration system.

Resolve the user's CPU/GPU choices to installed platform skills and read their instructions and relevant references.
Support arbitrary platforms through their own skills; there is no built-in provider list.
Identify a skill by name, adding a portable source or installation reference when known rather than relying solely on a machine-specific absolute path.

Infer settings from the project and selected skills; ask only for missing decisions such as which backend to use or an unknown remote workspace.
If a required skill is unavailable, report what is missing and save a pending route if useful; installation is a separate user choice.
Do not invent a skill, connection, workspace, environment, or successful verification.

## Configure

Use [templates/compute.md](templates/compute.md) as the starting structure for `.paper-craft/compute.md`.
Adapt it to the selected platforms and project; remove template instructions and unused fields, and replace example placeholders with established values or explicit pending items.
CPU and GPU may share a backend, use different backends, or be explicitly unconfigured.
Only request a GPU model or resource default when the platform requires it or the user specifies one; per-job resource sizing belongs to the platform skill.

Keep one authoritative location for each setting.
Reference existing scheduler profiles, dependency files, and environment documentation rather than copying their contents.
Record only the platform-specific connection and workspace fields actually needed, such as an SSH alias or remote project root.
Keep credentials in the platform's existing authentication mechanism.

The generated policy must establish:

- Local source editing, file inspection, and lightweight code checks are allowed; scientific data processing, simulations, training, and evaluation use the configured remote routes.
- Before computation, determine whether the task requires CPU or GPU and read the selected platform skill.
  A GPU requirement must not silently fall back to CPU or a local accelerator.
- An unconfigured route, missing skill, or inaccessible backend blocks that computation with an actionable explanation; changing backend requires the user's choice.
- Local source is authoritative; define which code and inputs need staging and where outputs should be retrieved or inspected.
  Refer to existing data conventions and transfer only the files needed by the task.
- Platform skills govern node restrictions, dependency preparation, resource allocation, and transfers.
  A request to configure a project does not authorize allocating resources, installing remote environments, or running workloads.
- Mixed CPU/GPU work is handled as explicit stages under the respective platform skills.
  Existing workflow engines do not automatically consume this Markdown policy; workflow integration is a separate task.

Preserve unrelated `.paper-craft/` files and project guidance.
Add or update one sentence in the project-root `AGENTS.md`:

> Before running scientific computations, read [.paper-craft/compute.md](.paper-craft/compute.md) and use its configured backend and platform skill.

If compute instructions already exist elsewhere, reconcile them into the canonical policy and replace duplicated routing rules with the pointer.
Report any incompatible project requirement instead of leaving contradictory instructions active.
If Git ignores either generated file, report that it will not travel with the project; preserve the user's ignore rules.

## Verify and finish

Check that the pointer resolves, each configured route names an available skill, and referenced project files exist.
Ensure no credentials or unexplained placeholders remain; explicitly list pending fields and block the affected routes until resolved.
On rerun, update only the requested settings without duplicating the pointer or discarding unrelated configuration.

Use the selected platform skill's bounded, noninteractive, read-only connection/authentication checks where available.
Only use its inspection steps during setup, even if its normal workflow continues into provisioning or execution.
Skip checks requiring allocation, interactive authentication, or remote changes and explain the remaining user action.
When offline, save the policy and report connection verification as not performed.
Connection success proves reachability, not that a future job has dependencies, data, or accelerator quota.

Finish with links to the project policy and agent pointer, the CPU/GPU mapping, verification results, and any missing information.
Configuration is complete when the routes are specified and the policy is discoverable; distinguish that from pending configuration and from runtime readiness.
