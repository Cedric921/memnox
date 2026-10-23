---
'memnox': patch
'@memnox/core': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
'@memnox/guard': patch
---

A rule can now say sensitive data never leaves for a destination nobody approved. What a call sends is read by shape at every seam that sees it, the MCP proxy, agent hooks, `curl` and `wget` bodies, plain HTTP through the egress proxy and `@memnox/guard`, and named `secret`, `financial`, `health`, `government-id`, `personal-data`, `customer-record`, `confidential`, `source-code` or `bulk-records`, each also `sensitive`, which `dataClassifications` matches, with the recipient's domain or the URL's host as the target. A policy file or the workspace's bundle can add its own patterns under a named classification. `memnox protect` offers the rule as a question. A cloud agent wrapped by `@memnox/guard` that reads a tool answer written to steer it now asks a person before its next send, post or loss, as the gateway does.
