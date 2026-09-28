---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

The hooks now read the results of every agent's MCP calls for instructions, and claim its outward calls the way the proxy does, so two agents about to send the same message or work the same issue meet even through MCP servers the proxy cannot sit in front of.
