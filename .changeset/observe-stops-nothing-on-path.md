---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

The interceptors on PATH now read the machine's mode the way the hook does, so observe records what a rule would have said about `git push --force` or `rm -rf` and lets it run, rather than refusing at one seam what it only annotated at the other. Advise says on stderr what enforce would have done. The ledger row carries the mode and the shadow verdict, so `why` and `timeline` tell a deny that stopped something from one observe let through.
