# paper-craft Constitution

[简体中文](CONSTITUTION.zh.md)

Development principles for paper-craft.

## Agents Execute, Humans Steer

Automate execution up to the point where judgment is required. Autonomous workers handle implementation, testing, and quality gates independently. Humans choose the direction of work and resolve genuine ambiguities (design questions, fuzzy requirements, architectural trade-offs).

## Skills Are the Product

Skills are the primary interface between humans, agents, and the CLI. Skill documentation is canonical—when CLI behavior changes, skill docs must be updated in the same PR. Skill behavior must strictly match `--help` output. Deliver new capabilities as skills first, then as CLI commands.

## Quality Gates over Human Review

Automated checks (`/pc-pr-review`) loop until all pass. Fix every defect they flag—do not skip, and never use `--no-verify`. But checks themselves must be fast and actionable, not performative ceremony. A suggestion to add content is not a finding of a defect.

## Fail Fast, Explain Clearly

Misconfiguration, missing data, and unbuilt indexes must produce actionable errors immediately. When the real issue is misconfiguration, never return silent empty results. Error messages must state what was expected and what was actually received.

## Lean by Default

Agents decide and land changes to this tool autonomously, under continuous downward pressure on size. Every line in a skill, `AGENTS.md`, or boot prompt costs context tokens on every session that loads it; those tokens belong to the actual work.

Reviewing agents (including peers) will propose additions: another pattern, another check, another caveat. Each looks cheap in isolation, but together they balloon layer by layer. Add content only when it solves a concrete failure encountered in practice or satisfies an active requirement. Favor deleting and simplifying.

Stronger models require less guidance. Words that once compensated for weaker models continue consuming context long after those failure modes disappear; delete an instruction once it no longer changes behavior.
