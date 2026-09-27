---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

Memnox trusts an MCP server's word only where it has earned it. Memnox's own tool names are recognised only on Memnox's own server, so a lookalike `memnox_memory` elsewhere is classified on its own rather than read as harmless. A server named `memnox` in a project's `.mcp.json`, which anybody with the repository can write, no longer has its tools skip the rules. And a server's read-only annotation can no longer make a tool whose name says it deletes or writes read as harmless: it may call a tool worse than its name, never better.
