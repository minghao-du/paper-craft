# Claude Code recovery evidence

Use with [conductor reclaim and recovery](../SKILL.md#step-6-propose-next-action).

## Ralph liveness

For Claude Code with Ralph, `.claude/ralph-loop.local.md` must exist **and** its `session_id` must belong to that running session.

## Lost worklog reconstruction

In the Claude Code branch, the transcript is `~/.claude/projects/$(echo "$CLONE" | sed 's|/|-|g')/<session-id>.jsonl`: replay the seed `Write`'s `input.content`, then each `Edit`'s `old_string`→`new_string`, then any Bash heredoc appends, in timestamp order. Stop if an `old_string` doesn't match. Mark the result as a reconstruction in its README.
