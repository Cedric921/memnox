---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

`memnox purge` now also drops the records beside the ledger past the retention window: parked and expired questions, posts, lifted pauses, closed missions, turns, tasks and old grants. Nothing still in force is touched, and `--dry-run` counts them.
