# S12 from a clean install: scripts/app-install into the rig's app home, the derived layout starts
# the link copy, which launches one verified bridge under flock; a layout switch reconnects to the same
# bridge; uninstall refuses while herdr-remote is shown and succeeds after switching away; the bridge
# idles out once the app is gone. The shipped main layout is hash-checked unchanged throughout.
bridge_pid() { # the serving bridge of this rig's app home, from runtime.json
  node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(r.pid))}catch{}' "$HERDR_APP_HOME/data/herdr-app-remote/runtime.json"
}
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
gone() { ! alive "$1"; }
serving() { # node processes serving this home (the flock(1) parent has the same argv tail)
  for p in $(pgrep -f "$HERDR_APP_HOME/data/herdr-app-remote/bin/bridge.mjs serve"); do ps -o comm= -p "$p"; done | grep -vc '^flock$'
}
runtime_trusted() { # runtime.json names the recorded bundle hash and a live pid
  node -e '
const fs=require("fs"),h=process.argv[1];
const r=JSON.parse(fs.readFileSync(h+"/data/herdr-app-remote/runtime.json","utf8"));
const i=JSON.parse(fs.readFileSync(h+"/data/herdr-app-remote/install.json","utf8"));
process.exit(r.bundle_sha256===i.files["data/herdr-app-remote/bin/bridge.mjs"].sha256?0:1)' "$HERDR_APP_HOME" && alive "$(bridge_pid)"
}
linked() { # an established TCP connection on the bridge's link port
  port=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port))' "$HERDR_APP_HOME/data/herdr-app-remote/runtime.json" 2>/dev/null)
  [ -n "$port" ] && ss -Htn state established "( sport = :$port )" | grep -q .
}
install_cmd() { node "$REPO/scripts/app-install" "$@" --app-home "$HERDR_APP_HOME" >>"$RIG/install.log" 2>&1; }

scenario_main() {
  [ -f "$REPO/packages/bridge/dist/bridge.mjs" ] && [ -f "$REPO/installer/dist/index.js" ] || { fail "not built: run pnpm -r build first"; return 1; }
  # A clean home: run.sh drops a rig copy of our mod in, and the docking probe mod, which the app would
  # dock into the first personal layout it shows (ours), making it the person's edit. Both go first.
  rm -rf "$HERDR_APP_HOME/mods/herdr-app-remote" "$HERDR_APP_HOME/mods/probe"
  start_stack || return 1
  wait_for 20 "app wrote its main layout" test -f "$HERDR_APP_HOME/layouts/main.json"
  main_sha=$(sha256sum "$HERDR_APP_HOME/layouts/main.json" | cut -d' ' -f1)
  key=""; [ -f "$HERDR_APP_HOME/keys.json" ] && key="--key ctrl-alt-r"
  say "keys.json present: ${key:+yes}"
  # shellcheck disable=SC2086
  if install_cmd install $key; then pass "clean install"; else fail "clean install"; cat "$RIG/install.log"; return 1; fi
  # shellcheck disable=SC2086
  if install_cmd install $key; then pass "re-install is accepted"; else fail "re-install"; fi
  assert_eq "$(sha256sum "$HERDR_APP_HOME/layouts/main.json" | cut -d' ' -f1)" "$main_sha" "shipped main.json unchanged by install"
  assert_contains "$HERDR_APP_HOME/layouts/herdr-remote.json" '"role": "link"' "derived layout has the link role"
  assert_contains "$HERDR_APP_HOME/layouts/herdr-remote.json" '"role": "panel"' "derived layout has the panel role"
  [ -n "$key" ] && assert_contains "$HERDR_APP_HOME/keys.json" '"ctrl-alt-r": "herdr-app-remote.open"' "key bound"
  if herdr-app check "$HERDR_APP_HOME/mods/herdr-app-remote" >"$RIG/check.txt" 2>&1; then pass "herdr-app check on the installed mod"; else fail "herdr-app check: $(head -c 400 "$RIG/check.txt")"; fi
  assert_eq "$(serving)" "0" "install started no bridge (nothing selected)"
  app_do space.new --name "Project Alpha"
  app_do layout.switch --name herdr-remote
  wait_for 30 "the link copy launched a trusted bridge" runtime_trusted
  wait_for 20 "the link copy is connected" linked
  pid=$(bridge_pid)
  say "bridge pid: $pid"
  sleep 3
  assert_eq "$(serving)" "1" "exactly one bridge serves"
  [ -f "$HERDR_APP_HOME/data/herdr-app-remote/bridge.lock" ] && pass "flock lock file in use" || fail "no lock file"
  # A layout switch restarts the copies: they reconnect to the same bridge, no second one starts.
  app_do layout.switch --name main
  sleep 2
  app_do layout.switch --name herdr-remote
  wait_for 30 "reconnected after the layout switch" linked
  assert_eq "$(bridge_pid)" "$pid" "same bridge after the switch"
  assert_eq "$(serving)" "1" "still one bridge"
  # The panel key command (informational: the result is the panel column shown on the Remote child).
  app_do herdr-app-remote.open && pass "open command accepted" || say "NOTE: herdr-app do herdr-app-remote.open not accepted"
  # Uninstall while shown: refused, nothing changed.
  if install_cmd uninstall; then fail "uninstall must refuse while herdr-remote is shown"; else pass "uninstall refused while shown"; fi
  [ -f "$HERDR_APP_HOME/mods/herdr-app-remote/main.js" ] && pass "refused uninstall kept the mod" || fail "refused uninstall removed files"
  # Switch away, then uninstall: allowed, and the running bridge stops by itself.
  app_do layout.switch --name main
  sleep 2
  if install_cmd uninstall; then pass "uninstall after switching away"; else fail "uninstall after switching away"; fi
  wait_for 20 "bridge stops after uninstall" gone "$pid"
  assert_eq "$(serving)" "0" "no bridge left after uninstall"
  # Install again and let the app go: the bridge idles out (30 s grace, 5 s checks).
  # shellcheck disable=SC2086
  if install_cmd install $key; then pass "install again"; else fail "install again"; fi
  app_do layout.switch --name herdr-remote
  wait_for 30 "a new bridge after reinstall" runtime_trusted
  pid=$(bridge_pid)
  kill "$APP_PID" 2>/dev/null
  wait_for 60 "bridge stops once the app is gone" gone "$pid"
  wait_for 5 "runtime.json removed by the bridge" test ! -f "$HERDR_APP_HOME/data/herdr-app-remote/runtime.json"
  # With no window, uninstall goes ahead and leaves nothing of ours.
  if install_cmd uninstall; then pass "uninstall with no window"; else fail "uninstall with no window"; fi
  [ ! -e "$HERDR_APP_HOME/mods/herdr-app-remote" ] && [ ! -e "$HERDR_APP_HOME/data/herdr-app-remote" ] && [ ! -e "$HERDR_APP_HOME/layouts/herdr-remote.json" ] && pass "nothing of ours left" || fail "leftovers after uninstall"
  [ -n "$key" ] && assert_absent "$HERDR_APP_HOME/keys.json" "herdr-app-remote.open" "key binding removed"
  assert_eq "$(sha256sum "$HERDR_APP_HOME/layouts/main.json" | cut -d' ' -f1)" "$main_sha" "shipped main.json unchanged after uninstall"
  cat "$RIG/install.log" >>"$RIG/rig.log"
  return 0
}
