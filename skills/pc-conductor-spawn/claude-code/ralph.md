# Claude Code Ralph loop

Only when the selected worker uses Claude Code with Ralph, include these runtime instructions in the brief composed by [pc-conductor-spawn](../SKILL.md). Keep its common worker protocol and gates.

## Start

Only for Claude Code with the Ralph plugin, start its loop with:
/ralph-loop:ralph-loop --completion-promise 'ISSUE WORK COMPLETE' --max-iterations 20 Continue working on the task. Read .epic-status.json and .epic-worklog.md for context. Output ISSUE WORK COMPLETE in promise tags when done.

## Human interrupt

Pause with `/ralph-loop:cancel-ralph` before engaging with human steering, then follow the common interrupt protocol to restart with the revised direction or wind down.
