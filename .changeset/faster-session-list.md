---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

Listing sessions and reading one by voice no longer starts git for every folder a session touched to find its repository, which made "what is that session doing" take several seconds more than it needed.
