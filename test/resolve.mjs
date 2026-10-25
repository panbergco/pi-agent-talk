/**
 * Loose "/talk" matching: does a human's phrase find the session they meant, and does a tie stay a tie?
 * Run: node test/resolve.mjs   (exit 0 = every expectation held)
 */
import { rankAgents } from "../src/resolve.ts";

const agents = [
  { address: "agent://pi/a1", role: "reviewer", project: "prj:billing", location: "desk · tmux main:2 'billing-review' · ~/Code/billing" },
  { address: "agent://pi/a2", role: "builder", project: "prj:shop", location: "desk · tmux main:3 'shop-builder' · ~/Code/shop" },
  { address: "agent://pi/a3", role: "vanness", project: "prj:overstand-private", location: "desk · herdr overstand:build (w4:p2) · ~/Code/overstand-private" },
  { address: "agent://pi/a4", role: "designer", project: "prj:overstand-private", location: "server · herdr main (w1:p3) · ~/Code/notes" },
  { address: "agent://pi/a5", role: "cad", project: "prj:ufo-workspace", location: "desk · herdr freecad (w2:p1) · ~/Code/sim-rig" },
];

let pass = 0, fail = 0;
const check = (desc, query, want) => {
  const r = rankAgents(agents, query);
  const got = r.best ? "unique:" + r.best.role : r.ambiguous && r.candidates.length > 1 ? "ambiguous" : r.ambiguous ? "nothing" : "unique:" + r.best?.role;
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${desc.padEnd(46)} "${query}" → ${got}${ok ? "" : ` (wanted ${want})`}`);
};

check("a role named plainly", "vanness", "unique:vanness");
check("role plus machine", "the reviewer on desk", "unique:reviewer");
check("role plus folder word", "tell the builder in shop to stop", "unique:builder");
check("herdr workspace words shared by two lanes", "the agent in the herdr overstand tab", "ambiguous");
check("herdr workspace plus a distinctive tab", "the freecad tab in herdr", "unique:cad");
check("a distinctive folder", "the freecad one", "unique:cad");
check("two sessions on one machine", "the agent on desk", "ambiguous");
check("two lanes of one project", "someone in overstand-private", "ambiguous");
check("nothing that matches", "wake up the accountant", "nothing");
check("too vague to act on", "tell the agent", "nothing");
check("a tie must not be guessed", "the agent in herdr", "ambiguous");

// The loser of a tie must never be offered as `best`.
const tie = rankAgents(agents, "the agent on desk");
if (!tie.best && tie.candidates.length >= 2) { pass++; console.log(`PASS  a tie lists all ${tie.candidates.length} candidates and picks no best`); }
else { fail++; console.log("FAIL  a tie offered a best or no candidates"); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
