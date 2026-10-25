# Agent-to-agent messaging for Pi — four systems and pi-agent-talk, side by side

_2026-10-25. Method: the decompose skill — every source read before judging, one row per checkable
capability, a closed verdict set, counts produced by a command._

**Question per row: does this system deliver the capability?**

| Mark | Meaning |
|---|---|
| ✅ | Yes — in the code read (others), or measured in a live run or test (pi-agent-talk) |
| 🟡 | Partly, or only in some cases — the note says which |
| ❌ | No |
| ➖ | Not applicable to that system's purpose |
| ❔ | Not determined from the code read |

## Sources

| Column | System | Version read | What was read |
|---|---|---|---|
| **TTEO** | [pi-agents-talk-to-each-other](https://github.com/Timur00Kh/pi-agents-talk-to-each-other) | `e4f162a` | README, `extensions/agent-room/index.ts` (1,443 lines) |
| **AC** | [pi-agent-comm](https://github.com/nishshukladev/pi-agent-comm) | `4b6f572` | README, `extensions/agent-comm.ts`, all 7 `src/*.ts` |
| **AS** | [pi-actor-subagents](https://github.com/fdietze/pi-actor-subagents) | `822a228` | README, DESIGN, AGENTS, and 16 modules: index, engine, spawner, agent-tools, agent-message(+renderer), authorize, spawn-tree, lifecycle-notice, agent-status, agent-record, settings, persistence(+logic), agent-system-prompt, resolve-model |
| **OMP** | [oh-my-pi](https://github.com/can1357/oh-my-pi) agent messaging ("IRC") | `0b5c27a` | `docs/agent-hub.md`, `docs/collab.md`, `src/irc/bus.ts`, `src/irc/messaging.ts`, `registry/agent-registry.ts` (`listVisibleTo`), `session/agent-session.ts` (IRC delivery API), prompts `irc-incoming.md`, `parent-irc.md`, `internal-urls/agent.md` |
| **PAT** | **pi-agent-talk** (this repo), MACP 2.0 binding | this repo | `src/index.ts`, `center/src/*`; evidence = [LIVE-TESTS.md](LIVE-TESTS.md) (L1–L7) and the center tests (`npm test` in `center/`) |

Spec: [MACP 2.0](https://github.com/multiagentcognition/macp/blob/main/spec/MACP-2.0.md) (2.0.0-draft.1).

**Not read, so not judged:** the three extensions' test files and UI modules (AS: panel, roster widget,
feed, transcript-document, tool-preview, timestamps…; behaviour taken from DESIGN/README); OMP's
task executor, `agent-session.ts` IRC internals (`#irc` controller), Collab host/guest source, and its
interactive history code. Rows that depend on them are ❔.

## 1 · Entering the receiver — four of five keep agent messages out of the human's input

| ID | Capability | TTEO | AC | AS | OMP | PAT |
|---|---|---|---|---|---|---|
| 1.1 | Enters as a custom message, not as user input | ❌ `sendUserMessage` | ✅ `agent-comm` | ✅ `agent-message` | ✅ `<irc>` block | ✅ `macp` (L1) |
| 1.2 | Never typed into the prompt box or terminal | ✅ | ✅ | ✅ | ✅ | ✅ |
| 1.3 | Stays out of the human's Up-arrow history | ❌ user role | ✅ | ✅ | ❔ history code not read | ✅ Up-arrow empty (L1) |
| 1.4 | Drawn distinctly in the transcript | ❌ plain header | 🟡 custom type, no renderer | ✅ boxed "from …" | ✅ IRC cards + main-UI relay | ✅ `✉ from … ↪ steering` (L1) |
| 1.5 | Sender named in the text the model sees | ✅ | ✅ `[[AGENT-COMM]]` | ✅ `[message from x]` | ✅ "from agent `x`" | ✅ center-stamped header (L1) |
| 1.6 | Arrivals coalesced into one injection | ❌ | ❌ | ✅ | ❔ | ✅ one block per drain (code; not driven live) |
| 1.7 | No per-turn system-prompt rewrite (prompt cache) | ✅ | ❌ guidance every turn | ✅ fixed at spawn | ❔ | ✅ guidelines fixed at load |

## 2 · Receiver state — only pi-agent-talk has priorities, so only it can stay quiet or cut in

| ID | Capability | TTEO | AC | AS | OMP | PAT |
|---|---|---|---|---|---|---|
| 2.1 | Busy receiver gets it before its next model call | 🟡 if sender picks steer | ❌ waits for run end | ✅ | ✅ "aside at next step boundary" | ✅ same request as the tool result (L2) |
| 2.2 | Idle receiver is woken | ✅ | ✅ | ✅ | ✅ | ✅ (L1) |
| 2.3 | Low-priority messages never wake an idle agent | ❌ | ❌ | 🟡 lifecycle notices only | ❌ no priorities | ✅ info/advisory (L5: placed, no model call) |
| 2.4 | Interrupt: cancel the running tool, then deliver | 🟡 separate abort control | ❌ | 🟡 pause aborts, send separately | 🟡 cuts a `wait` only | ✅ loop cut at tick 9, partial output kept (L3) |
| 2.5 | Sender can see whether the receiver is idle or busy | ✅ heartbeat | ✅ busy flag | ✅ | ✅ running/idle/parked | 🟡 live/offline only |
| 2.6 | Unavailable receiver: message held, not lost | ❌ | ❌ | ✅ paused inbox | ✅ parked agent revived | ✅ queued while crashed (L5) |

## 3 · Identity — all but one survive a restart

| ID | Capability | TTEO | AC | AS | OMP | PAT |
|---|---|---|---|---|---|---|
| 3.1 | Stable identity across restart | ❌ host-pid | ✅ session hash | ✅ name + roster | ✅ persisted roster | ✅ same address after restart (L5) |
| 3.2 | Human-readable names or roles | ❌ | ✅ auto-naming | ✅ | ✅ ids/display names | ✅ `role:` |
| 3.3 | Roster of agents | ✅ | ✅ | ✅ | ✅ Agent Hub | ✅ `macp_roster`, `/talk roster` |
| 3.4 | Scoped to project or repository | 🟡 manual rooms | 🟡 git neighbours | ➖ one swarm | ➖ one session tree | ✅ explicit project or repo identity |
| 3.5 | Broadcast or role targeting | ❌ | ❌ | 🟡 multicast list | 🟡 `agent://all` only | ✅ `project`, `role:` (center tests) |

## 4 · Reliability — only pi-agent-talk tells the sender whether a model actually read it

| ID | Capability | TTEO | AC | AS | OMP | PAT |
|---|---|---|---|---|---|---|
| 4.1 | Durable until read or acknowledged | ❌ deleted on read | 🟡 asks in session file | ❌ in memory | ❌ in-memory mailbox, cap 100, oldest dropped | ✅ SQLite until read/ack |
| 4.2 | Never delivered twice | 🟡 | ✅ settle-once | ✅ | ✅ | ✅ 0 duplicates after 3 reloads (L7) |
| 4.3 | Reaches a receiver that crashes and restarts | ❌ id changes | 🟡 owed asks re-injected | 🟡 restored paused, buffers lost | 🟡 parked revived; buffered mail lost on exit | ✅ `SIGKILL`, restart, both read (L5) |
| 4.4 | Delivery receipt (landed in the session) | ❌ | 🟡 answer resolves ask | 🟡 activity seen within 3 s | ✅ injected / woken / revived / failed | ✅ placed (L4) |
| 4.5 | Reply correlation | ❌ | ✅ thread id | ❌ | ✅ `replyTo` | ✅ `in_reply_to` → answered (L4) |
| 4.6 | Sender learns a model call actually read it | ❌ | ❌ | 🟡 "activity is not receipt" | ❌ "not what they did with it" | ✅ read (L4) |
| 4.7 | Sender learns the receiver's model is failing | ❌ | ❌ | 🟡 child error → parent | ❔ | ✅ provider's 401 in the trace + one notice (L4) |

## 5 · Authority — only pi-agent-talk enforces who may message whom

| ID | Capability | TTEO | AC | AS | OMP | PAT |
|---|---|---|---|---|---|---|
| 5.1 | Sender identity cannot be forged by an agent | ❌ any writer | 🟡 markers sanitised | ✅ bound at tool creation | ✅ bound `senderId` | ✅ connection identity; body cannot forge header |
| 5.2 | Steering or interrupting another needs permission | 🟡 control flag | ❌ | 🟡 pause/kill only; messages steer anyone¹ | ❌ | ✅ default deny → downgraded (center tests) |
| 5.3 | The human outranks agents | 🟡 `/room control` | ❌ | ✅ `user` actor | ✅ Hub steer/kill | ✅ operator, any priority (center tests) |
| 5.4 | Loop or rate limits | ❌ | ✅ 3/thread, 10/10 min | 🟡 agent/depth caps | ❔ | ❌ not built |
| 5.5 | Audit log of every send and receipt | 🟡 events.jsonl | ❌ | ❌ | 🟡 Hub activity log | ✅ `audit` table |
| 5.6 | Model told peers carry no human authority | ❌ | ✅ | 🟡 | ❔ | ✅ guideline A2 |
| 5.7 | Topology rules: e.g. workers reach the supervisor, never each other | ❌ | ❌ | ❌ any → any | ❌ any visible peer | ✅ refused with the right channel (L6) |

¹ Corrected 2026-10-25: the first version rated AS ✅ here. `engine.route()` checks no authority; only
pause/resume/kill call `authorize()`.

## 6 · Reach — only pi-agent-talk links separate Pi processes and can grow past one machine

| ID | Capability | TTEO | AC | AS | OMP | PAT |
|---|---|---|---|---|---|---|
| 6.1 | Separate Pi processes / tmux windows on one machine | ✅ | ✅ | ❌ in-process | ❌ process-global bus² | ✅ three processes (L1–L7) |
| 6.2 | Agents on other machines | ❌ | ❌ | ❌ | ❌² | 🟡 spec allows; localhost by default, untested |
| 6.3 | Other harnesses (Claude Code, Codex…) | ❌ | ❌ | ❌ | ❌ | 🟡 any MCP client; untested |
| 6.4 | Works without a background service | ✅ | ✅ | ✅ | ✅ | ❌ needs the center |

² OMP's Collab shares a whole session with remote **humans** over an encrypted relay; a guest's prompt
reaches the model "verbatim — names are display-only". It is session sharing, not agent messaging.

## 7 · Orchestration — outside messaging, so outside pi-agent-talk

| ID | Capability | TTEO | AC | AS | OMP | PAT |
|---|---|---|---|---|---|---|
| 7.1 | Spawn new agents | ❌ | ❌ | ✅ | ✅ task tool | ➖ |
| 7.2 | Pause / resume / kill others | 🟡 abort, compact | ❌ | ✅ | ✅ kill, revive | ➖ |
| 7.3 | Read another agent's history | ✅ | ✅ | ✅ | ✅ `history://` | ➖ |
| 7.4 | Instant no-model snapshot of a peer | ❌ | ✅ | ❌ | 🟡 `agent://` status | ➖ |

## Tally

40 rows × 5 systems, counted with `grep -E '^\| [0-9]\.[0-9]+ ' docs/SURVEY.md` and a cell parser.

| System | ✅ | 🟡 | ❌ | ➖ | ❔ |
|---|---|---|---|---|---|
| TTEO | 9 | 8 | 23 | 0 | 0 |
| AC | 17 | 6 | 17 | 0 | 0 |
| AS | 21 | 10 | 8 | 1 | 0 |
| OMP | 20 | 5 | 8 | 1 | 6 |
| PAT | 31 | 3 | 2 | 4 | 0 |

## Pattern

The fault that started this work — another agent's message arriving as if the human typed it — is
in group 1, and three of four systems already avoid it. What none of them has is in groups 2, 4 and 5:
**priorities** (stay quiet, or cut in), **knowing whether the message was actually read** (and why
not), and **rules about who may message whom**. Those are what pi-agent-talk adds, each measured live.
Its costs are a background service (6.4), no rate limits yet (5.4), and no busy flag in the roster (2.5).

## What pi-agent-talk takes from each

| From | Adopted | Rows |
|---|---|---|
| actor-subagents | Custom message with a boxed renderer; coalescing; steer a busy receiver; identity bound outside the model | 1.1, 1.4, 1.6, 2.1, 5.1 |
| oh-my-pi | Delivery outcome in the send result; wake idle, aside when busy; reply correlation | 4.4, 2.1, 4.5 |
| pi-agent-comm | Body cannot forge the header; trust framing for peer claims | 5.1, 5.6 |
| pi-cc-steer | Mid-task framing ("finish the step you are on, then address it"); interrupted tool reads as a hand-off with partial output | 2.1, 2.4 |
| pi-agents-talk-to-each-other | Roster status per agent (busy flag not yet built) | 2.5 |

Rejected: per-turn system-prompt rewrite (AC — breaks the prompt cache, MACP §1.1); delete-on-read
(TTEO); user-role delivery (TTEO); typing into terminals (tmux `send-keys` bridges); capped in-memory
mailboxes that drop the oldest (OMP).

## Reconciliation

Every row cites code read or a test run. Each source maps to rows as follows:

| Source | Rows it informs |
|---|---|
| TTEO index.ts (rooms, heartbeat, delivery, controls, history tools) | 1.1–1.5, 2.1–2.6, 3.1–3.5, 4.1–4.4, 5.1–5.5, 6.1, 7.2–7.3 |
| AC agent-comm.ts + src (registry, transport, protocol, identity, summary) | 1.1–1.7, 2.1–2.2, 3.1–3.4, 4.1–4.5, 5.1, 5.4, 5.6, 6.1, 7.3–7.4 |
| AS engine, agent-tools, authorize, spawn-tree, persistence, prompts | 1.1–1.7, 2.1–2.6, 3.1–3.5, 4.1–4.7, 5.1–5.7, 6.1, 7.1–7.3 |
| OMP irc/bus.ts, irc/messaging.ts, registry, agent-hub.md, collab.md, prompts | 1.1–1.5, 2.1–2.6, 3.1–3.5, 4.1–4.6, 5.1–5.3, 5.5, 5.7, 6.1–6.2, 7.1–7.4 |
| PAT src, center, LIVE-TESTS L1–L7, center tests | every row |
