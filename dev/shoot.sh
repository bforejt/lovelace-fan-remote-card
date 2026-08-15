#!/usr/bin/env bash
# Regenerate the README screenshots from dev/screenshot.html.
#
#   yarn build && dev/shoot.sh
#
# Serves the repo, then for each shot asks headless Chrome for the rendered
# content size (dev/screenshot.html publishes it as body[data-size]) and
# captures at exactly that size, 2x DPI, into docs/images/.
set -euo pipefail

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PORT="${PORT:-8199}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/docs/images"

[ -x "$CHROME" ] || { echo "Chrome not found at: $CHROME (set CHROME=...)" >&2; exit 1; }
[ -f "$ROOT/dist/fan-remote-card.js" ] || { echo "dist/fan-remote-card.js missing — run 'yarn build' first" >&2; exit 1; }

mkdir -p "$OUT"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
sleep 1

url() { echo "http://127.0.0.1:$PORT/dev/screenshot.html?$1"; }

shoot() { # name, query
  local size
  size=$("$CHROME" --headless --disable-gpu --virtual-time-budget=2000 --window-size=1200,1000 \
    --dump-dom "$(url "$2")" 2>/dev/null | grep -o 'data-size="[0-9]*x[0-9]*"' | head -1 | grep -o '[0-9]*x[0-9]*')
  [ -n "$size" ] || { echo "  !! could not measure $1" >&2; return 1; }
  "$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --virtual-time-budget=2000 --window-size="${size/x/,}" \
    --screenshot="$OUT/$1.png" "$(url "$2")" >/dev/null 2>&1
  echo "  $1.png (${size} @2x)"
}

echo "Rendering screenshots into docs/images:"
shoot card           "shot=card"
shoot card-dark      "shot=card&theme=dark"
shoot card-direction "shot=card-dir"
shoot row            "shot=row"
shoot row-dark       "shot=row&theme=dark"
shoot row-stack      "shot=both"
echo "Done."
