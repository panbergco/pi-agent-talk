/**
 * Receipt stages end to end: accepted → fetched → placed → failed/read → answered, stuck, offline,
 * the one-time failure notice to the sender, and who may look. Run: node test/receipts.mjs
 */
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 9900 + Math.floor(Math.random() * 90);
const URL_ = `http://127.0.0.1:${PORT}/mcp`;
const DB = `./test/receipts-${PORT}.db`, POLICY = `./test/receipts-${PORT}.json`;
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  " + x}`); };
const j = (r) => JSON.parse(r.content[0].text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

writeFileSync(POLICY, JSON.stringify({ projects: { t: { allow: [{ from: "*", to: "*", max: "steering" }] } } }));
rmSync(DB, { force: true });
const proc = spawn("node", ["dist/index.js", "--port", String(PORT), "--db", DB, "--policy", POLICY], {
  stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MACP_STUCK_SECONDS: "1" },
});
proc.stderr.on("data", (d) => process.stderr.write(d));
await new Promise((res, rej) => { proc.stdout.on("data", (d) => d.toString().includes("listening") && res()); setTimeout(() => rej(new Error("boot")), 8000); });

async function agent(id) {
  const c = new Client({ name: id, version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(URL_)));
  const r = j(await c.callTool({ name: "macp_register", arguments: { agent_id: id, harness: "pi", role: id, project: "t" } }));
  return { c, addr: r.address };
}
const inbox = async (a) => JSON.parse((await a.c.readResource({ uri: `macp://agent/${a.addr}/inbox` })).contents[0].text);
const status = async (a, id) => j(await a.c.callTool({ name: "macp_status", arguments: { delivery_id: id } }));
const rcpt = (a, id, stage, reason) => a.c.callTool({ name: "macp_receipt", arguments: { delivery_id: id, stage, ...(reason ? { reason } : {}) } });

try {
  const s = await agent("sender"), r = await agent("receiver"), x = await agent("bystander");
  const id = j(await s.c.callTool({ name: "macp_send", arguments: { to: r.addr, body: "do it", priority: "steering" } })).deliveries[0].id;

  ok("accepted: stored, not fetched yet", (await status(s, id)).stage === "accepted");
  await inbox(r);
  ok("fetched: the binding read its inbox", (await status(s, id)).stage === "fetched");
  await rcpt(r, id, "placed");
  ok("placed: in the recipient's context", (await status(s, id)).stage === "placed");
  ok("placed deliveries leave the inbox (no re-fetch)", (await inbox(r)).length === 0);

  await rcpt(r, id, "failed", "429 rate limit: quota exhausted");
  const st = await status(s, id);
  ok("failed: carries the recipient's model error", st.stage === "failed" && /429/.test(st.detail), JSON.stringify(st));
  const notice = (await inbox(s)).filter((e) => e.from === "center://macp");
  ok("sender told once, at info priority, linked to the message", notice.length === 1 && notice[0].priority === "info" && notice[0].in_reply_to === id, JSON.stringify(notice));
  await rcpt(r, id, "failed", "429 again");
  ok("a repeated failure does not notify again", (await inbox(s)).filter((e) => e.from === "center://macp").length === 1);

  await rcpt(r, id, "read");
  ok("read: a later model call succeeded (retry recovered)", (await status(s, id)).stage === "read");
  await r.c.callTool({ name: "macp_send", arguments: { to: s.addr, body: "done", priority: "advisory", in_reply_to: id } });
  ok("answered: the recipient replied with in_reply_to", (await status(s, id)).stage === "answered");

  ok("the recipient may look too", (await status(r, id)).stage === "answered");
  const peek = await x.c.callTool({ name: "macp_status", arguments: { delivery_id: id } });
  ok("a bystander may not look", peek.isError === true);
  ok("a unique id prefix works (as /talk trace prints)", (await status(s, id.slice(0, 10))).id === id);

  // stuck: a waking delivery placed, and no model call completes
  const id2 = j(await s.c.callTool({ name: "macp_send", arguments: { to: r.addr, body: "are you there?", priority: "steering" } })).deliveries[0].id;
  await rcpt(r, id2, "placed");
  await sleep(1300);
  const st2 = await status(s, id2);
  ok("stuck: placed, no completed model call within the limit", st2.stage === "stuck" && /no model call/.test(st2.detail), JSON.stringify(st2));

  // advisory is never 'stuck': it does not wake, so waiting is expected
  const id3 = j(await s.c.callTool({ name: "macp_send", arguments: { to: r.addr, body: "fyi", priority: "advisory" } })).deliveries[0].id;
  await rcpt(r, id3, "placed");
  await sleep(1300);
  ok("advisory stays placed, never stuck", (await status(s, id3)).stage === "placed");

  // offline after placement
  await r.c.close();
  await sleep(500);
  const st4 = await status(s, id3);
  ok("receiver went offline after placement → stuck, says so", st4.stage === "stuck" && /offline/.test(st4.detail), JSON.stringify(st4));
  const id5 = j(await s.c.callTool({ name: "macp_send", arguments: { to: r.addr, body: "later", priority: "advisory" } })).deliveries[0].id;
  const st5 = await status(s, id5);
  ok("send to an offline receiver: accepted, waits for reconnect", st5.stage === "accepted" && /offline/.test(st5.detail), JSON.stringify(st5));

  // role target whose only holder crashed: queued for it, not dropped; it gets it on return
  const qr = j(await s.c.callTool({ name: "macp_send", arguments: { to: "role:receiver", body: "while you were down", priority: "steering" } }));
  ok("role send to a crashed agent is queued for it, and says so", qr.deliveries?.[0]?.to === r.addr && /offline: queued/.test(qr.deliveries?.[0]?.note ?? ""), JSON.stringify(qr));
  const nobody = await s.c.callTool({ name: "macp_send", arguments: { to: "role:nobody", body: "x", priority: "advisory" } });
  ok("a role nobody ever held is an error, not an empty success", nobody.isError === true);
  const back = await agent("receiver");
  const got = (await inbox(back)).map((e) => e.body);
  ok("the returning agent (same id → same address) gets what was queued", back.addr === r.addr && got.includes("while you were down") && got.includes("later"), JSON.stringify(got));
  await back.c.close();

  // idempotent resend: same client_id → the original delivery, never a second copy
  const once = j(await s.c.callTool({ name: "macp_send", arguments: { to: "agent://pi/bystander", body: "exactly once", priority: "advisory", client_id: "c_test_1" } }));
  const again = j(await s.c.callTool({ name: "macp_send", arguments: { to: "agent://pi/bystander", body: "exactly once", priority: "advisory", client_id: "c_test_1" } }));
  ok("a resend with the same client_id returns the original, flagged duplicate", again.duplicate === true && again.deliveries[0].id === once.deliveries[0].id, JSON.stringify(again));
  ok("…and the recipient holds one copy", (await inbox(x)).filter((e) => e.body === "exactly once").length === 1);

  await s.c.close(); await x.c.close();

  // retention: restart with 0 days → finished deliveries pruned, unfinished ones kept
  proc.kill("SIGINT"); await sleep(400);
  const p2 = spawn("node", ["dist/index.js", "--port", String(PORT), "--db", DB], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MACP_RETENTION_DAYS: "0" } });
  const log = await new Promise((res) => { let buf = ""; p2.stdout.on("data", (d) => { buf += d; if (buf.includes("listening")) res(buf); }); });
  const s2 = await agent("sender");
  const still = (await status(s2, id5)).stage;
  const gone = /no delivery/.test((await status(s2, id)).error ?? "");
  ok("retention prunes answered deliveries", /pruned [1-9]/.test(log) && gone, log);
  ok("retention keeps unread deliveries", still === "accepted" || still === "fetched" || still === "placed", still);
  await s2.c.close(); p2.kill("SIGINT");
} catch (e) {
  fail++; console.log("FAIL  unexpected:", e?.stack ?? e);
} finally {
  proc.kill("SIGINT");
  if (!process.env.KEEP) for (const f of [DB, `${DB}-wal`, `${DB}-shm`, POLICY]) rmSync(f, { force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
