export type Priority = "interrupt" | "steering" | "advisory" | "info";
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
    interrupted: {
        operation: string;
        partial_output: boolean;
    } | null;
    /** Sent by an agent because its human asked for it in that turn (who asked). */
    asked_by?: string | null;
}
export interface RegistryEntry {
    address: string;
    project: string;
    harness: {
        name: string;
        version?: string;
    };
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
export declare class Store {
    private db;
    constructor(path: string);
    audit(actor: string, action: string, detail: unknown): void;
    register(entry: Omit<RegistryEntry, "live" | "registered_at" | "last_seen_at">): RegistryEntry;
    heartbeat(address: string): void;
    markStale(address: string): void;
    byClientId(from: string, clientId: string): {
        id: string;
        to: string;
        priority: Priority;
    }[];
    /**
     * Retention: drop deliveries that are finished (processed or answered) and older than `days`,
     * and audit rows older than `auditDays`. Pending or unread deliveries are never pruned.
     */
    prune(days: number, auditDays: number): {
        deliveries: number;
        audit: number;
    };
    /**
     * ONE ANSWER to a message a human asked for: the recipient of a human-asked delivery may reply once,
     * to its sender, with the human's authority. Returns who asked, or null.
     */
    replyTicket(from: string, to: string, inReplyTo: string): string | null;
    /** The human lets an agent (address), a whole project ("project:<id>") or everyone ("*") send on its own. */
    allow(holder: string, minutes: number | null, by: string): void;
    disallow(holder: string, by: string): boolean;
    isAllowed(address: string, project: string | null): boolean;
    allowances(): {
        holder: string;
        until: string | null;
        granted_by: string;
    }[];
    /** Every live agent, every project: the directory a human's "message the agent in window X" is resolved against. */
    directory(): RegistryEntry[];
    /** Sends by `from` since `sinceIso`, and between `a` and `b` in either direction (flood and loop limits). */
    keyHash(address: string): string | null;
    /** Before the row exists (first registration) the fingerprint waits in a pending map and is written at register. */
    setKeyHash(address: string, hash: string): void;
    private pendingKeys;
    setState(address: string, state: "busy" | "idle"): void;
    sentSince(from: string, sinceIso: string): number;
    pairSince(a: string, b: string, sinceIso: string): number;
    sweepStale(leaseMs: number, keep: Set<string>): void;
    getAgent(address: string): RegistryEntry | null;
    roster(project: string, includeStale?: boolean): RegistryEntry[];
    agentsInProject(project: string): string[];
    addGrant(g: Omit<Grant, "id" | "granted_at">): Grant;
    revokeGrant(id: string, by: string): boolean;
    grantsHeldBy(holder: string): Grant[];
    /** May `from` send at `priority` to `to` (an agent in `toProject`)? Spec §9. */
    allowed(from: string, to: string, toProject: string, fromProject: string | null, priority: Priority): boolean;
    private hasGrant;
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
    }): Envelope;
    /**
     * The receiving binding reports what happened to a delivery inside its session.
     * placed: in the session context. read: a model call completed with it in context
     * (an auto-ack delivery is processed then). failed: a model call with it in context failed.
     * Returns the delivery when this is the FIRST failure (so the sender is told once).
     */
    receipt(address: string, id: string, stage: "placed" | "read" | "failed", reason?: string): {
        ok: boolean;
        firstFailure?: Envelope;
    };
    /** Where a delivery stands, for its sender, its recipient or the operator. */
    status(id: string, stuckAfterMs: number): Record<string, unknown> | null;
    /** Pending deliveries for an address, priority-ordered then send-ordered (D3). */
    inbox(address: string): Envelope[];
    /** Reading the inbox marks deliveries received (§8.5). */
    markReceived(address: string): void;
    ackProcessed(address: string, deliveryId: string): boolean;
    close(): void;
}
