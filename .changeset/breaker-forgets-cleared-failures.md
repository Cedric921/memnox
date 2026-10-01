---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

The circuit breaker no longer pauses a session for a command that failed and then worked again: a success clears that command's failures, so five failures spread across a day of successes is not an error loop. A pause now names the command and its exit code, "git symbolic-ref has failed the same way 5 times, exiting 128", rather than "git.unknown".
