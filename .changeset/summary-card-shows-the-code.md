---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A session summary now says what the session actually did. Every turn is kept with its start and end, so `changes` finds files a session changed in its own repository while it worked even when no command named them, places the edit tool's relative paths in that repository, and says for each file how it knows. The summary card lists the changed files with their lines added and removed and shows a few changed lines of the file that changed most. A task is read from the person's own words, past a stray backtick or a pasted log, and a card is never said to be in an app.
