# Helpers sourced by inner.sh inside the sandbox. A scenario defines scenario_main.
FAILS=0
pass() { say "PASS: $*"; }
fail() { say "FAIL: $*"; FAILS=$((FAILS + 1)); }
assert_eq() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (expected '$2', got '$1')"; fi; }
assert_contains() { # file needle label
  if grep -qF -- "$2" "$1" 2>/dev/null; then pass "$3"; else fail "$3 (no '$2' in $1)"; fi
}
assert_absent() {
  if grep -qF -- "$2" "$1" 2>/dev/null; then fail "$3 ('$2' present in $1)"; else pass "$3"; fi
}
# wait_for <seconds> <label> <cmd...>: poll every 0.5s until the command succeeds.
wait_for() {
  n=$(($1 * 2)); label=$2; shift 2
  while [ "$n" -gt 0 ]; do "$@" >/dev/null 2>&1 && { pass "$label"; return 0; }; n=$((n - 1)); sleep 0.5; done
  fail "$label (timed out)"; return 1
}
have_line() { grep -qF -- "$2" "$1" 2>/dev/null; }

start_stack() {
  node "$RIG/bin/sidecar.mjs" "$RIG/sidecar.log" 47123 "$RIG/sidecar.cmd" &
  SIDECAR_PID=$!
  dbus-run-session -- mutter --headless --wayland --no-x11 --virtual-monitor 1280x800 --wayland-display rig-wl >"$RIG/mutter.log" 2>&1 &
  MUTTER_PID=$!
  for _ in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/rig-wl" ] && break; sleep 0.2; done
  say "wayland: $(ls "$XDG_RUNTIME_DIR")"
  WAYLAND_DISPLAY=rig-wl herdr-app >"$RIG/app.log" 2>&1 &
  APP_PID=$!
  say "app pid (in namespace): $APP_PID"
  wait_for 30 "app answers status" herdr-app status
}
# Everything dies with the pid namespace; this is only tidiness, by exact pid.
stop_stack() {
  for p in "${APP_PID:-}" "${SIDECAR_PID:-}" "${MUTTER_PID:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  sleep 1
}
app_do() { herdr-app do "$@" >>"$RIG/rig.log" 2>&1; }
sidecar_send() { echo "$1" >>"$RIG/sidecar.cmd"; }
# Adds the 1px probe block to a personal layout (the documented way to keep a mod alive).
clone_layout_with_probe() { # <name>
  app_do layout.clone --name main --as "$1" || return 1
  sleep 1
  node -e '
const fs = require("fs"), p = process.argv[1], l = JSON.parse(fs.readFileSync(p, "utf8"));
l.children.push({ id: "bridge", type: "block", size: { px: 1 }, content: { mod: "probe" } });
fs.writeFileSync(p, JSON.stringify(l, null, 1));' "$HERDR_APP_HOME/layouts/$1.json"
}
