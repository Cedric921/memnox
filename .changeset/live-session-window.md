---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

Opening a session by voice now shows it live. A new `session-view` daemon request answers with what the session is on, whether it is working, thinking or waiting, its latest steps in plain words with refusals and failures marked, its helpers and the files it changed, so the Mac app can open a window on it that updates while it works. `show` with display open puts that window up, with a button to the session's own terminal tab or editor.
