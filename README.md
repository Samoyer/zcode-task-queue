# ZCode 任务队列

[English](README.en.md) | 中文

一个带 Web 页面的 **ZCode 会话排队推进器**：把客户端里已有的会话逐个加入队列，脚本用固定话术（默认"继续，如果这项完成好了，告诉我全部完成，并给出完成报告。"）一轮轮推进，收到「全部完成」标记即判完成并自动顶上**下一个会话**——专为 GLM 套餐的并发限制设计，同一时间只推进一个会话。

![启动](https://img.shields.io/badge/零依赖-Node%20%E2%89%A5%2022-blue)

## 快速开始

```bash
cd zcode-task-queue
node server.js
# 浏览器打开 http://127.0.0.1:8787
```

> 前提：ZCode 客户端保持运行（任务在客户端内执行，用客户端自己的登录与套餐，无需 API Key）。

## 典型用法（夜间免费时段批量推进）

1. 白天在 ZCode 客户端里把要做的任务都建好（每个会话一个任务）
2. 打开本页面，在「ZCode 客户端会话」列表里对每个会话点 **▶ 续跑**，按想要的执行顺序排队（可用 ⤒↑↓ 调整）
3. 建议开启「每日自动启用 23:00」（免费时段开始）和「每日自动停止 08:55」（免费时段结束前退出，逻辑同 `~/bin/zcode-night-guard.sh`）
4. 每个会话会被客户端自动续跑：模型继续上次的进度干活；如果一轮跑完回复里没有「全部完成」，队列自动再发一轮继续话术，直到收到标记（最多 N 轮，可配置）
5. 收到「全部完成」→ 该会话标记已完成并移入历史，`📄` 按钮可看它交的完成报告；下一个会话自动顶上

## 页面功能

| 功能 | 说明 |
|---|---|
| 会话续跑队列 | 对客户端已有会话逐个续跑推进；前一个收到完成标记后，后一个自动顶上 |
| 多轮推进 | 一轮没完成就自动再发续跑话术，直到完成标记/达到最大轮数 |
| 执行时段分流 | 只在预约时段（默认 23:00–09:00，支持跨午夜）内派发任务，谷时 token 便宜；「立即执行」可单次无视时段 |
| 套餐与模型自选 | 体验套餐 / 个人套餐，模型列表从客户端配置读取，设置里切换 |
| 客户端任务监控 | 只读实时显示所有会话：进行中/出错/已完成、todo 进度条、最近工具活动 |
| 自动停止 | 每日到点退出 ZCode（复用夜间守护脚本 `~/bin/zcode-night-guard.sh`，未找到则用内置逻辑），队列自动暂停；也可页面手动触发 |
| 自动启用 | 每日到点拉起 ZCode，一分钟后自动恢复队列；也可页面手动触发 |
| 实时进度 | 当前会话的轮数、活动状态、todo 进度实时刷新（SSE） |
| 队列管理 | 立即执行 / 移到最前 / 上移下移 / 重试 / 删除 / 暂停队列 |
| 保护机制 | 5 分钟不接单判失败；已接单但 N 分钟无输出判卡（可配置）；可选超时与"失败后暂停队列" |
| 批量添加 | 支持添加全新任务（新会话）或 Shell 命令 |

## 续跑是怎么实现的

队列把一条**一次性自动化**写入客户端调度库（automations 表，`target_task_id` 指向目标会话）。客户端调度进程认领后走 `resumeTask`——和你在客户端里选中该会话再发消息完全一样，模型继续原会话的上下文与 todo 进度。队列通过会话库（只读）观察最新回复，命中「完成标记」即完成。

- 接单延迟约 10~40 秒（客户端调度器轮询节奏）
- 「停止」= 解除推进，会话本身保留在客户端
- 续跑统一使用设置里选的套餐模型：若沿用会话快照里的旧模型，而该模型已从当前可用列表下架，客户端会直接拒绝派发（实测报"当前会话使用的模型已不可用"）

## 重要提醒：并发限制

GLM 套餐有任务并发限制，**你自己在客户端里正在跑的会话（包括让 ZCode 干活的其他窗口）也占并发位**。队列保证同一时间只推进一个会话，但如果并发位被占用，排队任务的模型请求会长时间等待（实测有会话因此 10 分钟无任何输出）。已接单但长时间无输出会按「无输出判卡」设置（默认 15 分钟）判定失败并继续下一个，防止队列卡死——判卡的任务实际还在客户端里，并发空出来后可能继续跑完。

推进期间建议让客户端闲着。另外队列与 ZCode 会话互不冲突：两个「导入/重开」的测试任务在白天时段也正常完成了。

## 运维

```bash
./start.sh          # 启动（防双开，自动探测）
./start.sh status   # 查看运行状态
./start.sh restart  # 重启
./start.sh stop     # 停止
./smoke-test.sh     # 最小回归测试（3 用例 6 断言，只用 Shell 任务不耗额度，报告写入 test-report.md）
```

<details>
<summary>开机自启（可选，launchd）— 先编辑 plist 把 3 处 /REPLACE/WITH/... 改成你的项目实际路径</summary>

```bash
mkdir -p ~/Library/LaunchAgents
cp launchd/com.zcode-task-queue.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.zcode-task-queue.plist
# 卸载: launchctl unload ~/Library/LaunchAgents/com.zcode-task-queue.plist
```
</details>

## API 一览（本机防护：POST 需携带 `X-ZTQ-Local: 1` 头，跨站来源被拒绝）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/state` | GET | 全量状态（队列/设置/客户端会话） |
| `/api/events` | GET | SSE 实时推送（同 state） |
| `/api/tasks` | POST | 添加任务（`batch` 字段可按行批量） |
| `/api/tasks/:id/action` | POST | up/down/top/runNow/retry/remove |
| `/api/tasks/log?id=` | GET | 任务日志 |
| `/api/queue` | POST | pause / resume / clearFinished / stopCurrent |
| `/api/client-tasks/continue` | POST | 续跑指定会话（`sessionId`） |
| `/api/client-tasks/import` | POST | 导入会话提示词为新任务 |
| `/api/client-tasks/hide` | POST | 从面板隐藏会话 |
| `/api/guard` | POST | stopClient / enableClient（支持 `dryRun`） |
| `/api/config` | POST | 更新设置 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ZTQ_PORT` | `8787` | 服务端口 |
| `ZTQ_HOST` | `127.0.0.1` | 监听地址（仅本机，勿暴露公网） |

## 文件

```
zcode-task-queue/
├── server.js        # 后端（零依赖 Node）
├── public/index.html
└── data/            # tasks.json / settings.json（自动生成）
```

## License

[MIT](LICENSE)
