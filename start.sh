#!/usr/bin/env bash
# 启动 myclaude（后台运行），打印局域网访问地址
cd "$(dirname "$0")"
PORT="${PORT:-7801}"

if ss -tln 2>/dev/null | grep -q ":$PORT "; then
  # 重启会终止所有运行中的 claude 会话：有 active 会话时拒绝，除非 FORCE=1
  ACTIVE=$(curl -s "http://localhost:$PORT/api/sessions" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['active']))" 2>/dev/null || echo 0)
  if [ "$ACTIVE" != "0" ] && [ "${FORCE:-0}" != "1" ]; then
    echo "有 $ACTIVE 个运行中的会话，重启会中断它们。等会话结束后再试，或 FORCE=1 ./start.sh 强制重启。"
    echo "若是在网页会话内让 Claude 重启本服务，请用 ./restart.sh（脱离进程树执行，会话随旧服务退出后可 Resume）。"
    exit 1
  fi
  echo "端口 $PORT 已被占用，先停止旧进程…"
  kill $(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1) 2>/dev/null
  sleep 1
fi

nohup env PORT="$PORT" node server.js > server.log 2>&1 &
sleep 1.5
cat server.log
echo
echo "日志: $(pwd)/server.log"
