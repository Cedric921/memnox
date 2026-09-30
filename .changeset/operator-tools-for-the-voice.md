---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

`memnox-operator` is a new MCP server for the voice's brain: the person's own agent CLI runs it as the only tools it has, and it is never registered into a working agent's session. It reads the machine (`status`, `waiting`, `unattended`, `why`, `replay`, `decisions`) and writes nothing but proposals. `propose_answer` answers a held call from what the person said in whatever words: a deny takes effect at once, and an allow waits for Touch ID and never outlives the call. `propose_rule` writes down a rule the person asked for, named the way the engine rules on it, and nothing is in force until they confirm it.
