#!/bin/sh
# Runs inside bwrap (see run.sh). Every process here dies with the pid namespace.
# The guards come first: nothing is started unless the sandbox is what run.sh promised.
set -u
RIG=${RIG:?}
log="$RIG/rig.log"
say() { echo "$*" | tee -a "$log"; }
case "${XDG_RUNTIME_DIR:-}" in /run/user/*|"") say "ABORT: runtime dir unset or under /run/user"; exit 1;; esac
# RIG_RUN_USER is only for the guard tests (they point it at an empty dir); run.sh never sets it.
run_user=${RIG_RUN_USER:-/run/user}
[ -z "$(ls -A "$run_user" 2>/dev/null)" ] || { say "ABORT: /run/user is visible"; exit 1; }
case "${HERDR_APP_HOME:-}" in "$RIG"/*) ;; *) say "ABORT: app home is not inside the rig"; exit 1;; esac
case "${HOME:-}" in "$RIG"/*) ;; *) say "ABORT: HOME is not inside the rig"; exit 1;; esac
[ -n "${HC_SESSION:-}" ] || { say "ABORT: HC_SESSION unset"; exit 1; }
# The real tailscaled must be out of reach, and `tailscale` must be the rig's fake.
# RIG_TS_DIRS is only for the guard tests (they point it at an empty dir); run.sh never sets it.
for d in ${RIG_TS_DIRS:-/run/tailscale /var/run/tailscale}; do
  [ -z "$(ls -A "$d" 2>/dev/null)" ] || { say "ABORT: tailscaled's socket dir is visible ($d)"; exit 1; }
done
[ "$(command -v tailscale)" = "$RIG/fakebin/tailscale" ] || { say "ABORT: tailscale is not the rig's fake"; exit 1; }

hc_sock=$(hc server status 2>&1 | grep -oE '/[^ ]*\.sock' | head -1)
[ -n "$hc_sock" ] || hc_sock="$XDG_RUNTIME_DIR/herdr-core/$HC_SESSION.sock"
say "hc socket: $hc_sock"
case "$hc_sock" in /run/user/*) say "ABORT: hc socket under /run/user"; exit 1;; esac
case "$hc_sock" in "$RIG"/*) ;; *) say "ABORT: hc socket outside the rig"; exit 1;; esac

. "$RIG/bin/lib.sh"
SCENARIO_FILE="$RIG/scenarios/${SCENARIO:?}.sh"
[ -f "$SCENARIO_FILE" ] || { say "ABORT: scenario file missing"; exit 2; }
. "$SCENARIO_FILE"
scenario_main
rc=$?
say "scenario ${SCENARIO}: $FAILS failed assertion(s), rc=$rc"
stop_stack
[ "$rc" -eq 0 ] && [ "$FAILS" -eq 0 ]
