#!/usr/bin/env bash
# Lector X: arranca (o reinicia) el servidor en segundo plano.  Uso: ./start.sh [carpeta-de-datos]
cd "$(dirname "$(readlink -f "$0")")"
export LECTORX_DATA="${1:-${LECTORX_DATA:-$PWD/data}}"
PORT="${PORT:-$(python3 -c 'import json;print(json.load(open("config.json")).get("port",8787))')}"
export PORT
mkdir -p logs
PIDF="logs/server-$PORT.pid"
if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then kill "$(cat "$PIDF")"; sleep 0.5; fi
setsid nohup python3 server.py >> "logs/server-$PORT.log" 2>&1 < /dev/null &
echo $! > "$PIDF"
sleep 0.8
curl -fsS -o /dev/null -w "Lector X HTTP %{http_code} en puerto $PORT (datos: $LECTORX_DATA)\n" "http://127.0.0.1:$PORT/api/health"
