---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

The code fingerprint now describes the code that is actually there. It is tested against untracked code as well as committed code, so a repository nobody has committed to yet is read rather than taken as empty, and vendored directories are skipped even where no `.gitignore` names them. A check whose files name nothing the repository has is dropped with the reason, a repository with no code of its own records nothing, and a proposal too large to read in full says how much went unread. The agent now receives the whole of what to write, which was cut short before it reached the `enforce` list.
