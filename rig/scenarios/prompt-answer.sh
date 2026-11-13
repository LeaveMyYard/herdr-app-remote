# Prompt answering (CV7): the bridge's real prompt.answer actor against the real pinned claude in the rig's hc terminals
# and the scripted fake API (prompt-answer-harness.mjs). Fake data only; the operator's Claude config is hidden.
PINNED_CLAUDE_VERSION=2.1.323
scenario_main() {
  [ -f "$REPO/packages/bridge/dist/index.js" ] || { fail "bridge not built: run pnpm -r build first"; return 1; }
  start_stack || return 1
  node "$RIG/bin/fake-anthropic.mjs" 47200 "$RIG/api.log" & FAKE=$!
  sleep 1
  node "$RIG/bin/prompt-answer-harness.mjs" "$REPO" "$RIG" "$RIG/prompt.log" 47200 "$PINNED_CLAUDE_VERSION" >>"$RIG/prompt.out" 2>&1
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
  done <"$RIG/prompt.log"
  assert_contains "$RIG/prompt.log" '"done":true' "harness finished"
  assert_eq "$hrc" "0" "harness exit"
  return 0
}
