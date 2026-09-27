---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A command no longer slips past the rules by sitting behind something that only runs it. What `$(...)` and backticks run is ruled on like any other command, and `env`, `sudo`, `nohup`, `nice`, `timeout`, `xargs`, `find -exec` and `find -delete`, `bash -lc` and a `git -c alias.x='!...'` are all seen through to the command they run, so `echo $(rm -rf ~/work)` or `ls | xargs rm` is the delete it is. A download piped straight into a shell, or a payload decoded and run where the decoding could not be read, is now put to a person whatever the rules allow, because what it runs is only known once it has run.
