# The real link mod (mod/herdr-app-remote) against the bridge's own LinkServer: the layout switch
# starts the link, a host snapshot arrives, an allowlisted run round-trips (space.select), and a
# command outside the allowlist is refused without touching the app.
scenario_main() {
  [ -f "$REPO/packages/bridge/dist/link/index.js" ] || { fail "bridge not built: run pnpm -r build first"; return 1; }
  start_stack || return 1
  node "$RIG/bin/link-harness.mjs" "$REPO" "$HERDR_APP_HOME" "$RIG/link.log" "$RIG/link.cmd" &
  HARNESS_PID=$!
  wait_for 20 "link server listening" have_line "$RIG/link.log" '"listening"'
  app_do space.new --name "Project Alpha"
  app_do space.new --name "Agent 1 space"
  clone_layout_with_mod rig herdr-app-remote '{"role":"link"}' || fail "layout clone"
  app_do layout.switch --name rig
  wait_for 30 "layout switch starts the link" have_line "$RIG/link.log" '"link":"link"'
  wait_for 20 "host snapshot has both spaces" have_line "$RIG/link.log" '"spaces":["Project Alpha","Agent 1 space"'
  wait_for 20 "snapshot names the layout" have_line "$RIG/link.log" '"layout":"rig"'
  echo '{"run":"space.select","args":{"index":1}}' >>"$RIG/link.cmd"
  wait_for 20 "space.select round trip" have_line "$RIG/link.log" '"run":"space.select","outcome":{"ok":true}'
  echo '{"run":"space.close","args":{"index":1}}' >>"$RIG/link.cmd"
  wait_for 20 "space.close refused" have_line "$RIG/link.log" '"run":"space.close","outcome":{"ok":false,"code":"not_allowed"'
  herdr-app ls >"$RIG/ls.txt" 2>&1
  assert_contains "$RIG/ls.txt" "Agent 1 space" "refused command left the space alone"
  kill "$HARNESS_PID" 2>/dev/null
  return 0
}
