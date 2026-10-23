---
'memnox': patch
---

A rule published in the workspace, and a freeze or any other condition declared or lifted there, now reaches every enrolled machine with a live relay link in well under a second rather than on the next minute. The control plane beats the machine, and the beat now wakes the sync loop whether or not a call is held, with the pass it brings pulling the rules and the conditions before anything else. The minute stays as the fallback for a beat that never arrived.
