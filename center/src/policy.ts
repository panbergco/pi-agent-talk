/**
 * Topology policy — "project or center configuration" as a grant source (spec §9 G2b),
 * plus one local stricter profile: a CLOSED project, where nothing is delivered between its
 * agents unless a rule allows it (spec G1 lets advisory/info pass freely within a project).
 *
 * Built for supervisor/worker setups: a worker may message its supervisor, workers may not message
 * each other, the supervisor reaches workers another way, a refusal names the right channel,
 * workers may not broadcast, and a paused worker is never woken ("quiet": capped to advisory,
 * which a binding never wakes for, spec §8.2).
 *
 * File (MACP_POLICY or --policy), re-read whenever it changes:
 * {
 *   "projects": {
 *     "myproject": {
 *       "closed": true,
 *       "projectIsRole": true,   // a role is literally named "project": to "project" means it; broadcast is "all"
 *       "closedReason": "a worker messages the supervisor, not another worker",
 *       "allow": [ { "from": "role:worker", "to": "role:supervisor", "max": "steering" } ],
 *       "deny":  [ { "from": "role:worker", "to": "role:worker", "reason": "a worker messages the supervisor, not another worker" } ],
 *       "broadcast": ["role:supervisor"],
 *       "quiet": ["role:worker-paused"]
 *     }
 *   }
 * }
 * Selectors: "*", an exact agent address, or "role:<label>". Project keys match the explicit
 * project name (registered as "prj:<name>") or a full project id. The operator is never bound
 * by policy (spec §9 G3).
 */
import { readFileSync, statSync } from "node:fs";
import type { Priority } from "./store.js";

const RANK: Record<Priority, number> = { interrupt: 0, steering: 1, advisory: 2, info: 3 };

export interface Rule { from: string; to: string; max?: Priority; reason?: string }
export interface ProjectPolicy {
  closed?: boolean; closedReason?: string; projectIsRole?: boolean;
  /** "human-turn": an agent may send only within a turn its human started (the binding attests it). */
  agentSend?: "always" | "human-turn"; agentSendReason?: string; agentSendExempt?: string[]; allow?: Rule[]; deny?: Rule[]; broadcast?: string[]; quiet?: string[] }
interface PolicyFile {
  projects?: Record<string, ProjectPolicy>;
  /** For every project that does not say otherwise: "human-turn" = agents send only when their human asks. */
  defaultAgentSend?: "always" | "human-turn";
  defaultAgentSendReason?: string;
  /** Flood and loop limits for agents (the human is never limited). Defaults: 30 a minute; 20 per pair per 10 min. */
  limits?: { perMinute?: number; pairPer10Min?: number };
}

export interface Party { address: string; role: string | null; project: string | null }
export type Verdict =
  | { ok: true; cap?: Priority; grant?: Priority; note?: string; human?: true }
  | { ok: false; reason: string };

export class Policy {
  private file: PolicyFile = {};
  private stamp = "";
  private text = "";
  private checkedAt = 0;

  constructor(private readonly path: string | null) {}

  private load(): PolicyFile {
    if (!this.path) return {};
    try {
      // Re-read on any change of mtime or size, and at least every 2 s: two rewrites in the same
      // instant (pause, then resume) can share an mtime, and stale rules must not linger.
      const st = statSync(this.path);
      const stamp = `${st.mtimeMs}:${st.size}`;
      if (stamp !== this.stamp || Date.now() - this.checkedAt > 2000) {
        const text = readFileSync(this.path, "utf8");
        this.checkedAt = Date.now();
        if (text !== this.text) {
          const parsed = JSON.parse(text) as PolicyFile; // throws → keep the last good policy
          this.file = parsed; this.text = text;
        }
        this.stamp = stamp;
      }
    } catch {
      // Unreadable or malformed: keep the last good policy rather than silently opening up.
    }
    return this.file;
  }

  limits(): { perMinute: number; pairPer10Min: number } {
    const l = this.load().limits ?? {};
    return { perMinute: l.perMinute ?? 30, pairPer10Min: l.pairPer10Min ?? 20 };
  }

  forProject(project: string | null): ProjectPolicy | undefined {
    if (!project) return undefined;
    const projects = this.load().projects ?? {};
    return projects[project] ?? projects[project.replace(/^prj:/, "")];
  }

  /** May `from` send to `to` at `priority`? `fanout` = role or project targeting. */
  check(from: Party, to: Party, priority: Priority, fanout: "direct" | "role" | "project", humanTurn = false, autonomous = false): Verdict {
    if (from.address.startsWith("human://")) return { ok: true }; // G3 operator precedence
    // The human asked for this send in this turn: it carries the human's authority (any project, any rule).
    if (humanTurn) return { ok: true, human: true };
    // An agent may always report to the human — before any "only when asked" rule (measured 2026-10-25:
    // the cross-machine run refused an agent's report to the operator who had just messaged it).
    if (to.address.startsWith("human://")) return { ok: true };
    const file = this.load();
    const pp = this.forProject(from.project);
    const hit = (sel: string, p: Party) => sel === "*" || sel === p.address || (sel.startsWith("role:") && sel.slice(5) === (p.role ?? ""));
    const mode = pp?.agentSend ?? file.defaultAgentSend ?? "always";
    // Agents may not message on their own initiative unless the human allowed it (/talk allow).
    if (mode === "human-turn" && !autonomous && !(pp?.agentSendExempt ?? []).some((s) => hit(s, from))) {
      return { ok: false, reason: pp?.agentSendReason ?? file.defaultAgentSendReason ?? "agents send only when their human asks them to in that turn (the human can allow more with /talk allow)" };
    }
    if (from.project !== to.project) return { ok: true };          // cross-project stays with grants/links (§5.4)
    if (!pp) return { ok: true };

    const matches = (r: Rule) => hit(r.from, from) && hit(r.to, to);
    const label = (p: Party) => (p.role ? `role:${p.role}` : p.address);

    const denied = pp.deny?.find(matches);
    if (denied) return { ok: false, reason: denied.reason ?? `${label(from)} may not message ${label(to)} in ${from.project}` };

    if (fanout === "project" && pp.broadcast && !pp.broadcast.some((s) => hit(s, from))) {
      return { ok: false, reason: `${label(from)} may not broadcast in ${from.project}: name a recipient` };
    }

    const rule = pp.allow?.find(matches);
    if (pp.closed && !rule) {
      return { ok: false, reason: pp.closedReason ?? `no rule in ${from.project} lets ${label(from)} message ${label(to)}` };
    }

    let cap: Priority | undefined = rule?.max ?? (pp.closed ? "advisory" : undefined);
    let note: string | undefined;
    if (pp.quiet?.some((s) => hit(s, to)) && (cap === undefined || RANK[cap] < RANK.advisory)) {
      cap = "advisory";
      note = `${label(to)} is quiet: delivered without waking it`;
    }
    const grant = rule?.max && RANK[rule.max] <= RANK.steering ? rule.max : undefined;
    return { ok: true, cap, grant, note };
  }
}

export const lower = (a: Priority, cap?: Priority): Priority => (cap !== undefined && RANK[a] < RANK[cap] ? cap : a);
export const within = (a: Priority, max?: Priority): boolean => max !== undefined && RANK[a] >= RANK[max];
