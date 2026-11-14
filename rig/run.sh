#!/bin/sh
# Starts an ISOLATED herdr-app and runs one scenario against it.
#   rig/run.sh <scenario> <scratch dir> [seconds]
# Isolation: private HOME, XDG_CONFIG_HOME, XDG_STATE_HOME, XDG_RUNTIME_DIR, HERDR_APP_HOME and a
# unique HC_SESSION; bwrap hides /run/user and the live ~/.config/herdr-app, gives the app its own
# pid and net namespaces and a fresh /proc; headless mutter is its display. The rig dir is also
# bound at /mnt/r for short socket paths. Nothing here may reach the operator's live app.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
scenario=${1:?scenario name (rig/scenarios/<name>.sh)}
base=${2:?scratch dir}
secs=${3:-45}
[ -f "$here/scenarios/$scenario.sh" ] || { echo "ABORT: no such scenario: $scenario" >&2; exit 2; }
# Judge the path BEFORE creating anything: a scratch dir under /run/user must never be made.
want=$(realpath -m -- "$base")
case "$want" in /run/user|/run/user/*) echo "ABORT: scratch dir under /run/user" >&2; exit 1;; esac
case "$want" in "$HOME/.config/herdr-app"|"$HOME/.config/herdr-app"/*) echo "ABORT: scratch dir inside the live app home" >&2; exit 1;; esac
mkdir -p "$base"
base=$(cd "$base" && pwd -P)
case "$base" in /run/user|/run/user/*) echo "ABORT: scratch dir under /run/user" >&2; exit 1;; esac
case "$base" in "$HOME/.config/herdr-app"|"$HOME/.config/herdr-app"/*) echo "ABORT: scratch dir inside the live app home" >&2; exit 1;; esac
for t in bwrap mutter dbus-run-session herdr-app hc node; do
  command -v "$t" >/dev/null 2>&1 || { echo "ABORT: missing tool: $t" >&2; exit 2; }
done
rig="$base/rig-$(date +%s)-$$"
mkdir -p "$rig/home/.config/herdr-app/mods" "$rig/home/.local/state" "$rig/run" "$rig/bin" "$rig/scenarios"
chmod 700 "$rig/home" "$rig/run"
for m in probe probe-none; do
  mkdir -p "$rig/home/.config/herdr-app/mods/$m"
  sed "s|@RIG@|/mnt/r|" "$here/mods/$m/main.js" > "$rig/home/.config/herdr-app/mods/$m/main.js"
  cp "$here/mods/$m/mod.json" "$rig/home/.config/herdr-app/mods/$m/mod.json"
done
cat > "$rig/bin/long.sh" <<EOT
#!/bin/sh
echo \$\$ > "$rig/long.started"
sleep 12
echo done > "$rig/long.finished"
EOT
cat > "$rig/bin/daemon.sh" <<EOT
#!/bin/sh
echo \$\$ > "$rig/daemon.started"
sleep 20
echo done > "$rig/daemon.finished"
EOT
chmod +x "$rig/bin/"*.sh
cp "$here/fake-anthropic.mjs" "$here/claude-prompts-harness.mjs" "$here/claude-multiq-harness.mjs" "$here/prompt-answer-harness.mjs" "$here/agent-stop-harness.mjs" "$rig/bin/"
cp "$here/sidecar.mjs" "$here/inner.sh" "$here/lib.sh" "$rig/bin/"
# The real link mod and the harness, for the scenarios that use them (rig-only copy of the mod).
repo=$(cd "$here/.." && pwd -P)
mkdir -p "$rig/home/.config/herdr-app/mods/herdr-app-remote"
cp "$repo"/mod/herdr-app-remote/*.js "$repo"/mod/herdr-app-remote/*.svg "$repo"/mod/herdr-app-remote/mod.json "$rig/home/.config/herdr-app/mods/herdr-app-remote/"
cp "$here/link-harness.mjs" "$here/inbox-harness.mjs" "$here/panel-harness.mjs" "$here/pairing-harness.mjs" "$here/serve-standin.mjs" "$here/phone.mjs" "$here/terminal-harness.mjs" "$here/keys-harness.mjs" "$here/chat-harness.mjs" "$here/transcript-harness.mjs" "$here/chatview-harness.mjs" "$rig/bin/"
# `tailscale` inside the rig is always the fake CLI (it replays recorded outputs and keeps its serve config in
# $rig/ts); the real one is never reachable: tailscaled's socket dir is hidden below and the fake comes first.
mkdir -p "$rig/fakebin" "$rig/ts" "$rig/bin/tailscale-fixtures"
cp "$repo/packages/bridge/test/fake-tailscale.mjs" "$rig/bin/"
cp "$repo"/packages/bridge/test/fixtures/tailscale/* "$rig/bin/tailscale-fixtures/"
printf '{}\n' > "$rig/ts/serve.json"
: > "$rig/ts/calls.log"
cat > "$rig/fakebin/tailscale" <<'EOT'
#!/bin/sh
FAKE_TS_FIXTURES=/mnt/r/bin/tailscale-fixtures exec node /mnt/r/bin/fake-tailscale.mjs /mnt/r/ts "$@"
EOT
chmod +x "$rig/fakebin/tailscale"
# The operator's Claude Code state (~/.claude*, ~/.claude.json*, ~/.cache/claude*, ~/.local/state/claude*; not ~/.local/share/claude, where the binary lives) is hidden inside the rig: a scenario that runs the
# claude binary must never be able to read real credentials, settings or transcripts, even by a wrong path.
claude_hide=""
for p in "$HOME"/.claude "$HOME"/.claude-* "$HOME"/.claude.json* "$HOME"/.cache/claude "$HOME"/.cache/claude-* "$HOME"/.local/state/claude "$HOME"/.local/state/claude-*; do
  if [ -d "$p" ] && [ ! -L "$p" ]; then claude_hide="$claude_hide --tmpfs $p"
  elif [ -e "$p" ] || [ -L "$p" ]; then claude_hide="$claude_hide --ro-bind /dev/null $p"; fi
done
ts_hide=""
for d in /run/tailscale /var/run/tailscale; do
  [ -d "$d" ] && [ ! -L "$d" ] && ts_hide="$ts_hide --tmpfs $d"
done
cp "$here/scenarios/$scenario.sh" "$rig/scenarios/"
echo "rig: $rig"
rc=0
bwrap --dev-bind / / \
  --tmpfs /run/user \
  --tmpfs "$HOME/.config/herdr-app" \
  $ts_hide \
  $claude_hide \
  --bind "$rig" "$rig" \
  --tmpfs /mnt --bind "$rig" /mnt/r \
  --unshare-pid --proc /proc --unshare-net --die-with-parent --new-session \
  env -i PATH="/mnt/r/fakebin:$PATH" TERM=xterm-256color LANG="${LANG:-C.UTF-8}" \
    RIG=/mnt/r REPO="$repo" SECS="$secs" SCENARIO="$scenario" \
    PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}" \
    HOME=/mnt/r/home XDG_CONFIG_HOME=/mnt/r/home/.config XDG_STATE_HOME=/mnt/r/home/.local/state \
    XDG_RUNTIME_DIR=/mnt/r/run HERDR_APP_HOME=/mnt/r/home/.config/herdr-app \
    HC_SESSION="hws$$-$(date +%s)" \
    sh /mnt/r/bin/inner.sh || rc=$?
echo "rig: scenario $scenario exit $rc (logs in $rig)"
exit $rc
