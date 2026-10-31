# Tmux fleet process checks

Use during slot occupancy and liveness inspection from [pc-orchestrator](../SKILL.md). Linux/Claude examples apply only to that runtime.

A runner may carry its entire spawn prompt in argv, so **never match argv** (`pgrep -f`, `ps | grep`) for a question about processes: it matches every worker whose prompt mentions the string, and the asking shell itself. Enumerate by exact name and attribute by working directory:

```bash
# Linux + Claude Code example only; other runners/OSes use their supported process inspection.
# Which clone is each live Claude session in?
for pid in $(pgrep -x claude); do
  printf '%s\t%s\n' "$pid" "$(readlink /proc/$pid/cwd)"
done
```

- `pgrep -x` is not fleet-scoped; filter on the cwd being under `$CLONE_ROOT`.
- To ask "what is running in my pool", don't hand-list names: take `/proc/<pid>/comm` for every pid whose cwd is under `$CLONE_ROOT`, `sort | uniq -c` (test runners are named neither `zig` nor after the product).
- On shared hosts, scope with `-u $(id -u)`. You cannot read another user's `/proc/<pid>/cwd`; treat an unreadable cwd as foreign and report own and foreign counts separately.
- To wait on something you launched, poll its `$!`, never a pattern — or background it and let the harness re-invoke you.
- Load average answers "is this host contended", not "is my job still running": enumerate processes for occupancy.
- zsh does not word-split an unquoted `$VAR`, so `$EXTRA` holding several flags is one argument. Write flags literally or use an array, and read a failing arm's stderr before recording a non-result.
- argv size separates workers from interactive sessions without reading content: `wc -c < /proc/<pid>/cmdline` is over ~1 KB for a spawned worker, under ~100 B for a hand-started session.

Where you must identify a process you did not launch:

```bash
n=0
for p in $(pgrep -x zig); do
  [ "$p" = "$$" ] && continue
  [ "$(readlink /proc/$p/cwd 2>/dev/null)" = "$PWD" ] && n=$((n+1))
done
echo "$n"
```

**A slot blocked on a foreground shell wait** is not idle; Claude Code may report `shell` and cannot drain `SendMessage` in that state.
The following Linux/Claude process example applies only to that branch; inspect other runners through their actual process and session tools. Sweep whenever a slot reads `shell`, and on any full reconciliation:

```bash
for pid in $(pgrep -x zsh; pgrep -x bash; pgrep -x sh); do
  [ "$pid" = "$$" ] && continue
  cwd=$(readlink /proc/$pid/cwd 2>/dev/null); case "$cwd" in "$CLONE_ROOT"/*) ;; *) continue;; esac
  ppid=$(ps -o ppid= -p $pid | tr -d ' '); et=$(ps -o etimes= -p $pid | tr -d ' ')
  [ "$(ps -o comm= -p $ppid | tr -d ' ')" = "claude" ] || continue
  [ "$et" -gt 600 ] || continue
  echo "$et|$pid|${cwd##*/}"; tr '\0' '\n' < /proc/$pid/cmdline | tail -1 | /usr/bin/grep -o "eval '.*' < /dev/null"
done | sort -rn
```

Before killing one, confirm no real process of that clone is being waited on (`pgrep -x make` / `-x zig` plus a cwd match).

