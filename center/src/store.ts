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

export type Priority = "interrupt" | "steering" | "advisory" | "info";
const PRIORITY_ORDER: Record<Priority, number> = {
  interrupt: 0,
  steering: 1,
  advisory: 2,
  info: 3,
};

export interface Envelope {
  macp: "2.0";
  id: string;
  from: string;
  to: string;
  project: string;
  priority: Priority;
  sent_at: string;
  ack: "auto" | "required";
  in_reply_to: string | null;
  body: string;
  interrupted: { operation: string; partial_output: boolean } | null;
  /** Sent by an agent because its human asked for it in that turn (who asked). */
  asked_by?: string | null;
}

export interface RegistryEntry {
  address: string;
  project: string;
  harness: { name: string; version?: string };
  role: string | null;
  capabilities: string[];
  roots: string[];
  conformance: "L0" | "L1" | "L2" | "L3" | null;
  endpoint: string | null;
  /** Where it runs, as the harness describes it (machine, terminal window, folder) — for humans resolving names. */
  location?: string | null;
  /** busy | idle, as its harness last reported, and since when. */
  state?: string | null;
  state_at?: string | null;
  live: boolean;
  registered_at: string;
  last_seen_at: string | null;
}

export interface Grant {
  id: string;
  holder: string;
  subject: string;
  max_priority: "steering" | "interrupt";
  granted_by: string;
  granted_at: string;
  expires_at: string | null;
  note: string | null;
}

const now = () => new Date().toISOString();

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
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
    try { this.db.exec(`ALTER TABLE agents ADD COLUMN location TEXT`); } catch { /* exists */ }
    for (const col of ["state", "state_at", "key_hash"]) { try { this.db.exec(`ALTER TABLE agents ADD COLUMN ${col} TEXT`); } catch { /* exists */ } }
    for (const col of ["placed_at", "read_at", "failed_at", "fail_reason", "answered_at", "client_id", "asked_by"]) {
      try { this.db.exec(`ALTER TABLE deliveries ADD COLUMN ${col} TEXT`); } catch { /* exists */ }
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS allowances (holder TEXT PRIMARY KEY, until TEXT, granted_by TEXT NOT NULL, at TEXT NOT NULL)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS deliveries_client ON deliveries (from_addr, client_id) WHERE client_id IS NOT NULL`);
    const seeded = this.db.prepare(`SELECT COUNT(*) AS c FROM delivery_seq`).get() as { c: number };
    if (seeded.c === 0) this.db.prepare(`INSERT INTO delivery_seq (n) VALUES (0)`).run();
  }

  audit(actor: string, action: string, detail: unknown): void {
    this.db
      .prepare(`INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)`)
      .run(now(), actor, action, JSON.stringify(detail));
  }

  // ── registry ────────────────────────────────────────────────────────────

  register(entry: Omit<RegistryEntry, "live" | "registered_at" | "last_seen_at">): RegistryEntry {
    const registered_at = now();
    this.db
      .prepare(
        `INSERT INTO agents
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
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        entry.address,
        entry.project,
        entry.harness.name,
        entry.harness.version ?? null,
        entry.role,
        JSON.stringify(entry.capabilities),
        JSON.stringify(entry.roots),
        entry.conformance,
        entry.endpoint,
        registered_at,
        registered_at,
      );
    this.db.prepare(`UPDATE agents SET location = ? WHERE address = ?`).run(entry.location ?? null, entry.address);
    const pk = this.pendingKeys.get(entry.address);
    if (pk) { this.db.prepare(`UPDATE agents SET key_hash = ? WHERE address = ?`).run(pk, entry.address); this.pendingKeys.delete(entry.address); }
    this.audit(entry.address, "register", { project: entry.project, role: entry.role });
    return { ...entry, live: true, registered_at, last_seen_at: registered_at };
  }

  heartbeat(address: string): void {
    this.db.prepare(`UPDATE agents SET live = 1, last_seen_at = ? WHERE address = ?`).run(now(), address);
  }

  markStale(address: string): void {
    this.db.prepare(`UPDATE agents SET live = 0, last_seen_at = ? WHERE address = ?`).run(now(), address);
    this.audit(address, "stale", {});
  }

  byClientId(from: string, clientId: string): { id: string; to: string; priority: Priority }[] {
    return (this.db.prepare(`SELECT id, to_addr, priority FROM deliveries WHERE from_addr = ? AND client_id = ? ORDER BY seq`)
      .all(from, clientId) as Record<string, unknown>[]).map((r) => ({ id: r.id as string, to: r.to_addr as string, priority: r.priority as Priority }));
  }

  /**
   * Retention: drop deliveries that are finished (processed or answered) and older than `days`,
   * and audit rows older than `auditDays`. Pending or unread deliveries are never pruned.
   */
  prune(days: number, auditDays: number): { deliveries: number; audit: number } {
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
  replyTicket(from: string, to: string, inReplyTo: string): string | null {
    const o = this.db.prepare(`SELECT from_addr, asked_by FROM deliveries WHERE id = ? AND to_addr = ?`).get(inReplyTo, from) as { from_addr: string; asked_by: string | null } | undefined;
    if (!o?.asked_by || o.from_addr !== to) return null;
    const used = this.db.prepare(`SELECT 1 FROM deliveries WHERE from_addr = ? AND in_reply_to = ? LIMIT 1`).get(from, inReplyTo);
    return used ? null : o.asked_by;
  }

  /** The human lets an agent (address), a whole project ("project:<id>") or everyone ("*") send on its own. */
  allow(holder: string, minutes: number | null, by: string): void {
    const until = minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
    this.db.prepare(`INSERT OR REPLACE INTO allowances (holder, until, granted_by, at) VALUES (?, ?, ?, ?)`).run(holder, until, by, now());
    this.audit(by, "allow", { holder, until });
  }
  disallow(holder: string, by: string): boolean {
    const r = this.db.prepare(`DELETE FROM allowances WHERE holder = ?`).run(holder);
    this.audit(by, "disallow", { holder });
    return Number(r.changes) > 0;
  }
  isAllowed(address: string, project: string | null): boolean {
    const rows = this.db.prepare(`SELECT until FROM allowances WHERE holder IN (?, ?, '*')`).all(address, `project:${project ?? ""}`) as { until: string | null }[];
    return rows.some((r) => r.until === null || r.until > now());
  }
  allowances(): { holder: string; until: string | null; granted_by: string }[] {
    return this.db.prepare(`SELECT holder, until, granted_by FROM allowances WHERE until IS NULL OR until > ? ORDER BY holder`).all(now()) as any[];
  }
  /** Every live agent, every project: the directory a human's "message the agent in window X" is resolved against. */
  directory(): RegistryEntry[] {
    return (this.db.prepare(`SELECT * FROM agents WHERE live = 1 ORDER BY project, role`).all() as Record<string, unknown>[]).map(rowToEntry);
  }

  /** Sends by `from` since `sinceIso`, and between `a` and `b` in either direction (flood and loop limits). */
  keyHash(address: string): string | null {
    return ((this.db.prepare(`SELECT key_hash FROM agents WHERE address = ?`).get(address) as { key_hash?: string } | undefined)?.key_hash) ?? null;
  }
  /** Before the row exists (first registration) the fingerprint waits in a pending map and is written at register. */
  setKeyHash(address: string, hash: string): void {
    const r = this.db.prepare(`UPDATE agents SET key_hash = ? WHERE address = ?`).run(hash, address);
    if (Number(r.changes) === 0) this.pendingKeys.set(address, hash);
  }
  private pendingKeys = new Map<string, string>();

  setState(address: string, state: "busy" | "idle"): void {
    this.db.prepare(`UPDATE agents SET state = ?, state_at = ?, last_seen_at = ?, live = 1 WHERE address = ?`).run(state, now(), now(), address);
  }

  sentSince(from: string, sinceIso: string): number {
    return (this.db.prepare(`SELECT count(*) AS n FROM deliveries WHERE from_addr = ? AND sent_at > ?`).get(from, sinceIso) as { n: number }).n;
  }
  pairSince(a: string, b: string, sinceIso: string): number {
    return (this.db.prepare(`SELECT count(*) AS n FROM deliveries WHERE sent_at > ? AND ((from_addr = ? AND to_addr = ?) OR (from_addr = ? AND to_addr = ?))`).get(sinceIso, a, b, b, a) as { n: number }).n;
  }

  sweepStale(leaseMs: number, keep: Set<string>): void {
    const cutoff = new Date(Date.now() - leaseMs).toISOString();
    const rows = this.db.prepare(`SELECT address FROM agents WHERE live = 1 AND last_seen_at < ?`).all(cutoff) as { address: string }[];
    for (const { address } of rows) if (!keep.has(address)) this.markStale(address);
  }

  getAgent(address: string): RegistryEntry | null {
    const r = this.db.prepare(`SELECT * FROM agents WHERE address = ?`).get(address) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToEntry(r) : null;
  }

  roster(project: string, includeStale = false): RegistryEntry[] {
    const rows = this.db
      .prepare(
        includeStale
          ? `SELECT * FROM agents WHERE project = ? ORDER BY registered_at`
          : `SELECT * FROM agents WHERE project = ? AND live = 1 ORDER BY registered_at`,
      )
      .all(project) as Record<string, unknown>[];
    return rows.map(rowToEntry);
  }

  agentsInProject(project: string): string[] {
    return this.roster(project).map((e) => e.address);
  }

  // ── grants (spec §9) ───────────────────────────────────────────────────

  addGrant(g: Omit<Grant, "id" | "granted_at">): Grant {
    const grant: Grant = { ...g, id: `g_${randomUUID()}`, granted_at: now() };
    this.db
      .prepare(
        `INSERT INTO grants (id, holder, subject, max_priority, granted_by, granted_at, expires_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(grant.id, grant.holder, grant.subject, grant.max_priority, grant.granted_by, grant.granted_at, grant.expires_at, grant.note);
    this.audit(grant.granted_by, "grant", grant);
    return grant;
  }

  revokeGrant(id: string, by: string): boolean {
    const res = this.db.prepare(`UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now(), id);
    if (res.changes > 0) this.audit(by, "revoke", { id });
    return res.changes > 0;
  }

  grantsHeldBy(holder: string): Grant[] {
    const rows = this.db
      .prepare(`SELECT * FROM grants WHERE holder = ? AND revoked_at IS NULL`)
      .all(holder) as Record<string, unknown>[];
    return rows.map(rowToGrant).filter((g) => !expired(g));
  }

  /** May `from` send at `priority` to `to` (an agent in `toProject`)? Spec §9. */
  allowed(from: string, to: string, toProject: string, fromProject: string | null, priority: Priority): boolean {
    // G3: the operator may send ANY priority to any agent in any project. The reference checked this
    // only for steering/interrupt, so an operator's advisory/info was filed as cross-project and dropped.
    if (from.startsWith("human://")) return true;
    if (priority === "advisory" || priority === "info") {
      // No grant needed within a project (G1); cross-project still needs a link/grant (§5.4).
      return fromProject === toProject || this.hasGrant(from, to, toProject, fromProject, "steering", true);
    }
    if (from.startsWith("human://")) return true; // G3 operator precedence
    return this.hasGrant(from, to, toProject, fromProject, priority === "interrupt" ? "interrupt" : "steering", false);
  }

  private hasGrant(
    from: string,
    to: string,
    toProject: string,
    fromProject: string | null,
    needed: "steering" | "interrupt",
    anyPriorityCounts: boolean,
  ): boolean {
    const rows = this.db
      .prepare(`SELECT * FROM grants WHERE revoked_at IS NULL AND (holder = ? OR holder = ?)`)
      .all(from, fromProject ? `project:${fromProject}` : "__none__") as Record<string, unknown>[];
    return rows.map(rowToGrant).some((g) => {
      if (expired(g)) return false;
      const covers =
        g.subject === to ||
        g.subject === `project:${toProject}` ||
        (fromProject !== null &&
          (g.subject === `link:${fromProject}:${toProject}` || g.subject === `link:${toProject}:${fromProject}`));
      if (!covers) return false;
      if (anyPriorityCounts) return true;
      return needed === "steering" || g.max_priority === "interrupt";
    });
  }

  // ── deliveries (spec §7, §8.5) ─────────────────────────────────────────

  send(input: {
    from: string;
    to: string;
    project: string;
    priority: Priority;
    ack: "auto" | "required";
    in_reply_to: string | null;
    body: string;
    client_id?: string | null;
    asked_by?: string | null;
  }): Envelope {
    const seqRow = this.db.prepare(`UPDATE delivery_seq SET n = n + 1 RETURNING n`).get() as { n: number };
    const env: Envelope = {
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
      .prepare(
        `INSERT INTO deliveries
           (id, seq, from_addr, to_addr, project, priority, sent_at, ack, in_reply_to, body, interrupted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(env.id, seqRow.n, env.from, env.to, env.project, env.priority, env.sent_at, env.ack, env.in_reply_to, env.body);
    if (input.client_id) this.db.prepare(`UPDATE deliveries SET client_id = ? WHERE id = ?`).run(input.client_id, env.id);
    if (input.asked_by) { this.db.prepare(`UPDATE deliveries SET asked_by = ? WHERE id = ?`).run(input.asked_by, env.id); env.asked_by = input.asked_by; }
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
  receipt(address: string, id: string, stage: "placed" | "read" | "failed", reason?: string): { ok: boolean; firstFailure?: Envelope } {
    const row = this.db.prepare(`SELECT * FROM deliveries WHERE id = ? AND to_addr = ?`).get(id, address) as Record<string, unknown> | undefined;
    if (!row) return { ok: false };
    const t = now();
    if (stage === "placed") this.db.prepare(`UPDATE deliveries SET placed_at = COALESCE(placed_at, ?), received_at = COALESCE(received_at, ?) WHERE id = ?`).run(t, t, id);
    if (stage === "read") {
      this.db.prepare(`UPDATE deliveries SET read_at = COALESCE(read_at, ?), placed_at = COALESCE(placed_at, ?) WHERE id = ?`).run(t, t, id);
      if (row.ack === "auto") this.db.prepare(`UPDATE deliveries SET processed_at = COALESCE(processed_at, ?) WHERE id = ?`).run(t, id);
    }
    if (stage === "failed") this.db.prepare(`UPDATE deliveries SET failed_at = ?, fail_reason = ? WHERE id = ?`).run(t, (reason ?? "unknown").slice(0, 500), id);
    this.audit(address, `receipt-${stage}`, { id, ...(reason ? { reason: reason.slice(0, 200) } : {}) });
    return { ok: true, ...(stage === "failed" && row.failed_at == null && row.read_at == null ? { firstFailure: rowToEnvelope(row) } : {}) };
  }

  /** Where a delivery stands, for its sender, its recipient or the operator. */
  status(id: string, stuckAfterMs: number): Record<string, unknown> | null {
    let r = this.db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!r && id.length >= 8) { // a unique prefix, as /talk trace prints
      const rows = this.db.prepare(`SELECT * FROM deliveries WHERE id LIKE ? LIMIT 2`).all(`${id}%`) as Record<string, unknown>[];
      if (rows.length === 1) r = rows[0];
    }
    if (!r) return null;
    id = r.id as string;
    const receiver = this.getAgent(r.to_addr as string);
    const wakes = r.priority === "interrupt" || r.priority === "steering";
    const placedFor = r.placed_at ? Date.now() - Date.parse(r.placed_at as string) : 0;
    let stage: string, detail: string;
    if (r.answered_at) { stage = "answered"; detail = "the recipient replied"; }
    else if (r.read_at && r.ack === "required" && r.processed_at) { stage = "answered"; detail = "the recipient acknowledged it"; }
    else if (r.read_at) { stage = "read"; detail = "a model call completed with it in context"; }
    else if (r.failed_at) { stage = "failed"; detail = `the recipient's model call failed: ${r.fail_reason}`; }
    else if (r.placed_at && !receiver?.live) { stage = "stuck"; detail = "placed, then the recipient went offline before any model call"; }
    else if (r.placed_at && wakes && placedFor > stuckAfterMs) { stage = "stuck"; detail = `placed ${Math.round(placedFor / 1000)}s ago and no model call has completed since (waiting at a prompt or dialog, or wedged)`; }
    else if (r.placed_at) { stage = "placed"; detail = wakes ? "in the recipient's context; its next model call will read it" : "in the recipient's context; it does not wake an idle agent, so it is read at its next turn"; }
    else if (!receiver?.live) { stage = "accepted"; detail = "stored; the recipient is offline and gets it when it reconnects"; }
    else if (r.received_at) { stage = "fetched"; detail = "the recipient's binding fetched it but has not placed it"; }
    else { stage = "accepted"; detail = "stored; the recipient has not fetched it (it may not run a MACP binding)"; }
    const at = (k: string) => (r[k] as string | null) ?? null;
    return {
      id, from: r.from_addr, to: r.to_addr, priority: r.priority, stage, detail,
      times: { accepted: at("sent_at"), fetched: at("received_at"), placed: at("placed_at"), read: at("read_at"), failed: at("failed_at"), answered: at("answered_at") },
      ...(r.fail_reason ? { last_failure: r.fail_reason } : {}),
      receiver_live: !!receiver?.live,
    };
  }

  /** Pending deliveries for an address, priority-ordered then send-ordered (D3). */
  inbox(address: string): Envelope[] {
    const rows = this.db
      .prepare(`SELECT * FROM deliveries WHERE to_addr = ? AND processed_at IS NULL AND placed_at IS NULL ORDER BY seq`)
      .all(address) as Record<string, unknown>[];
    return rows
      .map(rowToEnvelope)
      .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  }

  /** Reading the inbox marks deliveries received (§8.5). */
  markReceived(address: string): void {
    this.db
      .prepare(`UPDATE deliveries SET received_at = ? WHERE to_addr = ? AND received_at IS NULL AND processed_at IS NULL`)
      .run(now(), address);
  }

  ackProcessed(address: string, deliveryId: string): boolean {
    const res = this.db
      .prepare(`UPDATE deliveries SET processed_at = ? WHERE id = ? AND to_addr = ? AND processed_at IS NULL`)
      .run(now(), deliveryId, address);
    if (res.changes > 0) this.audit(address, "ack", { id: deliveryId });
    return res.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

// ── row mappers ─────────────────────────────────────────────────────────

function rowToEntry(r: Record<string, unknown>): RegistryEntry {
  return {
    address: r.address as string,
    project: r.project as string,
    harness: { name: r.harness_name as string, version: (r.harness_version as string) ?? undefined },
    role: (r.role as string) ?? null,
    capabilities: JSON.parse(r.capabilities as string),
    roots: JSON.parse(r.roots as string),
    conformance: (r.conformance as RegistryEntry["conformance"]) ?? null,
    endpoint: (r.endpoint as string) ?? null,
    location: (r.location as string) ?? null,
    state: (r.state as string) ?? null,
    state_at: (r.state_at as string) ?? null,
    live: (r.live as number) === 1,
    registered_at: r.registered_at as string,
    last_seen_at: (r.last_seen_at as string) ?? null,
  };
}

function rowToGrant(r: Record<string, unknown>): Grant {
  return {
    id: r.id as string,
    holder: r.holder as string,
    subject: r.subject as string,
    max_priority: r.max_priority as Grant["max_priority"],
    granted_by: r.granted_by as string,
    granted_at: r.granted_at as string,
    expires_at: (r.expires_at as string) ?? null,
    note: (r.note as string) ?? null,
  };
}

function rowToEnvelope(r: Record<string, unknown>): Envelope {
  return {
    macp: "2.0",
    id: r.id as string,
    from: r.from_addr as string,
    to: r.to_addr as string,
    project: r.project as string,
    priority: r.priority as Priority,
    sent_at: r.sent_at as string,
    ack: r.ack as "auto" | "required",
    in_reply_to: (r.in_reply_to as string) ?? null,
    body: r.body as string,
    interrupted: r.interrupted ? JSON.parse(r.interrupted as string) : null,
    ...(r.asked_by ? { asked_by: r.asked_by as string } : {}),
  };
}

function expired(g: Grant): boolean {
  return g.expires_at !== null && g.expires_at < now();
}
