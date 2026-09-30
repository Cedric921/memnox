---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

The daemon answers `cancel`, which stops the answer in flight when the person talks over it. The turn ends with `cancelled` rather than as a failure, and the brain's process is ended rather than left to finish an answer nobody is listening to on the person's plan. The conversation survives it: the next question resumes where it was.
