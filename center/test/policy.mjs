/**
 * Topology policy, end to end against a live center: supervisor/worker project where
 * workers reach the supervisor, never each other, may not broadcast, and a paused worker
 * is never woken. Run: node test/policy.mjs
 */
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 9000 + Math.floor(Math.random() * 900);
const URL_ = `http://127.0.0.1:${PORT}/mcp`;
const DB = `./test/policy-${PORT}.db`;
const POLICY = `./test/policy-${PORT}.json`;

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`); };
const j = (res) => JSON.parse(res.content[0].text);
const inbox = async (c, addr) => JSON.parse((await c.readResource({ uri: `macp://agent/${addr}/inbox` })).contents[0].text);

const policy = (extra = {}) => ({ projects: { team: {
  closed: true,
  allow: [
    { from: "role:worker", to: "role:supervisor", max: "steering" },
    { from: "role:supervisor", to: "role:worker", max: "advisory" },
  ],
  deny: [{ from: "role:worker", to: "role:worker", reason: "a worker messages the supervisor, not another worker" }],
  broadcast: ["role:supervisor"],
  ...extra,
} } });
writeFileSync(POLICY, JSON.stringify(policy()));

rmSync(DB, { force: true });
const proc = spawn("node", ["dist/index.js", "--port", String(PORT), "--db", DB, "--policy", POLICY], { stdio: ["ignore", "pipe", "pipe"] });
proc.stderr.on("data", (d) => process.stderr.write(d));
await new Promise((res, rej) => { proc.stdout.on("data", (d) => d.toString().includes("listening") && res()); setTimeout(() => rej(new Error("boot timeout")), 8000); });

async function agent(id, role) {
  const c = new Client({ name: id, version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(URL_)));
  const r = j(await c.callTool({ name: "macp_register", arguments: { agent_id: id, harness: "pi", role, project: "team" } }));
  return { c, addr: r.address };
}

try {
  const sup = await agent("sup", "supervisor");
  const w1 = await agent("w1", "worker");
  const w2 = await agent("w2", "worker");
  const send = (from, to, priority = "steering", body = "x") => from.c.callTool({ name: "macp_send", arguments: { to, body, priority } });

  // worker → supervisor: allowed at steering by rule (configuration grant, no macp_grant needed)
  const r1 = j(await send(w1, sup.addr, "steering", "w1 reports"));
  ok("worker → supervisor delivered at steering via policy rule", r1.deliveries?.[0]?.priority === "steering", JSON.stringify(r1));

  // worker → worker: refused, reason names the channel, nothing stored
  const r2res = await send(w1, w2.addr, "advisory", "psst");
  const r2 = j(r2res);
  ok("worker → worker refused", r2res.isError === true && r2.deliveries.length === 0, JSON.stringify(r2));
  ok("refusal names the right channel", /messages the supervisor/.test(r2.refused?.[0]?.reason ?? ""), JSON.stringify(r2));
  ok("refused message never reaches w2's inbox", (await inbox(w2.c, w2.addr)).length === 0);

  // supervisor → worker: capped at advisory by rule
  const r3 = j(await send(sup, w2.addr, "steering", "note"));
  ok("supervisor → worker capped to advisory", r3.deliveries?.[0]?.priority === "advisory" && r3.deliveries?.[0]?.downgraded === true, JSON.stringify(r3));

  // broadcast: worker refused, supervisor allowed (reaches both workers)
  const r4res = await send(w1, "project", "advisory", "all hands");
  ok("worker broadcast refused", r4res.isError === true && /may not broadcast/.test(JSON.stringify(j(r4res))), JSON.stringify(j(r4res)));
  const r5 = j(await send(sup, "project", "advisory", "standup"));
  ok("supervisor broadcast reaches both workers", r5.deliveries?.length === 2, JSON.stringify(r5));

  // role targeting from a worker to role:worker is refused per recipient (it would be worker → worker)
  const r6res = await send(w1, "role:worker", "advisory", "who else?");
  ok("worker → role:worker refused for the other worker", j(r6res).deliveries.length === 0 && j(r6res).refused?.length === 1, JSON.stringify(j(r6res)));

  // quiet (paused) worker: the policy file changes on disk, the center picks it up without a restart
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(POLICY, JSON.stringify(policy({ allow: [
    { from: "role:worker", to: "role:supervisor", max: "steering" },
    { from: "role:supervisor", to: "role:worker", max: "steering" },
  ], quiet: ["agent://pi/w2"] })));
  const r7 = j(await send(sup, w1.addr, "steering", "go"));
  ok("policy reloads from disk: supervisor → w1 now steering", r7.deliveries?.[0]?.priority === "steering", JSON.stringify(r7));
  const r8 = j(await send(sup, w2.addr, "steering", "go"));
  ok("quiet worker gets advisory (never woken)", r8.deliveries?.[0]?.priority === "advisory" && /quiet/.test(r8.deliveries?.[0]?.note ?? ""), JSON.stringify(r8));

  // operator outranks policy (spec §9 G3)
  const op = new Client({ name: "op", version: "0" });
  await op.connect(new StreamableHTTPClientTransport(new URL(URL_)));
  j(await op.callTool({ name: "macp_register", arguments: { agent_id: "human", harness: "operator" } }));
  const r9 = j(await op.callTool({ name: "macp_send", arguments: { to: w2.addr, body: "from the human", priority: "interrupt" } }));
  ok("operator may interrupt anyone regardless of policy", r9.deliveries?.[0]?.priority === "interrupt", JSON.stringify(r9));

  // regression 2026-10-25: an operator's info/advisory was silently dropped (filed as cross-project)
  const r11 = j(await op.callTool({ name: "macp_send", arguments: { to: w1.addr, body: "fyi from the human", priority: "info" } }));
  ok("operator info reaches a worker (G3 at every priority)", r11.deliveries?.[0]?.priority === "info", JSON.stringify(r11));

  // regression 2026-10-25: a blocked cross-project send returned an empty success
  const out = new Client({ name: "outsider", version: "0" });
  await out.connect(new StreamableHTTPClientTransport(new URL(URL_)));
  j(await out.callTool({ name: "macp_register", arguments: { agent_id: "x1", harness: "pi", role: "worker", project: "elsewhere" } }));
  const r12res = await out.callTool({ name: "macp_send", arguments: { to: w1.addr, body: "hi", priority: "advisory" } });
  ok("cross-project send is refused with a reason, never dropped silently", r12res.isError === true && /another project/.test(j(r12res).refused?.[0]?.reason ?? ""), JSON.stringify(j(r12res)));
  await out.close();

  // closedReason: the project's own wording for "no rule allows this"
  writeFileSync(POLICY, JSON.stringify({ projects: { team: { closed: true, closedReason: "ask the supervisor instead",
    allow: [{ from: "*", to: "role:supervisor", max: "steering" }] } } }));
  await new Promise((r) => setTimeout(r, 30));
  const r13 = j(await send(w1, w2.addr, "advisory", "psst"));
  ok("closed project refuses with its own closedReason", r13.refused?.[0]?.reason === "ask the supervisor instead", JSON.stringify(r13));
  ok("closed project still allows the listed route", j(await send(w1, sup.addr, "steering", "hi")).deliveries?.[0]?.priority === "steering");

  // two rewrites with the same size inside one instant must not leave stale rules (re-read ≤ 2 s)
  const A = JSON.stringify({ projects: { team: { closed: true, closedReason: "AAAA", allow: [] } } });
  const B = JSON.stringify({ projects: { team: { closed: true, closedReason: "BBBB", allow: [] } } });
  writeFileSync(POLICY, A); j(await send(w1, w2.addr, "advisory", "x")); writeFileSync(POLICY, B);
  await new Promise((r) => setTimeout(r, 2100));
  ok("same-size rewrite is picked up within 2 s", j(await send(w1, w2.addr, "advisory", "x")).refused?.[0]?.reason === "BBBB");

  // regression 2026-10-25: a closed project refused an agent's reply to the human
  const toHuman = j(await send(w1, "human://human", "advisory", "answer for you"));
  ok("a closed project never blocks an agent answering the human", toHuman.deliveries?.length === 1, JSON.stringify(toHuman));

  // projectIsRole: "project" names the role; "all" broadcasts
  writeFileSync(POLICY, JSON.stringify({ projects: { team: { closed: true, projectIsRole: true,
    allow: [{ from: "*", to: "role:project", max: "steering" }, { from: "role:supervisor", to: "*", max: "steering" }], broadcast: ["role:supervisor"] } } }));
  await new Promise((r) => setTimeout(r, 2100));
  const pr = await agent("p1", "project");
  const toProj = j(await send(w1, "project", "advisory", "q"));
  ok("projectIsRole: to \"project\" reaches the role named project, not a broadcast", toProj.deliveries?.length === 1 && toProj.deliveries[0].to === pr.addr, JSON.stringify(toProj));
  const all = j(await send(sup, "all", "info", "hi all"));
  ok("\"all\" broadcasts", (all.deliveries?.length ?? 0) >= 3, JSON.stringify(all));
  await pr.c.close();

  // agentSend: human-turn — agents send only when their human asked in that turn
  writeFileSync(POLICY, JSON.stringify({ projects: { team: { agentSend: "human-turn", agentSendReason: "use the project's own tell command",
    agentSendExempt: ["role:supervisor"], allow: [{ from: "*", to: "*", max: "steering" }] } } }));
  await new Promise((r) => setTimeout(r, 2100));
  const own = await w1.c.callTool({ name: "macp_send", arguments: { to: sup.addr, body: "on my own", priority: "advisory" } });
  ok("agentSend human-turn: an agent's own send is refused with the project's reason", own.isError === true && j(own).refused?.[0]?.reason === "use the project's own tell command", JSON.stringify(j(own)));
  const asked = j(await w1.c.callTool({ name: "macp_send", arguments: { to: sup.addr, body: "you asked", priority: "advisory", human_turn: true } }));
  ok("…and allowed in a turn its human started", asked.deliveries?.length === 1, JSON.stringify(asked));
  ok("…an exempt role (the orchestrator) still sends", j(await send(sup, w1.addr, "advisory", "beat")).deliveries?.length === 1);
  ok("…the human is never bound", j(await op.callTool({ name: "macp_send", arguments: { to: w1.addr, body: "from you", priority: "steering" } })).deliveries?.length === 1);

  // a malformed policy file keeps the last good policy (never silently opens up)
  writeFileSync(POLICY, "{ not json");
  const r10res = await send(w1, w2.addr, "advisory", "still no");
  ok("malformed policy keeps last good policy (worker → worker still refused)", r10res.isError === true, JSON.stringify(j(r10res)));

  for (const x of [sup, w1, w2]) await x.c.close();
  await op.close();
} catch (e) {
  fail++; console.log("FAIL  unexpected:", e?.stack ?? e);
} finally {
  proc.kill("SIGINT");
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`, POLICY]) rmSync(f, { force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
