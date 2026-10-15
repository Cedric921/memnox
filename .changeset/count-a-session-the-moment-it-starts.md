---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

A session `memnox run` just started is counted at once, with its agent, folder and terminal, rather than only after its agent first acts, so the voice no longer says nothing is running a minute after you started Claude Code.
