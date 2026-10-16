---
'@memnox/core': patch
'memnox': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
---

Agent hooks run the edit hook by its absolute path, because an agent started without the installer's PATH failed every tool call with `memnox-edit-hook: command not found`, and the daemon rewrites any hook still written by the bare name.
