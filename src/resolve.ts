/**
 * Loose matching for "/talk <plain words>": the human names a session the way it looks on screen.
 * Kept apart from the extension so it can be tested without Pi.
 */
/**
 * LOOSE MATCHING for "/talk <plain words>". The human names a session the way it looks on screen — "the
 * reviewer on server", "vanness", "the herdr overstand tab", "the freecad one" — so the words are matched
 * against everything the directory knows: role, project, machine, tmux/herdr place, folder, session name.
 * A clear single winner is used; a tie is reported as ambiguous so the model asks instead of guessing.
 */
const STOP = new Set("the a an to tell ask say said send sent message note that in on at of for please and it them this these those agent session window tab workspace from my me hey hi there is are be do does with about into over".split(" "));
const words = (s: string) => (s ?? "").toLowerCase().split(/[^a-z0-9_.@-]+/).filter((w) => w.length > 1 && !STOP.has(w));

export interface Candidate { address: string; role?: string; location?: string; score: number; matched: string[] }
export function rankAgents(agents: any[], query: string): { query: string; tokens: string[]; candidates: Candidate[]; best?: Candidate; ambiguous: boolean } {
  const tokens = words(query);
  const scored = agents.map((a) => {
    // A project's "prj:" prefix is directory bookkeeping, not something a human says.
    // Where it sits on screen outranks directory bookkeeping: "the herdr overstand tab" is a place.
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
  // Ambiguous when two candidates matched exactly the same words: "the lanes in overstand-private" must not
  // silently pick the lane whose folder happens to repeat the project name. A lone weak match is ambiguous too.
  const distinct = (c?: Candidate) => new Set(c?.matched ?? []).size;
  // Ambiguous unless the winner matched MORE of the human's words than the runner-up. Two lanes in one project,
  // or two sessions on one machine, therefore ask instead of picking: the words did not single one out.
  const ambiguous = !top || (!!second && distinct(second) >= distinct(top)) || top.score <= 2;
  return { query, tokens, candidates: scored.slice(0, 5), best: ambiguous ? undefined : top, ambiguous };
}

/** Words that introduce the agent a message is for. A clause without one is content, not addressing. */
const CUE = new Set("to tell ask hand pass give forward send message ping reply tell forward brief delegate".split(" "));

/**
 * A HANDOVER is a long brief with the target buried in it ("hand this over to vanness: … 12 tests pass …").
 * Scoring the whole text lets the brief decide the target — "shop migration" and "build green" once sent a
 * handover meant for vanness to the shop builder. So each clause is judged alone, only clauses that address
 * someone get a say, and the votes decide: one agent named, one target; two agents named, ask; none, the
 * model resolves it from the directory as before.
 */
export function pickTarget(agents: any[], text: string): { best?: Candidate; ambiguous: boolean; candidates: Candidate[]; why: string } {
  const roleOf = (address: string) => String(agents.find((a) => a.address === address)?.role ?? "").toLowerCase();
  const named = new Map<string, Candidate>(), placed = new Map<string, Candidate>();
  for (const clause of String(text).split(/[;:.,\n]+/)) {
    const raw = clause.toLowerCase().split(/[^a-z0-9_.@-]+/).filter(Boolean);
    if (raw.length === 0 || raw.length > 25) continue;                     // a paragraph, not an address at all
    if (!raw.some((w) => CUE.has(w))) continue;                            // "the shop migration is done" is not addressing anyone
    const r = rankAgents(agents, clause);
    // A session NAMED by its role is named on purpose; a place word shared by several is weaker evidence.
    const byRole = r.candidates.filter((c) => { const role = roleOf(c.address); return role && raw.includes(role); });
    if (byRole.length > 1) return { ambiguous: true, candidates: byRole, why: `"${clause.trim()}" names ${byRole.length} sessions` };
    if (byRole.length === 1) { named.set(byRole[0].address, byRole[0]); continue; }
    // A place word only counts from a SHORT clause: "the agent in the overstand workspace" addresses someone,
    // while "then tell billing about the invoice fix" inside a brief is content that happens to name a folder.
    if (raw.length <= 8 && r.best) { placed.set(r.best.address, r.best); continue; }
    if (r.ambiguous && r.candidates.length > 1) {
      const most = new Set(r.candidates[0].matched).size;
      const tied = r.candidates.filter((c) => new Set(c.matched).size === most);
      if (tied.length > 1) return { ambiguous: true, candidates: tied, why: `"${clause.trim()}" fits ${tied.length} sessions equally` };
    }
  }
  // A session named by role outranks any number of places mentioned in passing.
  const all = named.size ? [...named.values()] : [...placed.values()];
  if (all.length === 1) return { best: all[0], ambiguous: false, candidates: all, why: named.size ? `"${all[0].role ?? all[0].address}" is named` : "its place is named" };
  if (all.length > 1) return { ambiguous: true, candidates: all, why: "the message names more than one agent" };
  return { ambiguous: false, candidates: [], why: "no agent is named" };
}
