---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

An agent can no longer reach what governs it by a path that does not look like one. A write is checked where it really lands, so a symlink into `~/.memnox` is `~/.memnox`. Claude Code's settings files, which install Memnox's hooks and could switch them off, and the `memnox` binaries a hook runs, are now protected like Memnox's own rules. A command line that names any of these and also writes, runs an interpreter such as `python -c` or `node -e`, or hides part of itself is refused, which catches `cd ~/.memnox && tee`, `ln -s ~/.memnox`, `chmod` and `sqlite3` on the ledger; reading them stays allowed.
