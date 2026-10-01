# paper-craft Design Decisions

Technical architecture decisions for paper-craft. These are
load-bearing choices — changing them has wide impact.

## I. JSONL Source of Truth

All persistent data lives in JSONL files (refs, projects, repos).
Indexes are ephemeral artifacts — rebuilt from JSONL via `pc rebuild`.
Schema changes require deleting the index and rebuilding, never
migration scripts.

JSONL is chosen for git-mergeability.

## II. Pure TypeScript, No Native Addons

`npm run build` MUST work without a C/C++ compiler or platform-specific
binaries. Use pure-JS/TS dependencies (e.g., `better-sqlite3` WASM or
equivalent for indexing). No `node-gyp`, no native modules. This keeps
installs fast and cross-platform.

## III. Local-First, Cloud-Optional

Core functionality works offline with local data. External APIs
(Semantic Scholar, GitHub, Slack, etc.) are optional enrichment.
pc never phones home.

## IV. Nexus Pattern

All user data lives in a single git-backed nexus repository. Path comes
from `~/.config/pc/config.yml` → `nexus_path`. The nexus is a git
repo — all data is versioned and shareable. pc MUST NOT write outside
the nexus or its own config directory.

## V. Git-Compatible Collaboration

JSONL format enables standard git merge workflows. `pc resolve` handles
domain-aware conflict resolution (DOI-based deduplication, complementary
metadata merging). `pc dedupe` cleans up post-merge duplicates. Design
for the case where multiple people push to the same nexus.

## VI. TypeScript Skill Modules

Skills are authored as TypeScript modules — testable, debuggable, and
type-safe. The skill prefix is `pc-`. Skill docs remain canonical:
when behavior changes, skill docs MUST update in the same PR.
