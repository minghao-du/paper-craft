---
name: pc-board
description: "Manage GitHub project boards. Add, move, and remove issues; boards auto-resolve from repo→channel mappings in sources.yml."
---

# /pc-board

Manage GitHub project boards.
Boards are resolved automatically from repo → channel → board mappings in sources.yml.

## Quick Reference

```bash
pc board list                              # List ALL boards by status
pc board list matsengrp/30                 # List specific board
pc board add dasm2-experiments#207         # Add issue (board auto-resolved)
pc board add netam#171 --status "Next"     # Add with initial status
pc board move dasm2-experiments#207 --status done  # Move item
pc board remove netam#171                  # Remove from board
```

## Board Resolution

The board is automatically resolved via channel mappings:
1. Look up repo's channel from `code`/`writing` array in sources.yml
2. Look up channel's board from `boards` mapping

Example sources.yml:
```json
{
  "boards": {
    "dasm2": "matsengrp/30",
    "loris": "matsengrp/29"
  },
  "code": [
    {"repo": "matsengrp/dasm2-experiments", "channel": "dasm2"},
    {"repo": "matsengrp/loris-experiments", "channel": "loris"}
  ]
}
```

## Subcommands

### list
Show board items grouped by status.
Shows ALL boards by default.

```bash
pc board list                  # All boards
pc board list matsengrp/30     # Specific board
pc board list --status "In Progress"  # Filter by status
pc board list --json           # JSON output
```

### add
Add an issue or PR to a board.

```bash
pc board add dasm2-experiments#207    # Auto-resolve board from channel
pc board add repo#123 --to matsengrp/30  # Explicit board
pc board add repo#123 --status "Next"    # Set initial status
```

### move
Move an item to a different status.

```bash
pc board move dasm2-experiments#207 --status done
pc board move repo#123 --status "In Progress" --to matsengrp/30
```

### remove
Remove an issue/PR from a board.

```bash
pc board remove dasm2-experiments#207
pc board remove repo#123 --to matsengrp/30  # Explicit board
```

### refresh-cache
Refresh cached board metadata (status options, field IDs).

```bash
pc board refresh-cache
pc board refresh-cache --board matsengrp/30
```
