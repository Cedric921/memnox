---
'@memnox/core': patch
'memnox': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
---

A second `memnox daemon` no longer takes the socket from one already running. Started by hand it says so and stops, and started by launchd or systemd it waits and takes over when the other stops, so a machine never runs two egress proxies on two ports.
