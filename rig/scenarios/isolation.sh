# Proves the sandbox: private dirs, /run/user hidden, own pid and net namespaces, socket in the rig.
scenario_main() {
  start_stack || return 1
  if [ -z "$(ls -A /run/user 2>/dev/null)" ]; then pass "/run/user empty"; else fail "/run/user visible"; fi
  assert_eq "$HOME" "$RIG/home" "private HOME"
  assert_eq "$HERDR_APP_HOME" "$RIG/home/.config/herdr-app" "private app home"
  tr '\0' ' ' </proc/1/cmdline >"$RIG/pid1.txt"
  assert_contains "$RIG/pid1.txt" "inner.sh" "own pid namespace (pid 1 is the rig)"
  ls /sys/class/net >"$RIG/net.txt" 2>/dev/null
  assert_eq "$(tr -d ' \n' <"$RIG/net.txt")" "lo" "own net namespace (loopback only)"
  sock=$(hc server status 2>&1 | grep -oE '/[^ ]*\.sock' | head -1)
  case "$sock" in "$RIG"/*) pass "hc socket inside rig";; *) fail "hc socket '$sock'";; esac
  return 0
}
