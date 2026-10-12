#!/usr/bin/env bash
# Map a URL the API returned (https://<host>/...) onto the local instance
# (http://<host>:PORT/...). Usage: local-url.sh RUN_DIR URL
set -euo pipefail
. "${1:?usage: local-url.sh RUN_DIR URL}/env"
printf '%s\n' "${2:?URL}" | sed -E "s#^https?://([^/:]+)(:[0-9]+)?#http://\1:$PORT#"
