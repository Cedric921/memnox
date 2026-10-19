---
'memnox': patch
'@memnox/core': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

The autopilot acts once a person turns it on: an action an agent was approved for five times with no refusal is handed to that agent for seven days, and one refusal takes it back. `memnox autopilot` lists and revokes the grants, and an agent can no longer run `next --hand-over` itself.
