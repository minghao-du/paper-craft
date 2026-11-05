# Skills Guidance

Facts and guardrails for authoring and maintaining skills in `skills/`.

## Authoring Standard

Every skill in this directory must adhere to the requirements and craftsmanship principles in [`.agents/skills/writing-great-skills`](../.agents/skills/writing-great-skills/SKILL.md) and its [`GLOSSARY.md`](../.agents/skills/writing-great-skills/GLOSSARY.md).

Before authoring, editing, or splitting any skill:
- Consult `.agents/skills/writing-great-skills/SKILL.md` for guidance on predictability, invocation trade-offs, description writing, information hierarchy, progressive disclosure, and pruning.
- Check terms and definitions against `.agents/skills/writing-great-skills/GLOSSARY.md`.

## Repository Rules

- **Naming**: All skill directories and skill names must use the `pc-` prefix (e.g., `pc-research-state`).
- **CLI Alignment**: When a change adds or alters a CLI command, run `./pc <cmd> --help` and ensure the corresponding skill documentation strictly matches the real flags and workflow.
- **Lean by Default**: Follow the principles in `docs/constitution/CONSTITUTION.md`. Skills are the product; maintain downward pressure on context size. Prune no-ops, eliminate fuzzy completion criteria, and favor deleting over adding.
