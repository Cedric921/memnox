---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

The voice talks like a person rather than reading a report. Its instructions replace Claude Code's own rather than being added to them, ask for one spoken sentence, and show by example the difference between a report and an answer. It runs on the fast model at low effort, set with `MEMNOX_VOICE_MODEL` for a deeper one, starts where no project memory or settings ride along, and never uses the person's name except to get their attention on a held call. The daemon's new `warm` starts the brain as soon as the person starts talking, and a conversation begun under older instructions is started fresh rather than resumed, since its own history teaches the old way.
