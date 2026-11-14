# Claude multi-question prompts (CV9, H0 style): see claude-multiq-harness.mjs. The pin moves with fixtures/claude-prompts/.
PINNED_CLAUDE_VERSION=2.1.325
scenario_main() {
  start_stack || return 1
  node "$RIG/bin/fake-anthropic.mjs" 47200 "$RIG/api.log" & FAKE=$!
  sleep 1
  node "$RIG/bin/claude-multiq-harness.mjs" "$RIG" "$RIG/rec-multiq" "$RIG/multiq.log" 47200 "$PINNED_CLAUDE_VERSION"
  hrc=$?
  real_home=$(getent passwd "$(id -u)" | cut -d: -f6)
  leak=$(find "$real_home"/.claude "$real_home"/.claude-* "$real_home"/.cache/claude "$real_home"/.cache/claude-* "$real_home"/.local/state/claude "$real_home"/.local/state/claude-* -mindepth 1 2>/dev/null | head -1)
  assert_eq "$leak" "" "the real ~/.claude*, ~/.cache/claude*, ~/.local/state/claude* dirs are empty inside the rig"
  kill $FAKE
  while IFS= read -r line; do
    case "$line" in
      *'"check"'*'"ok":true'*) pass "$(echo "$line" | sed 's/.*"check":"\([^"]*\)".*/\1/')";;
      *'"check"'*) fail "$line";;
    esac
  done <"$RIG/multiq.log"
  assert_contains "$RIG/multiq.log" '"done":true' "harness finished"
  assert_eq "$hrc" "0" "harness exit"
  return 0
}
