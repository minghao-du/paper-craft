---
name: pc-lit-import
description: Import references from Zotero SQLite or Paperpile JSON into pc library, rebuild database, and clean up.
---

# Import References

Import references from external tools (Zotero or Paperpile) into the `paper-craft` reference library.

## Formats

### 1. Zotero SQLite Import (Direct)

Direct ingestion from local Zotero SQLite database with Better BibTeX citekeys.

```bash
# Dry-run preview
pc import --format zotero --dry-run --human

# Import default personal library (library 1)
pc import --format zotero --human

# Custom Zotero directory or group library
pc import --format zotero --zotero-path ~/Zotero --library 2 --human

# Rebuild search index (always required after import)
pc rebuild --human
```

Flags:
- `--format zotero`: Ingest references directly from local Zotero SQLite database. Requires Better BibTeX.
- `--zotero-path <path>`: Path to Zotero data directory (containing `zotero.sqlite` and `better-bibtex-search.sqlite`). Defaults to `zotero_path` in `~/.config/pc/config.yml` or standard platform locations (`~/Zotero`).
- `--library <id>`: Zotero library ID to import from (default: `1` for personal library; use `2`, `3`, etc. for group libraries).
- `--collection <name>`: Zotero collection name to import from (scopes import to a specific collection/folder).
- `--dry-run`: Preview additions, updates, and skips without modifying `refs.jsonl`.

Always run `pc rebuild --human` after import to update the search index.

### 2. Paperpile JSON Import

Import a Paperpile JSON export from `~/Downloads/` into the reference library.

```bash
# Dry-run preview
pc import --format paperpile "<file>" --dry-run --human

# Import
pc import --format paperpile "<file>" --human

# Rebuild search index
pc rebuild --human
```

## Workflow: Paperpile Export File Cleanup

### 1. Find the export file

If no path argument given, look for `~/Downloads/Paperpile*.json` or `~/Downloads/*.json`:

```bash
ls -lt ~/Downloads/Paperpile*.json 2>/dev/null || ls -lt ~/Downloads/*.json
```

If multiple files match, ask the user which one.

### 2. Dry-run import

Always dry-run first to show what will change:

```bash
pc import --format paperpile "<file>" --dry-run --human
```

Report counts (added, updated, skipped) to the user.

### 3. Import

```bash
pc import --format paperpile "<file>" --human
```

### 4. Rebuild database

Always rebuild after import:

```bash
pc rebuild --human
```

### 5. Delete the export file

```bash
rm "<file>"
```

### 6. Report

Summarize: new refs added, total count, file deleted.
Notes from Paperpile and Zotero are preserved and searchable via `pc search`.
