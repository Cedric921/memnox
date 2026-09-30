---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

The daemon can now be the voice of what is waiting on a person. `subscribe` keeps a connection open and writes one line for every held call, proposal and paused session as it appears, `waiting` lists what is answerable now, and `confirm` answers a held call or a proposal. A refusal needs nothing, because saying no can do no harm. Anything that lets something happen carries a P-256 signature from a key registered once through `register-key` and never replaced from the socket, so a process running as the same user can raise a Touch ID sheet but never finish an approval. Proposals are a new store under `~/.memnox/proposals/`: a change something other than a person suggested, written down and applied only once confirmed, and a confirmed rule may only ever land in `memnox.policies.toml`.

`memnox unattended [--agent <name>] [--json]` answers whether an agent can be left running: the boundary the rules draw for it, and every reason not to yet, each one a count or a fact, in the order a person should deal with them.

The voice is one more route to a held call, beside the terminal, `memnox approve` and the workspace DM, and none of them is taken away: whichever answers first releases the agent's session with that answer, so it carries on after an allow and is handed the refusal after a deny. A subscriber is told `settled` when something it heard about was answered elsewhere or expired, so a question answered in a terminal stops being asked out loud.
