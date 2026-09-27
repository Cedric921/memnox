---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A held question's picker now counts only when it is worded exactly as Memnox wrote it: the question for one held call, word for word, and exactly its three options. The agent types the picker, so it could put a harmless question over a dangerous call's id, hide another call's id in an option, or relabel an option so that "Allow once" read as a yes for the whole session. Any of those is now refused before the picker opens, a pick is read by its exact label rather than as free text, and a reply typed in place of a pick answers nothing.
