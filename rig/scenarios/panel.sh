# S13: the Remote panel mod against the bridge's real LinkServer, Security and PanelDriver, seeded with
# FAKE devices, plugins and activity (panel-harness.mjs). `herdr-app check` must pass, the panel copy must
# connect and receive its view, and a screenshot per tab goes to $RIG/shots/ for the side-by-side with
# design/DesktopRemote.dc.html. Clicks are covered by the mod's unit tests (the rig has no input injection).
panel_links() { grep -c '"link":"panel"' "$RIG/panel.log" 2>/dev/null; }
panel_links_ge() { [ "$(panel_links)" -ge "$1" ] || { say "links=$(panel_links) want=$1"; return 1; }; }
# A layout = main with the Remote panel as a child of its right-hand panel column (the way the installer
# derives it), showing <tab> first.
clone_layout_with_panel() { # <layout> <tab>
  app_do layout.clone --name main --as "$1" || return 1
  sleep 1
  node -e '
const fs = require("fs"), p = process.argv[1], l = JSON.parse(fs.readFileSync(p, "utf8"));
const find = (n, id) => n.id === id ? n : (n.children || []).map(c => find(c, id)).find(Boolean);
const body = find(l, "panel-body"), col = find(l, "panel");
body.children.push({ id: "remote", type: "block", content: { mod: "herdr-app-remote", props: { role: "panel", tab: process.argv[2] } } });
body.active = "remote"; delete col.hidden;
fs.writeFileSync(p, JSON.stringify(l, null, 1));' "$HERDR_APP_HOME/layouts/$1.json" "$2"
}

scenario_main() {
  [ -f "$REPO/packages/bridge/dist/index.js" ] || { fail "bridge not built: run pnpm -r build first"; return 1; }
  # The welcome dialog would sit over the shots: mark it done in the rig's own shared.json first.
  mkdir -p "$HERDR_APP_HOME" && echo '{"frame.welcomed":"finished"}' >"$HERDR_APP_HOME/shared.json"
  start_stack || return 1
  mkdir -p "$RIG/shots"
  # The board is dark; settings.json is the rig's own. The welcome dialog is dismissed for the shots.
  node -e '
const fs = require("fs"), p = process.argv[1], s = JSON.parse(fs.readFileSync(p, "utf8"));
s.appearance = "dark"; fs.writeFileSync(p, JSON.stringify(s, null, 1));' "$HERDR_APP_HOME/settings.json"
  if herdr-app check "$HERDR_APP_HOME/mods/herdr-app-remote" >"$RIG/check.txt" 2>&1; then pass "herdr-app check on the mod"; else fail "herdr-app check: $(head -c 400 "$RIG/check.txt")"; fi
  node "$RIG/bin/panel-harness.mjs" "$REPO" "$HERDR_APP_HOME" "$RIG/panel.log" &
  HARNESS_PID=$!
  wait_for 20 "bridge side listening, seeded with fake data" have_line "$RIG/panel.log" '"devices":2'
  app_do space.new --name "Project Alpha"
  want=0
  for tab in status devices plugins activity; do
    want=$((want + 1))
    clone_layout_with_panel "rig-$tab" "$tab" || fail "layout clone $tab"
    app_do layout.switch --name "rig-$tab"
    wait_for 30 "panel copy connects ($tab)" panel_links_ge "$want"
    sleep 3
    if herdr-app shot "$RIG/shots/panel-$tab.png" >"$RIG/shot-$tab.txt" 2>&1 && [ -s "$RIG/shots/panel-$tab.png" ]; then pass "screenshot $tab"; else fail "screenshot $tab: $(head -c 300 "$RIG/shot-$tab.txt")"; fi
  done
  assert_absent "$RIG/panel.log" '"reason":"invalid"' "bridge dropped no invalid line from the panel"
  assert_absent "$RIG/panel.log" '"link":"link"' "only the panel copy connected"
  kill "$HARNESS_PID" 2>/dev/null
  return 0
}
