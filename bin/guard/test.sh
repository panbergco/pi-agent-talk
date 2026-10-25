#!/usr/bin/env bash
# Exercises bin/guard/tmux on a private tmux server that it is told to treat as the real one.
# Run: bin/guard/test.sh   (exit 0 = every verdict as expected)
set -u
here=$(cd "$(dirname "$0")" && pwd); T="$here/tmux"; G=$(mktemp -d); S=guardtest-$$
cp "$(command -v bash)" "$G/pi"; mkdir -p "$G/inst" "$G/evil"
printf '#!/bin/bash\n"$@"\n' > "$G/inst/orch"; cp "$G/inst/orch" "$G/evil/orch"; chmod +x "$G/inst/orch" "$G/evil/orch"
tm() { /usr/bin/tmux -L $S -f /dev/null "$@"; }
tm new-session -d -s t -n pipane -x 150 -y 30 "$G/pi --norc -c 'trap \"\" INT QUIT TSTP; while IFS= read -r l; do echo GOT:\$l; done'"
tm new-window -t t -n bashpane "bash --norc"; sleep 0.6
export MACP_GUARD_SOCKET="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$S" XDG_STATE_HOME="$G/state" MACP_GUARD_ORCHESTRATORS_FILE=/dev/null MACP_GUARD_ORCHESTRATORS="$G/inst/orch"
pass=0; fail=0
expect() { local want=$1 desc=$2; shift 2; local out got; out=$("$@" 2>&1); echo "$out" | grep -q 'tmux guard:' && got=BLOCKED || got=allowed
  if [ "$got" = "$want" ]; then pass=$((pass+1)); echo "PASS  $desc"; else fail=$((fail+1)); echo "FAIL  $desc (got $got)"; fi; }
expect BLOCKED "words into a Pi pane"                    $T -L $S send-keys -t t:pipane "hey reviewer, quick question" Enter
expect allowed "control keys into a Pi pane"             $T -L $S send-keys -t t:pipane C-c Escape
expect allowed "single-letter answer + Enter"            $T -L $S send-keys -t t:pipane y Enter
expect allowed "slash command (/reload)"                 $T -L $S send-keys -t t:pipane "/reload" Enter
expect BLOCKED "/talk (would carry the human's authority)" $T -L $S send-keys -t t:pipane "/talk tell the reviewer to stop" Enter
expect allowed "@file paste"                             $T -L $S send-keys -t t:pipane -l "@/home/x.png "
expect BLOCKED "literal words (-l)"                      $T -L $S send-keys -t t:pipane -l "hello"
expect allowed "words into a bash pane"                  $T -L $S send-keys -t t:bashpane "echo fixing" Enter
expect allowed "words in a human turn"                   env PI_HUMAN_TURN=1 $T -L $S send-keys -t t:pipane "human ok" Enter
expect allowed "words from the installed orchestrator"   "$G/inst/orch" $T -L $S send-keys -t t:pipane "door ok" Enter
expect BLOCKED "words from a script named like it"       "$G/evil/orch" $T -L $S send-keys -t t:pipane "evil" Enter
expect BLOCKED "paste-buffer into a Pi pane"             $T -L $S paste-buffer -t t:pipane
expect BLOCKED "chained: keys ; words"                   $T -L $S send-keys -t t:pipane C-c \; send-keys -t t:pipane "sneaky" Enter
expect BLOCKED "short command name (send)"               $T -L $S send -t t:pipane "short" Enter
expect BLOCKED "-S path to the guarded server"           $T -S "$MACP_GUARD_SOCKET" send-keys -t t:pipane "via S" Enter
expect allowed "another tmux server is untouched"        $T -L other-$$ list-sessions
sleep 0.4
leak=$(tm capture-pane -p -t t:pipane | grep -cE 'GOT:(hey reviewer|.*tell the reviewer|hello|evil|sneaky|short|via S)')
[ "$leak" = "0" ] && { pass=$((pass+1)); echo "PASS  nothing blocked reached the Pi pane"; } || { fail=$((fail+1)); echo "FAIL  $leak blocked texts reached the Pi pane"; }
tm kill-server; rm -rf "$G"
echo; echo "$pass passed, $fail failed"; [ $fail = 0 ]
