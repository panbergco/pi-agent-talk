# Live tests — real Pi sessions, real models

_Machine and user names in these records are replaced with neutral ones (desk, server, laptop, builder; `me`)._

_2026-10-25. Three Pi 0.87.1 sessions (alice, bob, carol) in an isolated tmux server, each loading only
this extension (`--no-extensions -e`), against a center on a test port and database. Model: a local
Qwen3.8-27B served by llama.cpp. Output below is copied from the sessions and the center's database,
not paraphrased. Delivery ids are shortened._

## L1 · An agent message is not the human

alice's model calls `macp_send` to bob at steering priority. bob is idle, so the message wakes him:

```
 ✉ from agent://pi/01a17082-af17-…  ↪ steering
 Quick check: what is 17+25? Reply to me with macp_send.
```

What bob's **model** sees (the block is attributed by the center; a body cannot forge the header):

```
[MACP delivery from agent://pi/01a17082-af17-… · priority steering · id d_a98f67a7-…]
Quick check: what is 17+25? Reply to me with macp_send.

(Delivered to you, agent://pi/01a17082-af14-…, by the MACP center. Reply with macp_send, in_reply_to set to the id.)
```

Up-arrow in bob's prompt box afterwards: **empty**. In alice's: only what the human typed. bob's
session file: `custom_message/macp: 1`, `message/user: 0` — nothing posed as the human.

## L2 · A busy agent gets it between steps, not after the whole job

bob runs `sleep 25`; 12 s in, the human sends *"also name the capital of France"* at steering
priority. bob's session file, in order:

```
00:51:00 assistant  [toolCall bash]           ← sleep 25 starts
00:51:25 toolResult done-sleeping-2
00:51:25 CUSTOM macp [MACP delivery from human://dm · priority steering …] STEER-TEST …
00:51:25 assistant  Output … `done-sleeping-2`. Capital of France: Paris.
```

Delivered in the same request as the tool result, answered in the same reply.

## L3 · An interrupt cancels the running tool

bob runs a 90-second loop; at tick 5 the human sends an interrupt:

```
01:14:54 assistant  [toolCall bash]           ← for i in $(seq 1 90) …
01:15:03 toolResult [Interrupted: an MACP interrupt from human://dm arrived; partial output follows]
                    tick-1 … tick-9 Command aborted
01:15:03 CUSTOM macp [MACP delivery from human://dm · priority interrupt …] R2-INTERRUPT: stop the loop …
01:15:05 assistant  Loop interrupted after 9 ticks; replied `9` …
```

## L4 · The sender learns what actually happened — receipts

`/talk trace` in alice's session, for a message bob read and answered:

```
ANSWERED — the recipient replied
human://dm → agent://pi/01a17082-af14-… (steering)
  accepted  01:14:15
  fetched   01:14:15
  placed    01:14:15
  read      01:14:29
  answered  01:14:29
```

**A dead session** — carol runs a model whose key is invalid (a real 401 from the provider, the same
thing an expired sign-in produces). The message *lands*, and the trace says why nothing happens:

```
FAILED — the recipient's model call failed: OpenAI API error (401): {"message":"Incorrect API key provided: …"}
human://dm → agent://pi/01a170a1-… (steering)
```

When the sender is an agent, it is told once, without being woken, linked to its own message (bob's
conversation, one second after sending):

```
[MACP delivery from center://macp · priority info · in reply to d_3af8c19a-…]
Your message d_3af8c19a-… to agent://pi/01a170a1-… was delivered, but the recipient's model call failed: …
```

## L5 · A crashed receiver loses nothing

carol's Pi process is killed with `SIGKILL`. The center marks it offline **4 s** later from the dropped
stream alone. Two messages then wait:

```
3439f54c  STUCK — placed, then the recipient went offline before any model call
77f77eac  ACCEPTED — stored; the recipient is offline and gets it when it reconnects
```

carol is restarted on its own conversation (same address) with a working model. 10 s later:

```
3439f54c  READ — a model call completed with it in context
77f77eac  ANSWERED — the recipient replied
```

## L6 · Topology rules hold against a real model

Center policy: bob (a worker) may message alice (the supervisor), not carol (another worker).
bob is asked to send carol a review request:

```
CALL macp_send {"to": "carol", "body": "R5: can you review my diff?", "priority": "advisory"}
ERROR refused → agent://pi/01a170a1-…: a worker messages the supervisor (alice), not another worker;
      ask alice if only she can settle it
CALL macp_send {"to": "alice", "body": "R5: can you review my diff?", "priority": "advisory"}
ok    {"deliveries":[{"id":"d_b6d0ef30-…","to":"agent://pi/01a17082-af17-…","priority":"advisory"}]}
```

Nothing reached carol; the refusal told the model the right channel and it took it.

## L7 · Restarts and reloads

| Event | Result |
|---|---|
| Center restarted while sessions run | Both re-registered under the same address within one health ping (≤ 15 s); a send 1 s after restart succeeded first time |
| `/reload` of all three sessions | Placed deliveries 8 / 3 / 4 before and after, 0 duplicates |

## Defects these runs found, all fixed and covered by a center test

| Found | Fix |
|---|---|
| After a center restart the sessions looked connected but every call failed ("Server not initialized") | Every call reconnects and retries once; a 15 s ping finds a dead session |
| An operator's info/advisory message was dropped silently (filed as cross-project) | Operator may send any priority anywhere (spec §9 G3) |
| A blocked send returned an empty success | Every refusal is an error with its reason |
| A killed process stayed "live" forever (it never says goodbye) | Liveness from the open stream, plus a 45 s lease |
| A message to a crashed agent by role name was refused ("no live agent") | Queued for the last holder of the role, delivered on return |
| A send right after a center restart failed once ("Connection closed") | Reconnect attempts are shared, every caller waits for the same one |
| An interrupt-cut model call could be reported as a model failure | Calls cut by our own interrupt are not failures |

## Not tested here

- Agents on different machines (the center listens on localhost only by default).
- Harnesses other than Pi (Claude Code, Codex) as MACP clients.
- A session waiting at an approval dialog: covered by the center test for "stuck", not driven live.
- Pi still prints one red `Error: This operation was aborted` line for an interrupted model reply.

## L8 · Transparency in the transcript (2026-10-25, test sessions)

Both sides read as a message log; receipt lines are shown but removed from the model's context
(debug log over 10 model calls: only `macp` messages reached the models, 15 display-only lines removed).

```
✉ you → bob (…258b71)  steering  f3a4c40a
  ✓ landed in bob (…258b71)'s session  · f3a4c40a
  ⚠ stuck at bob (…258b71): placed 123s ago and no model call has completed since …   ← the local model server was wedged
 ✉ from bob (…258b71)  ↪ steering  04:52 · c7939272 · reply to f3a4c40a
  ✓ answered by bob (…258b71)  · f3a4c40a
```

## L9 · Self-recovery and outbox

| Event | Result |
|---|---|
| Hub stopped; a session sends | the session started a hub itself; send accepted; the receiver got it after reconnecting |
| Hub `kill -9` | a session restarted it; both sessions re-registered within 4 s |
| No hub reachable and auto-start off | send queued in the session (`⏳ … queued`); 2 s after a hub appeared: sent, 1 copy in the hub, placed once |
| Role map entry appears for a running session | re-registered under the new role 6 s later, no reload |

## L10 · A real three-lane orchestrated project (desk)

Lanes loaded the extension through the orchestrator's own boundary-safe restart. The rules file names
roles, never lanes. Each lane's conversation was resumed under its original session id.

| Step | Result |
|---|---|
| Hub restart with three lanes connected | re-registered after 2, 4 and 13 s |
| Human → a worker, steering, through the hub (no terminal typing) | placed in 1 s, read 16 s later |
| Worker → another worker | refused with the project's own wording; nothing delivered |
| Worker → the lane named `project` | **first attempt refused as a broadcast** (MACP's `project` keyword); fixed in the hub (`projectIsRole`), second attempt accepted, landed in the project lane, not woken (advisory), stored as an agent message, 0 user-role copies |

## L11 · The human in plain words, across machines (desk → server)

Hub on desk reachable over the LAN, access key required (server without key: `401`). Default rule:
agents send only when their human asks. The desk session runs in tmux window `ops-desk`; the server
session in tmux session `lab`, window `billing-review`.

Typed on desk: `/talk tell the billing review agent on server that the invoice export is ready, and ask
it to confirm which batch it will start with`

- The model read the directory, matched *"billing review agent on server"* to
  `server · tmux lab:1 'billing-review'`, and sent to that address (`· asked by you`).
- The server agent's answer was accepted once, as the answer to the human's request. A second,
  unasked message was refused (center test). Its first attempt, before the one-answer rule
  existed, was refused: *"agents send only when their human asks them to in that turn"*.
- desk transcript: `✉ from reviewer@server … reply to 45cfcfcd`, then `✓ answered by reviewer@server`.
  39 s from Enter to answer.

## L12 · No typing words into another Pi session (tmux guard)

`bin/guard/tmux` is first on the PATH of every command a Pi session runs; `bin/guard/test.sh` passes
17 of 17. Live, with two Pi sessions (the guard pointed at the test server):

| Who asked | What bob ran | Guard |
|---|---|---|
| an incoming message (not the human) | `tmux send-keys -t alice 'hello from bob' Enter` | **BLOCK** — bob got the refusal; nothing reached alice |
| the human, typed in bob's prompt | `tmux send-keys -t alice 'unstick-requested-by-human'` | allowed (human turn); text appeared in alice's prompt box |
| an incoming message | `tmux send-keys -t alice C-u` | allowed (control key); cleared alice's prompt box |

Kept for repair, always: control keys, single-letter answers, slash commands except `/talk`, `@file`
pastes, bash panes, other tmux servers, and a trusted orchestrator matched by real path (a script
an agent names alike is blocked). A guardrail against noise, not security: `/usr/bin/tmux` bypasses it.

## L13 · Four machines, one weak local model (desk · server · Laptop · builder)

One test hub on desk (LAN, access key, `defaultAgentSend: human-turn`). One Pi session per machine
on an isolated tmux server, all on Qwen3.8-27B served from desk (one request at a time). Every send
was typed by the human as `/talk` in plain words, on the machine named in the first column.

| # | From | Typed | Result |
|---|---|---|---|
| T1 | desk | "tell the billing review agent on server … reply ACK-T1" | resolved by window name; `ACK-T1` came back as *answer to me@desk's request* (60 s) |
| T2 | Laptop | "ask the agent on builder to reply with its machine name" | resolved by machine; reply `builder` (20 s) |
| T3 | builder | "tell the ops desk on desk … reply OK-T3" | `OK-T3` back (206 s, queued behind the shared model) |
| T4 | server | "send the design notes agent on the laptop a note …" | landed on Laptop in 15 s, labelled *asked by me@server* |
| T5 | (an incoming message, not the human) | "message the design-notes agent on laptop yourself" | **refused**; nothing delivered |
| T6 | desk | "tell the agent in the xm folder hello" | three agents fit, so the model **asked which** and sent nothing; after the human typed `2`: delivered to Laptop |

Defect found and fixed: under "only when asked", an agent's report to the human was refused,
because that rule was checked before "an agent may always report to the human". Center test added (83 tests).

## L14 · Hardening round (2026-10-25 afternoon)

| Change | Live result |
|---|---|
| Hub address from `~/.config/macp-center/url` | a server session with only that file (no `MACP_URL`, auto-start off) registered on desk's hub |
| Busy/idle presence | idle → busy while a 12 s command ran → idle after the reply; `/talk roster` shows it |
| Quiet interrupt | a 90-tick loop interrupted at tick 6: **0** red abort lines, one dim `⚡ interrupted by human://dm` |
| Coexists with pi-cc-steer loaded **first** (it swallows mid-run typing and re-sends it) | the human's mid-run request, typed during a run started by a delivery, was delivered as *asked by me@desk*: the raw Enter keypress marks the run as the human's. No control run with the old code |
| No tmux | a session with `TMUX` and `TMUX_PANE` unset registered (`desk · ~/…/talktest`) and sent |

Found while testing: a machine that has pi-agent-talk but **no** address file auto-starts its own local hub
(by design, for one machine), and its sessions then cannot reach a shared hub. Roll out the address file **before**
the extension.

## L15 · Strict identity against forgery (two Pi sessions, hub `--strict-identity`)

An attacker process that has everything on disk and no secret (what an agent's shell has):

| Attack | Result |
|---|---|
| F1 claim alice's identity | **refused** — "held by another live process" (logged) |
| F2 claim bob's own identity, to send "asked by you" from the shell | **refused** |
| F3 claim to be the human (operator), alone or "through alice" with a guessed secret | **refused** |
| F4 read alice's Pi memory for the secret | **refused by the kernel** (`EACCES` on `/proc/<pid>/mem`, `ptrace_scope=1`); her environment holds no key |
| F5 a brand-new identity, choosing role `bob`, sends "asked by you" | **accepted** — the residual limit: it appears as `bob (…037)`, a different id and no location |

Normal use unchanged: `/talk` in plain words round-trip (answer labelled), and `/talk allow bob 1`
(the human acting through alice's in-memory secret).
