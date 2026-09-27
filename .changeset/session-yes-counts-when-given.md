---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A yes for the rest of the session now counts the moment it is given, wherever it was given: typed in the session, run as `memnox approve`, or pressed in a Slack or Discord DM. It used to count only if the agent retried the same call before the question expired, so an answer from a phone was usually lost and the same question came back. The project boundary check reads the same grant, so one yes is never asked for twice, and when a question is held for a person that question is what the session shows, rather than a refusal telling the agent that a yes could not help. A yes for the session on a delete covers that one file, and an answer about one file is never spent on another.
