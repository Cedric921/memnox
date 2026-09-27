---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

Memnox no longer holds its own tools for approval. A rule asking about unknown MCP tools held `memnox_memory` and `memnox_context`, which are the reads Memnox tells an agent to make before it changes anything, because a hook sees a tool's name and never its listing. Memnox's own tools are now known by what they do, and the hook rules on any other server's tools by what the last scan heard that server declare. The workspace's bookkeeping on the `memnox` server, which is asking for approval, taking and releasing a path and reporting an action, is not ruled on at all, since holding a request for approval asks one person twice. The same names on any other server are ruled on like every other tool, and `memnox policy test` now answers for a session tool as the hook would.
