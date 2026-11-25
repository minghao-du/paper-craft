# Project compute policy

## Execution boundary

Use the configured remote backend as the project runtime. Treat the local checkout as a place to edit and inspect files, without assuming a local runtime or toolchain is provisioned. This boundary applies in every phase, including check and review, and to every subagent.

Route tests, business code, scientific computations, minimal reproductions, checks that load the project runtime or workflow (including DAG dry-runs), and programmatic artifact validation through the configured remote routes below. Inspect command entry points and hooks and route by what they execute, regardless of command name.

Static checks such as lint, format, typecheck, and build may run locally within the command and scope explicitly allowed by this policy. If a check loads the workflow (as a workflow linter may do) or otherwise crosses the remote execution boundary above, local execution requires explicit user authorization for that scope or a scoped exception in this policy covering that behavior. Other skills' check instructions do not grant an exception. If the allowed local tools are unavailable, run the check through the configured remote route.

If the needed route is unconfigured, its skill or required environment is missing, or its backend is inaccessible, stop the affected execution and report what is needed. GPU requirements must not silently fall back to CPU or a local accelerator.

## Platform execution

Apply this protocol to every remote operation, including connection, environment preparation, transfers, workload execution, monitoring, and retrieval.

1. Select the configured backend using the routing rules below. Read its platform skill and the references required by the applicable procedure.
2. Construct the operation using that procedure and complete its prerequisites. Keep platform rules in the platform skill; this policy supplies project settings. Use only its permitted fallback procedures; if it does not establish a permitted procedure or execution target, stop the affected operation and report the gap.
3. Before a workload starts, verify its actual execution target and CPU/GPU allocation mode using the platform skill's checks in the context that will run it. Connection success alone does not establish an eligible execution target.
4. Check the result against the platform procedure's completion criteria. Keep the selected procedure, target verification, and job identifiers where applicable in the existing execution output or work log.

## Routes

| Workload | Backend |
| --- | --- |
| CPU | <backend name or unconfigured> |
| GPU | <backend name or unconfigured> |

Run every GPU stage on the configured GPU backend in GPU mode.
Route CPU stages to the configured CPU backend by default. In a mixed CPU/GPU task, a continuous CPU stage with an estimated total wall time of at most one hour may run on the GPU backend only after switching its allocation/billing mode to CPU-only. Merely running CPU code in GPU mode does not qualify.
Sum consecutive CPU steps as one stage when applying this limit. A CPU stage exceeding one hour, or a GPU backend without CPU-only mode, requires the configured CPU backend.

## Backends

Repeat this section for each selected backend, using fields required by its platform skill.

### <Backend name>

- Platform skill: <absolute path to installed skill's SKILL.md>
- Connection: <SSH alias or other platform-specific identifier, if needed>
- Remote workspace: <required nonempty project root on the remote platform>
- Use Git: <yes or no, as answered by the user for this HPC backend>
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
When stages move between backends, transfer the required files directly if supported. Otherwise retrieve them to the local machine, then upload them to the destination backend, following each platform skill's transfer procedure.
This policy does not automatically distribute an existing workflow across platforms.
Changes to workflow execution are a separate implementation task.
