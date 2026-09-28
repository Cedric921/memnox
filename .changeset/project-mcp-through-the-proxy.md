---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A repository's own MCP servers, from its `.mcp.json`, now go through the Memnox proxy too, without the team's committed file ever being rewritten: each server a person approved in Claude Code is placed behind the proxy in Claude Code's local scope, which only this machine reads.
