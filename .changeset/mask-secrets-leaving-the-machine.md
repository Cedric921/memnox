---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

Credentials are masked in everything that leaves the machine. A command line is the target when nothing narrower was parsed, so `vercel deploy --token=...`, a password in a `DATABASE_URL`, a `Bearer` header or a key set in the environment used to reach the control plane, the held question in a DM and the ledger rows the cloud keeps. Named secrets, secrets in a URL, auth headers and the usual key shapes (GitHub, OpenAI and Anthropic, Slack, AWS, npm, JWTs) are now masked in the question's wording, the heartbeat and every action synced, while the local ledger keeps the target whole so `memnox why` can still show it.
