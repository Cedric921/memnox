---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

Every tool on the workspace's `memnox` server whose name starts with `memnox_` is now Memnox's own, so a tool the control plane adds is never held as unknown until the next release. The new ones, `memnox_people`, `memnox_workspace` and `memnox_sources`, are known as reads, which is what lets somebody ask an agent session who is in the workspace, what it runs, and what people said or filed there. The same names on any other server are still ruled on like every other tool.
