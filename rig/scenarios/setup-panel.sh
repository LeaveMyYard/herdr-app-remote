# S14b: the Remote panel's Setup view (design/DesktopSetup.dc.html) against the bridge's real app (`startApp`
# with no serve identity, so Tailscale setup runs) and the rig's FAKE `tailscale` CLI. `herdr-app check` must
# pass; the panel copy must connect and draw the Setup view, shot at the board's state (step 3, HTTPS off) and
# with the operator error (the fix command shown, never run); Start and Stop serving go through panel_act with
# no arguments, and anything with arguments is refused before setup is reached. Every Start and Stop lands in
# Activity as codes only. Clicks are covered by the mod's unit tests (the rig has no input injection).
TS=$RIG/ts
harness() { echo "$1" >>"$RIG/harness.cmd"; }
harness_out() { wait_for 90 "harness op $1 answered" have_line "$RIG/harness.log" "\"n\":$1,"; grep -F "\"n\":$1," "$RIG/harness.log" | tail -1; }
OPN=0
op() { harness "$1"; out=$(harness_out "$OPN"); OPN=$((OPN + 1)); say "op $1: $out"; }
mutating_calls() { grep -vxF -e '["version"]' -e '["status","--json"]' -e '["serve","status","--json"]' "$TS/calls.log"; }
# The mod's panel connections only (the harness marks its own with "harness":true).
panel_links() { grep -cF '"link":"panel","t"' "$RIG/harness.log" 2>/dev/null; }
panel_links_ge() { [ "$(panel_links)" -ge "$1" ] || return 1; }
# A layout = main with the Remote panel as a child of its right-hand panel column (as the installer derives it).
clone_layout_with_panel() { # <layout>
  app_do layout.clone --name main --as "$1" || return 1
  sleep 1
  node -e '
const fs = require("fs"), p = process.argv[1], l = JSON.parse(fs.readFileSync(p, "utf8"));
const find = (n, id) => n.id === id ? n : (n.children || []).map(c => find(c, id)).find(Boolean);
const body = find(l, "panel-body"), col = find(l, "panel");
body.children.push({ id: "remote", type: "block", content: { mod: "herdr-app-remote", props: { role: "panel" } } });
body.active = "remote"; delete col.hidden;
fs.writeFileSync(p, JSON.stringify(l, null, 1));' "$HERDR_APP_HOME/layouts/$1.json"
}
# Shows a fresh layout with the panel, waits for the mod's panel copy to link, and takes a shot. (A fresh clone
# each time: switching back to a layout used before was not reliable in the rig.)
SHOTN=0
shot() { # <name>
  SHOTN=$((SHOTN + 1))
  want=$(( $(panel_links) + 1 ))
  clone_layout_with_panel "rig-setup-$SHOTN" || fail "layout clone $1"
  app_do layout.switch --name "rig-setup-$SHOTN"
  wait_for 60 "panel copy connects ($1)" panel_links_ge "$want"
  sleep 4
  if herdr-app shot "$RIG/shots/$1.png" >"$RIG/shot-$1.txt" 2>&1 && [ -s "$RIG/shots/$1.png" ]; then pass "screenshot $1"; else fail "screenshot $1: $(head -c 300 "$RIG/shot-$1.txt")"; fi
  # Off the panel layout again: the harness's own panel connection would otherwise fight the mod's for the slot.
  app_do layout.clone --name main --as "rig-plain-$SHOTN"
  app_do layout.switch --name "rig-plain-$SHOTN"
  sleep 6
}

scenario_main() {
  [ -f "$REPO/packages/bridge/dist/index.js" ] || { fail "bridge not built: run pnpm -r build first"; return 1; }
  assert_eq "$(command -v tailscale)" "$RIG/fakebin/tailscale" "tailscale is the rig's fake"
  mkdir -p "$HERDR_APP_HOME" && echo '{"frame.welcomed":"finished"}' >"$HERDR_APP_HOME/shared.json"
  # The board's state: steps 1-2 done, HTTPS certificates off.
  echo '{"status":"status-https-off.json"}' >"$TS/conf.json"
  start_stack || return 1
  mkdir -p "$RIG/shots"
  node -e '
const fs = require("fs"), p = process.argv[1], s = JSON.parse(fs.readFileSync(p, "utf8"));
s.appearance = "dark"; fs.writeFileSync(p, JSON.stringify(s, null, 1));' "$HERDR_APP_HOME/settings.json"
  if herdr-app check "$HERDR_APP_HOME/mods/herdr-app-remote" >"$RIG/check.txt" 2>&1; then pass "herdr-app check on the mod"; else fail "herdr-app check: $(head -c 400 "$RIG/check.txt")"; fi
  node "$RIG/bin/pairing-harness.mjs" "$REPO" "$HERDR_APP_HOME" "$RIG/harness.log" "$RIG/harness.cmd" >>"$RIG/harness.out" 2>&1 &
  HARNESS_PID=$!
  wait_for 20 "bridge API listening with setup" have_line "$RIG/harness.log" '"setup":true'
  app_do space.new --name "Project Alpha"

  # 1. The board: step 3 of 5, HTTPS off, Start serving disabled.
  op '{"op":"check"}'
  case "$out" in *'"step":3'*'"can_start":false'*'"code":"https_off"'*'"url":"https://login.tailscale.com/admin/dns"'*) pass "setup at step 3: HTTPS off, admin DNS link, Start serving not offered";; *) fail "step 3: $out";; esac
  shot setup-https-off

  # 2. Arguments are refused before setup runs; unknown setup kinds too.
  echo '{}' >"$TS/conf.json"
  op '{"op":"check"}'
  case "$out" in *'"step":4'*'"can_start":true'*) pass "HTTPS on: step 4 offers Start serving";; *) fail "step 4: $out";; esac
  op '{"op":"panel","kind":"setup.start","args":{"port":443}}'
  case "$out" in *'"res":{"ok":false,"code":"bad_args"}'*) pass "setup.start with an argument: bad_args";; *) fail "args: $out";; esac
  op '{"op":"panel","kind":"setup.start","args":{"target":"http://127.0.0.1:1"}}'
  case "$out" in *'"code":"bad_args"'*) pass "setup.start with a target: bad_args";; *) fail "target: $out";; esac
  op '{"op":"panel","kind":"setup.set","args":{}}'
  case "$out" in *'"code":"unsupported_action"'*) pass "an unknown setup kind: unsupported_action";; *) fail "kind: $out";; esac
  assert_eq "$(mutating_calls)" "" "nothing changed by refused acts"

  # 3. The Linux operator error: the fix is shown, never run.
  echo '{"set":"operator"}' >"$TS/conf.json"
  op '{"op":"panel","kind":"setup.start","args":{}}'
  case "$out" in *'"res":{"ok":false,"code":"operator"}'*'"fix":"sudo tailscale set --operator=$USER"'*) pass "Start serving: operator error, fix command in the view";; *) fail "operator: $out";; esac
  if grep -q '"set"' "$TS/calls.log"; then fail "tailscale set was run"; else pass "tailscale set never ran"; fi
  shot setup-operator

  # 4. Start serving through the panel, then Stop serving.
  echo '{}' >"$TS/conf.json"
  : >"$TS/calls.log"
  op '{"op":"panel","kind":"setup.start","args":{}}'
  case "$out" in *'"res":{"ok":true}'*'"status":"serving"'*'"serving":"ours"'*'"can_stop":true'*) pass "Start serving from the panel: serving, ours, Stop offered";; *) fail "start: $out";; esac
  assert_eq "$(mutating_calls)" '["serve","--bg","--https=8443","http://127.0.0.1:47391"]' "the only change: tailscale serve --bg --https=8443 http://127.0.0.1:47391"
  shot setup-serving
  # Stop refused by the operator rule while still served: the fix stays on the Status tab as the notice.
  echo '{"off":"operator"}' >"$TS/conf.json"
  op '{"op":"panel","kind":"setup.stop","args":{}}'
  case "$out" in *'"res":{"ok":false,"code":"operator"}'*'"status":"serving"'*'"notice":{"code":"operator"'*'"fix":"sudo tailscale set --operator=$USER"'*) pass "Stop serving refused (operator): still serving, fix shown as the notice";; *) fail "stop operator: $out";; esac
  shot setup-stop-operator
  echo '{}' >"$TS/conf.json"
  op '{"op":"panel","kind":"setup.stop","args":{}}'
  case "$out" in *'"res":{"ok":true}'*'"status":"setup"'*'"serving":"off"'*) pass "Stop serving from the panel: back to setup";; *) fail "stop: $out";; esac
  assert_eq "$(cat "$TS/serve.json" | tr -d ' \n')" '{}' "our handler removed"

  # 5. Activity: every Start and Stop, codes only.
  op '{"op":"activity"}'
  case "$out" in *'"Start serving failed (operator)"'*'"Started serving on the tailnet"'*'"Stop serving failed (operator)"'*'"Stopped serving on the tailnet"'*) pass "Start and Stop audited";; *) fail "activity: $out";; esac
  case "$out" in *ts.net*|*127.0.0.1*|*sudo*) fail "activity carries free text: $out";; *) pass "activity has no host, target or command";; esac

  assert_absent "$RIG/harness.log" '"reason":"invalid"' "bridge dropped no invalid line from the panel"
  assert_absent "$RIG/harness.log" '"event":"panel_invalid"' "every panel view matched the schema"
  kill "$HARNESS_PID" 2>/dev/null
  return 0
}
