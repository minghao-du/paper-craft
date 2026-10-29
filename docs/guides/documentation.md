# Bilingual documentation

[简体中文](documentation.zh.md)

English is the default display language. English and Simplified Chinese carry equal authority: correct either version first and synchronize both in the same contribution.

## Scope and pairs

`docs-i18n.yaml` defines the final controlled scope and explicit execution-document exclusions. Skills, agent instructions, execution prompts, machine templates, fixtures and downstream research material remain outside pairing. Discovery never follows symbolic links.

An English `name.md`, Chinese `name.zh.md` and sibling `name.i18n.yaml` form one unit. Create, rename or delete all three together and update references. Existing untranslated documents are listed in the temporary adoption backlog. Editing those documents alone does not require translation. New documents cannot enter that backlog; migrated documents cannot return. Remove the mechanism when migration finishes.

## Contributor commands

Run commands from the repository root:

```sh
pnpm docs:i18n:list
pnpm docs:i18n:check
pnpm docs:i18n:check -- README.md
pnpm docs:i18n:record -- README.md
pnpm docs:i18n:record --help
```

pnpm forwards paths, with or without the optional separator. Checking all active pairs is read-only and fails on missing artifacts or stale confirmations. Named checking scopes pair validation; backlog eligibility remains a repository invariant. Recording requires explicit English paths and only writes those records. It never translates.

## Review and records

Translate affected content incrementally, review meaning and terminology, then explicitly record the reviewed pairs and check the whole corpus. A mechanically compatible but untranslated counterpart can be recorded successfully; hashes cannot prove translation accuracy, completeness or readability. The contributor owns semantic confirmation.

Sections correspond by heading occurrence order. Keys use English heading-slug paths, with `~2` suffixes for repeats. Each side hashes its own top-level authored blocks, joined by newlines, using the first 16 hexadecimal characters of SHA-256. Fenced code is excluded from prose hashes. No generated prose exclusion is supported. Isolated body changes preserve unrelated entries; heading or hierarchy changes can change multiple keys.

The record format follows DeepSeek Harness's inspected revision `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`. Its MIT license was reviewed; this tooling is independently implemented. Records are canonical ordered YAML mappings with separate `en` and `zh` hashes. Values need not match or differ.

<a id="navigation"></a>

## Navigation

Place a reciprocal language link immediately after the main heading. Links into active pairs select the reader's language and corresponding destination, preserving query strings and fragments; excluded or backlog destinations keep their authored paths. Local destinations must exist. When a section is linked, both versions provide the same explicit English anchor, for example `<a id="navigation"></a>`, before their translated headings. This shared-anchor convention is a paper-craft adaptation; upstream preserves fragments but does not map translated headings automatically. Update inbound references when renaming or deleting a pair. Recording rejects invalid navigation before writing confirmations.
