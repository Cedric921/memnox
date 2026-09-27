---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

In Claude Code a held question is now asked in Claude Code's own picker, the same one the agent uses for its questions: Allow once, Allow for this session, or Deny, chosen with the arrow keys, and the pick is recorded as the person's answer at once. The agent can send that picker with its own answer already filled in and Claude Code passes it through unseen, so Memnox refuses a picker that arrives answered and takes an answer only from one it saw open empty. Every other agent still shows the numbered choices, and typing 1, 2 or 3 still works everywhere.
