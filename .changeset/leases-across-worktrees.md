---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

Two worktrees or clones of one repository now share leases on this machine, as they already did through the workspace, so a second agent writing the same file in another checkout waits and is told where the holder works.
