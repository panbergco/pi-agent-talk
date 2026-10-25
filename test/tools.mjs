/**
 * Every tool pi-agent-talk registers must implement Pi's contract: `execute()`, never `handler`, and no
 * reference to a helper that does not exist. A broken finder shipped once (handler + undefined ok_) and 151
 * passing tests did not notice — they never invoked the tool. This does.
 * Run: node test/tools.mjs   (exit 0 = contract holds)
 */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const SRC = new URL("../src/index.ts", import.meta.url).pathname;
const source = readFileSync(SRC, "utf8");
let pass = 0, fail = 0;
const check = (desc, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${desc}${ok ? "" : "  " + detail}`); };

// ── static: the shape of every registerTool block ────────────────────────────────────────────────
const blocks = [...source.matchAll(/pi\.registerTool\(\{([\s\S]*?)\n  \}\);/g)].map((m) => m[1]);
check("registerTool blocks found", blocks.length >= 5, `found ${blocks.length}`);
const withHandler = blocks.filter((b) => /\bhandler\s*:/.test(b)).map((b) => (b.match(/name:\s*"([^"]+)"/) ?? [])[1]);
check("no tool uses handler: instead of execute()", withHandler.length === 0, `offenders: ${withHandler.join(", ")}`);
const noExecute = blocks.filter((b) => !/\bexecute\s*\(/.test(b)).map((b) => (b.match(/name:\s*"([^"]+)"/) ?? [])[1]);
check("every tool declares execute()", noExecute.length === 0, `missing: ${noExecute.join(", ")}`);

// ── a helper called but never defined: exactly the shape of the bug that shipped (ok_ used, never written).
// Only identifiers that LOOK like helpers (trailing underscore) and appear as calls, so prose cannot trip it.
const helperCalls = [...source.matchAll(/(?<![\w."'`])([a-z]\w*_)\s*\(/g)].map((m) => m[1]);
const helperDefs = new Set([...source.matchAll(/(?:const|let|var|function)\s+([a-z]\w*_)\b/g)].map((m) => m[1]));
const phantom = [...new Set(helperCalls)].filter((n) => !helperDefs.has(n));
check("no helper is called before it is defined", phantom.length === 0, `never defined: ${phantom.join(", ")}`);

// ── dynamic: load the real extension through Pi's loader and invoke the finder ───────────────────
const candidates = [
  process.env.PI_CORE_LOADER,
  `${process.env.HOME}/Code/pi-build-0871/packages/coding-agent/dist/core/extensions/loader.js`,
  `${process.env.HOME}/.pi/agent/git/github.com/earendil-works/pi/packages/coding-agent/dist/core/extensions/loader.js`,
].filter(Boolean);
const loaderPath = candidates.find((p) => existsSync(p));
if (!loaderPath) {
  console.log("SKIP  the dynamic loader check (no Pi core build on this machine; the static checks above still ran)");
} else {
  const { loadExtensions } = await import(loaderPath);
  const loaded = await loadExtensions([SRC], new URL("../", import.meta.url).pathname);
  check("extension loads without errors", (loaded.errors ?? []).length === 0, JSON.stringify(loaded.errors ?? []).slice(0, 200));
  const tools = [...(loaded.extensions?.[0]?.tools?.values() ?? [])].map((t) => t.definition ?? t);
  check("all five tools registered", tools.length === 5, `got ${tools.length}`);
  const notCallable = tools.filter((t) => typeof t.execute !== "function").map((t) => t.name);
  check("every registered tool has a callable execute()", notCallable.length === 0, `not callable: ${notCallable.join(", ")}`);
  const find = tools.find((t) => t.name === "macp_find");
  check("macp_find is registered", !!find);
  if (find) {
    // With no hub running it must fail as a connection problem, never as a broken function.
    let msg = "";
    try { await find.execute("test-call", { query: "the reviewer on desk" }, undefined, undefined, {}); }
    catch (e) { msg = String(e?.message ?? e); }
    check("macp_find runs and its failure is about the hub, not the code",
      /not connected|ECONNREFUSED|fetch failed|ECONNRESET|hub|timeout/i.test(msg) && !/is not a function|is not defined|ok_/i.test(msg),
      `failed with: ${msg.slice(0, 160)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
