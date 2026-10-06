---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

`uploadPaths = "hashed"` in `config.toml` sends file paths and command lines to the workspace as a keyed hash under a key that never leaves this machine, so the same file still matches and none can be read. The default stays `full`.
