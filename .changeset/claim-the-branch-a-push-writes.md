---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

The hooks and the edit watcher now name a repository by its remote when they take a lease in the workspace, so the same project cloned on two machines is one repository there. A `git push` is claimed by the branch it writes, filed the way a GitHub tool call that pushes to that branch is, so two agents pushing one branch from two machines meet before either lands.
