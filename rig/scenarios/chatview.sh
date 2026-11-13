# Chat view topic (CV3): `chatview:<t>` and its older pages through the bridge's real API side and LinkServer, with
# the real Claude reader child (pinned SDK, checked against its sha256) reading fixture transcripts under the rig's
# private HOME, roots from a fake agent-usage config, and a fake panorama feed v2 behind a hash-pinned stand-in
# contract (chatview-harness.mjs). No herdr-app is needed: the harness plays the link mod and the phone. It proves:
# refused while chat history is off; the fixture session mapped as §3 says, bound only through the feed; the open and
# the pages in Activity (ids and counts only); a new transcript line as a patch, redacted; a Codex pane is `harness`;
# an aged feed hides the chat; turning chat history off ends it and the page route refuses.
scenario_main() {
  [ -f "$REPO/packages/bridge/dist/index.js" ] || { fail "bridge not built: run pnpm -r build first"; return 1; }
  [ -f "$REPO/packages/bridge/dist/claude-reader.mjs" ] || { fail "reader not built: run pnpm -r build first"; return 1; }
  node "$RIG/bin/chatview-harness.mjs" "$REPO" "$RIG" "$RIG/chatview.log" >>"$RIG/chatview.out" 2>&1
  hrc=$?
  while IFS= read -r line; do
    case "$line" in
      *'"check"'*'"ok":true'*) pass "$(echo "$line" | sed 's/.*"check":"\([^"]*\)".*/\1/')";;
      *'"check"'*) fail "$line";;
    esac
  done <"$RIG/chatview.log"
  assert_contains "$RIG/chatview.log" '"done":true' "harness finished"
  assert_eq "$hrc" "0" "harness exit"
  return 0
}
