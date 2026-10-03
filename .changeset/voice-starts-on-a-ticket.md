---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

Asking the voice to start an agent on a ticket now hands the agent its whole brief before its first turn through `memnox run --brief`, gathers what names the ticket by its key, its link or in documents as well as by its words, and works in the ticket's repository or the one the last session used when none is named.
