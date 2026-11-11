# Terminal input (S16): the bridge's terminal.send through the rig's own hc (never the live one) into a terminal
# running a line echoer. Checks the capability refusal, the send round trip, `--force` typed as text, Enter alone,
# the refusals, the rate limit, expiry and the audit lines (terminal-harness.mjs). Also records `hc send --help`,
# and fails if hc send ever grows options beyond the ones S16 was built against (the key bar depends on it).
scenario_main() {
  [ -f "$REPO/packages/bridge/dist/index.js" ] || { fail "bridge not built: run pnpm -r build first"; return 1; }
  start_stack || return 1
  hc send --help >"$RIG/hc-send-help.txt" 2>&1
  assert_contains "$RIG/hc-send-help.txt" "Usage: hc send [OPTIONS] <TERMINAL> <TEXT>" "hc send takes a terminal and text only"
  assert_contains "$RIG/hc-send-help.txt" "Pasted, then submitted with Enter" "hc send pastes and presses Enter"
  opts=$(grep -oE '^ +(-[a-zA-Z], )?--[a-z-]+' "$RIG/hc-send-help.txt" | sed 's/.*--/--/' | sort | tr '\n' ' ')
  assert_eq "$opts" "--force --help --if --json --timeout --wait " "hc send has no key option (text-only key bar)"
  cat >"$RIG/bin/echoer.sh" <<'EOT'
#!/bin/sh
while IFS= read -r l; do printf 'GOT[%s]\n' "$l"; done
EOT
  chmod +x "$RIG/bin/echoer.sh"
  hc run --bg "$RIG/bin/echoer.sh" >"$RIG/run.json" 2>&1 || { fail "hc run: $(head -c 300 "$RIG/run.json")"; return 1; }
  term=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).address)' "$RIG/run.json")
  case "$term" in t[0-9]*) pass "echo terminal $term";; *) fail "no terminal address in $(head -c 200 "$RIG/run.json")"; return 1;; esac
  node "$RIG/bin/terminal-harness.mjs" "$REPO" "$RIG" "$term" "$RIG/terminal.log"
  hrc=$?
  while IFS= read -r line; do
    case "$line" in
      *'"check"'*'"ok":true'*) pass "$(echo "$line" | sed 's/.*"check":"\([^"]*\)".*/\1/')";;
      *'"check"'*) fail "$line";;
    esac
  done <"$RIG/terminal.log"
  assert_contains "$RIG/terminal.log" '"done":true' "harness finished"
  assert_eq "$hrc" "0" "harness exit"
  hc kill "$term" >/dev/null 2>&1
  return 0
}
