#!/bin/bash
# ZCode Task Queue - macOS 启动器包装器
# 用法：./start [start|stop|restart|status|preflight]

set -u

# 获取当前目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 检查 Node.js 是否安装
if ! command -v node &> /dev/null; then
    echo "[错误] 找不到 Node.js，请先安装 Node.js >= 22.13.0"
    echo "下载地址：https://nodejs.org/"
    exit 1
fi

echo "[信息] Node.js 版本：$(node -p process.versions.node)"

# 执行主脚本
cd "$SCRIPT_DIR"
exec node start.js "$@"
