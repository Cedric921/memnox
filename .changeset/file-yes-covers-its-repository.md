---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A yes for the rest of the session to writing a file now covers the whole git repository that file is in, so an agent working across a project is not asked again folder by folder. A write anywhere outside that repository still asks, and a file in no repository, or in one that is the whole home directory, keeps the yes to its own folder, so one answer never reaches `~/.zshrc`, `~/.ssh` or another project.
