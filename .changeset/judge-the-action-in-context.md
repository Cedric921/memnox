---
'memnox': patch
'@memnox/core': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

`memnox run --for <person>` names who the agent works for, and a rule's `principals:` now fires on it, so an agent on a shared credential never does what its person may not. An agent setting its own identity variables, or running `memnox run --for` or `--role`, is refused. A database tool that has only ever read now asks before its first change, and one that has only made bounded changes asks before its first DELETE or UPDATE with no WHERE. `memnox why` now reads each decision against its context, person, agent, intent, tools, systems and history, and marks the part that decided, from what the gate found, which every row now keeps. The MCP proxy honours `--role` and `--for` and records the class a statement gave a call. An agent can no longer rewrite or delete its host's own session record.
