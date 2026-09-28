---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

The first agent in a repository now records how its code is written, as a code fingerprint every agent after it is held to and told about at the start of each session. Only a first fingerprint is taken without a person, so it can only tighten, and it is read from what git tracks, never from ignored, built, vendored or oversized files.
