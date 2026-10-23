---
'memnox': patch
'@memnox/core': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

A wrapped MCP server now reads the rules, the workspace bundle and the conditions in force again whenever one of them changed, so pausing an agent or pulling a new bundle decides its very next tool call rather than waiting for the agent to restart. The proxy knows the agent `memnox mcp wrap` wrote into its line, so a pause on that agent stops its servers too. A SQL statement handed to a database MCP tool is ruled like the same statement on `psql`: a DELETE or UPDATE with no WHERE is held with the bounded way forward on its table, while a bounded write goes through where the call shows the database is on this machine, and anything else still asks. Run `memnox protect` again to take the new MCP rule.
