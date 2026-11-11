# The inbox answer path (S11): pairing, an answer through a STUB herdr-inbox launcher (never the real binary),
# the unknown-effect and capability cases, and the audit entries. It needs no herdr-app: it runs the bridge's own
# HTTP + WebSocket server on loopback inside the rig's net namespace, with a private app home.
scenario_main() {
  [ -f "$REPO/packages/bridge/dist/index.js" ] || { fail "bridge not built: run pnpm -r build first"; return 1; }
  case "$HERDR_APP_HOME" in "$RIG"/*) ;; *) fail "app home outside the rig"; return 1;; esac
  node "$RIG/bin/inbox-harness.mjs" "$REPO" "$HERDR_APP_HOME" "$RIG" "$RIG/inbox.log"
  hrc=$?
  while IFS= read -r line; do
    case "$line" in
      *'"check"'*'"ok":true'*) pass "$(echo "$line" | sed 's/.*"check":"\([^"]*\)".*/\1/')";;
      *'"check"'*) fail "$line";;
    esac
  done <"$RIG/inbox.log"
  assert_contains "$RIG/inbox.log" '"done":true' "harness finished"
  assert_absent "$RIG/stub-calls.log" "--force" "no forced send"
  assert_eq "$hrc" "0" "harness exit"
  return 0
}
