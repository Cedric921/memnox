---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
'@memnox/guard': patch
---

`@memnox/core/engine` is the rule engine with nothing that reads a disk or opens a database: the policy engine, the default rules, the verb tables, the tool and SQL classifiers, the circuit breaker and budgets. An agent running in somebody's cloud can load it and decide allow, ask or deny in its own process, in microseconds. The SQL check's `psql -f` file reader moved to its own module so the check itself stays pure.

`@memnox/guard` governs an agent running in the cloud, built with the Claude Agent SDK or any framework that calls tools: allow and deny are decided in its own process from the workspace's signed rules, an ask is put to the right person on their phone, Mac, Slack, Discord or the console and waits a bounded time, only a signed answer is believed, and the circuit breaker pauses a session that fails the same way five times.

The guard also wraps OpenAI Agents SDK function tools and any plain function (`wrapTool`), can refuse a yes no device or passkey signed (`requireDeviceProof`), records a circuit breaker pause, and lifts it once a person resumes the session from their phone or the console. On a Mac connected to a team, a rule said aloud can now be offered to the team as a third place beside the whole Mac and a repository, and the voice can say what an agent running in the cloud is doing.
