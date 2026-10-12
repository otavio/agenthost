#!/usr/bin/env bash
# Stop a launch.sh instance and delete its scratch R2 state. Evidence survives.
# Usage: cleanup.sh RUN_DIR
set -uo pipefail
RUN_DIR="${1:?usage: cleanup.sh RUN_DIR}"
if [[ -f "$RUN_DIR/env" ]]; then
  . "$RUN_DIR/env"
  kill -TERM -- -"$PID" 2>/dev/null
  for _ in $(seq 1 10); do kill -0 -- -"$PID" 2>/dev/null || break; sleep 0.5; done
  kill -KILL -- -"$PID" 2>/dev/null
  ss -ltnH "sport = :$PORT" | grep -q . && echo "WARN port $PORT still listening" >&2
  mv "$RUN_DIR/wrangler.log" "$RUN_DIR/evidence/wrangler.log" 2>/dev/null
  rm -f "$RUN_DIR/env"
fi
rm -rf "$RUN_DIR/state" "$RUN_DIR/fixture" "$RUN_DIR/build.log" "$RUN_DIR/wrangler.json" "$RUN_DIR/pid" "$RUN_DIR/.wrangler"
echo "cleaned; evidence kept at $RUN_DIR/evidence" >&2
ls "$RUN_DIR/evidence" >&2
