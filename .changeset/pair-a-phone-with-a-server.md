---
'@memnox/core': patch
'memnox': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
---

A phone or a Mac can now pair with a machine that has no Memnox app, such as a server you reach over SSH. `memnox pair` draws the QR in the terminal and you accept by typing the six digits the device shows; three wrong codes close the pairing, and an agent can never run it. `memnox devices` lists, revokes and grants what each device may do. With a paired device connected, a held call waits for its answer rather than falling straight to the terminal nobody is watching, the daemon tells a device whether it has a voice to lend so the device speaks with its own when it has none, and on Linux `memnox daemon --install` keeps the daemon running after you log out.
