---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

The daemon refuses a method it does not know rather than answering it with a bare "ok". A newer client, such as the Mac app asking an older daemon for `ask`, read that "ok" as support and waited for an answer that was never coming.
