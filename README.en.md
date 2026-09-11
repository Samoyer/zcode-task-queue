# ZCode Task Queue

[中文](README.md) | English

A web-based **task queue for the ZCode desktop client**: queue up your existing ZCode sessions and the tool walks through them **one by one** — sending a configurable "continue" prompt each round until the reply contains a completion marker (default: 全部完成 / "all done"). Built for plans with **concurrency limits**: only one session is ever pushed at a time.

![zero-dependency](https://img.shields.io/badge/zero--dependency-Node%20%E2%89%A5%2022-blue)

## Quick Start

```bash
cd zcode-task-queue
node server.js
# open http://127.0.0.1:8787
```

> Prerequisite: keep the ZCode desktop client running — tasks execute **inside the client** using its own login and plan quota. No API keys required.

## How It Works

The queue writes a **one-shot automation** (`target_task_id` pointing at the target session) into the client's automation scheduler database. The client's scheduler process picks it up and resumes that exact session — identical to you typing a message into it manually:

1. **Enqueue** — a one-shot automation row is inserted into the client's task index (`<data-dir>/v2/tasks-index.sqlite`, auto-detected)
2. **Client takes over** — its scheduler claims due rows (`enabled=1 AND running=0 AND next_run_at<=now`) and runs the task in-client, typically within 10–40 s
3. **Progress & completion** — the queue reads the client session store (`~/.zcode/cli/db/db.sqlite`, read-only) for live tool activity / todo progress, and uses `automation_runs.outcome` (succeeded / failed / timed_out) to decide completion, then cleans up its automation row and dispatches the next one

The "Client Sessions" panel is a read-only live view of the same store: per-project grouping, running/stuck/completed states, todo progress bars, latest tool activity.

## Features

| Feature | Description |
|---|---|
| Sequential resume queue | Push existing sessions one at a time; next starts automatically after the previous completes |
| Multi-round push | Re-sends the continue prompt until the completion marker appears or max rounds reached |
| Execution window | Only dispatch within a scheduled time range (default 23:00–09:00, midnight-crossing supported) for off-peak pricing |
| Plan & model selection | Start plan / personal plan; model list read from the client config |
| Client task monitor | Read-only live view of all client sessions grouped by project, with todo progress and latest tool activity |
| Auto stop / enable | Daily scheduled client quit (reuses a custom guard script if present) and launch |
| Live progress | SSE push of current task activity, rounds, elapsed time |
| Queue management | run now / move to top / up / down / retry / remove / pause |
| Safety rails | Dispatch-timeout, no-output stall detection (configurable), optional halt-on-failure, per-task or global timeout |
| Persistence | Queue survives restarts via `data/tasks.json` |

## UI Notes

The web UI is Chinese-only at the moment. Key controls: **▶ 续跑 (Resume)** enqueues the original session; **🆕 重开 (Re-run)** extracts the original prompt into a brand-new session; **▶ 立即执行 (Run now)** bypasses the execution window once.

## Known Boundaries

- The client must be running; queued tasks wait (until dispatch timeout) if it is closed
- Stopping a task only detaches monitoring — the in-client session keeps running
- Concurrent usage counts against plan concurrency limits: your own active ZCode sessions occupy slots too
- Writing to the client's automation database relies on its current schema; re-verify after client upgrades

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ZTQ_PORT` | `8787` | Server port |
| `ZTQ_HOST` | `127.0.0.1` | Bind address (loopback only — do not expose) |

## Operations

```bash
./start.sh          # start (double-instance safe)
./start.sh status   # running?
./start.sh restart
./start.sh stop
./smoke-test.sh     # regression suite (3 cases / 6 assertions, shell tasks only)
```

Optional launchd auto-start: see `launchd/` (edit the three `/REPLACE/WITH/...` paths first).

## License

[MIT](LICENSE)
