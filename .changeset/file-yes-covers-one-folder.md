---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A yes for the rest of the session to reading or writing a file now covers that file's folder and nothing else. It used to cover the action everywhere, so one yes about a file in the project let the agent write `~/.zshrc`, a login item or any other file outside it for the rest of the session without asking, and the project boundary honoured the same grant. The question and the answer both say which folder the yes covers, and a write anywhere else is asked again.
