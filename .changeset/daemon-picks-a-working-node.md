---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

Installing the daemon picks a Node on this machine that really runs it, rather than whichever came first on the PATH, so an app that ships its own Node, such as Hermes, no longer leaves the daemon dying at every start.
