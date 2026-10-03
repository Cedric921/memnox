---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

The voice answers any question about Memnox itself, from the vision and its numbered sections to every command, the policies, the threat model, the build plan and the changelog, because the project's own documents now ship with the CLI and a new `about` tool searches them by the words of the question. It also says which agents approve their own actions and where each was installed from, names the subagent behind a refusal or a step, locks the hook in with `protect --managed`, and starts a session with `--hold-credentials` when asked to keep tokens away from it.
