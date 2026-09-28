---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

Claude Code now has a `/fingerprint` command that records a repository's code fingerprint, because a hook can tell a person the fingerprint is missing but cannot put a prompt in their input. It is written with the session tools and taken out with them, and a `fingerprint.md` a person wrote is never replaced or removed. A session in a repository with no fingerprint now says to type it.
