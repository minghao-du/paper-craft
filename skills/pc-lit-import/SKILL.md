---
name: pc-lit-import
description: Import references from Zotero SQLite or Paperpile JSON into pc library, rebuild database, and clean up.
---

# Import References

Import references from external tools (Zotero or Paperpile) into the `paper-craft` reference library.

## Choose the source

Read only the matching import workflow:

- [Zotero](zotero/guide.md): local SQLite library with Better BibTeX citekeys.
- [Paperpile](paperpile/guide.md): JSON export, including export-file discovery and cleanup.

Always rebuild the search index after import. Notes from both sources are preserved and searchable via `pc search`.
