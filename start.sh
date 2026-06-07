#!/usr/bin/env bash
set -euo pipefail
PORT="${PORT:-5619}"
if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -ti tcp:"$PORT" || true)"
  if [ -n "$PIDS" ]; then
    echo "Stopping existing process on port $PORT: $(echo "$PIDS" | tr '\n' ' ')"
    kill $PIDS || true
    sleep 1
  fi
fi
cd "$(dirname "$0")"
echo "Starting Water Utility Asset Compliance Suite on http://127.0.0.1:$PORT"
PORT="$PORT" node server.js
