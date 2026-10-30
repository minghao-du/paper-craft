# Paper Craft

[简体中文](GLOSSARY.zh.md)

Research organization and agent workflow terminology.

## Language

**Project**:
A research project grouping related repositories. A Project is distinct from a Fleet.
_Avoid_: Fleet as a synonym for Project

**Fleet**:
A configured resource and coordination boundary containing Runs and a pool of working directories. Each Run owns its Orchestrator. Legacy Conductor workflows remain supported; the initial Run intake retains Fleet-wide exclusion until concurrent ownership is available.
_Avoid_: Project as a synonym for Fleet

**Run**:
One requested Issue or EPIC workflow, with a fixed provider and its own Orchestrator.

**Orchestrator**:
The Run's scheduling agent, launched and inspected through Managed Runtime. Conductor entry points remain compatible during migration.
