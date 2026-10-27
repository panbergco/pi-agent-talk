# pi-agent-talk

> **No longer maintained (2026-10-27).** This package receives no further updates or fixes. Please do not use it for new setups.

**Pi agents that message each other the way a team should: attributed, never posing as the human,
at the right moment, under rules about who may talk to whom, and with proof that the message was
actually read.**

pi-agent-talk is a [Pi](https://pi.dev) extension plus a small local hub, implementing
[MACP 2.0](https://github.com/multiagentcognition/macp/blob/main/spec/MACP-2.0.md), the Multi-Agent
Cognition Protocol: an open, MCP-based protocol for messaging between running coding agents.

## Why another one

Most ways of getting one agent to tell another something either **type into its terminal** or **send
a user message**. Both make the message look exactly like the human typed it: it lands in the human's
Up-arrow history, carries the human's authority, and the sender never learns whether anything
happened. We compared four systems capability by capability ([docs/SURVEY.md](docs/SURVEY.md), 40
rows):

| | pi-agents-talk-to-each-other | pi-agent-comm | pi-actor-subagents | oh-my-pi IRC | **pi-agent-talk** |
|---|---|---|---|---|---|
| Arrives as an agent message, not the human | ❌ | ✅ | ✅ | ✅ | ✅ |
| Separate Pi processes / tmux windows | ✅ | ✅ | ❌ in-process | ❌ in-process | ✅ |
| Low-priority notes never wake an idle agent | ❌ | ❌ | 🟡 | ❌ | ✅ |
| Interrupt cancels the running tool | 🟡 | ❌ | 🟡 | 🟡 | ✅ |
| Durable until read; survives a crash | ❌ | 🟡 | ❌ | ❌ capped, in memory | ✅ |
| Sender learns it was **read**, or **why not** | ❌ | ❌ | 🟡 | ❌ | ✅ |
| Rules: who may message whom | ❌ | ❌ | ❌ | ❌ | ✅ |
| Steering another needs permission | 🟡 | ❌ | 🟡 | ❌ | ✅ |
| **Messaging capabilities delivered (of 36)** | 8 | 15 | 18 | 17 | **31** |

What it costs: a background hub process, and rules and roster files that have to exist on the hub's machine.

## What it looks like — real output

Everything below is copied from live Pi sessions; [docs/LIVE-TESTS.md](docs/LIVE-TESTS.md) has the
full runs.

**A message from another agent**, as the receiving human sees it, and as its model sees it:

```
 ✉ from agent://pi/01a17082-af17-…  ↪ steering
 Quick check: what is 17+25? Reply to me with macp_send.
```
```
[MACP delivery from agent://pi/01a17082-af17-… · priority steering · id d_a98f67a7-…]
Quick check: what is 17+25? Reply to me with macp_send.
```

**It arrives between steps, not after the whole job.** The receiver was 12 s into a 25 s command:

```
00:51:00 assistant  [toolCall bash]           ← sleep 25 starts
00:51:25 toolResult done-sleeping-2
00:51:25 CUSTOM macp [MACP delivery from human://dm · priority steering …] … also name the capital of France
00:51:25 assistant  Output … `done-sleeping-2`. Capital of France: Paris.
```

**An interrupt cuts the running tool:**

```
01:15:03 toolResult [Interrupted: an MACP interrupt from human://dm arrived; partial output follows]
                    tick-1 … tick-9 Command aborted
01:15:05 assistant  Loop interrupted after 9 ticks; replied `9` …
```

**The sender learns what really happened.** Landing in a session is not the same as being read: a
session whose sign-in expired or whose quota ran out accepts the message and then does nothing.

```
/talk trace 5830fffd                          /talk trace 928348aa
ANSWERED — the recipient replied              FAILED — the recipient's model call failed:
  accepted  01:14:15                            OpenAI API error (401): {"message":"Incorrect API key …"}
  fetched   01:14:15
  placed    01:14:15
  read      01:14:29
  answered  01:14:29
```

**A crash loses nothing.** The receiver was killed with `SIGKILL`; the hub noticed in 4 s:

```
3439f54c  STUCK — placed, then the recipient went offline before any model call
77f77eac  ACCEPTED — stored; the recipient is offline and gets it when it reconnects
                    … restarted on its own conversation, 10 s later:
3439f54c  READ — a model call completed with it in context
77f77eac  ANSWERED — the recipient replied
```

**Rules hold against a real model.** A worker tried to message another worker:

```
CALL  macp_send {"to": "carol", "body": "can you review my diff?"}
ERROR refused → agent://pi/01a170a1-…: a worker messages the supervisor (alice), not another worker;
      ask alice if only she can settle it
CALL  macp_send {"to": "alice", "body": "can you review my diff?"}
ok    {"deliveries":[{"id":"d_b6d0ef30-…","priority":"advisory"}]}
```

## How delivery works

| Priority | Receiver busy | Receiver idle | Needs permission |
|---|---|---|---|
| `info`, `advisory` | appended at the end of the current step | appended, **not woken** | no (same project) |
| `steering` | before its next model call, framed as "arrived mid-task" | woken | yes |
| `interrupt` | running tool cancelled (partial output kept), then delivered | woken | yes |

Ungranted steering or interrupt is downgraded to advisory, never refused silently (MACP §9). The
human operator may send any priority anywhere.

**Receipts.** Each message moves through `accepted → fetched → placed → read → answered`. It can
also end in one of two failure states:
- **failed:** the receiver's model call returned an error, and the trace carries the provider's text.
- **stuck:** a waking message has gone 120 s with no completed model call, or the receiver went
  offline after the message was placed.

An agent sender is told once, at `info` priority, when its message fails.

## Install

```bash
pi install npm:pi-agent-talk                          # every Pi session (add -l for this project only)
pi install git:github.com/panbergco/pi-agent-talk     # same thing, straight from the repository
```

Listed in the Pi package gallery: <https://pi.dev/packages/pi-agent-talk>.

That is all. The hub ships compiled. Sessions start a local hub themselves when none is running
(Node 22.13+, for `node:sqlite`). For a permanent hub, use `center/macp-center.service` (systemd user unit).

From a clone, for development: `npm install`, `npm run build` (recompiles `center/dist`), `npm test`.

## Where a session says it is

A session reports the place a human sees it in:

| Terminal | Reported as |
|---|---|
| herdr | `desk · herdr review (w4:p2) · ~/Code/review-project` — herdr's workspace label and pane |
| tmux | `desk · tmux main:2 'billing-review' · ~/Code/billing` |
| neither | `desk · ~/Code/billing` |

`/talk` then takes the human's own words: *"tell the agent in the review workspace …"*, *"the freecad one"*,
*"vanness"*. The directory resolves them to an address and hands that to the model, which composes and sends the
message. The addressing clause decides, never the briefing: "hand over to the reviewer" stays addressed to the
reviewer even when the brief mentions the builder. When two sessions fit equally it says so and the model asks
which — it never picks between them. "Prepare" or "draft" means write it here and wait; nothing is sent.

## Use

The model gets five tools: `macp_send`, `macp_find`, `macp_roster`, `macp_status` and `macp_ack`. The human types:

| Command | Does |
|---|---|
| `/talk` | This session's address, project and hub state |
| `/talk roster` | Agents in the project |
| `/talk send <to> <text> [--steer\|--interrupt\|--info]` | Send as the human; `<to>` is a role name, an address or `project` |
| `/talk trace <id>` | Every stage of a message, with times and the reason it stopped |
| `/talk grant <holder> <subject> <steering\|interrupt>` | Allow agents to steer or interrupt others |

| Variable | Default | Meaning |
|---|---|---|
| `MACP_URL` | `http://127.0.0.1:7737/mcp` | The hub |
| `MACP_ROLE` | session name, else folder name | This agent's role |
| `MACP_PROJECT` | from the git repository | Project name |
| `MACP_OFF=1` | | Disable in this session |

### Roles that change over time

An orchestrator that hands out roles (lanes, workers that come and go) keeps one file, by default
`~/.config/macp-center/roles.json`:

```json
{ "projects": { "/home/me/Code/myproject": "myproject" },
  "sessions": { "<pi session id>": { "role": "reviewer", "project": "myproject" } } }
```

Sessions re-read it every 15 s and re-register when their entry changes, with no reload. A session in a
listed folder belongs to that project, and so falls under its rules, from its first second. Write the
rules by role, never by name, so that a new role needs no edit.

### Talk in plain words

`/talk tell the billing review agent on server the export is ready` — the model looks the agent up
in the directory of every live session, in every project and on every machine. Each session reports its
machine, its place (herdr workspace and pane, or tmux session:window "name"), folder, and Pi session name. If more than one agent
fits, the model asks you which. The message carries your authority and arrives labelled
`(asked by you@host)`. The recipient may answer it **once**, to you.

`/talk allow <role|address|project|everyone> [minutes]` lets agents send on their own;
`/talk deny …` takes that back; `/talk allowed` lists what you have allowed. Set
`"defaultAgentSend": "human-turn"` at the top of the rules file to make "only when asked" the
default for every project.

### Alongside other extensions

An extension that swallows typed input mid-run and re-sends it later (pi-cc-steer, for example) would hide the
human's typing from extensions loaded after it. pi-agent-talk also watches the raw keypress: an Enter during a run
marks that run as the human's, whatever the load order.

### Across machines

Run one hub where every machine can reach it, with an access key: `--host 0.0.0.0` plus
`--token-file`. On every other machine, put the hub's address in `~/.config/macp-center/url` (one line, e.g.
`http://<hub-host>:7737/mcp`) and the key in `~/.config/macp-center/token` (mode 600). `MACP_URL` and
`MACP_TOKEN` override them. Without the key a connection is refused.

### Agents send only when their human asks

`"agentSend": "human-turn"` in a project's rules: an agent's `macp_send` is accepted only in a turn
that its human started by typing. Everything else is refused with `agentSendReason`, which should name
the project's own channel. That covers messages from other agents, mail injected by extensions, and
typed input matching a `notHuman` pattern (e.g. an orchestrator's wake-up knock). The session attests
the turn, never the model. Roles in `agentSendExempt` (an orchestrator) and the human are never bound.

### No typing into another Pi session

Every command a session runs finds `bin/guard/tmux` first on its PATH. An agent that types **words**
into a pane running Pi on the real tmux server is refused, and the refusal names the right channel.
Repair still works:
- control keys and single-letter answers;
- slash commands, except `/talk`;
- `@file` pastes;
- anything typed into bash panes or on other tmux servers;
- a trusted orchestrator (listed in `~/.config/macp-center/orchestrators`);
- anything at all in a turn the human started.

Every attempt is logged to `~/.local/state/pi-agent-talk/tmux-guard.log`. `MACP_TMUX_GUARD=0` turns
it off; `bin/guard/test.sh` tests it.

### Limits

An agent may send at most 30 messages a minute, and two agents at most 20 messages to each other in
10 minutes. Above that the send is refused with the reason, and a loop is told to stop and report. The
human is never limited. Adjust with `"limits": {"perMinute": 30, "pairPer10Min": 20}` at the top of
the rules file.

### From the command line

`bin/macp roster <project>` · `bin/macp send <address> <text> [--steer|--interrupt|--info]` ·
`bin/macp trace <id>`. These act as the human operator, with no Pi session.

### Rules: who may message whom

Start the hub with `--policy rules.json` (re-read whenever the file changes):

```json
{ "projects": { "myproject": {
  "closed": true,
  "closedReason": "a worker messages the supervisor, not another worker",
  "allow": [ { "from": "role:worker",     "to": "role:supervisor", "max": "steering" },
             { "from": "role:supervisor", "to": "role:worker",     "max": "steering" } ],
  "deny":  [ { "from": "role:worker", "to": "role:worker",
               "reason": "a worker messages the supervisor, not another worker" } ],
  "broadcast": ["role:supervisor"],
  "quiet": ["role:worker-paused"]
} } }
```

What the rules give you:
- **Closed project:** nothing is delivered without an `allow` rule; `closedReason` is the refusal text.
- **Steering by rule:** an `allow` rule's `max` grants steering or interrupt with no separate grant.
- **Refusals that teach:** a `deny` refuses with its `reason`, so the model learns the right channel.
- **Broadcast limits:** `broadcast` lists who may message the whole project.
- **Quiet agents:** a role listed under `quiet` is never woken.
- **Fail-safe:** a malformed file keeps the last good rules.

## Security: what holds, what does not

All of this runs as one user account. Within that limit:

- **With `--strict-identity` (recommended):** an identity is locked to the secret of the process that
  holds it. The secret lives only in the Pi process's memory, and on Linux with `ptrace_scope ≥ 1` no
  other process can read it, not even the session's own shell commands. Faking another session, or
  faking "the human asked" in your own name, is refused and logged.
- **The human acts through a live session** (`/talk`), or with an operator key you configure.
- **Does not hold:** a brand-new identity can still claim "the human asked". It shows up as an
  unknown sender with a new id. Any process of the same user can also edit the hub's database
  directly. Real isolation needs agents under a separate user account.
- **Remote hubs need an access key** (`--token-file`); without one a connection is refused.

The tmux guard and "agents send only when asked" are guardrails against noise, not locks.

## Tests

```bash
npm test                   # hub tests and the tmux guard test
cd center && npm test      # 82 tests: protocol (21), rules (24), receipts, crash recovery and retention (23), the human in charge (14)
```

[docs/LIVE-TESTS.md](docs/LIVE-TESTS.md) records the live runs with real Pi sessions.
`node test/live/chaos.mjs` runs N real Pi sessions under message load while killing, freezing and reloading
sessions and the hub, then checks that nothing was lost, doubled or delivered as user input. It also lists
the seven defects those runs found and fixed, and what was **not** tested: other machines, other
harnesses, and a session stuck at an approval dialog (that case is covered only by a hub test).

## Credits

- `center/` is derived from the MACP reference center
  ([multiagentcognition/macp](https://github.com/multiagentcognition/macp) `650046e`, Apache-2.0); see
  `center/NOTICE`.
- The delivery framing follows [pi-cc-steer](https://github.com/panbergco/pi-cc-steer).
- The comparison credits each system it learned from: [docs/SURVEY.md](docs/SURVEY.md).

Licence: Apache-2.0.
