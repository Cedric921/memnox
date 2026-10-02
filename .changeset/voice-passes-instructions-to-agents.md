---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

The voice can pass an instruction to an agent session. `propose_instruction` keeps what the person said and reads it back, since a recognizer mishears, and `send_instruction` sends it only after their yes. A working session picks it up after its next tool call, or as the next thing to do when its turn ends; one waiting in iTerm or Terminal has it typed in, only when the agent is the tab's foreground program; one waiting in VS Code, Cursor or Windsurf opens with it in its input for the person to send. It reaches the agent as the person's own request, and everything the agent then does is ruled as before.
