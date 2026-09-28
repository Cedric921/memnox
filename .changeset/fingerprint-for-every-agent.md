---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

The code fingerprint now holds in every agent Memnox hooks, not only Claude Code. A shell command's lines are read after it runs in Codex, Gemini CLI, Cursor and Windsurf too, paired with its return by session where the agent sends no call id, and Windsurf, which reads nothing back after a tool, has its next call refused with the report. The first write held until a fingerprint exists is refused in each agent's own words. Cursor is now told the session's context at its `sessionStart`, Windsurf hears the fingerprint when `memnox-session` connects, and `memnox setup` writes a `/fingerprint` command for each agent (`/prompts:fingerprint` in Codex), never over one a person wrote.
