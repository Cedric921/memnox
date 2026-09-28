---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A repository with no code fingerprint now gets one. The first write of a session there is held once, with the agent sent to record the fingerprint and then make the change again, because an ask at session start alone was skipped by any agent busy with its task. Once a session, so a recording that fails never stops the work. The person sees it too: a session starts with a line saying the repository has no fingerprint yet and what to ask for, or how many of its checks are enforced.
