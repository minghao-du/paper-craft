# Claude Code folder trust

Before launching in a fresh clone from [pc-conductor-spawn](../SKILL.md):

In the Claude Code branch, a fresh clone can open its folder-trust dialog, which queues the prompt. If you answer it from the conductor, read which option is highlighted first (`grep -nE 'No, exit|Yes, I trust'` the pane) and send `Down` before `Enter` when `No, exit` is highlighted — never a blind `Enter`.
