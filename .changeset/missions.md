---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

`memnox mission` groups many sessions under one goal: start one with a statement and a reference, join a run with `memnox run --mission`, and the runs it starts join on their own, as does any session working in the mission's repository or its worktrees. `memnox mission show` with no id is the screen for coming back: each session clear, waiting, failing or stopped, and what is waiting on you.
