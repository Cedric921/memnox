---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A held call answered by voice or Touch ID is now a row in the agent's own session: the person, what they answered, and what they said, with any secret they read out masked. `replay` shows it in place, `why` can name who let a call through and in what words, and a session's summary counts it among the approvals. The row is written after the answer and can never undo it, so an agent already released is not held again because the ledger could not be opened.
