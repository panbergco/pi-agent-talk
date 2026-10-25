/**
 * Strict identity: an identity is locked to its holder's in-memory secret; the operator acts only through a live
 * session's secret (or the operator key). Run: node test/identity.mjs
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 9700 + Math.floor(Math.random() * 90);
const URL_ = `http://127.0.0.1:${PORT}/mcp`, DB = `./test/identity-${PORT}.db`;
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  " + x}`); };
const j = (r) => ({ ...JSON.parse(r.content[0].text), isError: !!r.isError });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(DB, { force: true });
const proc = spawn("node", ["dist/index.js", "--port", String(PORT), "--db", DB, "--strict-identity"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MACP_OPERATOR_TOKEN: "op-key-" + PORT } });
proc.stderr.on("data", (d) => process.stderr.write(d));
await new Promise((res, rej) => { proc.stdout.on("data", (d) => d.toString().includes("listening") && res()); setTimeout(() => rej(new Error("boot")), 8000); });

const conn = async () => { const c = new Client({ name: "t", version: "0" }); await c.connect(new StreamableHTTPClientTransport(new URL(URL_))); return c; };
const reg = async (c, id, extra = {}) => j(await c.callTool({ name: "macp_register", arguments: { agent_id: id, harness: "pi", role: id, project: "p", ...extra } }));

try {
  const alice = await conn();
  const r1 = await reg(alice, "alice");
  ok("first registration issues a secret", typeof r1.key === "string" && r1.key.length >= 40, JSON.stringify(r1));

  const forger = await conn();
  const f1 = await reg(forger, "alice");
  ok("another process claiming a live identity without its secret is refused", f1.isError === true && /held by another live process/.test(f1.error), JSON.stringify(f1));
  const f2 = await reg(forger, "alice", { key: "guess" });
  ok("…and with a wrong secret too", f2.isError === true);

  const again = await conn();
  const r2 = await reg(again, "alice", { key: r1.key });
  ok("the holder may open a second connection with its secret", !r2.isError && r2.address === "agent://pi/alice", JSON.stringify(r2));

  // operator
  const fakeOp = await conn();
  const o1 = j(await fakeOp.callTool({ name: "macp_register", arguments: { agent_id: "dm", harness: "operator" } }));
  ok("claiming to be the human with nothing is refused", o1.isError === true, JSON.stringify(o1));
  const o2 = j(await fakeOp.callTool({ name: "macp_register", arguments: { agent_id: "dm", harness: "operator", via_address: "agent://pi/alice", via_key: "guess" } }));
  ok("…and with a wrong session secret", o2.isError === true);
  const realOp = await conn();
  const o3 = j(await realOp.callTool({ name: "macp_register", arguments: { agent_id: "dm", harness: "operator", via_address: "agent://pi/alice", via_key: r1.key } }));
  ok("the human through a live session (its secret) is the operator", o3.operator === true, JSON.stringify(o3));
  const tokOp = await conn();
  const o4 = j(await tokOp.callTool({ name: "macp_register", arguments: { agent_id: "dm", harness: "operator", operator_token: "op-key-" + PORT } }));
  ok("…or with the operator key", o4.operator === true, JSON.stringify(o4));

  // restart: the old process is gone, the new one has no secret
  await alice.close(); await again.close();
  await sleep(300);
  const restarted = await conn();
  const r3 = await reg(restarted, "alice");
  ok("a restarted session re-claims its identity when nobody holds it (new secret)", !r3.isError && typeof r3.key === "string" && r3.key !== r1.key, JSON.stringify(r3));

  // a squatter takes an identity while its holder is away; the holder returns with its old secret
  const bob = await conn(); const b1 = await reg(bob, "bob");
  await bob.close(); await sleep(300);
  const squat = await conn(); const s1 = await reg(squat, "bob");
  ok("(an identity whose holder is away can be squatted — the residual limit)", !s1.isError);
  const bobBack = await conn(); const b2 = await reg(bobBack, "bob", { key: b1.key });
  ok("…but the real holder returning is refused while the squatter holds it, and it is logged", b2.isError === true && /held by another live process/.test(b2.error), JSON.stringify(b2));
  await squat.close(); await sleep(300);
  const b3 = await reg(bobBack, "bob", { key: b1.key });
  ok("…and once the squatter leaves, the return is flagged as a conflict", !b3.isError && b3.conflict === true, JSON.stringify(b3));

  for (const c of [forger, fakeOp, realOp, tokOp, restarted, bobBack]) await c.close().catch(() => {});
} catch (e) {
  fail++; console.log("FAIL  unexpected:", e?.stack ?? e);
} finally {
  proc.kill("SIGINT");
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
