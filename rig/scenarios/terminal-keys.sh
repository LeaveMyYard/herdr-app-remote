# Special-keys menu (S16b): the bridge's terminal.keys through the rig's own hc (never the live one) into a terminal
# running a raw-mode program that logs every byte it reads as hex. Records `hc keys --help` and fails if hc keys
# grows options beyond the ones S16b was built against; then keys-harness.mjs presses every allowed key token
# through the real hc keys (each must be accepted and send a control byte or escape, never text) and drives the
# bridge: capability off by default, the menu round trip, a stale menu, a damaged keys.json, refusals, the rate
# limit, expiry and the audit lines.
scenario_main() {
  [ -f "$REPO/packages/bridge/dist/index.js" ] || { fail "bridge not built: run pnpm -r build first"; return 1; }
  start_stack || return 1
  hc keys --help >"$RIG/hc-keys-help.txt" 2>&1
  assert_contains "$RIG/hc-keys-help.txt" "Usage: hc keys [OPTIONS] <TERMINAL> <KEYS>..." "hc keys takes a terminal and key names"
  opts=$(grep -oE '^ +(-[a-zA-Z], )?--[a-z-]+' "$RIG/hc-keys-help.txt" | sed 's/.*--/--/' | sort | tr '\n' ' ')
  assert_eq "$opts" "--help --json " "hc keys has only --json and --help"
  cat >"$RIG/bin/rawkeys.mjs" <<'EOT'
import { appendFileSync } from 'node:fs';
const out = process.argv[2];
process.stdin.setRawMode(true);
process.stdout.write('READY\n');
process.stdin.on('data', b => appendFileSync(out, b.toString('hex') + '\n'));
EOT
  : >"$RIG/keys-bytes.log"
  hc run --bg node "$RIG/bin/rawkeys.mjs" "$RIG/keys-bytes.log" >"$RIG/run.json" 2>&1 || { fail "hc run: $(head -c 300 "$RIG/run.json")"; return 1; }
  term=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).address)' "$RIG/run.json")
  case "$term" in t[0-9]*) pass "raw key terminal $term";; *) fail "no terminal address in $(head -c 200 "$RIG/run.json")"; return 1;; esac
  wait_for 10 "raw key program ready" sh -c "hc read $term --lines 5 | grep -q READY"
  node "$RIG/bin/keys-harness.mjs" "$REPO" "$RIG" "$term" "$RIG/keys-bytes.log" "$RIG/keys.log"
  hrc=$?
  while IFS= read -r line; do
    case "$line" in
      *'"check"'*'"ok":true'*) pass "$(echo "$line" | sed 's/.*"check":"\([^"]*\)".*/\1/')";;
      *'"check"'*) fail "$line";;
    esac
  done <"$RIG/keys.log"
  assert_contains "$RIG/keys.log" '"done":true' "harness finished"
  assert_eq "$hrc" "0" "harness exit"
  hc kill "$term" >/dev/null 2>&1
  return 0
}
