---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

The macOS kernel guard's profile now escapes a backslash in a path, so a path ending in one can no longer close its string early and add a rule of its own.
