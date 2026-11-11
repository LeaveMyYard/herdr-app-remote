#!/bin/sh
# render.sh OUTDIR name:WxH ... : serves a copy of design/ with the local support.js shim and screenshots each board.
set -e
W=$(cd "$(dirname "$0")" && pwd)
P=$(dirname "$W")
OUT=$1; shift
S=${TMPDIR:-/tmp}/herdr-remote-render.$$; rm -rf "$S"; mkdir -p "$S" "$OUT"
trap 'kill $PID 2>/dev/null; rm -rf "$S"' EXIT
cp -r "$P"/*.dc.html "$P"/icons "$S"/; cp "$W/support.js" "$S/support.js"
PORT=$(python3 -c 'import random;print(random.randint(20000,60000))')
python3 -m http.server $PORT --bind 127.0.0.1 --directory "$S" >/dev/null 2>&1 &
PID=$!
sleep 0.6
for spec in "$@"; do
  name=${spec%%:*}; size=${spec#*:}
  google-chrome-stable --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=${SCALE:-1} --virtual-time-budget=${VT:-3000} \
    --user-data-dir="$S/chrome-prof" --screenshot="$OUT/$name.png" --window-size=${size%x*},${size#*x} "http://127.0.0.1:$PORT/$name.dc.html" >/dev/null 2>&1 || echo "fail $name"
done
