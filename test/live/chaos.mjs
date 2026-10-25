#!/usr/bin/env node
/**
 * Live chaos test: N real Pi sessions on a real model, a driver that keeps giving them messaging work, and faults
 * injected while they run (kill -9 a session, kill -9 the hub, freeze a session, /reload, restart the hub).
 * At the end it checks invariants from the hub's database and every session's conversation file.
 *
 *   node test/live/chaos.mjs [--sessions 5] [--minutes 45] [--model ufo/qwen3.8-27b:low] [--port 7785]
 *
 * Needs tmux and pi. Runs everything on the isolated tmux server `-L pi-harness` and in .scratch/chaos/.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(ROOT, "package.json"));
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg("sessions", 5)), MINUTES = Number(arg("minutes", 45)), MODEL = arg("model", "ufo/qwen3.8-27b:low");
const PORT = Number(arg("port", 7785)), URL_ = `http://127.0.0.1:${PORT}/mcp`;
const DIR = join(ROOT, ".scratch", "chaos"), DB = join(DIR, "hub.db"), POLICY = join(DIR, "policy.json"), LOG = join(DIR, "chaos.log");
const OPKEY = "chaos-operator-" + process.pid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => Math.floor(Math.random() * n);
const log = (s) => { const l = `${new Date().toISOString().slice(11, 19)} ${s}`; console.log(l); appendFileSync(LOG, l + "\n"); };
const tmux = (...a) => spawnSync("tmux", ["-L", "pi-harness", ...a], { encoding: "utf8" });

// ── setup ──────────────────────────────────────────────────────────────────
rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true });
writeFileSync(POLICY, JSON.stringify({ projects: { chaos: { agentSend: "always" } }, limits: { perMinute: 60, pairPer10Min: 200 } }));
const ENV = {
  MACP_URL: URL_, MACP_DB: DB, MACP_POLICY: POLICY, MACP_PROJECT: "chaos", MACP_STRICT_IDENTITY: "1",
  MACP_OPERATOR_TOKEN: OPKEY, MACP_STUCK_SECONDS: "90", MACP_TMUX_GUARD: "0", MACP_ROLES: join(DIR, "no-roles.json"),
};
let hub;
function startHub() {
  hub = spawn(process.execPath, [join(ROOT, "center/dist/index.js"), "--port", String(PORT), "--db", DB, "--policy", POLICY, "--strict-identity"],
    { env: { ...process.env, ...ENV }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  hub.unref();
}
const hubPid = () => { const r = spawnSync("ss", ["-ltnp"], { encoding: "utf8" }).stdout.split("\n").find((l) => l.includes(`:${PORT} `)); return r ? Number(r.match(/pid=(\d+)/)?.[1]) : null; };

const sessions = [];
function launch(i, resumeFile) {
  const name = `chaos-${i}`, dir = join(DIR, `s${i}`); mkdirSync(dir, { recursive: true });
  const env = Object.entries({ ...ENV, MACP_ROLE: `c${i}` }).map(([k, v]) => `${k}=${v}`).join(" ");
  const sess = resumeFile ? `--session ${resumeFile}` : `--session-dir ${dir}`;
  tmux("kill-session", "-t", name);
  tmux("new-session", "-d", "-s", name, "-x", "150", "-y", "45", "-c", dir, `env ${env} pi --no-extensions --no-skills -e ${ROOT} --model ${MODEL} ${sess}`);
  sessions[i] = { i, name, dir, role: `c${i}` };
}
const sessionFile = (i) => { const d = sessions[i].dir; const f = readdirSync(d).filter((x) => x.endsWith(".jsonl")); return f.length ? join(d, f.sort().at(-1)) : null; };
const piPid = (i) => Number(tmux("display", "-p", "-t", sessions[i].name, "#{pane_pid}").stdout.trim()) || null;

let op;
async function operator() {
  for (let k = 0; k < 30; k++) {
    try {
      if (!op) {
        const c = new Client({ name: "chaos-driver", version: "0" });
        await c.connect(new StreamableHTTPClientTransport(new URL(URL_)));
        const r = JSON.parse((await c.callTool({ name: "macp_register", arguments: { agent_id: "dm", harness: "operator", operator_token: OPKEY } })).content[0].text);
        if (!r.operator) throw new Error("not operator");
        op = c;
      }
      return op;
    } catch { op = undefined; await sleep(2000); }
  }
  throw new Error("operator cannot reach the hub");
}
async function send(toRole, body, priority) {
  const addr = db().prepare("SELECT address FROM agents WHERE role = ? ORDER BY registered_at DESC LIMIT 1").get(toRole)?.address;
  if (!addr) return null;
  for (let k = 0; k < 3; k++) {
    try {
      const o = await operator();
      const r = JSON.parse((await o.callTool({ name: "macp_send", arguments: { to: addr, body, priority } })).content[0].text);
      return r.deliveries?.[0]?.id ?? null;
    } catch { op = undefined; await sleep(2000); }
  }
  return null;
}
const db = () => new DatabaseSync(DB, { readOnly: true });

// ── work: each task names the token that proves it happened ─────────────────
const expect = []; let n = 0;
const TASKS = {
  reply: async (i) => { const t = `TOKEN-${++n}`; const id = await send(`c${i}`, `Reply to this message with macp_send (in_reply_to its id) with exactly: ${t}`, "steering");
    expect.push({ kind: "reply", t, from: `c${i}`, to: "human://", id }); },
  relay: async (i) => { const j = (i + 1 + rnd(N - 1)) % N; const t = `RELAY-${++n}`;
    const id = await send(`c${i}`, `Use macp_send to send the agent with role c${j} (to "c${j}", priority steering) exactly this: "${t}: reply to the human (to "human://dm") with ${t}-ACK"`, "steering");
    expect.push({ kind: "relay", t, from: `c${i}`, to: `c${j}`, id }); expect.push({ kind: "relay-ack", t: `${t}-ACK`, from: `c${j}`, to: "human://", id }); },
  info: async (i) => { const t = `INFO-${++n}`; const id = await send(`c${i}`, `FYI ${t}. No reply needed.`, "info"); expect.push({ kind: "info", t, to: `c${i}`, id, placedOnly: true }); },
  busy: async (i) => { const t = `BUSY-${++n}`; const id = await send(`c${i}`, `Run this bash command: sleep 20 && echo done. Then reply to the human with macp_send: ${t}`, "steering");
    expect.push({ kind: "busy", t, from: `c${i}`, to: "human://", id });
    await sleep(6000); const s = `STEER-${++n}`; const id2 = await send(`c${i}`, `Also, in the same turn, reply to the human with macp_send: ${s}`, "steering");
    expect.push({ kind: "steer", t: s, from: `c${i}`, to: "human://", id: id2 }); },
  interrupt: async (i) => { const id0 = await send(`c${i}`, "Run exactly this bash command: for k in $(seq 1 120); do echo tick-$k; sleep 1; done", "steering");
    await sleep(25000); const t = `INT-${++n}`; const id = await send(`c${i}`, `Stop that. Reply to the human with macp_send: ${t}`, "interrupt");
    expect.push({ kind: "interrupt", t, from: `c${i}`, to: "human://", id }); },
};
const WEIGHTS = [["reply", 4], ["relay", 3], ["info", 2], ["busy", 2], ["interrupt", 1]];
const pick = () => { let r = rnd(WEIGHTS.reduce((a, [, w]) => a + w, 0)); for (const [k, w] of WEIGHTS) { if ((r -= w) < 0) return k; } };

// ── faults ──────────────────────────────────────────────────────────────────
const faults = [];
const FAULTS = {
  "kill9-session": async () => { const i = rnd(N); const f = sessionFile(i); const p = piPid(i); if (!p || !f) return;
    process.kill(p, "SIGKILL"); faults.push(`kill9 c${i}`); log(`FAULT kill -9 c${i} (pid ${p}); restart in 20 s`); await sleep(20000); launch(i, f); },
  "kill9-hub": async () => { const p = hubPid(); if (!p) return; process.kill(p, "SIGKILL"); faults.push("kill9 hub"); log(`FAULT kill -9 hub (pid ${p}); sessions must restart it`); },
  "freeze-session": async () => { const i = rnd(N); const p = piPid(i); if (!p) return; process.kill(p, "SIGSTOP"); faults.push(`freeze c${i}`);
    log(`FAULT SIGSTOP c${i} for 100 s`); await sleep(100000); try { process.kill(p, "SIGCONT"); } catch {} log(`  SIGCONT c${i}`); },
  "reload-session": async () => { const i = rnd(N); tmux("send-keys", "-t", sessions[i].name, "/reload", "Enter"); faults.push(`reload c${i}`); log(`FAULT /reload c${i}`); },
  "restart-hub": async () => { const p = hubPid(); if (!p) return; process.kill(p, "SIGTERM"); faults.push("restart hub"); log("FAULT hub SIGTERM (clean stop); sessions must restart it"); },
};
const FAULT_KEYS = Object.keys(FAULTS);

// ── run ─────────────────────────────────────────────────────────────────────
log(`chaos: ${N} sessions, ${MINUTES} min, model ${MODEL}, hub :${PORT}`);
startHub(); await sleep(1500);
for (let i = 0; i < N; i++) launch(i);
await sleep(20000);
log(`registered: ${db().prepare("SELECT count(*) n FROM agents WHERE live = 1 AND project = 'prj:chaos'").get().n}/${N}`);
const end = Date.now() + MINUTES * 60_000;
let nextFault = Date.now() + 120_000;
const running = new Set();
while (Date.now() < end) {
  const task = pick(), i = rnd(N);
  const p = TASKS[task](i).catch((e) => log(`task error ${task}: ${e.message}`)); running.add(p); p.finally(() => running.delete(p));
  log(`task ${task} → c${i}`);
  if (Date.now() > nextFault) { const f = FAULT_KEYS[rnd(FAULT_KEYS.length)]; const fp = FAULTS[f]().catch((e) => log(`fault error ${f}: ${e.message}`)); running.add(fp); fp.finally(() => running.delete(fp)); nextFault = Date.now() + 150_000 + rnd(120_000); }
  await sleep(25_000 + rnd(15_000));
}
log("work stopped; waiting up to 12 min for the last answers");
await Promise.allSettled([...running]);
const met = (e) => { const d = db(); try {
  if (e.placedOnly) return !!d.prepare("SELECT 1 FROM deliveries WHERE id = ? AND placed_at IS NOT NULL").get(e.id ?? "");
  const rows = d.prepare("SELECT from_addr, to_addr FROM deliveries WHERE body LIKE ?").all(`%${e.t}%`);
  const fromAddr = (role) => d.prepare("SELECT address FROM agents WHERE role = ?").all(role).map((r) => r.address);
  const froms = fromAddr(e.from);
  return rows.some((r) => froms.includes(r.from_addr) && (e.to === "human://" ? r.to_addr.startsWith("human://") : fromAddr(e.to).includes(r.to_addr)));
} finally { d.close(); } };
for (let k = 0; k < 72 && expect.some((e) => !met(e)); k++) await sleep(10_000);

// ── invariants ───────────────────────────────────────────────────────────────
const report = { sessions: N, minutes: MINUTES, model: MODEL, faults, tasks: {}, unmet: [], duplicates: [], userRole: [], conflicts: 0, unexplained: [] };
for (const e of expect) { const k = (report.tasks[e.kind] ??= { total: 0, met: 0 }); k.total++; if (met(e)) k.met++; else report.unmet.push(e); }
const d = db();
for (const e of report.unmet) { // was it at least explained?
  const r = e.id ? d.prepare("SELECT priority, placed_at, read_at, answered_at, failed_at, fail_reason FROM deliveries WHERE id = ?").get(e.id) : null;
  e.trace = r ?? "operator message not accepted (hub down?)";
}
for (let i = 0; i < N; i++) {
  const seen = new Map();
  for (const f of readdirSync(sessions[i].dir).filter((x) => x.endsWith(".jsonl"))) {
    for (const l of readFileSync(join(sessions[i].dir, f), "utf8").split("\n")) {
      if (!l) continue; let r; try { r = JSON.parse(l); } catch { continue; }
      if (r.type === "custom_message" && r.customType === "macp") for (const env of r.details?.envelopes ?? []) seen.set(env.id, (seen.get(env.id) ?? 0) + 1);
      if (r.type === "message" && r.message?.role === "user") report.userRole.push({ session: `c${i}`, text: JSON.stringify(r.message.content).slice(0, 80) });
    }
  }
  for (const [id, c] of seen) if (c > 1) report.duplicates.push({ session: `c${i}`, id, times: c });
}
report.conflicts = d.prepare("SELECT count(*) n FROM audit WHERE action = 'identity-conflict'").get().n;
report.rekeys = d.prepare("SELECT count(*) n FROM audit WHERE action = 'rekey'").get().n;
// placed long ago, never read, while its session later completed model calls
report.unexplained = d.prepare(`SELECT substr(id,3,8) id, to_addr, priority, placed_at FROM deliveries
  WHERE placed_at IS NOT NULL AND read_at IS NULL AND failed_at IS NULL AND priority IN ('steering','interrupt')
    AND to_addr IN (SELECT DISTINCT from_addr FROM deliveries d2 WHERE d2.sent_at > deliveries.placed_at)`).all();
d.close();
writeFileSync(join(DIR, "report.json"), JSON.stringify(report, null, 1));
log(`RESULT tasks ${JSON.stringify(report.tasks)} · unmet ${report.unmet.length} · duplicates ${report.duplicates.length} · user-role ${report.userRole.length} · identity conflicts ${report.conflicts} · rekeys ${report.rekeys} · placed-unread-while-active ${report.unexplained.length} · faults ${faults.length}`);
for (let i = 0; i < N; i++) tmux("kill-session", "-t", sessions[i].name);
try { op?.close(); } catch {}
const hp = hubPid(); if (hp) process.kill(hp, "SIGTERM");
process.exit(0);
