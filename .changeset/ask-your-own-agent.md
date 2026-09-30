---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

`memnox ask "<anything>"` answers questions about your agents in your own words, through your own Claude Code rather than any key Memnox holds. The words go whole, with no keyword matching. Claude Code is started with every built-in tool off and only `memnox-operator`, recorded as the operator rather than as your work, kept warm across a conversation and resumed for thirty minutes, and answers stream sentence by sentence, which is what the voice will speak. A plan that has run out is said plainly.
