---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A lease now holds the code a session is editing rather than the whole file: the lines it changes and the function, method or class they sit in, named like `PaymentService.retryCharge`. Two sessions in one file meet only when they touch the same code, names win over line numbers where both sides give them, and a second part of the same file grows the session's lease rather than adding one. Each lease also says which checkout it is in, so one machine's register keeps its repositories apart, and a repository is named by its remote, so two clones of one project meet and two projects that share a folder name do not.
