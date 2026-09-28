---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A shell line is no longer taken for one that writes everywhere it names because of a dollar it cannot expand. A `$` inside single quotes is text, so an awk program counting files reads as the read it is; a variable the line itself set to a plain path is read as that path; and awk is judged by its program, so only one with a redirect, a pipe, `system` or `getline` counts as writing. A variable that could hold anything else stays unknown and is ruled on as before.
