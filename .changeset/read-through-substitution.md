---
'@memnox/core': patch
'memnox': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
---

A read such as `cd ../other && f=$(grep -rl x src); grep -n y $f` no longer asks as a write outside the project, so a session that only searched another repository is not reported as having worked in it. What an assignment like `f=$(...)` runs is now ruled on too.
