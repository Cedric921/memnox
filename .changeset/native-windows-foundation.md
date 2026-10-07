---
'@memnox/core': patch
'memnox': patch
'@memnox/interceptors': patch
'@memnox/proxy': patch
---

Memnox can now govern agents running natively on Windows, not only inside WSL, which still works as before. On Windows the daemon listens on a named pipe, `memnox protect` writes `.cmd` interceptors beside the Git Bash scripts, `memnox run` finds `claude.exe` or an npm installed `.cmd` agent and puts the interceptors first on `Path`, `memnox daemon --install` registers a Scheduled Task that starts the daemon at logon, and `memnox doctor` lists which agents are governed natively and which seams, such as the kernel guard, are not available on Windows. This has only been tested on macOS with Windows simulated; ADR 0003 lists what is not yet verified on a real Windows machine, including that the pipe is not a boundary against another local user.
