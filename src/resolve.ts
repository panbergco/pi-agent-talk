/**
 * Loose matching for "/talk <plain words>": the human names a session the way it looks on screen.
 * Kept apart from the extension so it can be tested without Pi.
 */
/**
 * LOOSE MATCHING for "/talk <plain words>". The human names a session the way it looks on screen — "the
 * reviewer on server", "vanness", "the herdr review tab", "the freecad one" — so the words are matched
 * against everything the directory knows: role, project, machine, tmux/herdr place, folder, session name.
 * A clear single winner is used; a tie is reported as ambiguous so the model asks instead of guessing.
 */
const STOP = new Set("the a an to tell ask say said send sent message note that in on at of for please and it them this these those agent session window tab workspace from my me hey hi there is are be do does with about into over".split(" "));
const words = (s: string) => (s ?? "").toLowerCase().split(/[^a-z0-9_.@-]+/).filter((w) => w.length > 1 && !STOP.has(w));

export interface Candidate { address: string; role?: string; location?: string; score: number; matched: string[] }
export function rankAgents(agents: any[], query: string): { query: string; tokens: string[]; candidates: Candidate[]; all: Candidate[]; best?: Candidate; ambiguous: boolean } {
  const tokens = words(query);
  const scored = agents.map((a) => {
    // A project's "prj:" prefix is directory bookkeeping, not something a human says.
    // Where it sits on screen outranks directory bookkeeping: "the herdr review tab" is a place.
    const hay = words([a.role, a.location, a.location, a.project, a.cwd, a.session].filter(Boolean).join(" ").replace(/prj:/g, ""));
    const matched: string[] = []; let score = 0;
    for (const tk of tokens) {
      let best = 0;
      for (const h of hay) {
        if (h === tk) best = Math.max(best, 4);
        else if (tk.length >= 4 && (h.startsWith(tk) || tk.startsWith(h))) best = Math.max(best, 2); // "build" is not "builder"
        else if (tk.length >= 5 && h.includes(tk)) best = Math.max(best, 1);
      }
      if (best) score += best;
      // Only a word the human used EXACTLY counts as evidence of which session they meant. "build", "shop"
      // and "billing" appear in briefs and in other sessions' names; counting them made handovers ambiguous.
      if (best >= 4) matched.push(tk);
    }
    return { address: a.address, role: a.role, location: a.location, score, matched };
  }).filter((c) => c.score > 0).sort((x, y) => y.score - x.score);
  const top = scored[0], second = scored[1];
  // Ambiguous when two candidates matched exactly the same words: "the lanes in review-project" must not
  // silently pick the lane whose folder happens to repeat the project name. A lone weak match is ambiguous too.
  const distinct = (c?: Candidate) => new Set(c?.matched ?? []).size;
  // Ambiguous unless the winner matched MORE of the human's words than the runner-up. Two lanes in one project,
  // or two sessions on one machine, therefore ask instead of picking: the words did not single one out.
  const ambiguous = !top || (!!second && distinct(second) >= distinct(top)) || top.score <= 2;
  // `candidates` is for display (five is plenty); `all` is the complete ranking, so a tie between six
  // sessions can still be shown as the six it is instead of a misleading five.
  return { query, tokens, candidates: scored.slice(0, 5), all: scored, best: ambiguous ? undefined : top, ambiguous };
}

/** Words that introduce the agent a message is for. A clause without one is content, not addressing. */
const CUE = new Set("to tell ask hand pass give forward send message ping reply brief delegate".split(" "));
/** Strong verbs carry the message itself, so they outrank a "tell …" that is only part of the brief. */
const STRONG = new Set(["hand", "pass", "forward", "send", "give", "brief", "delegate"].map((w) => w));
/** "do not send to the builder" names a session only to exclude it. */
const NEGATED = /\b(?:do not|don't|dont|never|not|no)\b/i;

const tokensOf = (s: string) => s.toLowerCase().split(/[^a-z0-9_.@-]+/).filter(Boolean);
const isStrictSuperset = (a: string[], b: string[]) => a.length > b.length && b.every((x) => a.includes(x));

/**
 * A HANDOVER is a long brief with the target buried in it ("hand this over to vanness: … 12 tests pass …").
 * Judging the whole text let the brief choose — "shop migration" and "build green" once sent a handover meant
 * for vanness to the shop builder, and "tell billing about the invoice fix" inside a brief nominated the
 * billing agent. So each clause is judged alone, under two rules:
 *   1. A clause with a STRONG verb (hand, send, brief …) outranks one whose only cue is "tell": the brief's
 *      own instructions are not addressing.
 *   2. Within that rank, the first clause that singles out one session decides; a clause that fits two
 *      equally is the human's ambiguity and is reported, never guessed. Negated clauses are skipped.
 */
export function pickTarget(agents: any[], text: string): { best?: Candidate; ambiguous: boolean; candidates: Candidate[]; why: string } {
  const roleOf = (address: string) => String(agents.find((a) => a.address === address)?.role ?? "").toLowerCase();
  const seen = new Map<string, Candidate>();          // agents named by any clause, for a useful tie message
  for (const rank of [2, 1]) {                        // strong verbs first
    for (const clause of String(text).split(/[;:.,\n]+/)) {
      const raw = tokensOf(clause);
      if (raw.length === 0 || raw.length > 25) continue;              // a paragraph, not an address at all
      const cues = raw.filter((w) => CUE.has(w));
      if (cues.length === 0) continue;                                // "the shop migration is done" addresses nobody
      if (NEGATED.test(clause)) continue;                             // "do not send to builder" is not a destination
      const thisRank = cues.some((w) => STRONG.has(w)) ? 2 : 1;
      if (thisRank !== rank) continue;
      const r = rankAgents(agents, clause);
      // A session named by its role is named on purpose; a place word shared by several is weaker evidence.
      const byRole = r.all.filter((c) => { const role = roleOf(c.address); return role && raw.includes(role); });
      // Strong verbs already outrank the brief's own "tell …", so any matched place counts here; two places
      // named in one clause stay ambiguous rather than one of them being guessed.
      const pool = byRole.length ? byRole : r.all.filter((c) => c.matched.length > 0);
      for (const c of pool) seen.set(c.address, c);
      if (pool.length === 0) continue;
      // "the reviewer on desk" singles out the desk one, because it matched strictly more of the words.
      const narrowed = pool.filter((c) => !pool.some((o) => o !== c && isStrictSuperset(o.matched, c.matched)));
      if (narrowed.length === 1)
        return { best: narrowed[0], ambiguous: false, candidates: narrowed, why: byRole.length ? `"${narrowed[0].role}" is named` : "its place is named" };
      if (narrowed.length > 1)
        return { ambiguous: true, candidates: narrowed, why: `"${clause.trim()}" fits ${narrowed.length} sessions equally` };
    }
  }
  if (seen.size > 1) return { ambiguous: true, candidates: [...seen.values()], why: "it names more than one session" };
  return { ambiguous: false, candidates: [], why: "no agent is named" };
}
