---
'memnox': patch
'@memnox/core': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

Two agents on two machines meeting in one file now settle it between themselves first. A write held off by another machine's agent tells the agent it can ask that agent directly with `memnox_message_agent`, and a message from another agent reaches it at its next step with the address to answer. The person hears about the hold only if their agent is still held off a minute later, or when an agent asks them. People can speak to each other by voice too: "tell Ana I'm done with billing" or "ask them how long they need" is said on the teammate's Mac at once, and their spoken answer comes back. The workspace stream now picks up what it missed after a dropped connection, so nothing said during a network blink is lost.
