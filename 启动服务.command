#!/bin/bash
# ZCode Task Queue - 双击启动器
# 用法：双击此文件即可启动服务

set -e

# 获取当前目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 进入项目目录
cd "$SCRIPT_DIR"

# 检查 Node.js 是否安装
if ! command -v node &> /dev/null; then
    echo "❌ 错误：找不到 Node.js"
    echo "请先安装 Node.js >= 22.13.0"
    echo "下载地址：https://nodejs.org/"
    read -p "按回车键退出..."
    exit 1
fi

echo "=========================================="
echo "   ZCode Task Queue - 启动器"
echo "=========================================="
echo ""
echo "📦 Node.js 版本：$(node -v)"
echo "📁 项目目录：$SCRIPT_DIR"
echo ""

# 显示菜单
show_menu() {
    echo ""
    echo "请选择操作:"
    echo "  1) 🚀 启动服务"
    echo "  2) 🔍 查看状态"
    echo "  3) ⏹️  停止服务"
    echo "  4) 🔄 重启服务"
    echo "  5) ✅ 预检检查"
    echo "  6) ❌ 退出"
    echo ""
    read -p "请输入选项 (1-6): " choice
}

handle_choice() {
    case $choice in
        1)
            echo ""
            echo "🚀 正在启动服务..."
            echo ""
            node start.js start
            ;;
        2)
            echo ""
            echo "🔍 正在检查服务状态..."
            echo ""
            node start.js status
            ;;
        3)
            echo ""
            echo "⏹️  正在停止服务..."
            echo ""
            node start.js stop
            ;;
        4)
            echo ""
            echo "🔄 正在重启服务..."
            echo ""
            node start.js restart
            ;;
        5)
            echo ""
            echo "✅ 正在运行预检检查..."
            echo ""
            node start.js preflight
            ;;
        6)
            echo ""
            echo "👋 退出"
            exit 0
            ;;
        *)
            echo ""
            echo "❌ 无效选项，请重新选择"
            sleep 2
            ;;
    esac
}

# 主循环
while true; do
    show_menu
    handle_choice
    
    # 询问是否继续
    echo ""
    read -p "是否继续？(y/n): " continue
    if [[ "$continue" != "y" && "$continue" != "Y" ]]; then
        echo ""
        echo "👋 再见!"
        break
    fi
    echo ""
done

read -p "按回车键退出..."
