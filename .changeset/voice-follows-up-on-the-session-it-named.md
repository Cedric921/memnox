---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

Asking the voice what changed after it says a session finished now reads that session. A notice or held call names its session id and the folder it last wrote in, and the brain passes that id to `changes`, `show` and `replay` rather than guessing. A window merely opened no longer stands in for the session that did the work. `changes` reads the repository the session wrote in last, counts the agent's own edits and the files a shell command changed while it ran, never another session's work in the same tree, lists what the latest turn changed, and finds a file by its short name.
