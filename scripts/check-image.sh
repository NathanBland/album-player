#!/bin/sh
# Build the image and smoke-test it: start it with a throwaway music folder, check that the app, the
# library scan, Range requests and the health endpoint work, that it runs unprivileged, then clean up.
#
#   scripts/check-image.sh              build + test with Apple's `container` (or Docker if that's what's installed)
#   scripts/check-image.sh --multiarch  also build linux/amd64 alongside arm64 (build only; the test runs native)
#   scripts/check-image.sh --keep       keep the image afterwards
#   scripts/check-image.sh --local      no image: run scripts/serve.py with the image's settings and test that
set -eu
cd "$(dirname "$0")/.."

IMAGE=album-player:check NAME=album-player-check PORT=5199
MULTIARCH=0 KEEP=0 LOCAL=0
for a in "$@"; do case $a in
  --multiarch) MULTIARCH=1 ;; --keep) KEEP=1 ;; --local) LOCAL=1 ;;
  *) echo "unknown option: $a" >&2; exit 2 ;;
esac; done

if [ $LOCAL = 1 ]; then RT=local
elif command -v container >/dev/null 2>&1; then RT=container
elif command -v docker >/dev/null 2>&1; then RT=docker
else echo "No container runtime found. Install Apple's container (https://github.com/apple/container/releases) or Docker, or use --local." >&2; exit 1
fi

ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0

# a throwaway library: one folder-named album with a short WAV (no tags, so the folder name is used)
MUSIC=$(mktemp -d)
mkdir -p "$MUSIC/Test Artist - Smoke Test (2026)"
python3 - "$MUSIC/Test Artist - Smoke Test (2026)/01 - Tone.wav" <<'EOF'
import math, struct, sys, wave
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(22050)
    w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(i / 8))) for i in range(22050)))
EOF
chmod -R a+rX "$MUSIC" # readable by the image's unprivileged user

PID=
cleanup() {
  if [ $RT = local ]; then [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  else
    $RT stop "$NAME" >/dev/null 2>&1 || true
    $RT rm "$NAME" >/dev/null 2>&1 || true
    [ $KEEP = 1 ] || $RT image rm "$IMAGE" >/dev/null 2>&1 || true
  fi
  rm -rf "$MUSIC"
}
trap cleanup EXIT INT TERM

echo "▸ runtime: $RT"
case $RT in
  container)
    container system status >/dev/null 2>&1 || container system start
    if [ $MULTIARCH = 1 ]; then container build --arch arm64 --arch amd64 -t "$IMAGE" .
    else container build -t "$IMAGE" .; fi
    container run -d --name "$NAME" -p "127.0.0.1:$PORT:5173" -v "$MUSIC:/music:ro" "$IMAGE" >/dev/null ;;
  docker)
    if [ $MULTIARCH = 1 ]; then docker buildx build --platform linux/amd64,linux/arm64 -t "$IMAGE" . ; fi
    docker build -t "$IMAGE" .
    docker run -d --name "$NAME" -p "127.0.0.1:$PORT:5173" -v "$MUSIC:/music:ro" "$IMAGE" >/dev/null ;;
  local)
    HOST=127.0.0.1 PORT=$PORT MUSIC_DIR="$MUSIC" RESCAN_SECONDS=600 QUIET=1 python3 scripts/serve.py >/dev/null 2>&1 &
    PID=$! ;;
esac
ok "built and started"

B="http://127.0.0.1:$PORT"
echo "▸ waiting for $B/healthz"
i=0; until curl -fs "$B/healthz" >/dev/null 2>&1; do
  i=$((i+1)); [ $i -lt 60 ] || { fail "server never became healthy"; [ $RT = local ] || $RT logs "$NAME" 2>&1 | tail -20; exit 1; }
  sleep 0.5
done
ok "/healthz answers"

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
[ "$(code "$B/")" = 200 ] && ok "app page" || fail "app page"
for f in js/main.js css/style.css vendor/mpg123-decoder.min.js; do
  [ "$(code "$B/$f")" = 200 ] || fail "missing $f"
done; ok "app files served"

LIB=$(curl -fs "$B/albums/library.json" || true)
SRC=$(printf '%s' "$LIB" | python3 -c 'import json,sys
d=json.load(sys.stdin)["albums"]
print(d[0]["tracks"][0]["src"] if len(d)==1 and d[0]["artist"]=="Test Artist" else "")' 2>/dev/null || true)
[ -n "$SRC" ] && ok "library scan finds the mounted album" || fail "library scan (got: $(printf '%s' "$LIB" | head -c 200))"

if [ -n "$SRC" ]; then
  H=$(curl -s -o /dev/null -D - -H 'Range: bytes=0-99' "$B/$SRC" | tr -d '\r')
  printf '%s' "$H" | grep -q '^HTTP/[0-9.]* 206' && printf '%s' "$H" | grep -qi '^content-range: bytes 0-99/' \
    && ok "Range request on a track (206)" || fail "Range request: $(printf '%s' "$H" | head -1)"
fi
[ "$(code "$B/albums/")" = 404 ] && ok "no directory listing" || fail "directory listing is exposed"
[ "$(code --path-as-is "$B/albums/../../../../etc/passwd")" = 404 ] && ok "path traversal blocked" || fail "path traversal"
[ "$(code "$B/scripts/serve.py")" = 404 ] && [ "$(code --path-as-is "$B/js/../scripts/serve.py")" = 404 ] && ok "only app files served" || fail "files outside the app are served"

if [ $RT != local ]; then
  U=$($RT exec "$NAME" id -u 2>/dev/null | tr -d '\r' || true)
  [ "$U" = 1000 ] && ok "runs as uid 1000" || fail "runs as uid '$U' (expected 1000)"
  $RT exec "$NAME" sh -c 'wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz"' >/dev/null 2>&1 \
    && ok "HEALTHCHECK command passes inside the container" || fail "HEALTHCHECK command fails inside the container"
fi

echo
if [ $FAILED = 0 ]; then echo "All checks passed."; else echo "Some checks failed." >&2; exit 1; fi
