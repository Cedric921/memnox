---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

Scan reads whether each agent asks before acting, where its binary lives and who signed it, and which agents were removed. `protect --managed` moves Claude Code's hook into managed settings. Every row names the subagent that did it. `run --hold-credentials` keeps tokens out of the agent's environment and hands each only to the CLI that uses it.
