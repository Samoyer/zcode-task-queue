# ZCode Task Queue - 跨平台启动器

## 概述

这是一个跨平台的 Node.js 启动器，用于管理 ZCode 任务队列服务。支持 macOS 和 Windows 操作系统。

## 快速开始

### macOS / Linux

```bash
# 使用 npm 脚本 (推荐)
npm start          # 启动服务
npm stop           # 停止服务
npm restart        # 重启服务
npm run status     # 查看状态

# 或使用 shell 脚本
./start.sh start   # 启动服务
./start.sh stop    # 停止服务
./start.sh status  # 查看状态
```

### Windows

```cmd
:: 使用 npm 脚本 (推荐)
npm start          :: 启动服务
npm stop           :: 停止服务
npm restart        :: 重启服务
npm run status     :: 查看状态

:: 或使用批处理脚本
start.bat start    :: 启动服务
start.bat stop     :: 停止服务
start.bat status   :: 查看状态
```

## 命令说明

### `start` - 启动服务

启动 ZCode 任务队列服务器。

```bash
node start.js start
npm start
```

**选项:**
- `--port <num>` - 指定端口 (默认：8787)
- `--host <addr>` - 指定主机地址 (默认：127.0.0.1)
- `--data-dir <path>` - 指定数据目录

**示例:**
```bash
node start.js start --port 9090 --host 127.0.0.1
```

---

### `stop` - 停止服务

优雅地停止正在运行的服务。

```bash
node start.js stop
npm stop
```

**注意:** 
- 会发送 SIGTERM 信号给进程
- 如果进程未响应，会自动发送 SIGKILL
- 自动清理 PID 文件和 ready 文件

---

### `restart` - 重启服务

先停止再启动服务。

```bash
node start.js restart
npm restart
```

---

### `status` - 查看服务状态

显示服务的运行状态和健康检查信息。

```bash
node start.js status
npm run status
```

**输出信息:**
- PID (进程 ID)
- 启动时间
- 监听地址
- 进程状态
- HTTP 健康检查
- 访问 URL 和 API Token

---

### `preflight` - 预检检查

在启动前运行系统检查和验证。

```bash
node start.js preflight
```

**检查项目:**
- ✅ Node.js 版本 (需要 >= 22.13.0)
- ✅ 服务器文件存在性
- ✅ 数据目录可写性
- ✅ 端口可用性
- ✅ node:sqlite 模块可用

---

## 环境变量

可以通过环境变量配置启动器行为:

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `ZTQ_NODE_BIN` | Node.js 可执行文件路径 | 自动检测 |
| `ZTQ_HOST` | 监听地址 | `127.0.0.1` |
| `ZTQ_PORT` | 监听端口 | `8787` |
| `ZTQ_DATA_DIR` | 数据目录 | `./data` |
| `ZTQ_PID_FILE` | PID 文件路径 | `{data_dir}/server.pid.json` |
| `ZTQ_READY_FILE` | Ready 文件路径 | `{data_dir}/ready.json` |
| `ZTQ_LOG_FILE` | 日志文件路径 | `{data_dir}/server.log` |

**示例:**
```bash
export ZTQ_PORT=9090
npm start
```

---

## 工作原理

### 启动流程

1. **预检检查**: 验证 Node.js 版本、端口可用性、文件权限
2. **进程隔离**: 使用 `detached` 模式启动子进程
3. **健康轮询**: 定期检查 `/api/health` 端点
4. **自动打开浏览器**: 成功后尝试打开默认浏览器

### 停止流程

1. **优雅终止**: 发送 SIGTERM 信号
2. **等待退出**: 等待最多 10 秒
3. **强制终止**: 如未退出，发送 SIGKILL
4. **清理文件**: 删除 PID 和 ready 文件

### 平台适配

#### macOS
- 使用 `kill` 命令发送信号到进程组
- 使用 `lsof` 检查端口占用
- 使用 `open` 命令打开浏览器

#### Windows
- 使用 `taskkill /F` 强制终止进程树
- 使用 `netstat` 检查端口占用
- 使用 `start` 命令打开浏览器

---

## 故障排除

### 问题：端口已被占用

**解决方案:**
```bash
# 使用不同的端口
node start.js start --port 9090

# 或查找并停止占用端口的进程
# macOS/Linux:
lsof -i :8787
kill -9 <PID>

# Windows:
netstat -ano | findstr :8787
taskkill /PID <PID> /F
```

### 问题：Node.js 版本过低

**解决方案:**
```bash
# 安装最新 LTS 版本
# macOS (Homebrew):
brew install node@24

# Windows:
# 下载并安装 https://nodejs.org/

# 验证版本
node -v  # 应该显示 v22.x.x 或更高
```

### 问题：服务无法启动

**排查步骤:**
1. 运行预检检查
   ```bash
   node start.js preflight
   ```

2. 查看详细日志
   ```bash
   tail -n 50 data/server.log
   ```

3. 检查端口是否被占用
   ```bash
   node start.js preflight
   ```

4. 手动启动调试
   ```bash
   node server.js
   ```

---

## 与其他启动方式的对比

### vs 原有的 start.sh

| 特性 | 新的 start.js | 旧的 start.sh |
|------|---------------|---------------|
| 跨平台 | ✅ macOS + Windows | ❌ 仅 macOS |
| 语言 | Node.js | Bash |
| 错误提示 | ✅ 彩色输出 + 中文 | ⚠️ 英文 |
| 自动打开浏览器 | ✅ 自动 | ❌ 需手动 |
| 健康检查 | ✅ 集成 | ❌ 需外部工具 |
| npm 脚本 | ✅ 完整支持 | ❌ 无 |

### vs launchd

| 用途 | start.js | launchd |
|------|----------|---------|
| 类型 | 交互式启动器 | 系统级守护进程 |
| 场景 | 开发环境 | 生产环境 |
| 自启 | ❌ 需手动 | ✅ 开机自启 |
| 重启 | ❌ 手动 | ✅ 崩溃自动重启 |

---

## 最佳实践

### 开发环境

```bash
# 日常使用
npm start       # 启动
npm run status  # 查看状态
npm stop        # 停止
```

### 多实例部署

```bash
# 不同端口运行多个实例
node start.js start --port 8787 --data-dir ./data1
node start.js start --port 8788 --data-dir ./data2
node start.js start --port 8789 --data-dir ./data3
```

### CI/CD 集成

```yaml
# GitHub Actions 示例
- name: Start ZCode Queue
  run: |
    node start.js preflight --port 9090
    node start.js start --port 9090 &
    sleep 5
    curl http://127.0.0.1:9090/api/health
```

---

## 技术支持

如有问题，请查阅:
- [README.md](README.md) - 完整项目文档
- [GitHub Issues](https://github.com/Samoyer/zcode-task-queue/issues) - 反馈问题
- `node start.js --help` - 在线帮助

---

## 许可证

MIT License - 详见 [LICENSE](LICENSE)
