---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

`memnox_claim_action` and `memnox_finish_action` on the workspace's `memnox` server are known as Memnox's own tools that record something, so an agent claiming an outward action before it takes it is never held for approval as an unknown tool.
