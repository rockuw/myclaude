#!/usr/bin/env bash
# 安全自重启：供网页会话内的 Claude Code 调用（也可在终端用）。
# 关键：kill+start 序列运行在 setsid 脱离的独立会话里，
# 旧 server 退出（连带杀死执行重启的 claude 会话）不会中断它。
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-7801}"
mkdir -p data

# 记录发起重启的网页会话：重启后 resume 它可跳过"会话仍在写入"安全锁
if [ -n "$MYCLAUDE_SESSION_ID" ]; then
  printf '{"id":"%s","at":%s}' "$MYCLAUDE_SESSION_ID" "$(date +%s%3N)" > data/restart.json
fi

setsid nohup bash -c '
  cd "'"$PWD"'" || exit 1
  PORT='"$PORT"'
  sleep 3  # grace: let the calling turn finish and persist before the server dies
  pid=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP "pid=\K[0-9]+" | head -1)
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$pid" 2>/dev/null
  fi
  for _ in $(seq 1 50); do ss -tln 2>/dev/null | grep -q ":$PORT " || break; sleep 0.2; done
  nohup env PORT="$PORT" node server.js > server.log 2>&1 &
  echo "restarted at $(date)" >> restart.log
' > restart.log 2>&1 < /dev/null &

echo "重启已调度（独立进程执行）。当前会话会随旧服务退出；服务恢复后在网页点 Resume 继续。"
