# Project compute policy

## Execution boundary

Edit source locally; inspect files and run lightweight code checks locally.
Run scientific computations, including data processing, simulations, training, and evaluation, through the remote routes below.
Before each computation, identify its CPU/GPU requirement and read the selected platform skill.
If a route is unconfigured, its skill is missing, or its backend is inaccessible, stop that computation and report what is needed.
Use the configured route until the user changes it; GPU requirements must not silently fall back to CPU or a local accelerator.

## Routes

| Workload | Backend |
| --- | --- |
| CPU | <backend name or unconfigured> |
| GPU | <backend name or unconfigured> |

## Backends

Repeat this section for each selected backend, using fields required by its platform skill.

### <Backend name>

- Platform skill: <installed skill name; portable source reference if known>
- Connection: <SSH alias or other platform-specific identifier, if needed>
- Remote workspace: <project root on the remote platform, if needed>
- Environment: <reference to existing dependency/environment instructions, or explicit pending item>
- Inputs and code: <required local/remote paths and existing staging instructions>
- Outputs: <remote artifact paths and local retrieval destinations, or remote inspection policy>

The platform skill owns connection, dependency preparation, transfers, scheduling, resource sizing, monitoring, and result retrieval.
Keep secrets in the platform's authentication mechanism.
Resolve pending settings before executing an affected task.

## Source and data

Local source files are authoritative; stage the version needed by the task using the platform skill's transfer procedure.
Transfer only required code and inputs, keeping credentials and local environments out of uploads.
Use the input/output locations above and existing project data conventions; report missing mappings before transferring data.
Keep independent work units' outputs distinct and retrieve or inspect the requested artifacts through the selected platform skill.

## Mixed workloads

Handle CPU and GPU stages explicitly using their configured platform skills and stage the required intermediate artifacts between them.
This policy does not automatically distribute an existing workflow across platforms.
Changes to workflow execution are a separate implementation task.
