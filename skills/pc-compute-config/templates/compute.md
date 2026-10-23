# Project compute policy

## Execution boundary

Run all tests and business code through the configured remote routes below, including scientific computations, verification scripts that import project modules, and minimal reproductions.
This boundary applies in every phase, including check and review, and to every subagent; task size and duration do not change the execution location.
Edit and inspect files locally; lint, typecheck, and build may run locally only when they execute neither tests nor business code.
Before running a command, inspect its entry point and hooks to determine what it actually executes; route commands that execute tests or business code remotely regardless of their name.
If a route is unconfigured, its skill or required environment is missing, or its backend is inaccessible, stop the affected execution and report what is needed; never fall back to local execution.
Local execution of tests or business code requires explicit user authorization for that scope or an explicit exception recorded in this policy; other skills' check instructions do not grant an exception.
Use the configured route until the user changes it; GPU requirements must not silently fall back to CPU or a local accelerator.

## Platform execution

Apply this protocol to every remote operation, including connection, environment preparation, transfers, workload execution, monitoring, and retrieval.

1. Select the configured backend for the operation and its CPU/GPU needs, where applicable. Read its platform skill and the references required by the applicable procedure.
2. Construct the operation using that procedure and complete its prerequisites. Keep platform rules in the platform skill; this policy supplies project settings. Use only its permitted fallback procedures; if it does not establish a permitted procedure or execution target, stop the affected operation and report the gap.
3. Before a workload starts, verify its actual execution target using the platform skill's checks in the context that will run it. Connection success alone does not establish an eligible execution target.
4. Check the result against the platform procedure's completion criteria. Keep the selected procedure, target verification, and job identifiers where applicable in the existing execution output or work log.

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
This policy does not automatically distribute an existing workflow across platforms.
Changes to workflow execution are a separate implementation task.
