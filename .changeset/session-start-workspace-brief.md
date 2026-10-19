---
'memnox': patch
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
---

A session that starts on a machine logged in to a workspace is told, before its first turn, who has a pull request or a pushed branch open on the files it is about to work on, which other open work touches them, and what was said about them in connected tools, asked once with a short timeout and said nothing about when the workspace cannot answer. The brief tool says the same lines first, and a note about other work on a file now reads as being about other work rather than about another agent.
