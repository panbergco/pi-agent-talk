/**
 * The human in charge: access key, "agents send only when asked" as the machine default, a human-asked
 * send carrying the human's authority across projects, allowances, and the cross-project directory.
 * Run: node test/human.mjs
 */
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 9800 + Math.floor(Math.random() * 90);
const URL_ = `http://127.0.0.1:${PORT}/mcp`, DB = `./test/human-${PORT}.db`, POLICY = `./test/human-${PORT}.json`, KEY = "k-" + PORT + "-secret";
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  " + x}`); };
const j = (r) => ({ ...JSON.parse(r.content[0].text), isError: !!r.isError });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

writeFileSync(POLICY, JSON.stringify({ defaultAgentSend: "human-turn" }));
rmSync(DB, { force: true });
const proc = spawn("node", ["dist/index.js", "--port", String(PORT), "--db", DB, "--policy", POLICY], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MACP_TOKEN: KEY } });
proc.stderr.on("data", (d) => process.stderr.write(d));
await new Promise((res, rej) => { proc.stdout.on("data", (d) => d.toString().includes("listening") && res()); setTimeout(() => rej(new Error("boot")), 8000); });

const connect = async (key = KEY) => {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(URL_), key ? { requestInit: { headers: { Authorization: `Bearer ${key}` } } } : undefined));
  return c;
};
async function agent(id, role, project, location) {
  const c = await connect();
  const r = j(await c.callTool({ name: "macp_register", arguments: { agent_id: id, harness: "pi", role, project, location } }));
  return { c, addr: r.address };
}

try {
  let refusedNoKey = false; try { await connect(null); } catch { refusedNoKey = true; }
  ok("no access key → connection refused", refusedNoKey);
  let refusedBadKey = false; try { await connect("wrong"); } catch { refusedBadKey = true; }
  ok("wrong access key → connection refused", refusedBadKey);

  const a = await agent("a", "builder", "alpha", "desk · tmux main:3 'shop-builder' · ~/Code/shop");
  const b = await agent("b", "reviewer", "beta", "server · tmux main:1 'billing-review' · ~/Code/billing");
  const send = (x, extra) => x.c.callTool({ name: "macp_send", arguments: { to: b.addr, body: "hi", priority: "steering", ...extra } });

  const own = await send(a);
  ok("machine default: an agent's own send is refused", own.isError === true && /only when their human asks/.test(j(own).refused?.[0]?.reason ?? ""), JSON.stringify(j(own)));
  const report = j(await a.c.callTool({ name: "macp_send", arguments: { to: "human://dm", body: "status", priority: "advisory" } }));
  ok("…but it may always report to the human", report.deliveries?.length === 1, JSON.stringify(report));
  const asked = j(await send(a, { human_turn: true, asked_by: "dm" }));
  ok("human-asked send crosses projects at steering, no grant needed", asked.deliveries?.[0]?.priority === "steering", JSON.stringify(asked));
  const inbox = JSON.parse((await b.c.readResource({ uri: `macp://agent/${b.addr}/inbox` })).contents[0].text);
  ok("…and the receiver sees who asked for it", inbox[0]?.asked_by === "dm", JSON.stringify(inbox[0]));

  const reply = j(await b.c.callTool({ name: "macp_send", arguments: { to: a.addr, body: "done", priority: "advisory", in_reply_to: asked.deliveries[0].id } }));
  ok("the recipient may answer a human-asked message once, labelled as the answer", reply.deliveries?.length === 1, JSON.stringify(reply));
  const again = await b.c.callTool({ name: "macp_send", arguments: { to: a.addr, body: "and more", priority: "advisory", in_reply_to: asked.deliveries[0].id } });
  ok("…but only once", again.isError === true);
  const elsewhere = await b.c.callTool({ name: "macp_send", arguments: { to: "human://nobody", body: "x", priority: "advisory", in_reply_to: asked.deliveries[0].id } });
  ok("…and only to its sender (a ticket is not a pass to message others)", j(elsewhere).deliveries?.[0]?.to !== a.addr);

  const op = await connect();
  j(await op.callTool({ name: "macp_register", arguments: { agent_id: "dm", harness: "operator" } }));
  const notOp = await a.c.callTool({ name: "macp_allow", arguments: { holder: a.addr } });
  ok("an agent cannot allow itself", notOp.isError === true);
  j(await op.callTool({ name: "macp_allow", arguments: { holder: a.addr } }));
  ok("after /talk allow: the agent may send on its own (normal rules apply)", (await send(a)).isError !== true);
  j(await op.callTool({ name: "macp_allow", arguments: { holder: a.addr, revoke: true } }));
  ok("after /talk deny: refused again", (await send(a)).isError === true);
  j(await op.callTool({ name: "macp_allow", arguments: { holder: "project:prj:alpha", minutes: 0.01 } }));
  ok("a project-wide allowance works", (await send(a)).isError !== true);
  await sleep(1000);
  ok("…and expires on time", (await send(a)).isError === true);

  const dir = j(await a.c.callTool({ name: "macp_roster", arguments: { all: true } }));
  ok("directory lists every live agent across projects, with where it runs",
    dir.agents?.length === 2 && dir.agents.some((x) => /server · tmux main:1 'billing-review'/.test(x.location ?? "")), JSON.stringify(dir));

  // presence: busy / idle reaches the directory
  await a.c.callTool({ name: "macp_presence", arguments: { state: "busy" } });
  const d1 = j(await b.c.callTool({ name: "macp_roster", arguments: { all: true } })).agents.find((x) => x.address === a.addr);
  ok("presence: busy shows in the directory, with since when", d1?.state === "busy" && !!d1?.state_at, JSON.stringify(d1));

  // flood and loop limits (rules file re-read within 2 s)
  writeFileSync(POLICY, JSON.stringify({ limits: { perMinute: 100, pairPer10Min: 3 } }));
  await sleep(2100);
  const c1 = await agent("c1", "x", "lim"), c2 = await agent("c2", "y", "lim");
  const ping = (f, t) => f.c.callTool({ name: "macp_send", arguments: { to: t.addr, body: "ping", priority: "advisory" } });
  for (let k = 0; k < 3; k++) await ping(k % 2 ? c2 : c1, k % 2 ? c1 : c2);
  const looped = await ping(c1, c2);
  ok("loop limit: the 4th message between one pair in 10 min is refused, with the reason", looped.isError === true && /loop limit/.test(j(looped).refused?.[0]?.reason ?? ""), JSON.stringify(j(looped)));
  ok("…the human is never limited", j(await op.callTool({ name: "macp_send", arguments: { to: c2.addr, body: "from you", priority: "advisory" } })).deliveries?.length === 1);
  writeFileSync(POLICY, JSON.stringify({ limits: { perMinute: 2, pairPer10Min: 100 } }));
  await sleep(2100);
  const c3 = await agent("c3", "z", "lim");
  await ping(c3, c1); await ping(c3, c2);
  const flood = await c3.c.callTool({ name: "macp_send", arguments: { to: c1.addr, body: "more", priority: "advisory" } });
  ok("flood limit: the 3rd send in a minute (limit 2) is refused, with the reason", flood.isError === true && /rate limit/.test(j(flood).error ?? ""), JSON.stringify(j(flood)));
  for (const x of [c1, c2, c3]) await x.c.close();

  for (const x of [a, b]) await x.c.close();
  await op.close();
} catch (e) {
  fail++; console.log("FAIL  unexpected:", e?.stack ?? e);
} finally {
  proc.kill("SIGINT");
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`, POLICY]) rmSync(f, { force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
