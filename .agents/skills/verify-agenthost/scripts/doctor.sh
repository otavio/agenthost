#!/usr/bin/env bash
# Read-only health check for a launch.sh instance. Usage: doctor.sh RUN_DIR
set -u  # no pipefail: grep -q closing the pipe early must not fail a check
RUN_DIR="${1:?usage: doctor.sh RUN_DIR}"
[[ -f "$RUN_DIR/env" ]] || { echo "FAIL no $RUN_DIR/env (not launched?)"; exit 1; }
. "$RUN_DIR/env"
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }

check "process group $PID alive" "kill -0 $PID"
check "port $PORT owned by our workerd" "ss -ltnpH 'sport = :$PORT' | grep -q workerd && pgrep -g $PID workerd | grep -qxf <(ss -ltnpH 'sport = :$PORT' | grep -o 'pid=[0-9]*' | cut -d= -f2)"
check "control plane: /llms.txt names apex $APEX" "curl -fsS $BASE/llms.txt | grep -q '$APEX'"
check "landing page served (Static Assets built)" "curl -fsS $BASE/ | grep -q '<title>agenthost'"
check "DEV_MODE on: admin API open without Access" "curl -fsS -H 'Host: admin.$APEX' $BASE/admin/api/users | grep -q '\"users\"'"
check "worker client bundle built" "test -d $ROOT/worker/src/client/gen"
exit $fail
