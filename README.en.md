# ZCode Task Queue

[中文](README.md) | [English](README.en.md)

A macOS, loopback-only queue for advancing ZCode sessions one at a time. It resumes existing sessions, creates new ZCode tasks, runs local shell commands, enforces an execution window, and pauses safely whenever client state cannot be proven. Work dispatched by one service instance is strictly serial; this is not a cross-instance coordinator.

ZCode must already be signed in and have run on this Mac. Work uses the desktop client's own models, plan, quota, and concurrency slots. No ZCode/model-provider API key is required, and this project does not bypass client limits; the Web control surface uses a separate local Bearer token.

## Quick start

Requires **Node.js 22.13.0 or newer** with `node:sqlite` available without an experimental flag.

~~~bash
git clone https://github.com/Samoyer/zcode-task-queue.git
cd zcode-task-queue
./start.sh preflight
./start.sh start
~~~

`start` prints a complete authorized URL containing `#token=...`; copy that URL into the browser. `./start.sh status` prints it again later. Do not open only bare `http://127.0.0.1:8787`, because that page has no API authorization. The token is placed in a URL fragment, so it is not sent with the initial HTTP request; the page removes it from the address bar and browser history immediately after capturing it.

~~~bash
./start.sh status
./start.sh restart
./start.sh stop
~~~

`preflight` prints the resolved Node binary, project root, state paths, PID/ready files, and listener. The launcher validates the PID owner, process start identity, executable, working directory, project path, and health token before it reports or signals a process.

`start`, `stop`, and `restart` use a lifecycle lock so concurrent launcher commands cannot lose PID ownership. Status exit codes are `0` healthy, `3` stopped, `4` untrusted/foreign PID, and `5` process present but unhealthy. The lifecycle lock waits about 15 seconds; its timeout exit code is `6`. `node server.js` is also supported for foreground use.

`start` captures early child-process output in `${ZTQ_LOG_FILE}.startup` (mode 0600 where supported). On failure, the launcher redacts Bearer/query tokens before showing the diagnostic tail; runtime messages continue to use `ZTQ_LOG_FILE`.

## Completion and reconciliation

Before touching the client scheduler, the queue atomically persists a dispatch intent. Automation IDs are deterministic for each queue task and attempt, so a crash can adopt the exact same record instead of duplicating work.

For resumed sessions, completion requires all of the following:

- The client automation run is terminal and successful.
- No tool is still reported as running.
- The final non-empty line of the newest assistant message from this attempt exactly equals the configured marker.

The shipped marker is:

~~~text
[[ZTQ_TASK_DONE]]
~~~

Mentioning or quoting the marker earlier in a reply does not count. If a successful attempt lacks it, the same session is advanced again up to the configured round limit. New ZCode tasks and shell tasks use their own successful terminal result and do not require the marker.

The queue never converts uncertainty into a fake stopped state. A lost scheduler record, prolonged database failure, claimed timeout, stalled session, unverifiable between-attempt cleanup, unknown shell process after restart, or multiple active records enters **attention** and blocks further dispatch.

Scheduled stop signals only the current user's verified `ZCode.app` main process and its snapshotted descendants. A standalone `zcode-cli`, crashpad, or `ZCode Computer Use` process is not signalled. If only an unowned app helper remains, no signal is sent to it and the guard persists **attention**. While that state remains, each guard check may again stop and verify only a newly found, verified `ZCode.app` tree; disable scheduled stop before manually reopening the client ahead of its scheduled enable time.

Reattach is allowed only when the complete persisted fingerprint—title, prompt, model, workspace, and target session—still matches. Acknowledge-and-continue should only be used after manually verifying that the client task cannot overlap the next item.

“Run now” bypasses the time window and current inter-task delay. It does not bypass a manual/safety pause, a storage fault, or another active task.

For a dispatched ZCode task, the UI's “Stop” action stops queue-side monitoring and enters **attention**; if the client can still be proven not to have claimed it, the queue atomically revokes it and marks it stopped instead. Stopping or restarting the service never cancels a client session. On restart the queue reconciles its persisted evidence and resumes monitoring when that evidence is complete, entering **attention** only when the scheduler record is missing, conflicting, or unreadable. Shell tasks instead attempt to terminate the whole process group. Only the guard's explicit client-stop action exits a verified `ZCode.app` process tree.

## Main features

| Feature | Behavior |
|---|---|
| Single-instance serial queue | Existing-session continuation, new ZCode tasks, and shell commands |
| Queue controls | Pause/resume, run now, top/up/down, stop, retry, soft-delete and restore |
| Lightweight live state | SSE carries active summaries; history, details, and logs load on demand |
| Client sessions | Recent sessions, todo/tool activity, resume, import, hide and restore |
| Execution window | Midnight-crossing window; start inclusive, end exclusive; equal times mean all day; active work is not interrupted |
| Guard | Optional scheduled ZCode stop/enable without overwriting manual or attention pauses |
| Resilient UI | Writable polling fallback, monotonic revisions, instance invalidation, guarded forms, keyboard dialogs/tabs, mobile layout |
| Bounded shell execution | Capped output memory and process-group termination on timeout/manual stop |

The UI uses a unique `Idempotency-Key` for replay-safe mutations. It durably records uncertainty before sending and, after a lost response, makes only a replay-only request that cannot create a new operation. If the server can no longer prove the original result, the UI retains the tombstone and requires explicit reconciliation instead of silently minting a new key. It does not automatically retry inherently non-idempotent client stop/enable commands.

## Durable state and migration

Version 2 stores one atomic snapshot in `data/state.json` and the previous valid generation in `data/state.json.bak`. Writes use a same-directory temporary file, mode 0600, `fsync`, atomic rename, and directory synchronization; the data directory is tightened to 0700 where possible.

Permission tightening is best-effort. Modes 0600/0700 are not an effective multi-user security boundary on an external APFS volume mounted with “Ignore ownership on this volume,” or on a filesystem without Unix permission enforcement. Because tampering with the service code, control wrapper, state, or Bearer token can all become code execution as the service user, place the deployed runtime, control entry point, state/run/log files, and token together on a trusted local filesystem with ownership enabled; moving only the data directory is not a sufficient boundary. Work material may remain on an external volume, but tasks should set an explicit working directory.

On the first upgrade:

- `data/tasks.json` and `data/settings.json` are merged and preserved, with `.legacy.bak` copies.
- Only the exact shipped legacy prompt/marker pair migrates to `[[ZTQ_TASK_DONE]]`; custom values remain untouched.
- Guard scheduling starts from migration time and does not replay older stop/enable events; a write failure between the first state generation and its initialization marker cannot leave a replay window.

If the primary snapshot is corrupt or missing, the previous valid generation is restored in a forced pause and a corrupt primary is quarantined when possible. Recovery first advances the guard watermarks to this activation time and synchronizes both generations, so stop/enable events from the backup's stale interval are not replayed; an existing stop-ownership latch is preserved and cannot be bypassed by recovery or acknowledgement. If both generations are unusable, health returns 503 and `start.sh` exits without leaving an orphan server.

## Tests

~~~bash
npm run check
npm test
./smoke-test.sh
~~~

`npm test` uses temporary directories and SQLite fixtures for core, HTTP/SSE, persistence faults, crash reconciliation, launcher identity, and launchd rendering. `smoke-test.sh` runs 19 release checks: functional tasks use a fully isolated service, temporary state/SQLite, and a random port, while one separate check read-only hashes production files. It consumes no ZCode quota and writes `test-report.md`.

The smoke test read-only hashes the production queue state and the real SQLite main/WAL/SHM files before and after. If ZCode writes concurrently, a hash difference makes that evidence inconclusive rather than proving test contamination; rerun during a quiet window.

`test/ui-playwright.py` is an optional real-browser acceptance suite. It requires Python Playwright plus Chromium or Chrome and must point to an isolated server.

## Optional launchd service

Render a concrete plist instead of installing the placeholder template directly. The renderer resolves the current Node binary, project root, user directory, and state paths:

~~~bash
./start.sh stop
node launchd/render.js "$HOME/Library/LaunchAgents/com.zcode-task-queue.plist"
plutil -lint "$HOME/Library/LaunchAgents/com.zcode-task-queue.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.zcode-task-queue.plist"
launchctl kickstart -k "gui/$(id -u)/com.zcode-task-queue"
launchctl print "gui/$(id -u)/com.zcode-task-queue"
~~~

Unload it with:

~~~bash
launchctl bootout "gui/$(id -u)/com.zcode-task-queue"
~~~

The generated job uses `Umask=0077`, restarts only after unsuccessful exit, and throttles restarts for 10 seconds. The renderer pre-creates the selected stdout/stderr parent directories and log files, rejects symlinks, and applies 0700/0600 where supported. Re-render after moving Node, the repository, or the state directory. Choose either `start.sh` or launchd to manage the service; do not run multiple queue instances against the same ZCode profile, even with different ports or data directories.

To update an already loaded launchd job, first use the `bootout` command above, then re-render, lint, and `bootstrap` it; overwriting the plist on disk does not refresh the loaded configuration. If you set a custom `ZTQ_LAUNCHD_LABEL`, use that label in every `launchctl` command too.

## API

Every API endpoint except `/api/health` requires `Authorization: Bearer <token>` from `ZTQ_API_TOKEN_FILE`. Because browser `EventSource` cannot set custom headers, loopback `/api/events` alone also accepts `?token=`. Every POST additionally requires `X-ZTQ-Local: 1`; a supplied `Origin` must be loopback.

Replay-safe writes should include a unique `Idempotency-Key`. After an uncertain network result, reuse the same key with the identical request and add `Idempotency-Replay-Only: 1`. The server then returns only a recorded result; if none remains, it returns `409 IDEMPOTENCY_REPLAY_UNKNOWN` without writing. The ledger is valid for exactly 24 hours and retains at most 200 entries, so that 409 requires manual reconciliation, never a blind retry with a new key. `/api/guard` directly starts or stops the client, does not support replay-only, and is not automatically retried by the UI.

The local token can create Shell tasks, so it is effectively a credential for arbitrary local command execution as the service user. Do not share the authorized URL or token file, and never proxy the service onto a LAN or the public Internet.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Instance/PID/Node/path/storage/client health |
| `/api/state?view=summary` | GET | Active summary, queue, settings, and client sessions |
| `/api/events` | GET | Revisioned SSE summary |
| `/api/tasks?status=history\|trash` | GET | Paginated history/trash |
| `/api/tasks/:id` | GET | Full task detail |
| `/api/tasks/log?id=` | GET | Task log |
| `/api/tasks` | POST | Create one task or a line-based `batch` |
| `/api/tasks/:id/action` | POST | `up`, `down`, `top`, `runNow`, `retry`, `remove`, `restore`, `reattach`, `acknowledge` |
| `/api/queue` | POST | `pause`, `resume`, `clearFinished`, `restoreDeleted`, `stopCurrent`; stop requires the current `taskId` |
| `/api/client-tasks/continue` | POST | Resume a recent session |
| `/api/client-tasks/import` | POST | Import the first user prompt of a recent session |
| `/api/client-tasks/hide` | POST | Hide a session |
| `/api/client-tasks/unhide` | POST | Restore a hidden session |
| `/api/guard` | POST | `stopClient`, `enableClient`; stop supports `dryRun` |
| `/api/config` | POST | Execution, model, marker, and guard settings |

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `ZTQ_HOST` | `127.0.0.1` | Only `127.0.0.1`, `::1`, or `localhost` |
| `ZTQ_PORT` | `8787` | `0` asks the kernel for a random port recorded in the ready file |
| `ZTQ_DATA_DIR` | `<project>/data` | State and service logs |
| `ZTQ_PID_FILE` | `<data>/server.pid.json` | PID plus process identity |
| `ZTQ_READY_FILE` | `<data>/ready.json` | Ready instance, actual port, and start token |
| `ZTQ_LOG_FILE` | `<data>/server.log` | Rotated at startup at a 5 MiB threshold; retains 3 historical copies plus the current log |
| `ZTQ_NODE_BIN` | `node` on PATH | Absolute Node binary for `start.sh` and the launchd renderer |
| `ZTQ_HOME_DIR` | current user directory | Root for ZCode path discovery and the default token location; mainly useful for isolated tests |
| `ZTQ_API_TOKEN_FILE` | `<ZTQ_HOME_DIR>/.zcode-task-queue/api-token` | Local API Bearer token; auto-created if absent, or an existing non-symlink regular file owned by the current user containing exactly 64 lowercase hexadecimal characters |
| `ZTQ_CLIENT_INDEX_DB` | auto-detected | ZCode task-index SQLite; only owned automation/run rows are written |
| `ZTQ_CLIENT_SESSION_DB` | auto-detected | ZCode session SQLite, opened read-only |
| `ZTQ_CLIENT_CONFIG` | beside index DB | Available-model discovery |
| `ZTQ_START_WAIT_TENTHS` | `100` | Launcher readiness wait in 0.1-second units, range 1–600 |
| `ZTQ_LAUNCHD_LABEL` | `com.zcode-task-queue` | Job label used by the launchd renderer |
| `ZTQ_LAUNCHD_STDOUT` | `/dev/null` | launchd standard output; a file target is safely pre-created |
| `ZTQ_LAUNCHD_STDERR` | `<data>/launchd.stderr.log` | Captures pre-start and abnormal launchd diagnostics |

Explicit file/directory overrides passed through `start.sh` must be absolute. `ZTQ_TEST_MODE` and internal poll/grace timing variables are intended for isolated tests and fault injection, not normal production configuration; timer values are validated as bounded integer milliseconds before startup.

Shell tasks run `/bin/zsh -lc <command>` with the service user's permissions and environment in the task working directory (the project root when omitted). They are non-interactive: stdin receives EOF immediately. On timeout, manual stop, service shutdown, and after the main shell exits normally, the queue attempts to clean up the entire isolated process group. If it cannot prove that descendants have exited, the task enters **attention** and the queue does not advance.

## Operational boundaries

- Serialization covers only work dispatched by one queue instance. Sessions started directly by the user or another tool can still run concurrently and consume plan slots.
- The instance lock protects only one data directory. Do not run multiple queue instances against the same ZCode profile, even with different data directories or ports.
- The queue depends directly on the current ZCode SQLite tables and columns. After a ZCode client upgrade, rerun the regression suite and re-check the schema. Database files being present does not by itself prove version compatibility.

## Project layout

~~~text
server.js                 HTTP/SSE, security headers, ZCode guard, lifecycle
lib/queue-runtime.js      Queue state machine, idempotent dispatch, reconciliation, safety pause
lib/client-db.js          ZCode SQLite reads, automation writes, fingerprint checks
lib/state-store.js        Versioned atomic snapshot, backup, corruption recovery
public/                   Responsive UI with no inline scripts
launchd/                  plist template and safe renderer
test/                     Node regressions, SQLite fixtures, Playwright acceptance
smoke-test.sh             Fully isolated pre-release smoke suite
~~~

## License

[MIT](LICENSE)
