---
'@memnox/core': patch
---

The core builds the protocol vectors every client is tested against: each signed message with its exact text, one signature in DER and raw form, and every value a mirror must know. `pnpm vectors` writes them to `vectors/protocol.json`.
