#!/usr/bin/env bash
set -e
PORT=${PORT:-3000}
node server.js &
SERVER_PID=$!
trap "kill $SERVER_PID 2>/dev/null" EXIT
cloudflared tunnel --url http://127.0.0.1:$PORT
