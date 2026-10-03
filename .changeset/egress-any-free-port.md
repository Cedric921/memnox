---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

The daemon's egress proxy listens on a port the system picks rather than 8888, so it never takes the port Jupyter, Charles or another local proxy expects. `memnox run` already read the port from the daemon, so agents are pointed at it as before.
