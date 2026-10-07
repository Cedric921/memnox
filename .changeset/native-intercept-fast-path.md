---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

A wrapped command no longer has to start Node when the daemon is running. Where a native build of `memnox-intercept-native` ships for the platform, `memnox protect` puts it in front of each shim: it asks the daemon, which rules on the whole command with the Node interceptor's own code, and runs the real binary itself. Anything the daemon cannot rule on exactly as Node would, such as a rule that asks a person, a push, or a command that destroys work, still goes to `memnox-intercept`, and so does every command when the daemon is not running or `MEMNOX_INTERCEPT_NATIVE=off` is set. Without a native build nothing changes.
