---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A session now says where it runs. When it starts, the hook notes the app hosting the agent (the outermost app bundle above it, so a terminal inside VS Code is VS Code), the terminal it has and its folder, once per session and never on the hot path. The daemon's `locate` answers that for a session, with whether the agent is still running, so the Mac app can bring the right window forward for "show me", and `sessions` names the app, so the voice can say which window to look in. A machine where `ps` cannot run still notes the session, without its app.
