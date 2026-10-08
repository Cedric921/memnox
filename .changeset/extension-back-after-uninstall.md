---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

The daemon puts the Memnox extension back into an editor that uninstalled it, since the folder an editor leaves behind until it restarts is no longer read as installed.
