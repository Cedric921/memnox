---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

`memnox run` points its agent at a relay of its own rather than the daemon's egress port, so an agent keeps its network when the daemon stops or restarts on another port. Without a daemon its calls go straight through, and a desktop notice says Memnox is not watching until the daemon is back.
