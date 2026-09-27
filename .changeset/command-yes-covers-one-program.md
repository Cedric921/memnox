---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A yes for the rest of the session to running a command now covers commands the same program runs and nothing else. It used to cover every command, so one yes to `pnpm test` let `curl ... | sh` or any other command through without asking. The question and the answer both say which program the yes covers, and any other command is asked again.
