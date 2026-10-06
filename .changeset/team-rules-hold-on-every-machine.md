---
'@memnox/core': patch
'memnox': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
---

A machine says at enrolment whether it is a server or a workstation, read off the machine or given with `memnox login --class`, so a workspace rule can hold on servers only. Workspace rules now keep their project and who decided them: `memnox why` names a workspace rule as the team's, with who approved it and when, and says when the team has published newer rules since. A workspace rule that asks can no longer be answered by a local `memnox allow`, and naming policy files in `MEMNOX_POLICIES` keeps the workspace's rules rather than setting them aside. An answer from the workspace is now written into the ledger naming who gave it, a shell or MCP question honours the approval route set in `config.toml`, a refusal says who refused, and when a phone, the workspace and a terminal answer the same call at once exactly one answer is taken.
