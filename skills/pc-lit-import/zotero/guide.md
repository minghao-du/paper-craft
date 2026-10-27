# Zotero SQLite import

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
