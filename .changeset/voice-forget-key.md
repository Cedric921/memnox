---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

`memnox voice` shows the key the Mac app signs its confirmations with, and `memnox voice forget-key` clears it so the app can register its own again. It asks first and defaults to no, because whichever key registers next is the one trusted, and an agent is refused it like every other command that loosens what agents may do.
