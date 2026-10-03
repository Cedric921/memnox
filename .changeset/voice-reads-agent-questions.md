---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

The voice reads out a question an agent asks in its own picker and passes the spoken answer back in its place, so the agent carries on without the picker ever opening; unanswered, the picker opens as before. It stays silent when the person pauses mid sentence, keeps a request across two turns, proposes again when a start is corrected, understands more misheard names, and can watch a session it only just started.
