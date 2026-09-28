---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

`memnox setup` now runs from any directory and picks up each repository in its first session. The baseline rules live in the machine's own file, merged rather than written over, so a second run never undoes somebody's edits, and the copies earlier setups left in whatever directory they ran in, which applied to the whole machine, are no longer read unless somebody changed them.
