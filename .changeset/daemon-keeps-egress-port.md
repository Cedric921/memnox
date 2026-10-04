---
'@memnox/core': patch
'memnox': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
---

A restarted daemon takes back the egress port it held, so an agent started under `memnox run` keeps reaching the network instead of getting connection refused.
