---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A rule asked for by voice is now registered once you confirm it, so every hook enforces it, where before it sat in a project file only `memnox policy test` read. While Memnox is only watching, the voice tells you when one of your rules would have asked about or refused something that went through, and it offers to turn on enforcing behind Touch ID. Registering a rule file by voice now waits for Touch ID too, and a rule for a project folder that is not there is refused before Touch ID rather than failing after it.
