# Claude prompts (H0): see claude-prompts-harness.mjs. PINNED_CLAUDE_VERSION moves together with fixtures/claude-prompts/.
PINNED_CLAUDE_VERSION=2.1.323
scenario_main() {
  start_stack || return 1
  node "$RIG/bin/fake-anthropic.mjs" 47200 "$RIG/api.log" & FAKE=$!
  sleep 1
  node "$RIG/bin/claude-prompts-harness.mjs" "$RIG" "$RIG/rec-claude" "$RIG/claude.log" 47200 "$PINNED_CLAUDE_VERSION"
  hrc=$?
  # Isolation: the operator's real Claude config must be unreachable inside the rig (run.sh hides it).
  real_home=$(getent passwd "$(id -u)" | cut -d: -f6)
  leak=$(find "$real_home"/.claude "$real_home"/.claude-* -mindepth 1 2>/dev/null | head -1)
  assert_eq "$leak" "" "the real ~/.claude* dirs are empty inside the rig"
  [ ! -s "$real_home/.claude.json" ] && pass "the real ~/.claude.json is empty inside the rig" || fail "real ~/.claude.json readable"
  kill $FAKE
  while IFS= read -r line; do
    case "$line" in
      *'"check"'*'"ok":true'*) pass "$(echo "$line" | sed 's/.*"check":"\([^"]*\)".*/\1/')";;
      *'"check"'*) fail "$line";;
    esac
  done <"$RIG/claude.log"
  assert_contains "$RIG/claude.log" '"done":true' "harness finished"
  assert_eq "$hrc" "0" "harness exit"
  return 0
}
