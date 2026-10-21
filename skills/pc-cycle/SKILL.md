---
name: pc-cycle
description: Tuck in, reset through the selected runner, then resume with /pc-continue; includes a Claude Code tmux helper
allowed-tools: Skill, Bash
---

# /pc-cycle

Run `/pc-tuckin` with the current harness's skill tool, or read and follow its text, passing `$ARGUMENTS` through (a role name, if given).

When it has finished and the continuation prompt is verified, reset through the selected runner's supported mechanism and resume from that file with `/pc-continue` or its skill text.
If reset cannot be automated, report the continuation path and resume instruction without claiming a reset occurred.
For **Claude Code inside tmux only**, make this the turn's last tool call:

```bash
<this skill's base directory>/self-cycle
```

The Claude helper types `/clear` into this session's tmux pane.
That input is queued until the turn ends.
Once the fresh Claude transcript appears, it types `/pc-continue`.
Then end the turn without starting further work.

Skip the cycle, and say why, if any of these holds: the tuckin reported unpushed work, something pending with the user needs an answer before a reset, or the script exits non-zero (it does outside tmux).
