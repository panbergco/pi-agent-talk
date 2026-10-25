/**
 * MACP 2.0 reference center — store.
 *
 * Storage is implementation-private per spec §3; this reference uses an
 * embedded SQLite database (node:sqlite, no native build step). Any backend
 * satisfying spec §7.4 (durable until acked, per-recipient order within a
 * priority, full audit) is equally valid.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
const PRIORITY_ORDER = {
    interrupt: 0,
    steering: 1,
    advisory: 2,
    info: 3,
};
const now = () => new Date().toISOString();
export class Store {
    db;
    constructor(path) {
        this.db = new DatabaseSync(path);
        this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agents (
        address TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        harness_name TEXT NOT NULL,
        harness_version TEXT,
        role TEXT,
        capabilities TEXT NOT NULL DEFAULT '[]',
        roots TEXT NOT NULL DEFAULT '[]',
        conformance TEXT,
        endpoint TEXT,
        live INTEGER NOT NULL DEFAULT 1,
        registered_at TEXT NOT NULL,
        last_seen_at TEXT
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        seq INTEGER,
        from_addr TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        project TEXT NOT NULL,
        priority TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        ack TEXT NOT NULL,
        in_reply_to TEXT,
        body TEXT NOT NULL,
        interrupted TEXT,
        received_at TEXT,
        processed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS deliveries_pending
        ON deliveries (to_addr, processed_at, seq);
      CREATE TABLE IF NOT EXISTS delivery_seq (n INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS grants (
        id TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        subject TEXT NOT NULL,
        max_priority TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        expires_at TEXT,
        note TEXT,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS audit (
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL
      );
    `);
        // Receipt stages (pi-agent-talk extension of §8.5): placed → read → answered, or failed.
        try {
            this.db.exec(`ALTER TABLE agents ADD COLUMN location TEXT`);
        }
        catch { /* exists */ }
        for (const col of ["state", "state_at", "key_hash"]) {
            try {
                this.db.exec(`ALTER TABLE agents ADD COLUMN ${col} TEXT`);
            }
            catch { /* exists */ }
        }
        for (const col of ["placed_at", "read_at", "failed_at", "fail_reason", "answered_at", "client_id", "asked_by"]) {
            try {
                this.db.exec(`ALTER TABLE deliveries ADD COLUMN ${col} TEXT`);
            }
            catch { /* exists */ }
        }
        this.db.exec(`CREATE TABLE IF NOT EXISTS allowances (holder TEXT PRIMARY KEY, until TEXT, granted_by TEXT NOT NULL, at TEXT NOT NULL)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS deliveries_client ON deliveries (from_addr, client_id) WHERE client_id IS NOT NULL`);
        const seeded = this.db.prepare(`SELECT COUNT(*) AS c FROM delivery_seq`).get();
        if (seeded.c === 0)
            this.db.prepare(`INSERT INTO delivery_seq (n) VALUES (0)`).run();
    }
    audit(actor, action, detail) {
        this.db
            .prepare(`INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)`)
            .run(now(), actor, action, JSON.stringify(detail));
    }
    // ── registry ────────────────────────────────────────────────────────────
    register(entry) {
        const registered_at = now();
        this.db
            .prepare(`INSERT INTO agents
           (address, project, harness_name, harness_version, role, capabilities,
            roots, conformance, endpoint, live, registered_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           project = excluded.project,
           harness_name = excluded.harness_name,
           harness_version = excluded.harness_version,
           role = excluded.role,
           capabilities = excluded.capabilities,
           roots = excluded.roots,
           conformance = excluded.conformance,
           endpoint = excluded.endpoint,
           live = 1,
           last_seen_at = excluded.last_seen_at`)
            .run(entry.address, entry.project, entry.harness.name, entry.harness.version ?? null, entry.role, JSON.stringify(entry.capabilities), JSON.stringify(entry.roots), entry.conformance, entry.endpoint, registered_at, registered_at);
        this.db.prepare(`UPDATE agents SET location = ? WHERE address = ?`).run(entry.location ?? null, entry.address);
        const pk = this.pendingKeys.get(entry.address);
        if (pk) {
            this.db.prepare(`UPDATE agents SET key_hash = ? WHERE address = ?`).run(pk, entry.address);
            this.pendingKeys.delete(entry.address);
        }
        this.audit(entry.address, "register", { project: entry.project, role: entry.role });
        return { ...entry, live: true, registered_at, last_seen_at: registered_at };
    }
    heartbeat(address) {
        this.db.prepare(`UPDATE agents SET live = 1, last_seen_at = ? WHERE address = ?`).run(now(), address);
    }
    markStale(address) {
        this.db.prepare(`UPDATE agents SET live = 0, last_seen_at = ? WHERE address = ?`).run(now(), address);
        this.audit(address, "stale", {});
    }
    byClientId(from, clientId) {
        return this.db.prepare(`SELECT id, to_addr, priority FROM deliveries WHERE from_addr = ? AND client_id = ? ORDER BY seq`)
            .all(from, clientId).map((r) => ({ id: r.id, to: r.to_addr, priority: r.priority }));
    }
    /**
     * Retention: drop deliveries that are finished (processed or answered) and older than `days`,
     * and audit rows older than `auditDays`. Pending or unread deliveries are never pruned.
     */
    prune(days, auditDays) {
        const cut = new Date(Date.now() - days * 86_400_000).toISOString();
        const acut = new Date(Date.now() - auditDays * 86_400_000).toISOString();
        const d = this.db.prepare(`DELETE FROM deliveries WHERE sent_at < ? AND (processed_at IS NOT NULL OR answered_at IS NOT NULL)`).run(cut);
        const a = this.db.prepare(`DELETE FROM audit WHERE at < ?`).run(acut);
        return { deliveries: Number(d.changes), audit: Number(a.changes) };
    }
    /**
     * ONE ANSWER to a message a human asked for: the recipient of a human-asked delivery may reply once,
     * to its sender, with the human's authority. Returns who asked, or null.
     */
    replyTicket(from, to, inReplyTo) {
        const o = this.db.prepare(`SELECT from_addr, asked_by FROM deliveries WHERE id = ? AND to_addr = ?`).get(inReplyTo, from);
        if (!o?.asked_by || o.from_addr !== to)
            return null;
        const used = this.db.prepare(`SELECT 1 FROM deliveries WHERE from_addr = ? AND in_reply_to = ? LIMIT 1`).get(from, inReplyTo);
        return used ? null : o.asked_by;
    }
    /** The human lets an agent (address), a whole project ("project:<id>") or everyone ("*") send on its own. */
    allow(holder, minutes, by) {
        const until = minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
        this.db.prepare(`INSERT OR REPLACE INTO allowances (holder, until, granted_by, at) VALUES (?, ?, ?, ?)`).run(holder, until, by, now());
        this.audit(by, "allow", { holder, until });
    }
    disallow(holder, by) {
        const r = this.db.prepare(`DELETE FROM allowances WHERE holder = ?`).run(holder);
        this.audit(by, "disallow", { holder });
        return Number(r.changes) > 0;
    }
    isAllowed(address, project) {
        const rows = this.db.prepare(`SELECT until FROM allowances WHERE holder IN (?, ?, '*')`).all(address, `project:${project ?? ""}`);
        return rows.some((r) => r.until === null || r.until > now());
    }
    allowances() {
        return this.db.prepare(`SELECT holder, until, granted_by FROM allowances WHERE until IS NULL OR until > ? ORDER BY holder`).all(now());
    }
    /** Every live agent, every project: the directory a human's "message the agent in window X" is resolved against. */
    directory() {
        return this.db.prepare(`SELECT * FROM agents WHERE live = 1 ORDER BY project, role`).all().map(rowToEntry);
    }
    /** Sends by `from` since `sinceIso`, and between `a` and `b` in either direction (flood and loop limits). */
    keyHash(address) {
        return (this.db.prepare(`SELECT key_hash FROM agents WHERE address = ?`).get(address)?.key_hash) ?? null;
    }
    /** Before the row exists (first registration) the fingerprint waits in a pending map and is written at register. */
    setKeyHash(address, hash) {
        const r = this.db.prepare(`UPDATE agents SET key_hash = ? WHERE address = ?`).run(hash, address);
        if (Number(r.changes) === 0)
            this.pendingKeys.set(address, hash);
    }
    pendingKeys = new Map();
    setState(address, state) {
        this.db.prepare(`UPDATE agents SET state = ?, state_at = ?, last_seen_at = ?, live = 1 WHERE address = ?`).run(state, now(), now(), address);
    }
    sentSince(from, sinceIso) {
        return this.db.prepare(`SELECT count(*) AS n FROM deliveries WHERE from_addr = ? AND sent_at > ?`).get(from, sinceIso).n;
    }
    pairSince(a, b, sinceIso) {
        return this.db.prepare(`SELECT count(*) AS n FROM deliveries WHERE sent_at > ? AND ((from_addr = ? AND to_addr = ?) OR (from_addr = ? AND to_addr = ?))`).get(sinceIso, a, b, b, a).n;
    }
    sweepStale(leaseMs, keep) {
        const cutoff = new Date(Date.now() - leaseMs).toISOString();
        const rows = this.db.prepare(`SELECT address FROM agents WHERE live = 1 AND last_seen_at < ?`).all(cutoff);
        for (const { address } of rows)
            if (!keep.has(address))
                this.markStale(address);
    }
    getAgent(address) {
        const r = this.db.prepare(`SELECT * FROM agents WHERE address = ?`).get(address);
        return r ? rowToEntry(r) : null;
    }
    roster(project, includeStale = false) {
        const rows = this.db
            .prepare(includeStale
            ? `SELECT * FROM agents WHERE project = ? ORDER BY registered_at`
            : `SELECT * FROM agents WHERE project = ? AND live = 1 ORDER BY registered_at`)
            .all(project);
        return rows.map(rowToEntry);
    }
    agentsInProject(project) {
        return this.roster(project).map((e) => e.address);
    }
    // ── grants (spec §9) ───────────────────────────────────────────────────
    addGrant(g) {
        const grant = { ...g, id: `g_${randomUUID()}`, granted_at: now() };
        this.db
            .prepare(`INSERT INTO grants (id, holder, subject, max_priority, granted_by, granted_at, expires_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(grant.id, grant.holder, grant.subject, grant.max_priority, grant.granted_by, grant.granted_at, grant.expires_at, grant.note);
        this.audit(grant.granted_by, "grant", grant);
        return grant;
    }
    revokeGrant(id, by) {
        const res = this.db.prepare(`UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now(), id);
        if (res.changes > 0)
            this.audit(by, "revoke", { id });
        return res.changes > 0;
    }
    grantsHeldBy(holder) {
        const rows = this.db
            .prepare(`SELECT * FROM grants WHERE holder = ? AND revoked_at IS NULL`)
            .all(holder);
        return rows.map(rowToGrant).filter((g) => !expired(g));
    }
    /** May `from` send at `priority` to `to` (an agent in `toProject`)? Spec §9. */
    allowed(from, to, toProject, fromProject, priority) {
        // G3: the operator may send ANY priority to any agent in any project. The reference checked this
        // only for steering/interrupt, so an operator's advisory/info was filed as cross-project and dropped.
        if (from.startsWith("human://"))
            return true;
        if (priority === "advisory" || priority === "info") {
            // No grant needed within a project (G1); cross-project still needs a link/grant (§5.4).
            return fromProject === toProject || this.hasGrant(from, to, toProject, fromProject, "steering", true);
        }
        if (from.startsWith("human://"))
            return true; // G3 operator precedence
        return this.hasGrant(from, to, toProject, fromProject, priority === "interrupt" ? "interrupt" : "steering", false);
    }
    hasGrant(from, to, toProject, fromProject, needed, anyPriorityCounts) {
        const rows = this.db
            .prepare(`SELECT * FROM grants WHERE revoked_at IS NULL AND (holder = ? OR holder = ?)`)
            .all(from, fromProject ? `project:${fromProject}` : "__none__");
        return rows.map(rowToGrant).some((g) => {
            if (expired(g))
                return false;
            const covers = g.subject === to ||
                g.subject === `project:${toProject}` ||
                (fromProject !== null &&
                    (g.subject === `link:${fromProject}:${toProject}` || g.subject === `link:${toProject}:${fromProject}`));
            if (!covers)
                return false;
            if (anyPriorityCounts)
                return true;
            return needed === "steering" || g.max_priority === "interrupt";
        });
    }
    // ── deliveries (spec §7, §8.5) ─────────────────────────────────────────
    send(input) {
        const seqRow = this.db.prepare(`UPDATE delivery_seq SET n = n + 1 RETURNING n`).get();
        const env = {
            macp: "2.0",
            id: `d_${randomUUID()}`,
            from: input.from,
            to: input.to,
            project: input.project,
            priority: input.priority,
            sent_at: now(),
            ack: input.ack,
            in_reply_to: input.in_reply_to,
            body: input.body,
            interrupted: null,
        };
        this.db
            .prepare(`INSERT INTO deliveries
           (id, seq, from_addr, to_addr, project, priority, sent_at, ack, in_reply_to, body, interrupted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
            .run(env.id, seqRow.n, env.from, env.to, env.project, env.priority, env.sent_at, env.ack, env.in_reply_to, env.body);
        if (input.client_id)
            this.db.prepare(`UPDATE deliveries SET client_id = ? WHERE id = ?`).run(input.client_id, env.id);
        if (input.asked_by) {
            this.db.prepare(`UPDATE deliveries SET asked_by = ? WHERE id = ?`).run(input.asked_by, env.id);
            env.asked_by = input.asked_by;
        }
        this.audit(input.from, "send", { id: env.id, to: env.to, priority: env.priority });
        // A reply by the recipient answers the original (stage 4), with no extra call.
        if (input.in_reply_to) {
            this.db
                .prepare(`UPDATE deliveries SET answered_at = ? WHERE id = ? AND to_addr = ? AND answered_at IS NULL`)
                .run(env.sent_at, input.in_reply_to, input.from);
        }
        return env;
    }
    /**
     * The receiving binding reports what happened to a delivery inside its session.
     * placed: in the session context. read: a model call completed with it in context
     * (an auto-ack delivery is processed then). failed: a model call with it in context failed.
     * Returns the delivery when this is the FIRST failure (so the sender is told once).
     */
    receipt(address, id, stage, reason) {
        const row = this.db.prepare(`SELECT * FROM deliveries WHERE id = ? AND to_addr = ?`).get(id, address);
        if (!row)
            return { ok: false };
        const t = now();
        if (stage === "placed")
            this.db.prepare(`UPDATE deliveries SET placed_at = COALESCE(placed_at, ?), received_at = COALESCE(received_at, ?) WHERE id = ?`).run(t, t, id);
        if (stage === "read") {
            this.db.prepare(`UPDATE deliveries SET read_at = COALESCE(read_at, ?), placed_at = COALESCE(placed_at, ?) WHERE id = ?`).run(t, t, id);
            if (row.ack === "auto")
                this.db.prepare(`UPDATE deliveries SET processed_at = COALESCE(processed_at, ?) WHERE id = ?`).run(t, id);
        }
        if (stage === "failed")
            this.db.prepare(`UPDATE deliveries SET failed_at = ?, fail_reason = ? WHERE id = ?`).run(t, (reason ?? "unknown").slice(0, 500), id);
        this.audit(address, `receipt-${stage}`, { id, ...(reason ? { reason: reason.slice(0, 200) } : {}) });
        return { ok: true, ...(stage === "failed" && row.failed_at == null && row.read_at == null ? { firstFailure: rowToEnvelope(row) } : {}) };
    }
    /** Where a delivery stands, for its sender, its recipient or the operator. */
    status(id, stuckAfterMs) {
        let r = this.db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(id);
        if (!r && id.length >= 8) { // a unique prefix, as /talk trace prints
            const rows = this.db.prepare(`SELECT * FROM deliveries WHERE id LIKE ? LIMIT 2`).all(`${id}%`);
            if (rows.length === 1)
                r = rows[0];
        }
        if (!r)
            return null;
        id = r.id;
        const receiver = this.getAgent(r.to_addr);
        const wakes = r.priority === "interrupt" || r.priority === "steering";
        const placedFor = r.placed_at ? Date.now() - Date.parse(r.placed_at) : 0;
        let stage, detail;
        if (r.answered_at) {
            stage = "answered";
            detail = "the recipient replied";
        }
        else if (r.read_at && r.ack === "required" && r.processed_at) {
            stage = "answered";
            detail = "the recipient acknowledged it";
        }
        else if (r.read_at) {
            stage = "read";
            detail = "a model call completed with it in context";
        }
        else if (r.failed_at) {
            stage = "failed";
            detail = `the recipient's model call failed: ${r.fail_reason}`;
        }
        else if (r.placed_at && !receiver?.live) {
            stage = "stuck";
            detail = "placed, then the recipient went offline before any model call";
        }
        else if (r.placed_at && wakes && placedFor > stuckAfterMs) {
            stage = "stuck";
            detail = `placed ${Math.round(placedFor / 1000)}s ago and no model call has completed since (waiting at a prompt or dialog, or wedged)`;
        }
        else if (r.placed_at) {
            stage = "placed";
            detail = wakes ? "in the recipient's context; its next model call will read it" : "in the recipient's context; it does not wake an idle agent, so it is read at its next turn";
        }
        else if (!receiver?.live) {
            stage = "accepted";
            detail = "stored; the recipient is offline and gets it when it reconnects";
        }
        else if (r.received_at) {
            stage = "fetched";
            detail = "the recipient's binding fetched it but has not placed it";
        }
        else {
            stage = "accepted";
            detail = "stored; the recipient has not fetched it (it may not run a MACP binding)";
        }
        const at = (k) => r[k] ?? null;
        return {
            id, from: r.from_addr, to: r.to_addr, priority: r.priority, stage, detail,
            times: { accepted: at("sent_at"), fetched: at("received_at"), placed: at("placed_at"), read: at("read_at"), failed: at("failed_at"), answered: at("answered_at") },
            ...(r.fail_reason ? { last_failure: r.fail_reason } : {}),
            receiver_live: !!receiver?.live,
        };
    }
    /** Pending deliveries for an address, priority-ordered then send-ordered (D3). */
    inbox(address) {
        const rows = this.db
            .prepare(`SELECT * FROM deliveries WHERE to_addr = ? AND processed_at IS NULL AND placed_at IS NULL ORDER BY seq`)
            .all(address);
        return rows
            .map(rowToEnvelope)
            .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
    }
    /** Reading the inbox marks deliveries received (§8.5). */
    markReceived(address) {
        this.db
            .prepare(`UPDATE deliveries SET received_at = ? WHERE to_addr = ? AND received_at IS NULL AND processed_at IS NULL`)
            .run(now(), address);
    }
    ackProcessed(address, deliveryId) {
        const res = this.db
            .prepare(`UPDATE deliveries SET processed_at = ? WHERE id = ? AND to_addr = ? AND processed_at IS NULL`)
            .run(now(), deliveryId, address);
        if (res.changes > 0)
            this.audit(address, "ack", { id: deliveryId });
        return res.changes > 0;
    }
    close() {
        this.db.close();
    }
}
// ── row mappers ─────────────────────────────────────────────────────────
function rowToEntry(r) {
    return {
        address: r.address,
        project: r.project,
        harness: { name: r.harness_name, version: r.harness_version ?? undefined },
        role: r.role ?? null,
        capabilities: JSON.parse(r.capabilities),
        roots: JSON.parse(r.roots),
        conformance: r.conformance ?? null,
        endpoint: r.endpoint ?? null,
        location: r.location ?? null,
        state: r.state ?? null,
        state_at: r.state_at ?? null,
        live: r.live === 1,
        registered_at: r.registered_at,
        last_seen_at: r.last_seen_at ?? null,
    };
}
function rowToGrant(r) {
    return {
        id: r.id,
        holder: r.holder,
        subject: r.subject,
        max_priority: r.max_priority,
        granted_by: r.granted_by,
        granted_at: r.granted_at,
        expires_at: r.expires_at ?? null,
        note: r.note ?? null,
    };
}
function rowToEnvelope(r) {
    return {
        macp: "2.0",
        id: r.id,
        from: r.from_addr,
        to: r.to_addr,
        project: r.project,
        priority: r.priority,
        sent_at: r.sent_at,
        ack: r.ack,
        in_reply_to: r.in_reply_to ?? null,
        body: r.body,
        interrupted: r.interrupted ? JSON.parse(r.interrupted) : null,
        ...(r.asked_by ? { asked_by: r.asked_by } : {}),
    };
}
function expired(g) {
    return g.expires_at !== null && g.expires_at < now();
}
//# sourceMappingURL=store.js.map