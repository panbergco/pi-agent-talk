import { mkdirSync, readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
/**
 * MACP 2.0 reference center — HTTP host.
 * One long-lived process serving MCP over streamable HTTP (spec §3):
 * every agent in the fleet connects to the same URL; each MCP session is one agent.
 *
 *   macp-center [--port 7737] [--db ~/.local/state/macp-center/center.db] [--policy rules.json]
 *   MACP_OPERATOR_TOKEN=…   optional; when set, operator registration requires it.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Store } from "./store.js";
import { Notifier, buildSessionServer } from "./server.js";
import { Policy } from "./policy.js";
const args = process.argv.slice(2);
const flag = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = Number(flag("port", process.env.MACP_PORT ?? "7737"));
// One default for every starter (systemd unit, a Pi session's auto-start, a human): the same data.
const DB = flag("db", process.env.MACP_DB ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "macp-center", "center.db"));
mkdirSync(dirname(DB), { recursive: true });
const OPERATOR_TOKEN = process.env.MACP_OPERATOR_TOKEN ?? null;
// STRICT IDENTITY (--strict-identity or MACP_STRICT_IDENTITY=1): identities locked to their holder's in-memory
// secret, and the operator only through a live session or the operator key. Off by default (spec reference behaviour).
const STRICT = process.argv.includes("--strict-identity") || process.env.MACP_STRICT_IDENTITY === "1";
// ACCESS KEY: when set, every request must carry "Authorization: Bearer <key>" (required before
// listening beyond localhost, spec §11.1). --token-file or MACP_TOKEN.
const TOKEN = (() => {
    const f = flag("token-file", process.env.MACP_TOKEN_FILE ?? "");
    try {
        if (f)
            return readFileSync(f, "utf8").trim() || null;
    }
    catch {
        console.error(`cannot read token file ${f}`);
        process.exit(1);
    }
    return process.env.MACP_TOKEN || null;
})();
const POLICY = flag("policy", process.env.MACP_POLICY ?? "") || null;
const HOST = flag("host", process.env.MACP_HOST ?? "127.0.0.1"); // spec §11.1: localhost by default
const store = new Store(DB);
const notifier = new Notifier();
const policy = new Policy(POLICY);
const sessions = new Map();
const openStreams = new Map();
// Lease backstop: no request and no open stream for this long → offline (spec §5.2 keeps its inbox).
const LEASE_MS = Number(process.env.MACP_LEASE_SECONDS ?? 45) * 1000;
setInterval(() => {
    const streaming = new Set([...openStreams.keys()].map((id) => sessions.get(id)?.ctx.address).filter((a) => !!a));
    store.sweepStale(LEASE_MS, streaming);
}, Math.min(10_000, LEASE_MS)).unref();
async function handle(req, res) {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    if (url.pathname !== "/mcp") {
        res.writeHead(404).end("MACP center: MCP endpoint is /mcp");
        return;
    }
    if (TOKEN) {
        const got = Buffer.from(String(req.headers.authorization ?? "")), want = Buffer.from(`Bearer ${TOKEN}`);
        if (got.length !== want.length || !timingSafeEqual(got, want)) {
            res.writeHead(401).end("MACP center: missing or wrong access key");
            return;
        }
    }
    const sessionId = req.headers["mcp-session-id"];
    // Existing session → route to its transport.
    if (sessionId && sessions.has(sessionId)) {
        const s = sessions.get(sessionId);
        if (s.ctx.address)
            store.heartbeat(s.ctx.address);
        // LIVENESS FROM THE OPEN STREAM. A killed process never sends DELETE, so the center used to keep
        // it live forever (measured 2026-10-25). The standalone GET stream closes when the process dies.
        // The GET opens before macp_register, so key it by connection and resolve the address at close.
        if (req.method === "GET") {
            openStreams.set(sessionId, (openStreams.get(sessionId) ?? 0) + 1);
            // The same authenticated connection reopening its stream takes its identity back — unless someone else holds it.
            if (s.ctx.address && !notifier.holder(s.ctx.address))
                notifier.bind(s.ctx);
            res.on("close", () => {
                const n = (openStreams.get(sessionId) ?? 1) - 1;
                if (n > 0) {
                    openStreams.set(sessionId, n);
                    return;
                }
                openStreams.delete(sessionId);
                if (s.ctx.address && !s.ctx.isOperator)
                    store.markStale(s.ctx.address); // a later request marks it live again
                notifier.unbind(s.ctx); // the holder is gone: its identity may be re-claimed (strict identity)
            });
        }
        await s.transport.handleRequest(req, res);
        if (req.method === "DELETE")
            endSession(sessionId);
        return;
    }
    // New session → new transport + per-session MCP server.
    if (req.method === "POST") {
        const ctx = buildSessionServer(store, notifier, { operatorToken: OPERATOR_TOKEN, policy, strict: STRICT });
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
                ctx.sessionId = id;
                sessions.set(id, { transport, ctx });
            },
        });
        transport.onclose = () => {
            if (ctx.sessionId)
                endSession(ctx.sessionId);
        };
        await ctx.server.connect(transport);
        await transport.handleRequest(req, res);
        return;
    }
    res.writeHead(400).end("unknown session");
}
function endSession(id) {
    const s = sessions.get(id);
    if (!s)
        return;
    sessions.delete(id);
    notifier.unbind(s.ctx);
    if (s.ctx.address && !s.ctx.isOperator)
        store.markStale(s.ctx.address); // spec §5.2 — inbox retained
}
const httpServer = createServer((req, res) => {
    handle(req, res).catch((e) => {
        console.error("request error:", e);
        if (!res.headersSent)
            res.writeHead(500).end("internal error");
    });
});
// Retention (days): finished deliveries 30, audit 90. Pending/unread are never pruned.
const KEEP_DAYS = Number(process.env.MACP_RETENTION_DAYS ?? 30);
const AUDIT_DAYS = Number(process.env.MACP_AUDIT_DAYS ?? 90);
const prune = () => { const r = store.prune(KEEP_DAYS, AUDIT_DAYS); if (r.deliveries || r.audit)
    console.log(`pruned ${r.deliveries} deliveries, ${r.audit} audit rows`); };
prune();
setInterval(prune, 3_600_000).unref();
// The port is the lock: when several Pi sessions start a center at once, the losers exit quietly.
httpServer.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
        console.log(`port ${PORT} already served — another center is running; exiting`);
        process.exit(0);
    }
    throw e;
});
httpServer.listen(PORT, HOST, () => {
    console.log(`MACP center listening on http://${HOST}:${PORT}/mcp (db: ${DB}${POLICY ? `, policy: ${POLICY}` : ""}${STRICT ? ", strict identity" : ""})`);
});
process.on("SIGINT", () => {
    httpServer.close();
    store.close();
    process.exit(0);
});
//# sourceMappingURL=index.js.map