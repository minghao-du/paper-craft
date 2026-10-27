# Paperpile JSON import

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
