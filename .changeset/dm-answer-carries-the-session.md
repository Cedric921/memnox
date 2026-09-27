---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

With "Also ask me in my DM" on, a held question no longer opens Claude Code's picker. Nothing outside can close a picker, so a question answered in Slack or Discord left it on screen asking for nothing. The agent now says it is waiting and ends its turn, and the answer from the DM, or a 1, 2 or 3 typed in the session, carries it on. A picker opened for a question that is already answered is refused with that answer, and a pick that arrives after another answer is not used, with both the person and the agent told which answer stands.
