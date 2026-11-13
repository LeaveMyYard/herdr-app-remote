# Chat (fix/chat-loading-forever): the real PWA in headless Chromium opens a chat from the Chat tab's picker and from
# the Agents tab, through a TLS stand-in for serve, and shows the lines of a real terminal read by the rig's own hc
# (chat-harness.mjs). Then the failures: a terminal closed before and while the chat is open, and hc missing, each
# a visible state within seconds; and the recovery. The harness runs without hc's directory on PATH (a desktop
# launcher's PATH): the bridge finds hc in ~/.local/bin by itself. hc's ls/read output is recorded in $RIG/rec.
scenario_main() {
  [ -f "$REPO/packages/bridge/dist/index.js" ] || { fail "bridge not built: run pnpm -r build first"; return 1; }
  [ -f "$REPO/packages/pwa/dist/index.html" ] || { fail "PWA not built: run pnpm -r build first"; return 1; }
  start_stack || return 1
  real_hc=$(command -v hc)
  hc_dir=$(dirname "$real_hc")
  # PATH without hc's directory; node and the fake tailscale stay reachable by absolute path.
  path=$(printf '%s' "$PATH" | tr ':' '\n' | grep -vxF "$hc_dir" | paste -sd: -)
  node_bin=$(command -v node)
  PATH="$path" "$node_bin" "$RIG/bin/chat-harness.mjs" "$REPO" "$RIG" "$RIG/chat.log" "$real_hc" >>"$RIG/chat.out" 2>&1
  hrc=$?
  while IFS= read -r line; do
    case "$line" in
      *'"check"'*'"ok":true'*) pass "$(echo "$line" | sed 's/.*"check":"\([^"]*\)".*/\1/')";;
      *'"check"'*) fail "$line";;
    esac
  done <"$RIG/chat.log"
  assert_contains "$RIG/chat.log" '"done":true' "harness finished"
  assert_eq "$hrc" "0" "harness exit"
  return 0
}
