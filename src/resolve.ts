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
        else if (h.startsWith(tk) || tk.startsWith(h)) best = Math.max(best, 3);
        else if (h.includes(tk)) best = Math.max(best, 1);
      }
      if (best) { score += best; matched.push(tk); }
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
