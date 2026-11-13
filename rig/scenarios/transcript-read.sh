# Chat history (CV1): the `transcript.read` capability through the bridge's real API side and LinkServer, with the
# harness as the Remote panel copy (transcript-harness.mjs). `herdr-app check` must pass on the mod (its panel gained
# the "Chat history" switch). The harness proves: a devices.json from before CV1 reads as off; `chatview:<t>` and
# `timeline:<t>` are refused with `stale forbidden` while other topics work; the panel switch takes no time limit,
# turns it on (stored) and off; off ends open subscriptions without closing the socket; Activity has ids only.
scenario_main() {
  [ -f "$REPO/packages/bridge/dist/index.js" ] || { fail "bridge not built: run pnpm -r build first"; return 1; }
  start_stack || return 1
  if herdr-app check "$HERDR_APP_HOME/mods/herdr-app-remote" >"$RIG/check.txt" 2>&1; then pass "herdr-app check on the mod"; else fail "herdr-app check: $(head -c 400 "$RIG/check.txt")"; fi
  node "$RIG/bin/transcript-harness.mjs" "$REPO" "$RIG" "$RIG/transcript.log"
  hrc=$?
  while IFS= read -r line; do
    case "$line" in
      *'"check"'*'"ok":true'*) pass "$(echo "$line" | sed 's/.*"check":"\([^"]*\)".*/\1/')";;
      *'"check"'*) fail "$line";;
    esac
  done <"$RIG/transcript.log"
  assert_contains "$RIG/transcript.log" '"done":true' "harness finished"
  assert_eq "$hrc" "0" "harness exit"
  return 0
}
