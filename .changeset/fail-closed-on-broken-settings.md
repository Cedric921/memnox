---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

Memnox now fails closed when its own settings cannot be trusted. A `config.toml` that exists but cannot be read, or that was emptied so it no longer names a mode, is read as enforce rather than as a first run that only watches, since one `chmod` or truncation used to switch enforcement off. And in enforce, a hook that fails before it could rule on a tool call now refuses that call instead of letting it through.
