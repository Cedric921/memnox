---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A milestone is now taken on a machine where git has no name or email set. `git commit-tree` refused outright there, so every milestone, and every rewind that needs one, failed on a fresh laptop or a CI runner. Milestones are Memnox's own objects under `refs/memnox/`, never part of the person's history, so they are now signed as Memnox rather than borrowing whatever identity the machine has.
