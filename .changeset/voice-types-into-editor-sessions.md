---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

The voice can type an instruction into an editor session it did not start, such as Claude Code in VS Code, since that session's own id is its conversation id; before, it left the words on the clipboard.
