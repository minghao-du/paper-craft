# paper-craft

[简体中文](README.zh.md)

Manuscript-driven agent development platform, rewritten in TypeScript.

paper-craft connects research ideas and implementation: manuscript sessions turn findings into scoped issues, and autonomous workers implement and test them. Humans steer research and review changes.

The ideas, workflow design and orchestration patterns originate from Erick Matsen's [bipartite](https://github.com/matsen/bipartite) (MIT). Paper-craft delivers these capabilities as agent skills rather than a CLI tool; TypeScript brings shared types, testable skill modules and access to the JavaScript ecosystem. Managed workflows exclusively support `agy` (Antigravity); other agent runtimes are not supported.

## Skills
Skills remain English-only. See the [skill directory](skills/) for the complete execution guidance.

## Guides
- [Bilingual documentation maintenance](docs/i18n/documentation.md#navigation)

## Status and license

The project is in an early stage; architecture and core modules are being rewritten.

MIT, consistent with upstream bipartite. See Matsen's [workflow introduction](https://matsen.group/general/2026/06/06/bipartite.html) for background.
