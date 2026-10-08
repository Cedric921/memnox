---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

With a phone paired, an answer given in the workspace now reaches a held call within a second rather than on the next poll: the control plane sends the machine a beat with nothing in it over the relay, and the machine checks at once. The fast poll while a call is held relaxes to thirty seconds behind it.
