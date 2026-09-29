<p align="center">
<img width="1920" height="1080" alt="memnox-architecture-dark-16x9" src="https://github.com/user-attachments/assets/21141ee8-06c4-4c99-a5af-a54fab10d4a8" />
</p>

<p align="center"><sub>BEFORE YOU LEAVE AN AGENT RUNNING</sub></p>

<h1 align="center">
  Your agents can already do the work.<br>
  <sub>Memnox makes it safe to let them <b>do it without you</b>.</sub>
</h1>

<p align="center">
  <img src="assets/agents/claude-code.svg" width="44" height="44" alt="Claude Code" title="Claude Code">&nbsp;&nbsp;
  <img src="assets/agents/codex.svg" width="44" height="44" alt="Codex" title="Codex">&nbsp;&nbsp;
  <img src="assets/agents/cursor.svg" width="44" height="44" alt="Cursor" title="Cursor">&nbsp;&nbsp;
  <img src="assets/agents/cline.svg" width="44" height="44" alt="Cline" title="Cline">&nbsp;&nbsp;
  <img src="assets/agents/hermes.svg" width="44" height="44" alt="Hermes" title="Hermes">&nbsp;&nbsp;
  <img src="assets/agents/openclaw.svg" width="44" height="44" alt="OpenClaw" title="OpenClaw">
</p>

<p align="center">
  <sub>Claude Code · Codex · Cursor · Gemini CLI · Windsurf, and what Cline, Hermes, OpenClaw and Ruflo can reach</sub>
</p>

<p align="center">
  <strong>Set it up once. Every agent is governed inside the session it already works in.</strong><br>
  No model decides anything. Your code and your secrets never leave your machine.
</p>

---

You already have agents that read your files, run your shell, push to your repositories
and call your MCP servers. Memnox sits inside each of their sessions and rules on every
tool call before it runs: what is allowed goes ahead, what is dangerous is refused with a
way forward, and what needs a person asks you in the prompt you are already looking at.

You do not learn a new tool to get that. You set it up once and keep working the way you
work now.

## Set up once

```sh
npm install -g memnox
memnox setup
```

That is the last Memnox command you need. `setup` finds the agents on this machine and
goes through them one at a time: what each can already reach, what you want to call it,
and whether to put it under Memnox. Nothing is changed for an agent you say no to.

```
Claude Code
            claude-code
id          agt_claude-code
config      ~/.claude.json
mcp         github
can use     shell, filesystem, git, network, mcp
can reach   ~/.aws/credentials, network

  Call it something acme will recognise, or press Enter to keep "Claude Code"  > Backend Coder
  Put Backend Coder under Memnox now?  [Y/n] y
```

For each agent you accept, it puts a hook in front of every tool call, gives the agent a
small MCP server (`memnox-session`) it can ask Memnox through, and adds a `/fingerprint`
command. Then you open Claude Code, Codex, Cursor, Gemini CLI or Windsurf the way you
always do. There is nothing to launch and nothing to remember.

Node 22 or newer, on macOS or Linux. On Windows, run it inside WSL, and
[ADR 0001](docs/adr/0001-windows-support.md) says why.

## What you get, inside every session

| When | What Memnox does | What you typed |
|---|---|---|
| A session starts | The agent is told the boundary it works in, the rules in force, what your team has settled and how this repository is built, so it plans around them instead of walking into them | nothing |
| The agent reaches for something your rules refuse | The call never runs. The agent is told why and what to use instead, so it finishes the task rather than stalling | nothing |
| Something needs a person | You are asked in your agent's own permission prompt, or in the conversation, or in your Slack or Discord DM. Yes once, yes for the session, or no | a yes or a no |
| The agent writes code that breaks how this repository is built | Refused before it lands, or sent straight back to be put right, even when the agent switches from its edit tool to the shell | nothing |
| Your prompt touches something your team already decided | The decision is put in front of the agent, with who confirmed it and where | nothing |
| Two agents go for the same file | The second is told who holds it and what they have been doing | nothing |
| You want to know why, what happened, or to undo it | Ask the agent in plain words: "why was that refused?", "what have you done this session?", "undo what you did" | a sentence |

## One session, start to finish

You open Claude Code in a repository and ask it to add order cancellation. Before it
reads a file, it has been told where it stands:

```
Memnox: Memnox rules on this session in enforce mode: a rule that refuses stops the call, and one that asks puts the question to the person.
Project boundary: ~/work/shop. A write outside it asks first.
Your workspace has settled 1 decision(s), policies and owners. Before you change code, ask the memnox-session "brief" tool about the paths, or "memory" about the subject, and cite what it says.
This repository states how its code is written, in .memnox/code-fingerprint.yaml. Follow it; a write that breaks an enforced line is refused.
```

Your prompt mentions payment retries, which your team settled in Slack, so that decision
is put in front of the agent too:

```
Your workspace settled this about payment retries: "Declined payments are never retried." (a decision, confirmed by ada@acme.com, on 2026-05-02, source https://acme.slack.com/archives/C01/p17).
```

In a hurry, the agent writes the update straight into the HTTP handler. The repository
sends every database write through an Action, so the write never lands:

```
Memnox: This repository's code fingerprint: all database writes go through Actions, which own transactions and event persistence (rule fingerprint:writes-only-in-actions)
Instead: call actionFactory.create(XAction.class).run(params)
```

It writes the Action instead, and when the work is done it tries to force push:

```
verdict     DENY
reason      you chose to deny this: it rewrites history somebody else may already have pulled
instead     push a branch and open a PR
```

So it pushes a branch and opens a PR. You typed one prompt. Every one of those answers
came back inside the conversation, and each is in the record when you ask the agent
"why was that refused?"

## How it reaches each agent

Each agent's own hook asks Memnox before every tool call: a file read or write, a shell
command, a web fetch, an MCP call. The answer comes back in the agent's own format, so the
agent treats it like any other result.

**When a rule refuses**, the call never runs and the agent is told why and what to use
instead, so it carries on with the task rather than retrying.

**When a rule asks**, Claude Code shows its own permission prompt with Memnox's reason
in it. Say yes once, or for the rest of the session; a second yes to the same thing
stops the asking for that session. An agent with no prompt of its own relays the
question in the conversation, and you reply `yes`, `allow for this session` or `no`.
Turn on `memnox config set approvals both` and it reaches your Slack or Discord DM too,
where the first answer wins.

**When your prompt names something the workspace already settled**, or just before the
agent's first write to a file it covers, the decision is added to the conversation with
who confirmed it and where.

**Ask Memnox through the agent**, in plain words. Every agent gets `memnox-session`,
with eight tools:

| You say | Tool |
|---|---|
| "Why was that refused?" | `why` |
| "Where does Memnox stand?" | `status` |
| "What have you done this session?" | `replay` |
| "Would `git push --force` be allowed here?" | `decisions` |
| "What did we decide about retries, and who said so?" | `memory` |
| "Brief me on `src/payments` before you start" | `brief` |
| "Record how this repository's code is written" | `fingerprint` |
| "Undo what you did this session" | `rewind` |

Every tool but `rewind` and `fingerprint` only reads. `rewind` waits for your yes before
it moves a file, and `fingerprint` writes a repository's first fingerprint and never
changes one that exists. None of them can allow, approve or change a rule, and an agent
that tries `memnox allow`, `memnox mode off` or an edit to a rule file from its shell is
refused before any rule is read, since an agent that could would approve itself.

| Agent | Checked before it runs | A question goes to | Told at session start |
|---|---|---|---|
| Claude Code | every tool | its own permission prompt | yes |
| Codex | every tool its hook reports | the conversation | yes |
| Gemini CLI | every tool | the conversation | yes |
| Cursor | commands, MCP calls, file reads and writes | its own prompt for commands and MCP calls | yes |
| Windsurf | commands, MCP calls, file reads and writes | `memnox approve`, the workspace or your DM | no, only what `memnox-session` says when it connects |

A change to your rules reaches an open session on its next tool call. MCP servers the
agent already started, and the note it read at the start, catch up when you restart the
agent. [Everything from inside the session](docs/use-cases.md#20-everything-from-inside-the-session)
has the whole story.

## Holding agents to the way your code is written

Every repository has rules nobody wrote down where an agent would read them: writes go
through one layer, time is always UTC, nothing returns null. An agent new to the code
breaks them in the first hour, and a reviewer catches it days later if at all. Memnox
turns them into a **code fingerprint** the first agent records and every agent after it
is held to.

### Why this is not another CLAUDE.md

`CLAUDE.md`, `AGENTS.md`, `GEMINI.md` and `.cursor/rules` tell an agent what it should do.
They are loaded into the model's context, and following them is the agent's job. Nothing
happens when it does not, until a reviewer notices.

```
CLAUDE.md, AGENTS.md, .cursor/rules          .memnox/code-fingerprint.yaml
             │                                            │
             ▼                                            ▼
   agent reads instructions                            Memnox
             │                                            │
             ▼                              ┌─────────────┼─────────────┐
    agent edits the code                    ▼             ▼             ▼
             │                          Claude Code     Cursor        Codex
             ▼                              └─────────────┼─────────────┘
   a reviewer finds out later                             ▼
                                                  every write checked
                                                          │
                                              ┌───────────┴───────────┐
                                              ▼                       ▼
                                           allowed                 refused
                                                          or sent back to fix
```

| | `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules` | `.memnox/code-fingerprint.yaml` |
|---|---|---|
| **Who reads it** | one agent each, from its own file | every agent Memnox hooks, from one file |
| **How it reaches the agent** | loaded into the model's context | told at session start, and checked on every write |
| **When the agent ignores it** | nothing happens until review | the write is refused before it lands, or sent back to put right |
| **When the agent switches to the shell** | nothing checks it | `cat <<EOF` and `echo` are refused before they run, `perl -pi` and `sed -i` are read after |
| **Where it comes from** | written by hand, sometimes what somebody wished were true | read out of the code by the agent, each check tested against the code before it is kept |
| **When it contradicts the code** | nobody knows | it cannot: a check the code already breaks is dropped, and the reason is said |
| **Who may change it** | anyone, the agent included | a person; an agent records a first one and never changes it |
| **When the team changes agents** | rewrite it for the next one | the same file holds the next one to the same checks |

Keep those files. They are the right place for how you want an agent to work: which
commands to run, how to write a pull request, what to ask before starting. The
fingerprint is for how this repository is actually built, and it is the part that holds.

**Three layers, and each answers a different question:**

```
CLAUDE.md, AGENTS.md, .cursor/rules   "What should I do?"             advice
                 │
                 ▼
code-fingerprint.yaml                 "How is this repository built?"   knowledge
                 │
                 ▼
Memnox rules and fingerprint checks   "What may I change?"              enforcement
                 │
                 ▼
         allow · ask · refuse
```

The same rule at each layer, from the Java backend below:

```
AGENTS.md              Use the Action pattern for database writes.

code-fingerprint.yaml  architecture.writes: every DB write goes through an Action,
                       run via actionFactory.create(X.class).run(params)
                       enforce: writes-only-in-actions

The agent writes       orderRepository.update(...)  in http/OrderResource.java

Memnox                 refused: all database writes go through Actions, which own
                       transactions and event persistence.
                       Instead: call actionFactory.create(XAction.class).run(params)
```

The first is advice, the second is knowledge, and the third is what actually stops it.

Two limits, said plainly. Only the `enforce` checks are checked; everything else in the
file is told to the agent at the start of a session, which is still more than a file it
may never open. And a fingerprint check refuses rather than asks, because it describes
what the code already does. A rule your team decides on purpose, rather than reads out of
the code, belongs in your Memnox rules (`memnox protect`), where it can ask a person
instead. That keeps a habit the code happens to have apart from a decision somebody made.

### Recorded once, by the agent you already run

A session in a repository with no fingerprint says so on your screen:

```
SessionStart:startup says: Memnox: this repository has no code fingerprint yet. Type /fingerprint to record it now, or the agent records one before its first change here.
```

Type the command `setup` put into your agent, or just ask for a change: the first write of
the session is held until the agent has read the code and recorded one. Memnox calls no
model of its own.

| Agent | Type | Written to |
|---|---|---|
| Claude Code | `/fingerprint` | `~/.claude/commands/fingerprint.md` |
| Codex | `/prompts:fingerprint` | `~/.codex/prompts/fingerprint.md` |
| Gemini CLI | `/fingerprint` | `~/.gemini/commands/fingerprint.toml` |
| Cursor | `/fingerprint` | `~/.cursor/commands/fingerprint.md` |
| Windsurf | `/fingerprint` | `~/.codeium/windsurf/global_workflows/fingerprint.md` |

Each is written only where that agent has the `memnox-session` tools, never over a command
of the same name you wrote, and taken out with the tools.

The result is `.memnox/code-fingerprint.yaml`, a page a newcomer could work from alone:
the stack and layout, which layer may call which, the steps to add a feature end to end,
naming, errors, time and nulls, testing, and the commands to build and test. Under
`enforce` it names the checks a machine runs on every line an agent adds. Every check is
tested against your code before it is kept: one your code already breaks, or one that
covers no file, is dropped with the reason, so what is enforced is what the code already
does. It is yours to review and commit, and only a person changes it afterwards.

### Every check holds however the agent writes

A real shape, from a Java backend where every database write goes through an Action:

```yaml
enforce:
  - name: writes-only-in-actions
    files: ["app/src/main/java/com/acme/shop/http/**", "app/src/main/java/com/acme/shop/service/**"]
    forbid: ["*Repository.update(*", "*Repository.add(*", "*Repository.delete(*"]
    reason: all database writes go through Actions, which own transactions and event persistence
    instead: call actionFactory.create(XAction.class).run(params)
```

Asked to let a customer cancel an order, an agent in a hurry writes
`orderRepository.update(...)` straight into the HTTP resource. It is caught three
ways:

| How the agent writes it | What Memnox does |
|---|---|
| The edit tool | Refused before it is written, with the reason and the `instead` |
| A shell line that shows its text: `cat >> Resource.java <<EOF`, `echo`, `printf`, `tee` | Refused before it runs, with the same message |
| A shell line that does not: `perl -pi`, `sed -i`, a script | Read after it runs, and the agent is told in the same turn to put it right; Windsurf, which reads nothing back after a tool, has its next call refused with the same words |

```
Memnox: that command added lines this repository's code fingerprint forbids. A shell edit is held to the same checks as an edit, so put these right now, before going on:
- writes-only-in-actions: all database writes go through Actions. 1 line(s), first in app/src/main/java/com/acme/shop/http/OrderResource.java. Instead: call actionFactory.create(XAction.class).run(params).
```

That last row is what makes a check real rather than a suggestion: switching from the
edit tool to the shell, which agents do all the time, no longer walks around it. What a
command wrote is read from a git tree kept through an index of its own, so your index,
your staging and your stash are never touched.

## What your agents can reach, before you decide anything

Curious what is at stake before you set anything up? One command reads the agent configs
on your laptop, asks each MCP server what it holds, and prints what is reachable from
where. It changes nothing and needs no account:

```sh
npx memnox
```

On most machines one line is a surprise. This is a real laptop, with the home directory
shortened to `~`:

```
memnox scan

On this machine
agents       claude-code, claude-desktop, cursor, codex-cli, hermes
harnesses    hermes  1 principal
             hermes: no roles defined yet
mcp clients  cursor, codex-cli, hermes
mcp servers  next-devtools, node_repl, computer-use, memnox
tools        git, docker, kubectl, psql, mongosh, gh, railway, npm

Credentials these agents can read
!  ~/.ssh/id_ed25519       4 agents
!  ~/.config/gh/hosts.yml  4 agents
   github.com
!  ~/.railway/config.json  4 agents
!  ~/.docker/config.json   4 agents
!  ~/.npmrc                4 agents

What they can do with them, through a shell
!  docker   can push images to your registries · 2 destructive
!  gh       can merge pull requests and delete branches · 12 destructive
   github.com
!  railway  can deploy · 5 destructive
!  npm      can publish packages · 1 destructive

Reachable from an agent right now
!  ~/.ssh/id_ed25519      4 agents
!  ~/.docker/config.json  4 agents
!  ~/.npmrc               4 agents
!  /var/run/docker.sock   4 agents
!  network                5 agents
   unrestricted

14 execution surfaces.
135 capabilities can change something outside this laptop.
102 of them are governed by a policy.
```

Nobody granted that. It accumulated.

It knows Claude Code, Claude Desktop, Cursor, Codex, Cline, VS Code, and the three
harnesses that run other agents: **Hermes**, **OpenClaw** and **Ruflo**. Those three route
work, define roles, install hooks and, in two cases, hand work to machines you are not
looking at, so one row on the roster is several principals at the seam:

```
On this machine
agents       hermes, ruflo
harnesses    hermes, ruflo  3 principals
             hermes: no roles defined yet
             ruflo: 2 roles · runs claude-code
definitions  2 installed into claude-code
             2 of them declare no tools, so each inherits every tool in the session
mcp clients  hermes  3 tools
mcp servers  crm
             1 more hidden by the host's own filter, so it is not counted here

Combined capability, where no single tool does this
!  hermes: customer data can leave, in one session
   crm.read_customer → crm.create_customer_export → crm.send_customer_report

  Each of these tools is ordinary. Holding all of them is the path.
```

Every tool in that chain is ordinary and passes review on its own. Holding all three is a
path, and a per-call allow-list is not shaped to notice it. Memnox does not replace what
the harnesses enforce; what none of them can see is the other two, the credentials on the
disk underneath, and the shell all three share. [Harnesses](docs/harnesses.md) is the
whole story.

## When you want the terminal

Nothing below is needed day to day. It is here for when you want to look, tune or hand
more over.

**Start in observe.** A tool that denies something important on its first day gets
uninstalled on its first day. Observe records the real verdict and applies nothing, and
you switch when the verdicts look right:

```sh
memnox timeline                # what happened, and what would have been refused
memnox protect --enforce       # when the verdicts look right
```

**Tune the rules.** Every refusal names a way forward:

```sh
memnox protect                 # propose reversible steps; changes nothing
memnox protect --apply         # write them; the undo is printed first
memnox policy test "git push --force origin main"
```

```
git push --force origin main
verdict     DENY
reason      you chose to deny this: it rewrites history somebody else may already have pulled
rule        git-deny
instead     push a branch and open a PR

DENY  git push --force origin main
Nothing was run, and nothing on this machine changed.
```

An agent told only "no" abandons the task. One told what to use instead finishes it.

**Leave it running.** The point of a boundary is not that it refuses things. It is that
you can walk away. An `ask` rule holds the call for a person, and you can answer from
anywhere; five similar calls are one decision:

```sh
memnox approvals               # what is waiting, grouped
memnox approve <id> --group
```

The breaker watches outcomes, not requests: the same command failing the same way five
times, eight failures with nothing succeeding between them, an action count far past what
the task estimated, or work outside what was asked for. A pause names the count that
produced it and can always be lifted, because a stop nobody can argue with is one people
work around by uninstalling.

```sh
memnox paused                  # a loop the breaker stopped, and how to lift it
memnox budget                  # what is left in the window
memnox lock --list             # who holds which path
memnox run --task "fix checkout" --paths 'src/checkout/**' -- claude
```

**Hand over more.** `memnox next` reads what you have already approved and names the
things you have said yes to often enough that being asked again is the tool wasting your
attention. One refusal stops a recommendation, and destructive or outward actions never
rise past supervised however routine they became. It prints counts, never hours.

**On a server**, nothing starts an agent through a shell profile, so Memnox prints the
lines a unit file or a container needs:

```sh
memnox env --format systemd
memnox env --format docker
```

With a workspace (`memnox login`), a question raised on a box nobody can reach travels up
on the heartbeat and the answer comes back on the next one. Leases and budgets are counted
across the fleet, and when the control plane cannot be reached each degrades to the local
answer rather than blocking work.

**The handful worth knowing:**

```sh
memnox status     # where this machine stands
memnox rewind     # undo what an agent did to your files
memnox doctor     # check the wiring, and prove it holds
memnox stop       # turn protection off on purpose and on the record, e.g. --for 30m
memnox start      # turn it back on, in the mode it was stopped in
memnox update     # the latest version, with the wiring pointed at it
```

`memnox help --all` lists every command.

## Three promises

**No model decides anything.** Every verdict comes from a rule table and a matcher.
A model is not consulted, so a prompt cannot talk one around.

**A secret value never leaves the process that read it.** What is stored is a path, a
kind and a fingerprint. The event schema refuses a digest field long enough to be a
payload.

**It comes off cleanly.** `memnox uninstall` removes the interceptors, the hooks and
the wrapping. `--purge` takes the history and rules too. A tool that cannot be removed
is one people never install.

## Documentation

- [Quickstart](docs/quickstart.md)
- [Commands](docs/commands.md): every command and flag
- [Harnesses](docs/harnesses.md): Hermes, OpenClaw, Ruflo, and combined capability
- [Policies](docs/policies.md): the rule file
- [Risk bands](docs/risk-bands.md): how a band is decided, rule by rule
- [Event schema](docs/event-schema.md): the frozen v1 row
- [Threat model](docs/threat-model.md), including where it would fail
- [FAQ](docs/faq.md), starting with "does it call an LLM?" (no)
- [Architecture](ARCHITECTURE.md): how the code is put together

## What it deliberately does not do

No code review. No risk score, because a single number is unarguable, and an unarguable
number is one nobody acts on. There are counts by severity and a band that names every
rule that fired.

Memnox rules on an action an agent says it intends to take. It does not do the work,
and it has no opinion about yours beyond what your repository already does.

## Contributing

[ARCHITECTURE.md](ARCHITECTURE.md) is the map: four packages, one direction of
dependency, and one path every decision travels down. It ends with a table of where
to make each kind of change.

[CONTRIBUTING.md](CONTRIBUTING.md) is how a change lands. Every change ships with a
test, and `pnpm format && pnpm typecheck && pnpm test && pnpm deadcode` has to pass.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
