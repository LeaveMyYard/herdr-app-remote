# Stop (CV8): what Esc does in the pinned claude (recorded), and the bridge's real agent.stop actor against it
# (agent-stop-harness.mjs). Fake data only; the operator's Claude config is hidden by run.sh.
PINNED_CLAUDE_VERSION=2.1.323
scenario_main() {
  [ -f "$REPO/packages/bridge/dist/index.js" ] || { fail "bridge not built: run pnpm -r build first"; return 1; }
  start_stack || return 1
  node "$RIG/bin/fake-anthropic.mjs" 47200 "$RIG/api.log" & FAKE=$!
  sleep 1
  node "$RIG/bin/agent-stop-harness.mjs" "$REPO" "$RIG" "$RIG/rec-stop" "$RIG/stop.log" 47200 "$PINNED_CLAUDE_VERSION" >>"$RIG/stop.out" 2>&1
  hrc=$?
  real_home=$(getent passwd "$(id -u)" | cut -d: -f6)
  leak=$(find "$real_home"/.claude "$real_home"/.claude-* -mindepth 1 2>/dev/null | head -1)
  assert_eq "$leak" "" "the real ~/.claude* dirs are empty inside the rig"
  kill $FAKE
  while IFS= read -r line; do
    case "$line" in
      *'"check"'*'"ok":true'*) pass "$(echo "$line" | sed 's/.*"check":"\([^"]*\)".*/\1/')";;
      *'"check"'*) fail "$line";;
    esac
  done <"$RIG/stop.log"
  assert_contains "$RIG/stop.log" '"done":true' "harness finished"
  assert_eq "$hrc" "0" "harness exit"
  return 0
}
