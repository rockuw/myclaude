#!/usr/bin/env bash
# 启动 myclaude（后台运行），打印局域网访问地址
cd "$(dirname "$0")"
PORT="${PORT:-7801}"

if ss -tln 2>/dev/null | grep -q ":$PORT "; then
  echo "端口 $PORT 已被占用，先停止旧进程…"
  kill $(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1) 2>/dev/null
  sleep 1
fi

nohup env PORT="$PORT" node server.js > server.log 2>&1 &
sleep 1.5
cat server.log
echo
echo "日志: $(pwd)/server.log"
