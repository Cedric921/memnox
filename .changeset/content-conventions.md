---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A rule can now carry a content convention, and a write that adds a line matching it is refused, such as a `console.log` left in source. The lines are read where the call is made and never recorded, since a ledger row carries names and never contents, and a write whose lines cannot be read is not matched.
