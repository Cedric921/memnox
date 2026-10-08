---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

The daemon also listens on the egress port an agent started by an older `memnox run` was pointed at, read back from that agent's own proxy variables, so a session started before an upgrade or a reinstall keeps its network with nobody running a command.
