---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

`memnox update` checks a release before installing it: every Memnox package must carry provenance from this repository's release workflow at a version tag, and the install is pinned to the version checked. `--skip-verify` installs anyway and is kept on the record in `~/.memnox/updates.jsonl`.
