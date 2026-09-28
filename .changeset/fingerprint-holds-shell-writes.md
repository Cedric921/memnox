---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A code fingerprint check now holds however an agent writes, rather than only when it uses its edit tool. A shell line that shows its text (a heredoc or here-string into `cat` or `tee`, or `echo` and `printf` into a file) is refused before it runs, with the same message an edit gets. A command that shows nothing beforehand, such as `perl -pi` or a script, is read after it runs: the repository's tree is kept before it through an index of its own and compared after, and a forbidden line it added is told to the agent to put right in the same turn.
