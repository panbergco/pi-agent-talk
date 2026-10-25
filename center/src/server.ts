/**
 * MACP 2.0 reference center — per-session MCP server (spec §6).
 * Tools: macp_register / macp_send / macp_ack / macp_roster / macp_grant.
 * Resources: macp://self · macp://project/{project}/roster · macp://agent/{address}/inbox.
 * All standard MCP: no custom methods, no custom notification types.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";

const hashKey = (k: string) => createHash("sha256").update(k).digest("hex");
const newKey = () => randomBytes(32).toString("base64url");
import { Store, type Priority } from "./store.js";
import { resolveProject } from "./scope.js";
import { Policy, lower, within } from "./policy.js";

/** A waking delivery placed this long without a completed model call is reported stuck. */
const STUCK_MS = Number(process.env.MACP_STUCK_SECONDS ?? 120) * 1000;

export interface SessionCtx {
  sessionId: string;
  address: string | null; // assigned at register (or provisional)
  project: string | null;
  isOperator: boolean;
  roots: string[];
  subscriptions: Set<string>; // resource URIs this session subscribed to
  server: McpServer;
}

/** Cross-session router: address → live session, for inbox update notifications. */
export class Notifier {
  private byAddress = new Map<string, SessionCtx>();

  bind(ctx: SessionCtx): void {
    if (ctx.address) this.byAddress.set(ctx.address, ctx);
  }

  unbind(ctx: SessionCtx): void {
    if (ctx.address && this.byAddress.get(ctx.address) === ctx) this.byAddress.delete(ctx.address);
  }

  /** The live connection currently holding an identity, if any. */
  holder(address: string): SessionCtx | undefined {
    return this.byAddress.get(address);
  }

  /** Notify the recipient's session that its inbox resource changed (spec §6.2/§6.3 rung 1). */
  async notifyInbox(address: string): Promise<void> {
    const ctx = this.byAddress.get(address);
    if (!ctx) return; // offline — delivery waits durably in the store
    const uri = `macp://agent/${address}/inbox`;
    if (!ctx.subscriptions.has(uri)) return;
    try {
      await ctx.server.server.sendResourceUpdated({ uri });
    } catch {
      /* session racing shutdown — the delivery remains in the store */
    }
  }
}

const prioritySchema = z.enum(["interrupt", "steering", "advisory", "info"]);

export function buildSessionServer(store: Store, notifier: Notifier, opts: { operatorToken: string | null; policy?: Policy; strict?: boolean }): SessionCtx {
  const server = new McpServer(
    { name: "macp-center", version: "0.1.0" },
    { capabilities: { resources: { subscribe: true, listChanged: true }, tools: {}, logging: {} } },
  );

  const ctx: SessionCtx = {
    sessionId: "",
    address: null,
    project: null,
    isOperator: false,
    roots: [],
    subscriptions: new Set(),
    server,
  };

  // ── macp_register (spec §5.1, §6.1) ─────────────────────────────────────
  server.registerTool(
    "macp_register",
    {
      description:
        "Register this connection as an agent. Returns the assigned address. " +
        "Project resolves per spec §5.3: explicit > repository identity > workspace path.",
      inputSchema: {
        agent_id: z.string().min(1).describe("The harness's stable identifier for this agent (session ID or equivalent)."),
        harness: z.string().min(1).describe("Lowercase harness product id (e.g. 'opencode', 'pi')."),
        role: z.string().nullable().optional(),
        capabilities: z.array(z.string()).optional(),
        project: z.string().nullable().optional().describe("Explicit logical project (strongest scope evidence)."),
        conformance: z.enum(["L0", "L1", "L2", "L3"]).nullable().optional(),
        endpoint: z.string().nullable().optional().describe("Optional L3 drive endpoint served by this agent's harness."),
        location: z.string().max(300).nullable().optional().describe("Where this agent runs, for humans: machine, terminal window, folder."),
        operator_token: z.string().optional().describe("Present + matching registers this connection as the human operator."),
        key: z.string().optional().describe("Strict identity: the secret this identity was issued; held only in the harness's memory."),
        via_address: z.string().optional().describe("Strict identity, operator: the live session the human is working in…"),
        via_key: z.string().optional().describe("…and that session's secret."),
      },
    },
    async (args) => {
      // Operator registration (spec §9 G3): local trust when no token configured.
      if (args.operator_token !== undefined || args.harness === "operator") {
        let ok = opts.operatorToken === null || args.operator_token === opts.operatorToken;
        if (opts.strict) {
          // STRICT: claiming to be the human needs the operator key, or the secret of a LIVE session the human works in
          // (/talk in that session). A process that merely says "operator" — an agent's shell — is refused.
          const byToken = opts.operatorToken !== null && args.operator_token === opts.operatorToken;
          const via = args.via_address && args.via_key && notifier.holder(args.via_address) && store.keyHash(args.via_address) === hashKey(args.via_key);
          ok = byToken || !!via;
          if (!ok) store.audit(`human://${args.agent_id}`, "refused-operator", { via: args.via_address ?? null });
        }
        if (!ok) return err(opts.strict ? "operator registration refused: the human acts through a live session (/talk) or with the operator key" : "operator registration rejected: bad token");
        ctx.isOperator = true;
        ctx.address = `human://${args.agent_id}`;
        ctx.project = null;
        notifier.bind(ctx);
        store.audit(ctx.address, "register-operator", {});
        return ok_({ address: ctx.address, operator: true });
      }

      // Best-effort roots from the client (scope evidence).
      try {
        const caps = server.server.getClientCapabilities();
        if (caps?.roots) {
          const res = await server.server.listRoots();
          ctx.roots = res.roots.map((r) => r.uri);
        }
      } catch {
        /* client has no roots support — evidence ladder continues */
      }

      const clientInfo = server.server.getClientVersion();
      const project = resolveProject(args.project ?? null, ctx.roots);
      const address = `agent://${args.harness}/${args.agent_id}`;

      // STRICT IDENTITY: an identity is locked to the secret of the process that holds it. The secret lives only
      // in that harness's memory (the kernel keeps other processes, the agent's own shell included, out of it);
      // the center keeps a fingerprint. Messages need no signature: the connection itself is authenticated.
      let minted: string | null = null, conflict = false;
      if (opts.strict) {
        const holder = notifier.holder(address);
        const stored = store.keyHash(address);
        const given = args.key ? hashKey(args.key) : null;
        if (holder && holder !== ctx) {
          if (!given || given !== stored) {
            store.audit(address, "identity-conflict", { held: true, presented_key: !!given });
            return err(`identity ${address} is held by another live process; refused and logged`);
          }
        } else if (!stored) {
          minted = newKey();
        } else if (given !== stored) {
          // Not held: a restarted harness (no secret yet) re-claims it. A WRONG secret means someone else
          // took it while it was away: re-issued to this claimant, and the conflict is logged and reported.
          conflict = given !== null;
          store.audit(address, conflict ? "identity-conflict" : "rekey", { held: false, presented_key: given !== null });
          minted = newKey();
        }
        if (minted) store.setKeyHash(address, hashKey(minted));
      }

      notifier.unbind(ctx);
      ctx.address = address;
      ctx.project = project;
      const entry = store.register({
        address,
        project,
        harness: { name: args.harness, version: clientInfo?.version },
        role: args.role ?? null,
        capabilities: args.capabilities ?? [],
        roots: ctx.roots,
        conformance: args.conformance ?? null,
        endpoint: args.endpoint ?? null,
        location: args.location ?? null,
      });
      notifier.bind(ctx);
      return ok_({ address: entry.address, project: entry.project, ...(minted ? { key: minted } : {}), ...(conflict ? { conflict: true } : {}) });
    },
  );

  // ── macp_send (spec §6.1, §7, §9) ───────────────────────────────────────
  server.registerTool(
    "macp_send",
    {
      description:
        "Send an envelope. 'to' is an agent address, 'role:<label>' (all live agents with that role " +
        "in your project), or 'project' (broadcast to your project). steering/interrupt require a grant; " +
        "ungranted sends are downgraded to advisory and audited (spec §11.4).",
      inputSchema: {
        to: z.string().min(1),
        body: z.string().min(1),
        priority: prioritySchema.default("advisory"),
        ack: z.enum(["auto", "required"]).default("auto"),
        in_reply_to: z.string().nullable().optional(),
        client_id: z.string().max(200).optional(),
        // Set by the BINDING, never the model: this send happens in a turn a human started.
        human_turn: z.boolean().optional(),
        asked_by: z.string().max(200).optional(),
      },
    },
    async (args) => {
      if (!ctx.address) return err("not registered — call macp_register first");
      const from = ctx.address;
      const fromProject = ctx.project;
      // Idempotent resend: a client that lost the answer to a send it retries with the same
      // client_id gets the original deliveries back, never a second copy.
      if (args.client_id) {
        const prior = store.byClientId(from, args.client_id);
        if (prior.length) return ok_({ deliveries: prior, duplicate: true });
      }

      // FLOOD LIMIT: an agent sending faster than the limit is refused, with the reason (never silently).
      const lim = opts.policy?.limits() ?? { perMinute: 30, pairPer10Min: 20 };
      if (!from.startsWith("human://")) {
        const n = store.sentSince(from, new Date(Date.now() - 60_000).toISOString());
        if (n >= lim.perMinute) {
          store.audit(from, "refused-limit", { kind: "per-minute", n });
          return err(`rate limit: ${n} messages in the last minute (limit ${lim.perMinute}); wait, or tell the human what you are trying to do`);
        }
      }
      // "all" is always a broadcast. "project" is one too (spec), unless the project declares a role of
      // that name (projectIsRole): then it means that role — measured 2026-10-25, a worker's message to
      // the lane named "project" was refused as a broadcast.
      if (args.to === "all") args.to = "project";
      else if (args.to === "project" && opts.policy?.forProject(fromProject)?.projectIsRole) args.to = "role:project";

      // Resolve recipients.
      let recipients: { address: string; project: string }[];
      let queuedOffline = false;
      if (args.to === "project") {
        if (!fromProject) return err("operator broadcast requires an explicit address list");
        recipients = store
          .roster(fromProject)
          .filter((e) => e.address !== from)
          .map((e) => ({ address: e.address, project: e.project }));
      } else if (args.to.startsWith("role:")) {
        if (!fromProject) return err("role targeting requires a project-scoped sender");
        const role = args.to.slice(5);
        recipients = store
          .roster(fromProject)
          .filter((e) => e.role === role && e.address !== from)
          .map((e) => ({ address: e.address, project: e.project }));
        // Nobody with that role is live: queue for the agent that held it last, so a crashed or
        // restarting receiver still gets it on return (§5.2) instead of the send vanishing.
        if (recipients.length === 0) {
          const last = store.roster(fromProject, true).filter((e) => e.role === role && e.address !== from).pop();
          if (last) { recipients = [{ address: last.address, project: last.project }]; queuedOffline = true; }
        }
      } else {
        const target = store.getAgent(args.to);
        if (!target && !args.to.startsWith("human://")) return err(`unknown recipient: ${args.to}`);
        recipients = [{ address: args.to, project: target?.project ?? fromProject ?? "unknown" }];
      }
      if (recipients.length === 0) return err(`no agent has ever registered as ${args.to} in ${fromProject ?? "your project"}`);

      const results: { id: string; to: string; priority: Priority; downgraded?: true; note?: string }[] = [];
      const refused: { to: string; reason: string }[] = [];
      const fanout = args.to === "project" ? "project" : args.to.startsWith("role:") ? "role" : "direct";
      // An answer to a message the human asked for carries that request's authority — once, to its sender.
      const ticket = args.in_reply_to && recipients.length === 1 ? store.replyTicket(from, recipients[0].address, args.in_reply_to) : null;
      const onHumansBehalf = args.human_turn === true || ticket !== null;
      const fromRole = store.getAgent(from)?.role ?? null;
      for (const r of recipients) {
        let priority = args.priority as Priority;
        let downgraded = false;
        // LOOP LIMIT: two agents exchanging too fast is a loop, not a conversation.
        if (!from.startsWith("human://") && !r.address.startsWith("human://")) {
          const pn = store.pairSince(from, r.address, new Date(Date.now() - 600_000).toISOString());
          if (pn >= lim.pairPer10Min) {
            store.audit(from, "refused-limit", { kind: "pair", to: r.address, n: pn });
            refused.push({ to: r.address, reason: `loop limit: ${pn} messages between you and ${r.address} in 10 minutes (limit ${lim.pairPer10Min}); stop and report to the human` });
            continue;
          }
        }
        // Topology policy first (policy.ts): refuse with a reason that names the right channel, or cap.
        const verdict = opts.policy?.check(
          { address: from, role: fromRole, project: fromProject },
          { address: r.address, role: store.getAgent(r.address)?.role ?? null, project: r.project },
          priority,
          fanout,
          onHumansBehalf,
          store.isAllowed(from, fromProject),
        ) ?? { ok: true as const };
        if (!verdict.ok) {
          store.audit(from, "refused-policy", { to: r.address, reason: verdict.reason });
          refused.push({ to: r.address, reason: verdict.reason });
          continue;
        }
        const capped = lower(priority, verdict.cap);
        if (capped !== priority) {
          store.audit(from, "policy-cap", { to: r.address, requested: priority, delivered: capped, note: verdict.note });
          priority = capped;
          downgraded = true;
        }
        // A policy rule is a configuration grant (spec §9 G2b) up to its max.
        const ruleGrants = within(priority, verdict.grant) || (verdict.ok && verdict.human === true);
        if (!ruleGrants && !store.allowed(from, r.address, r.project, fromProject, priority)) {
          if (priority === "steering" || priority === "interrupt") {
            // Spec §11.4: downgrade rather than drop, so misconfiguration is visible.
            priority = "advisory";
            downgraded = true;
            store.audit(from, "downgrade", { to: r.address, requested: args.priority });
          } else {
            store.audit(from, "blocked-cross-project", { to: r.address });
            // §5.4: not delivered — and never silently: the sender learns why.
            refused.push({ to: r.address, reason: `${r.address} is in another project and no link or grant allows it (spec §5.4)` });
            continue;
          }
        }
        const env = store.send({
          from,
          to: r.address,
          project: r.project,
          priority,
          ack: args.ack as "auto" | "required",
          in_reply_to: args.in_reply_to ?? null,
          body: args.body,
          client_id: args.client_id ?? null,
          asked_by: verdict.ok && verdict.human ? (args.human_turn === true ? (args.asked_by ?? "the human") : `answer to ${ticket}'s request`) : null,
        });
        const note = verdict.ok ? verdict.note : undefined;
        results.push({ id: env.id, to: env.to, priority, ...(downgraded ? { downgraded: true as const } : {}), ...(note ? { note } : {}) });
        void notifier.notifyInbox(r.address);
      }
      if (results.length === 0 && refused.length > 0) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ deliveries: [], refused }) }], isError: true as const };
      }
      if (queuedOffline) for (const d of results) d.note = `${d.to} is offline: queued, delivered when it reconnects`;
      return ok_(refused.length ? { deliveries: results, refused } : { deliveries: results });
    },
  );

  // ── macp_ack (spec §8.5) ────────────────────────────────────────────────
  server.registerTool(
    "macp_ack",
    {
      description: "Acknowledge a delivery as processed (removes it from your pending inbox).",
      inputSchema: { delivery_id: z.string().min(1) },
    },
    async (args) => {
      if (!ctx.address) return err("not registered");
      const done = store.ackProcessed(ctx.address, args.delivery_id);
      return done ? ok_({ acked: args.delivery_id }) : err(`no pending delivery ${args.delivery_id} for ${ctx.address}`);
    },
  );

  // ── receipts (pi-agent-talk extension of §8.5) ──────────────────────────────────
  server.registerTool(
    "macp_receipt",
    {
      description: "Binding-only: report a delivery as placed in context, read by a completed model call, or failed (with the model error).",
      inputSchema: { delivery_id: z.string().min(1), stage: z.enum(["placed", "read", "failed"]), reason: z.string().optional() },
    },
    async (args) => {
      if (!ctx.address) return err("not registered");
      const r = store.receipt(ctx.address, args.delivery_id, args.stage, args.reason);
      if (!r.ok) return err(`no delivery ${args.delivery_id} for ${ctx.address}`);
      // Tell an agent sender ONCE, at info priority (never wakes it), that its message is not being read.
      const f = r.firstFailure;
      if (f && f.from.startsWith("agent://")) {
        const sender = store.getAgent(f.from);
        if (sender) {
          store.send({
            from: "center://macp", to: f.from, project: sender.project, priority: "info", ack: "auto", in_reply_to: f.id,
            body: `Your message ${f.id} to ${f.to} was delivered, but the recipient's model call failed: ${args.reason ?? "unknown"}. It will be read only if that session recovers.`,
          });
          void notifier.notifyInbox(f.from);
        }
      }
      return ok_({ ok: true });
    },
  );

  server.registerTool(
    "macp_status",
    {
      description: "Where a delivery stands: accepted, fetched, placed, read, answered, failed or stuck, with the reason and times.",
      inputSchema: { delivery_id: z.string().min(1) },
    },
    async (args) => {
      if (!ctx.address) return err("not registered");
      const s = store.status(args.delivery_id, STUCK_MS);
      if (!s || (!ctx.isOperator && s.from !== ctx.address && s.to !== ctx.address)) return err(`no delivery ${args.delivery_id} visible to ${ctx.address}`);
      return ok_(s);
    },
  );

  // ── macp_presence: busy / idle, for the roster ───────────────────────────────
  server.registerTool(
    "macp_presence",
    { description: "Binding-only: report this agent busy (a model run started) or idle (it ended).", inputSchema: { state: z.enum(["busy", "idle"]) } },
    async (args) => {
      if (!ctx.address) return err("not registered");
      store.setState(ctx.address, args.state);
      return ok_({ ok: true });
    },
  );

  // ── macp_allow: the human lets agents send on their own (operator only) ───────────────────
  server.registerTool(
    "macp_allow",
    {
      description: "Operator only. Let an agent (address), a project ('project:<id>') or everyone ('*') send without being asked; minutes limits it. revoke: take it back. No holder: list.",
      inputSchema: { holder: z.string().optional(), minutes: z.number().positive().optional(), revoke: z.boolean().optional() },
    },
    async (args) => {
      if (!ctx.isOperator) return err("only the human operator may allow agents to send on their own");
      if (!args.holder) return ok_({ allowances: store.allowances() });
      if (args.revoke) return ok_({ revoked: store.disallow(args.holder, ctx.address!) });
      store.allow(args.holder, args.minutes ?? null, ctx.address!);
      return ok_({ allowed: args.holder, minutes: args.minutes ?? null });
    },
  );

  // ── macp_roster (spec §6.1) ─────────────────────────────────────────────
  server.registerTool(
    "macp_roster",
    {
      description: "Live agents in a project (default: your own).",
      inputSchema: { project: z.string().optional(), include_offline: z.boolean().optional(), all: z.boolean().optional() },
    },
    async (args) => {
      // all: every live agent on every machine and project, with where it runs — names only, no content.
      if (args.all) return ok_({ agents: store.directory() });
      const project = args.project ?? ctx.project;
      if (!project) return err("no project — register first or pass one explicitly");
      if (args.project && args.project !== ctx.project && !ctx.isOperator) {
        return err("cross-project roster requires the operator (spec §5.4)");
      }
      return ok_({ project, agents: store.roster(project, args.include_offline === true) });
    },
  );

  // ── macp_grant (spec §9) ────────────────────────────────────────────────
  server.registerTool(
    "macp_grant",
    {
      description:
        "Create or revoke an authority grant. The operator may grant anything; an agent may grant " +
        "only over agents it spawned (subject address under its own). No self-granting (spec §9 G2).",
      inputSchema: {
        action: z.enum(["create", "revoke"]),
        grant_id: z.string().optional().describe("For revoke."),
        holder: z.string().optional(),
        subject: z.string().optional().describe("Address, 'project:<id>', or 'link:<a>:<b>'."),
        max_priority: z.enum(["steering", "interrupt"]).optional(),
        expires_at: z.string().nullable().optional(),
        note: z.string().nullable().optional(),
      },
    },
    async (args) => {
      if (!ctx.address) return err("not registered");
      if (args.action === "revoke") {
        if (!args.grant_id) return err("grant_id required");
        return store.revokeGrant(args.grant_id, ctx.address)
          ? ok_({ revoked: args.grant_id })
          : err("no such active grant");
      }
      if (!args.holder || !args.subject || !args.max_priority) return err("holder, subject, max_priority required");
      const spawnerOk =
        !ctx.isOperator &&
        args.subject.startsWith(`${ctx.address}/`) && // only over own spawned subtree
        args.holder === ctx.address;
      if (!ctx.isOperator && !spawnerOk) {
        return err("only the operator may create this grant (spec §9 G2 — no self-granting)");
      }
      const grant = store.addGrant({
        holder: args.holder,
        subject: args.subject,
        max_priority: args.max_priority,
        granted_by: ctx.address,
        expires_at: args.expires_at ?? null,
        note: args.note ?? null,
      });
      return ok_({ grant });
    },
  );

  // ── resources (spec §6.2) ───────────────────────────────────────────────
  server.registerResource(
    "self",
    "macp://self",
    { description: "Your registry entry, project, and grants held.", mimeType: "application/json" },
    async (uri) => {
      if (!ctx.address) return json(uri.href, { registered: false });
      const entry = store.getAgent(ctx.address);
      return json(uri.href, { ...entry, address: ctx.address, grants: store.grantsHeldBy(ctx.address) });
    },
  );

  server.registerResource(
    "roster",
    new ResourceTemplate("macp://project/{project}/roster", { list: undefined }),
    { description: "Live agents in a project.", mimeType: "application/json" },
    async (uri, vars) => {
      const project = decodeURIComponent(String(vars.project));
      if (project !== ctx.project && !ctx.isOperator) {
        throw new Error("cross-project roster requires the operator (spec §5.4)");
      }
      return json(uri.href, store.roster(project));
    },
  );

  server.registerResource(
    "inbox",
    new ResourceTemplate("macp://agent/{+address}/inbox", { list: undefined }),
    {
      description: "Your pending deliveries, priority-ordered. Reading marks them received (spec §8.5).",
      mimeType: "application/json",
    },
    async (uri, vars) => {
      const address = decodeURIComponent(String(vars.address));
      // An agent may only read ITS OWN inbox — enforced by connection identity (spec §6.2).
      if (address !== ctx.address) throw new Error("an agent may only read its own inbox (spec §6.2)");
      const pending = store.inbox(address);
      store.markReceived(address);
      return json(uri.href, pending);
    },
  );

  // ── subscriptions (spec §6.3 rung 1) ───────────────────────────────────
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    ctx.subscriptions.add(req.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    ctx.subscriptions.delete(req.params.uri);
    return {};
  });

  return ctx;
}

// ── helpers ───────────────────────────────────────────────────────────────

function ok_(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true as const };
}

function json(uri: string, payload: unknown) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }] };
}
