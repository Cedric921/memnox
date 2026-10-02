---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

The voice now reads what a session it started actually answered, because a session under `memnox run` is found by the agent's own transcript id. Asking it to close a session closes its live window and its terminal tab, though never mid turn, where it used to pause the session instead. Asking it to log in, or to onboard an agent, takes one Touch ID and a page in your browser to approve the Mac, with no terminal, and the voice tells you when it is done. It stops waiting the moment it decides you have not finished, rather than after the brain writes on, and it understands more misheard names such as "my nose cloud" for Memnox Cloud.
