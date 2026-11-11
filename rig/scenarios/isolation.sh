# Proves the sandbox: private dirs, /run/user hidden, own pid and net namespaces, socket in the rig.
scenario_main() {
  start_stack || return 1
  if [ -z "$(ls -A /run/user 2>/dev/null)" ]; then pass "/run/user empty"; else fail "/run/user visible"; fi
  assert_eq "$HOME" "$RIG/home" "private HOME"
  assert_eq "$HERDR_APP_HOME" "$RIG/home/.config/herdr-app" "private app home"
  tr '\0' ' ' </proc/1/cmdline >"$RIG/pid1.txt"
  assert_contains "$RIG/pid1.txt" "inner.sh" "own pid namespace (pid 1 is the rig)"
  # /proc/net/dev is per net namespace (/sys is not): only loopback may be there.
  awk -F: 'NR>2 {gsub(/ /,"",$1); print $1}' /proc/net/dev >"$RIG/net.txt"
  assert_eq "$(tr -d '\n' <"$RIG/net.txt")" "lo" "own net namespace (loopback only)"
  case "$hc_sock" in "$RIG"/*) pass "hc socket path inside rig";; *) fail "hc socket '$hc_sock'";; esac
  wait_for 10 "hc socket exists" test -S "$hc_sock"
  return 0
}
