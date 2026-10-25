#!/usr/bin/env bash
# Exercises bin/guard/herdr against a stub herdr that records what got through.
# Run: bin/guard/test-herdr.sh   (exit 0 = every verdict as expected)
set -u
here=$(cd "$(dirname "$0")" && pwd); G=$(mktemp -d)
mkdir -p "$G/inst" "$G/evil" "$G/bin"
printf '#!/bin/bash\n"$@"\n' > "$G/inst/orch"; cp "$G/inst/orch" "$G/evil/orch"; chmod +x "$G/inst/orch" "$G/evil/orch"

# The stub stands in for the real herdr: it answers `pane get` like herdr does and records writes.
cat > "$G/bin/herdr" <<STUB
#!/bin/bash
printf '%s\n' "\$*" >> "$G/reached"
# Two servers share pane ids: in this one w1:p1 is Pi, on "foreign" w1:p1 is Pi too but w1:p2 is bash.
ses=""; while [ \$# -gt 0 ]; do case "\$1" in --session) ses=\$2; shift 2;; *) break;; esac; done
case "\$1 \$2" in
  "pane get")
    case "\$ses:\$3" in
      :w1:p1|foreign:w1:p1) echo '{"id":"cli:pane:get","result":{"pane":{"pane_id":"w1:p1","agent":"pi","workspace_id":"w1","tab_id":"w1:t1"},"type":"pane_info"}}';;
      :w1:p2|foreign:w1:p2) echo '{"id":"cli:pane:get","result":{"pane":{"pane_id":"w1:p2","agent":"bash","workspace_id":"w1","tab_id":"w1:t2"},"type":"pane_info"}}';;
      *) echo '{"error":"no such pane"}' >&2; exit 1;;
    esac;;
esac
exit 0
STUB
chmod +x "$G/bin/herdr"

export PATH="$here:$G/bin:/usr/bin:/bin" XDG_STATE_HOME="$G/state" \
       MACP_GUARD_ORCHESTRATORS_FILE=/dev/null MACP_GUARD_ORCHESTRATORS="$G/inst/orch" \
       HERDR_ENV=1 HERDR_PANE_ID=w1:p9 HERDR_BIN_PATH="$G/bin/herdr" MACP_SELF=vanness@host
unset PI_HUMAN_TURN MACP_TMUX_GUARD 2>/dev/null || true
pass=0; fail=0
expect() { local want=$1 desc=$2; shift 2; local out got; out=$("$@" 2>&1); echo "$out" | grep -q 'herdr guard:' && got=BLOCKED || got=allowed
  if [ "$got" = "$want" ]; then pass=$((pass+1)); echo "PASS  $desc"; else fail=$((fail+1)); echo "FAIL  $desc (got $got)"; fi; }

expect BLOCKED "words into another Pi pane"          herdr pane send-text w1:p1 "hey reviewer, stop that"
expect BLOCKED "a command run in another Pi pane"    herdr pane run w1:p1 "echo hi"
expect BLOCKED "a prompt submitted to an agent"      herdr agent prompt reviewer "do this now"
expect BLOCKED "/talk (would carry the human's authority)" herdr pane send-text w1:p1 "/talk tell the reviewer to stop"
expect allowed "key presses into a Pi pane"          herdr pane send-keys w1:p1 C-c Escape
expect allowed "slash command into a Pi pane"        herdr pane send-text w1:p1 "/reload"
expect allowed "@file paste into a Pi pane"          herdr pane send-text w1:p1 "@/home/x.png "
expect allowed "words into a pane that is not Pi"    herdr pane send-text w1:p2 "echo fixing"
expect allowed "words into your OWN pane"            env HERDR_PANE_ID=w1:p1 herdr pane send-text w1:p1 "self note"
expect allowed "words in a human turn"               env PI_HUMAN_TURN=1 herdr pane send-text w1:p1 "human ok"
expect allowed "words from the installed orchestrator" "$G/inst/orch" herdr pane send-text w1:p1 "door ok"
expect BLOCKED "words from a script named like it"   "$G/evil/orch" herdr pane send-text w1:p1 "evil"
expect allowed "reading a pane"                      herdr pane get w1:p1
expect allowed "listing panes"                       herdr pane list
expect allowed "guard switched off"                  env MACP_TMUX_GUARD=0 herdr pane send-text w1:p1 "off"
# ── session boundaries: w1:p1 exists on every herdr server, so the selector decides which pane is meant ──
expect BLOCKED "a Pi pane on another herdr session"  herdr --session foreign pane send-text w1:p1 "cross server"
expect BLOCKED "own pane id, but a foreign session"  env HERDR_SESSION=local herdr --session foreign pane send-text w1:p9 "cross server"
expect allowed "a non-Pi pane on another session"    herdr --session foreign pane send-text w1:p2 "echo fixing"
sleep 0.2
leak=$(grep -cE 'send-text w1:p1 (hey reviewer|/talk|human ok|door ok|off)|run w1:p1 echo hi|prompt reviewer|send-text w1:p1 evil' "$G/reached" 2>/dev/null || true)
# human turn, orchestrator and the off switch are ALLOWED, so only the blocked ones must be absent:
blocked=$(grep -cE 'send-text w1:p1 (hey reviewer|/talk)|run w1:p1 echo hi|prompt reviewer|send-text w1:p1 evil' "$G/reached" 2>/dev/null || true)
[ "$blocked" = "0" ] && { pass=$((pass+1)); echo "PASS  no blocked text reached the real herdr"; } || { fail=$((fail+1)); echo "FAIL  $blocked blocked calls reached the real herdr"; }
rm -rf "$G"
echo; echo "$pass passed, $fail failed"; [ $fail = 0 ]
