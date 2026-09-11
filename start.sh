#!/bin/bash
# ZCode 任务队列 启动/停止脚本
# 用法: ./start.sh [start|stop|restart|status]

set -u
cd "$(dirname "$0")"
ACTION="${1:-start}"
PORT="${ZTQ_PORT:-8787}"

is_running() { pgrep -f "node server.js" > /dev/null 2>&1; }

status() {
  if is_running; then
    local pid; pid=$(pgrep -f "node server.js" | head -1)
    echo "运行中 (PID $pid) → http://127.0.0.1:${PORT}"
  else
    echo "未运行"
  fi
}

start() {
  if is_running; then echo "已在运行，跳过启动（避免双开）。$(status)"; exit 0; fi
  nohup node server.js > server.log 2>&1 &
  local pid=$!
  sleep 1
  if kill -0 "$pid" 2>/dev/null && curl -s "http://127.0.0.1:${PORT}/api/state" > /dev/null 2>&1; then
    echo "✓ 已启动 (PID $pid) → http://127.0.0.1:${PORT}"
  else
    echo "✗ 启动失败，请查看 server.log"
    exit 1
  fi
}

stop() {
  if ! is_running; then echo "未运行"; exit 0; fi
  pkill -f "node server.js"
  sleep 1
  is_running && { sleep 2; pkill -9 -f "node server.js" 2>/dev/null; }
  echo "已停止"
}

case "$ACTION" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  *)       echo "用法: $0 [start|stop|restart|status]"; exit 1 ;;
esac
