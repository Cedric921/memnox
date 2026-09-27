---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

Installing the Claude Code hook now also turns on Claude Code's own sandbox for the agent's shell, so a command it runs cannot write `~/.memnox`, Claude's settings files or `~/.claude.json`, however the path is spelled, since the sandbox holds at the system call rather than reading the command line. Unsandboxed retries are turned off, and writes and the network stay as open as they were, so ordinary work goes on. A sandbox the person already set is kept and only the wall is added, removing Memnox puts their own back, and on a Claude Code too old to allow every host the wall is skipped and the install says so rather than cutting the network off.
