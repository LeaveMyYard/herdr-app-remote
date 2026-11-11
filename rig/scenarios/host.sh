# Host scenarios: a space appears, a layout switch keeps a mod alive, the mod mirrors host data to
# the sidecar (a host snapshot) and commands pushed back by the sidecar round-trip (space.select, tab.select).
scenario_main() {
  start_stack || return 1
  app_do space.new --name "Project Alpha"
  clone_layout_with_probe rig || fail "layout clone"
  app_do layout.switch --name rig
  wait_for 20 "probe connects to the sidecar" have_line "$RIG/sidecar.log" "connection"
  wait_for 20 "probe says hello" have_line "$RIG/sidecar.log" '"hello":"probe"'
  wait_for 20 "snapshot shows Project Alpha" have_line "$RIG/sidecar.log" '"name":"Project Alpha"'
  # Host data changes: the probe re-renders and the sidecar sees them.
  app_do terminal.open --argv '["sh","-c","sleep 300"]'
  wait_for 20 "terminal appears in a later render" have_line "$RIG/sidecar.log" '"terminals":["'
  # Command round trip: sidecar -> mod -> app. Selecting a space is observable in the next snapshot.
  app_do space.new --name "Agent 1 space"
  wait_for 20 "second space shows in a snapshot" have_line "$RIG/sidecar.log" '"name":"Agent 1 space"'
  sidecar_send '{"run":"space.select","args":{"index":0}}'
  wait_for 20 "mod ran space.select" have_line "$RIG/sidecar.log" '"ran":"space.select"'
  wait_for 20 "Project Alpha is active again" have_line "$RIG/sidecar.log" '"name":"Project Alpha","tabs":1,"active":true'
  sidecar_send '{"run":"tab.select","args":{"index":0}}'
  wait_for 20 "mod ran tab.select" have_line "$RIG/sidecar.log" '"ran":"tab.select"'
  # place:none mods only start when something opens them.
  assert_absent "$RIG/sidecar.log" '"from":"probe-none"' "probe-none not started yet"
  app_do mod.open --name probe-none
  wait_for 20 "probe-none starts on open" have_line "$RIG/sidecar.log" '"from":"probe-none"'
  app_do overlay.close
  if herdr-app status >"$RIG/status.txt" 2>&1; then pass "status answers"; else fail "status answers"; fi
  return 0
}
