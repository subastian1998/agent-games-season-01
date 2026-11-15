#!/bin/bash
# Start the Agent Games server (Proof Gatekeeper + Steal the VFY).
# Usage:
#   ./start.sh            # start server on 127.0.0.1:$PORT (default 8080)
#   ./start.sh tunnel     # also start a tunnelmole tunnel and print the public URL
# The server reads .env (copy from .env.example first).
# VM restarts kill background processes — just re-run this script.
set -e
cd "$(dirname "$0")"
NODE=~/workspace/tools/node22/bin/node
if [ ! -f .env ]; then
  echo "No .env found — copy .env.example to .env and fill it in first." >&2
  exit 1
fi
if [ "$1" = "tunnel" ]; then
  if [ ! -x tunnel/node_modules/.bin/tunnelmole ]; then
    echo "tunnelmole is not installed in tunnel/ — run the install first (see README)." >&2
    exit 1
  fi
  # shellcheck disable=SC1091
  PORT="${PORT:-8080}"
  echo "Starting server on 127.0.0.1:$PORT and tunnelmole tunnel..."
  "$NODE" server.js &
  SERVER_PID=$!
  sleep 2
  tunnel/node_modules/.bin/tunnelmole "$PORT" &
  TUNNEL_PID=$!
  trap 'kill $SERVER_PID $TUNNEL_PID 2>/dev/null' INT TERM
  wait
else
  exec "$NODE" server.js
fi
