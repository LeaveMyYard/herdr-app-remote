# S14 (and the rig run S5 owed): Tailscale setup and serve control against the fake `tailscale` CLI, then a
# phone pairing through a stand-in for serve that injects Tailscale-User-Login.
#   - the bridge refuses everything but /healthz until "Start serving" supplies the serve identity;
#   - Start serving runs exactly `tailscale serve --bg --https=8443 http://127.0.0.1:47391`;
#   - Host spoof, a missing identity and a wrong login are refused; pairing, approval, then the WebSocket
#     gets the host snapshot from the real link mod;
#   - Funnel on the serve port: every request answers 503 funnel and the live socket closes 4004;
#   - Stop serving removes only our handler (a handler on another port is kept);
#   - a port held by a handler we did not create is refused and left byte-for-byte unchanged;
#   - the Linux operator error shows the fix command, and `tailscale set` is never run.
TS=$RIG/ts
harness() { echo "{\"op\":\"$1\"}" >>"$RIG/harness.cmd"; }
# wait for the harness's answer to the n-th op (0-based) and print it
harness_out() { wait_for 30 "harness op $1 answered" have_line "$RIG/harness.log" "\"n\":$1,"; grep -F "\"n\":$1," "$RIG/harness.log" | tail -1; }
OPN=0
op() { harness "$1"; out=$(harness_out "$OPN"); OPN=$((OPN + 1)); say "op $1: $out"; }
phone() { node "$RIG/bin/phone.mjs" "$REPO" "$RIG" "$@"; }
ts_calls() { cat "$TS/calls.log"; }
mutating_calls() { grep -vxF -e '["version"]' -e '["status","--json"]' -e '["serve","status","--json"]' "$TS/calls.log"; }

scenario_main() {
  [ -f "$REPO/packages/bridge/dist/index.js" ] || { fail "bridge not built: run pnpm -r build first"; return 1; }
  assert_eq "$(command -v tailscale)" "$RIG/fakebin/tailscale" "tailscale is the rig's fake"
  # A handler on another port that is not ours: it must survive everything below.
  cp "$RIG/bin/tailscale-fixtures/serve-other-port.json" "$TS/serve.json"
  other_sha=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify({TCP:{443:d.TCP["443"]},Web:{k:d.Web[Object.keys(d.Web).find(k=>k.endsWith(":443"))]}}))' "$TS/serve.json" | sha256sum | cut -d' ' -f1)
  other443() { node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify({TCP:{443:(d.TCP||{})["443"]},Web:{k:(d.Web||{})[Object.keys(d.Web||{}).find(k=>k.endsWith(":443"))]}}))' "$TS/serve.json" | sha256sum | cut -d' ' -f1; }

  start_stack || return 1
  node "$RIG/bin/pairing-harness.mjs" "$REPO" "$HERDR_APP_HOME" "$RIG/harness.log" "$RIG/harness.cmd" >>"$RIG/harness.out" 2>&1 &
  HARNESS_PID=$!
  wait_for 20 "bridge API listening with setup" have_line "$RIG/harness.log" '"setup":true'
  node "$RIG/bin/serve-standin.mjs" 8443 47391 user-1@example >>"$RIG/standin.log" 2>&1 &
  STANDIN_PID=$!
  wait_for 10 "serve stand-in listening" have_line "$RIG/standin.log" '"standin":8443'
  app_do space.new --name "Project Alpha"
  clone_layout_with_mod rig herdr-app-remote '{"role":"link"}' || fail "layout clone"
  app_do layout.switch --name rig
  wait_for 30 "the real link mod connected" have_line "$RIG/harness.log" '"link":"link"'

  # Before serving: only /healthz.
  op check
  case "$out" in *'"step":4'*'"serving":"off"'*'"can_start":true'*) pass "setup: steps 1-3 done, step 4 offers Start serving";; *) fail "setup before start: $out";; esac
  r=$(phone get /api/v1/meta); say "$r"
  case "$r" in *'"status":403'*) pass "no serve identity yet: refused";; *) fail "before serving: $r";; esac
  r=$(phone get /healthz); case "$r" in *'"status":200'*) pass "/healthz answers before serving";; *) fail "healthz: $r";; esac

  # Start serving.
  op start
  case "$out" in *'"res":{"ok":true}'*'"serving":"ours"'*'"login":"user-1@example"'*) pass "Start serving: ours, owner login from tailscale status";; *) fail "start: $out";; esac
  assert_eq "$(mutating_calls)" '["serve","--bg","--https=8443","http://127.0.0.1:47391"]' "the only change: tailscale serve --bg --https=8443 http://127.0.0.1:47391"
  assert_eq "$(other443)" "$other_sha" "the handler on port 443 is unchanged"
  [ "$(stat -c %a "$HERDR_APP_HOME/data/herdr-app-remote/serve.json")" = 600 ] && pass "serve record is 0600" || fail "serve record mode"

  # The guards, through the stand-in.
  r=$(phone get /api/v1/meta); case "$r" in *'"status":200'*) pass "owner through the serve name: 200";; *) fail "meta: $r";; esac
  r=$(phone get /api/v1/meta evil.example); case "$r" in *'"status":403'*) pass "Host spoof refused";; *) fail "host spoof: $r";; esac
  r=$(phone get /api/v1/meta desk-1.example-tailnet.ts.net); case "$r" in *'"status":403'*) pass "Host without the serve port refused";; *) fail "host no port: $r";; esac
  r=$(phone get /api/v1/meta desk-1.example-tailnet.ts.net:8443 direct); case "$r" in *'"status":403'*) pass "missing identity (straight to 127.0.0.1:47391) refused";; *) fail "no identity: $r";; esac
  node "$RIG/bin/serve-standin.mjs" 8444 47391 user-2@example >>"$RIG/standin2.log" 2>&1 &
  STANDIN2_PID=$!
  wait_for 10 "second stand-in (another login) listening" have_line "$RIG/standin2.log" '"standin":8444'
  r=$(node -e 'require("http").get({host:"127.0.0.1",port:8444,path:"/api/v1/meta",headers:{Host:"desk-1.example-tailnet.ts.net:8443"}},r=>{console.log(r.statusCode)})')
  assert_eq "$r" "403" "wrong login refused"
  kill "$STANDIN2_PID" 2>/dev/null
  r=$(phone ws 3); case "$r" in *'"ws":"refused","status":401'*) pass "WebSocket without a device: 401";; *) fail "ws unpaired: $r";; esac

  # Pairing and approval.
  op code
  case "$out" in *'https://desk-1.example-tailnet.ts.net:8443/pair#c='*) pass "pairing URL names the serve name";; *) fail "code: $out";; esac
  r=$(phone pair); say "$r"
  case "$r" in *'"pair":202'*'"state":"pending"'*'HttpOnly'*'Secure'*'SameSite=Strict'*) pass "pairing: 202 pending, __Host- cookie";; *) fail "pair: $r";; esac
  r=$(phone pair); case "$r" in *'"pair":403'*) pass "replayed code refused";; *) fail "replay: $r";; esac
  r=$(phone me); case "$r" in *'"state":"pending"'*) pass "pending before approval";; *) fail "me pending: $r";; esac
  r=$(phone ws 3); case "$r" in *'"ws":"refused","status":401'*) pass "pending device gets no WebSocket";; *) fail "ws pending: $r";; esac
  op approve
  case "$out" in *'"approved":"Phone 1"'*'"step":6'*) pass "approved on the desktop; setup complete (step 6)";; *) fail "approve: $out";; esac
  r=$(phone me); case "$r" in *'"state":"approved"'*) pass "approved";; *) fail "me approved: $r";; esac
  phone ws 25 >"$RIG/ws1.log" 2>&1 &
  WS_PID=$!
  wait_for 10 "WebSocket open with the subprotocol" have_line "$RIG/ws1.log" '"protocol":"herdr-remote.v1"'
  wait_for 15 "host snapshot from the real link mod" have_line "$RIG/ws1.log" '"spaces":["Project Alpha"'
  wait_for 10 "setup topic snapshot" have_line "$RIG/ws1.log" '"topic":"setup","step":6'

  # Funnel on our port: refused everywhere, live socket dropped with 4004.
  node -e 'const f=process.argv[1],d=JSON.parse(require("fs").readFileSync(f,"utf8"));d.AllowFunnel={"desk-1.example-tailnet.ts.net:8443":true};require("fs").writeFileSync(f,JSON.stringify(d))' "$TS/serve.json"
  op funnel
  case "$out" in *'"state":"on"'*) pass "Funnel seen on";; *) fail "funnel: $out";; esac
  wait_for 10 "live socket closed 4004" have_line "$RIG/ws1.log" '"ws":"closed","code":4004'
  r=$(phone get /healthz); case "$r" in *'"status":503'*'funnel'*) pass "Funnel on: /healthz 503 funnel";; *) fail "healthz funnel: $r";; esac
  r=$(phone get /api/v1/me); case "$r" in *'"status":503'*) pass "Funnel on: API 503";; *) fail "me funnel: $r";; esac
  op stop
  case "$out" in *'"ok":false'*'"code":"funnel_on"'*) pass "Stop refuses while Funnel is on (the config is no longer ours)";; *) fail "stop while funnel: $out";; esac
  node -e 'const f=process.argv[1],d=JSON.parse(require("fs").readFileSync(f,"utf8"));delete d.AllowFunnel;require("fs").writeFileSync(f,JSON.stringify(d))' "$TS/serve.json"
  op funnel
  r=$(phone get /healthz); case "$r" in *'"status":200'*) pass "Funnel off again: serving";; *) fail "healthz after funnel: $r";; esac
  op check
  case "$out" in *'"serving":"identical"'*) pass "after the outside change our record is void: identical, used but not ours";; *) fail "check after funnel: $out";; esac
  op stop
  case "$out" in *'"code":"not_ours"'*) pass "a handler we did not (provably) create is never removed";; *) fail "stop identical: $out";; esac
  r=$(phone me); case "$r" in *'"state":"approved"'*) pass "the paired phone still works on the identical handler";; *) fail "me identical: $r";; esac

  # Start/stop cycle of our own handler: stop removes only it.
  node -e 'const f=process.argv[1],d=JSON.parse(require("fs").readFileSync(f,"utf8"));delete d.TCP["8443"];for(const k of Object.keys(d.Web))if(k.endsWith(":8443"))delete d.Web[k];require("fs").writeFileSync(f,JSON.stringify(d))' "$TS/serve.json"
  op start
  case "$out" in *'"serving":"ours"'*) pass "served again as ours";; *) fail "restart: $out";; esac
  phone ws 20 >"$RIG/ws2.log" 2>&1 &
  wait_for 10 "WebSocket open again" have_line "$RIG/ws2.log" '"ws":"open"'
  op stop
  case "$out" in *'"res":{"ok":true}'*'"serving":"off"'*) pass "Stop serving";; *) fail "stop: $out";; esac
  wait_for 10 "live socket dropped on stop (4001)" have_line "$RIG/ws2.log" '"ws":"closed","code":4001'
  assert_eq "$(other443)" "$other_sha" "the handler on port 443 survived start/stop"
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(d.TCP&&d.TCP["8443"]?1:0)' "$TS/serve.json" && pass "port 8443 is empty after stop" || fail "8443 still configured"
  r=$(phone get /api/v1/meta); case "$r" in *'"status":403'*) pass "not serving: refused again";; *) fail "after stop: $r";; esac

  # A port held by a handler we did not create.
  cp "$RIG/bin/tailscale-fixtures/serve-foreign-8443.json" "$TS/serve.json"
  before=$(sha256sum "$TS/serve.json" | cut -d' ' -f1)
  n_before=$(mutating_calls | wc -l)
  op start
  case "$out" in *'"code":"port_taken"'*) pass "a foreign handler on 8443: Start refused";; *) fail "foreign start: $out";; esac
  op stop
  case "$out" in *'"code":"not_ours"'*) pass "a foreign handler on 8443: Stop refused";; *) fail "foreign stop: $out";; esac
  assert_eq "$(sha256sum "$TS/serve.json" | cut -d' ' -f1)" "$before" "the foreign config is byte-for-byte unchanged"
  assert_eq "$(mutating_calls | wc -l)" "$n_before" "no command ran against the foreign config"

  # The Linux operator error.
  printf '{}\n' >"$TS/serve.json"
  printf '{"set":"operator"}' >"$TS/conf.json"
  op start
  case "$out" in *'"code":"operator"'*'"fix":"sudo tailscale set --operator=$USER"'*) pass "operator error: the fix command is shown";; *) fail "operator: $out";; esac
  if grep -q '"set"' "$TS/calls.log"; then fail "tailscale set was run"; else pass "tailscale set never ran"; fi
  if grep -qi 'funnel' "$TS/calls.log"; then fail "a funnel command was run"; else pass "no funnel command ever ran"; fi

  say "tailscale calls:"; ts_calls >>"$RIG/rig.log"
  kill "$HARNESS_PID" "$STANDIN_PID" "$WS_PID" 2>/dev/null
  return 0
}
