---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

The voice can see what a session did and which session it is. `sessions` lists every agent session on the machine lately, side by side: the agent, the task it was given, the repository, how busy and how quiet it has been, what is waiting on the person and whether it is paused, so two Claude sessions are two rows and the voice asks which one is meant rather than picking the newest. `changes` reads what a session changed in the code against the milestone taken before its first write, file by file with lines added and removed, or the diff of one file, writing git objects only so no ref and no index moves. The operator never reads its own run as the session it was asked about.
