#!/usr/bin/env bash
# Start an isolated local agenthost (wrangler dev + Miniflare R2) for verification.
# Usage: launch.sh [RUN_DIR]        (default: /tmp/verify-agenthost/<timestamp>)
# Env:   SKIP_BUILD=1  reuse existing public/ and worker/src/client/gen/
#        APEX=<host>   apex host (default: localhost, so sites are *.localhost)
#        ACCOUNT_EMAIL=<email>  signed-in email on account.<apex> (default: owner@example.com)
# Prints RUN_DIR on the last line. RUN_DIR/env holds PORT, BASE, APEX, PID.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
RUN_DIR="${1:-/tmp/verify-agenthost/$(date +%Y%m%d-%H%M%S)-$$}"
APEX="${APEX:-localhost}"
mkdir -p "$RUN_DIR/state" "$RUN_DIR/evidence"

if [[ -f "$RUN_DIR/env" ]] && kill -0 "$(. "$RUN_DIR/env"; echo "$PID")" 2>/dev/null; then
  echo "instance already running for $RUN_DIR; run cleanup.sh first" >&2; exit 1
fi

run() { (cd "$ROOT" && direnv exec "$ROOT" "$@"); }

[[ -d "$ROOT/node_modules" ]] || run pnpm setup:dev

if [[ "${SKIP_BUILD:-0}" != 1 ]]; then
  run bash -c 'pnpm build && pnpm assets && pnpm -C worker run build:client' > "$RUN_DIR/build.log" 2>&1 \
    || { echo "build failed, see $RUN_DIR/build.log" >&2; exit 1; }
fi

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }
PORT="$(free_port)"; INSPECT="$(free_port)"

# Config without `routes` (see verify-config.mjs). It lives in RUN_DIR, so the
# user's worker/.dev.vars (and any real R2 credentials) is not loaded; DEV_MODE
# comes from --var instead.
run node "$ROOT/.agents/skills/verify-agenthost/scripts/verify-config.mjs" "$ROOT" "$RUN_DIR/wrangler.json" 2>/dev/null

# setsid makes the instance a process-group leader whose PGID we record, so
# cleanup kills exactly what we started.
cd "$ROOT/worker"
setsid bash -c 'echo $$ > "$1/pid"; shift; exec "$@"' _ "$RUN_DIR" \
  direnv exec "$ROOT" pnpm exec wrangler dev --local -c "$RUN_DIR/wrangler.json" \
  --ip 127.0.0.1 --port "$PORT" --inspector-port "$INSPECT" \
  --persist-to "$RUN_DIR/state" --var "APEX_HOST:$APEX" --var DEV_MODE:1 \
  --var "DEV_ACCOUNT_EMAIL:${ACCOUNT_EMAIL:-owner@example.com}" \
  > "$RUN_DIR/wrangler.log" 2>&1 < /dev/null &
for _ in $(seq 1 50); do [[ -s "$RUN_DIR/pid" ]] && break; sleep 0.1; done
PID="$(cat "$RUN_DIR/pid")"
BASE="http://127.0.0.1:$PORT"
printf 'PORT=%s\nINSPECT=%s\nBASE=%s\nAPEX=%s\nPID=%s\nROOT=%s\n' "$PORT" "$INSPECT" "$BASE" "$APEX" "$PID" "$ROOT" > "$RUN_DIR/env"

# Ready = the control plane answers /llms.txt with the configured apex baked in.
for _ in $(seq 1 90); do
  if curl -fsS "$BASE/llms.txt" 2>/dev/null | grep -q "$APEX"; then
    echo "ready: $BASE (apex $APEX, sites at http://<user>-<id>.$APEX:$PORT/)" >&2
    echo "$RUN_DIR"; exit 0
  fi
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
echo "not ready; tail of $RUN_DIR/wrangler.log:" >&2; tail -20 "$RUN_DIR/wrangler.log" >&2
kill -- -"$PID" 2>/dev/null || true
rm -f "$RUN_DIR/env"
exit 1
