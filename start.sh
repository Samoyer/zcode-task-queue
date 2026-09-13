#!/bin/bash
# ZCode 任务队列安全启动器
# 用法: ./start.sh [preflight|start|stop|restart|status]

set -u
umask 077

ROOT=$(cd -- "$(dirname -- "$0")" && pwd -P)
ACTION=${1:-start}
HOST=${ZTQ_HOST:-127.0.0.1}
REQUESTED_PORT=${ZTQ_PORT:-8787}
DATA_DIR=${ZTQ_DATA_DIR:-$ROOT/data}
PID_FILE=${ZTQ_PID_FILE:-$DATA_DIR/server.pid.json}
READY_FILE=${ZTQ_READY_FILE:-$DATA_DIR/ready.json}
LOG_FILE=${ZTQ_LOG_FILE:-$DATA_DIR/server.log}
STARTUP_LOG_FILE="${LOG_FILE}.startup"
AUTH_HOME=${ZTQ_HOME_DIR:-$HOME}
API_TOKEN_FILE=${ZTQ_API_TOKEN_FILE:-$AUTH_HOME/.zcode-task-queue/api-token}
NODE_BIN=${ZTQ_NODE_BIN:-}
NODE_BIN_EXPLICIT=0
NODE_EXECUTABLE=""
START_WAIT_TENTHS=${ZTQ_START_WAIT_TENTHS:-100}
LOCK_FILE="${PID_FILE}.lifecycle.lock"
LOCK_HELD=0
STARTING_CHILD=""
STARTING_CHILD_STARTED_AT=""
STARTING_CHILD_EXECUTABLE=""
STARTING_CHILD_COMMAND=""
LIFECYCLE_SIGNAL_ACTIVE=0
LAUNCH_DIR=""
LAUNCH_IDENTITY_FILE=""
LAUNCH_IDENTITY_TMP=""
LAUNCH_ACK_FILE=""
LAUNCH_CANCEL_FILE=""
LAUNCH_GATE_FILE=""

if [ -n "$NODE_BIN" ]; then
  NODE_BIN_EXPLICIT=1
else
  NODE_BIN=$(command -v node 2>/dev/null || true)
fi

json_field() {
  "$NODE_BIN" -e '
    const fs=require("fs");
    const [file,key]=process.argv.slice(1);
    try { const value=JSON.parse(fs.readFileSync(file,"utf8"))[key]; if(value===undefined||value===null) process.exit(2); process.stdout.write(String(value)); }
    catch { process.exit(2); }
  ' "$1" "$2"
}

base_url() {
  local file=${1:-$PID_FILE}
  local h p
  h=$(json_field "$file" host 2>/dev/null || true)
  p=$(json_field "$file" port 2>/dev/null || true)
  case "$h" in 127.0.0.1|localhost|::1) ;; *) return 1 ;; esac
  case "$p" in ''|*[!0-9]*) return 1 ;; esac
  [ "$p" -ge 1 ] && [ "$p" -le 65535 ] || return 1
  [ "$h" = "::1" ] && h="[::1]"
  printf 'http://%s:%s' "$h" "$p"
}

browser_url() {
  local url token
  url=$(base_url "$1") || return 1
  [ -f "$API_TOKEN_FILE" ] || return 1
  token=$("$NODE_BIN" -e '
    const fs = require("fs");
    try {
      const token = fs.readFileSync(process.argv[1], "utf8").trim();
      if (!/^[a-f0-9]{64}$/.test(token)) process.exit(1);
      process.stdout.write(token);
    } catch { process.exit(1); }
  ' "$API_TOKEN_FILE" 2>/dev/null) || return 1
  printf '%s/#token=%s' "$url" "$token"
}

control_preflight() {
  for path_value in "$PID_FILE" "$READY_FILE" "$API_TOKEN_FILE"; do
    case "$path_value" in /*) ;; *) echo "✗ 路径必须是绝对路径: $path_value" >&2; return 2 ;; esac
  done
  if [ "$NODE_BIN_EXPLICIT" -eq 1 ]; then
    case "$NODE_BIN" in /*) ;; *) echo "✗ 显式 ZTQ_NODE_BIN 必须是绝对路径" >&2; return 2 ;; esac
  fi
  [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || { echo "✗ 找不到可执行 Node；可设置 ZTQ_NODE_BIN" >&2; return 2; }
  [ -x /usr/bin/shlock ] || { echo "✗ 系统缺少 /usr/bin/shlock，无法安全串行化启停操作" >&2; return 2; }
  NODE_BIN=$(cd -- "$(dirname -- "$NODE_BIN")" && printf '%s/%s' "$(pwd -P)" "$(basename -- "$NODE_BIN")")
  NODE_EXECUTABLE=$("$NODE_BIN" -p 'process.execPath' 2>/dev/null || true)
  case "$NODE_EXECUTABLE" in /*) ;; *) echo "✗ 无法确认 Node 运行时可执行文件" >&2; return 2 ;; esac
  [ -x "$NODE_EXECUTABLE" ] || { echo "✗ Node 运行时可执行文件不可用: $NODE_EXECUTABLE" >&2; return 2; }
  NODE_EXECUTABLE=$(cd -- "$(dirname -- "$NODE_EXECUTABLE")" && printf '%s/%s' "$(pwd -P)" "$(basename -- "$NODE_EXECUTABLE")")
}

start_preflight() {
  control_preflight || return $?
  case "$HOST" in 127.0.0.1|localhost|::1) ;; *) echo "✗ 拒绝非本机监听地址: $HOST" >&2; return 2 ;; esac
  case "$REQUESTED_PORT" in ''|*[!0-9]*) echo "✗ ZTQ_PORT 必须是 0–65535 的整数" >&2; return 2 ;; esac
  [ "$REQUESTED_PORT" -le 65535 ] || { echo "✗ ZTQ_PORT 超出范围" >&2; return 2; }
  case "$START_WAIT_TENTHS" in ''|*[!0-9]*) echo "✗ ZTQ_START_WAIT_TENTHS 必须是正整数" >&2; return 2 ;; esac
  [ "$START_WAIT_TENTHS" -ge 1 ] && [ "$START_WAIT_TENTHS" -le 600 ] || { echo "✗ ZTQ_START_WAIT_TENTHS 必须在 1–600 之间" >&2; return 2; }
  for path_value in "$DATA_DIR" "$PID_FILE" "$READY_FILE" "$LOG_FILE" "$STARTUP_LOG_FILE" \
                    "$API_TOKEN_FILE" "${ZTQ_HOME_DIR:-}" "${ZTQ_CLIENT_INDEX_DB:-}" "${ZTQ_CLIENT_SESSION_DB:-}" "${ZTQ_CLIENT_CONFIG:-}"; do
    [ -z "$path_value" ] && continue
    case "$path_value" in /*) ;; *) echo "✗ 路径必须是绝对路径: $path_value" >&2; return 2 ;; esac
  done
  "$NODE_BIN" -e '
    const [a,b,c]=process.versions.node.split(".").map(Number);
    if (!(a>22 || a===22 && b>=13)) { console.error(`需要 Node >=22.13.0，当前 ${process.versions.node}`); process.exit(2); }
    const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(":memory:"); db.exec("CREATE TABLE probe(x)"); db.close();
  ' || return 2
  "$NODE_BIN" -e '
    try {
      const server = require(process.argv[1]);
      server.runtimeTimings(process.env);
      server.validateWritablePathLayout({
        dataDir: process.argv[2], pidFile: process.argv[3], readyFile: process.argv[4],
        logFile: process.argv[5], apiTokenFile: process.argv[6],
        indexDbPath: process.env.ZTQ_CLIENT_INDEX_DB,
        sessionDbPath: process.env.ZTQ_CLIENT_SESSION_DB,
        additionalFiles: [{ label: "启动诊断日志", path: process.argv[7] }],
      });
    }
    catch (error) { console.error(error.message); process.exit(2); }
  ' "$ROOT/server.js" "$DATA_DIR" "$PID_FILE" "$READY_FILE" "$LOG_FILE" "$API_TOKEN_FILE" "$STARTUP_LOG_FILE" || return 2
  echo "Node: $NODE_BIN ($("$NODE_BIN" -p 'process.versions.node'))"
  echo "Root: $ROOT"
  echo "Data: $DATA_DIR"
  echo "PID: $PID_FILE"
  echo "Ready: $READY_FILE"
  echo "API token: $API_TOKEN_FILE"
  echo "Listen: $HOST:$REQUESTED_PORT"
}

sanitize_startup_log() {
  [ -f "$STARTUP_LOG_FILE" ] || return 0
  "$NODE_BIN" -e '
    const fs = require("fs");
    const { redactDiagnostic } = require(process.argv[1]);
    const [file, tokenFile] = process.argv.slice(2);
    try {
      const value = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, redactDiagnostic(value, tokenFile), { mode: 0o600 });
      fs.chmodSync(file, 0o600);
    } catch (error) {
      console.error(`无法脱敏启动诊断日志: ${error.message}`);
      process.exit(1);
    }
  ' "$ROOT/server.js" "$STARTUP_LOG_FILE" "$API_TOKEN_FILE"
}

release_lifecycle_lock() {
  [ "$LOCK_HELD" -eq 1 ] || return 0
  local owner=""
  owner=$(tr -d '[:space:]' < "$LOCK_FILE" 2>/dev/null || true)
  [ "$owner" = "$$" ] && rm -f -- "$LOCK_FILE"
  LOCK_HELD=0
}

cleanup_launch_handshake() {
  [ -n "$LAUNCH_DIR" ] || return 0
  case "$LAUNCH_DIR" in "${PID_FILE}.launch."*) ;; *) return 1 ;; esac
  rm -f -- "$LAUNCH_IDENTITY_FILE" "$LAUNCH_IDENTITY_TMP" "$LAUNCH_ACK_FILE" "$LAUNCH_CANCEL_FILE" \
    "$LAUNCH_GATE_FILE" "$LAUNCH_DIR/ack.pre-observe" "$LAUNCH_DIR/ack.observed"
  rmdir -- "$LAUNCH_DIR" 2>/dev/null || true
  LAUNCH_DIR=""
  LAUNCH_IDENTITY_FILE=""
  LAUNCH_IDENTITY_TMP=""
  LAUNCH_ACK_FILE=""
  LAUNCH_CANCEL_FILE=""
  LAUNCH_GATE_FILE=""
}

cancel_launch_handshake() {
  [ -n "$LAUNCH_CANCEL_FILE" ] || return 0
  : > "$LAUNCH_CANCEL_FILE" 2>/dev/null || return 1
  chmod 600 "$LAUNCH_CANCEL_FILE" 2>/dev/null || true
}

starting_child_identity_matches_once() {
  local pid="$STARTING_CHILD" actual_uid actual_cwd actual_start actual_node command
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  [ -n "$STARTING_CHILD_STARTED_AT" ] && [ -n "$STARTING_CHILD_EXECUTABLE" ] && [ -n "$STARTING_CHILD_COMMAND" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  actual_uid=$(ps -o uid= -p "$pid" 2>/dev/null | tr -d ' ')
  actual_cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  actual_node=$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  actual_start=$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  command=$(ps -ww -o command= -p "$pid" 2>/dev/null || true)
  if [ "$LIFECYCLE_SIGNAL_ACTIVE" -eq 1 ] \
    && [ "${ZTQ_TEST_MODE:-0}" = "1" ] \
    && [ "${ZTQ_TEST_MIX_STARTING_IDENTITY_ONCE:-0}" = "1" ]; then
    ZTQ_TEST_MIX_STARTING_IDENTITY_ONCE=0
    : > "${PID_FILE}.test-mixed-identity"
    if [ "$actual_node" = "$NODE_EXECUTABLE" ]; then
      actual_node="/bin/bash"
    else
      command="$NODE_EXECUTABLE $ROOT/server.js"
    fi
  fi
  [ "$actual_uid" = "$(id -u)" ] || return 1
  [ "$actual_cwd" = "$ROOT" ] || return 1
  [ "$actual_start" = "$STARTING_CHILD_STARTED_AT" ] || return 1
  if [ "$actual_node" = "$STARTING_CHILD_EXECUTABLE" ] && [ "$command" = "$STARTING_CHILD_COMMAND" ]; then
    return 0
  fi
  [ "$actual_node" = "$NODE_EXECUTABLE" ] && [ "$command" = "$NODE_EXECUTABLE $ROOT/server.js" ]
}

starting_child_identity_matches() {
  local i
  for i in $(seq 1 20); do
    starting_child_identity_matches_once && return 0
    kill -0 "$STARTING_CHILD" 2>/dev/null || return 1
    sleep 0.01
  done
  return 1
}

terminate_starting_child() {
  local pid="$STARTING_CHILD" i
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac
  kill -0 "$pid" 2>/dev/null || {
    STARTING_CHILD=""; STARTING_CHILD_STARTED_AT=""; STARTING_CHILD_EXECUTABLE=""; STARTING_CHILD_COMMAND=""
    return 0
  }
  if ! starting_child_identity_matches; then
    echo "启动服务进程身份已变化，拒绝发送信号" >&2
    return 4
  fi
  kill -TERM "$pid" 2>/dev/null || true
  for i in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    if ! starting_child_identity_matches; then
      echo "启动服务进程身份已变化，拒绝 SIGKILL" >&2
      return 4
    fi
    kill -KILL "$pid" 2>/dev/null || true
    for i in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
  fi
  if kill -0 "$pid" 2>/dev/null; then
    echo "启动服务进程未能停止 (PID $pid)" >&2
    return 5
  fi
  STARTING_CHILD=""
  STARTING_CHILD_STARTED_AT=""
  STARTING_CHILD_EXECUTABLE=""
  STARTING_CHILD_COMMAND=""
}

handle_lifecycle_signal() {
  local code=$1
  trap - EXIT INT TERM HUP
  LIFECYCLE_SIGNAL_ACTIVE=1
  cancel_launch_handshake || true
  terminate_starting_child || true
  release_lifecycle_lock
  exit "$code"
}

acquire_lifecycle_lock() {
  mkdir -p -- "$(dirname -- "$LOCK_FILE")"
  local i
  for i in $(seq 1 150); do
    if /usr/bin/shlock -f "$LOCK_FILE" -p "$$"; then
      LOCK_HELD=1
      trap release_lifecycle_lock EXIT
      trap 'handle_lifecycle_signal 130' INT
      trap 'handle_lifecycle_signal 143' TERM
      trap 'handle_lifecycle_signal 129' HUP
      return 0
    fi
    sleep 0.1
  done
  echo "✗ 另一个启停操作仍在进行，请稍后重试" >&2
  return 6
}

run_locked() {
  acquire_lifecycle_lock || return $?
  "$@"
  local rc=$?
  release_lifecycle_lock
  trap - EXIT INT TERM HUP
  return "$rc"
}

pid_identity() {
  [ -f "$PID_FILE" ] || return 3
  local pid expected_root expected_uid expected_start expected_node actual_uid actual_cwd actual_start actual_node command
  pid=$(json_field "$PID_FILE" pid 2>/dev/null || true)
  expected_root=$(json_field "$PID_FILE" root 2>/dev/null || true)
  expected_uid=$(json_field "$PID_FILE" uid 2>/dev/null || true)
  expected_start=$(json_field "$PID_FILE" processStartedAt 2>/dev/null || true)
  expected_node=$(json_field "$PID_FILE" node 2>/dev/null || true)
  case "$pid" in ''|*[!0-9]*) return 4 ;; esac
  kill -0 "$pid" 2>/dev/null || return 3
  actual_uid=$(ps -o uid= -p "$pid" 2>/dev/null | tr -d ' ')
  actual_cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  actual_node=$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  actual_start=$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  command=$(ps -o command= -p "$pid" 2>/dev/null || true)
  [ "$expected_root" = "$ROOT" ] || return 4
  [ "$expected_uid" = "$(id -u)" ] && [ "$actual_uid" = "$(id -u)" ] || return 4
  [ "$actual_cwd" = "$ROOT" ] || return 4
  [ -n "$expected_start" ] && [ "$actual_start" = "$expected_start" ] || return 4
  [ -n "$expected_node" ] && [ "$actual_node" = "$expected_node" ] || return 4
  case "$command" in *"$ROOT/server.js"*) ;; *) return 4 ;; esac
  printf '%s' "$pid"
}

health_matches() {
  local url token pid body
  url=$(base_url "$PID_FILE") || return 1
  token=$(json_field "$PID_FILE" startToken 2>/dev/null || true)
  pid=$(json_field "$PID_FILE" pid 2>/dev/null || true)
  body=$(curl --fail --silent --show-error --connect-timeout 1 --max-time 2 "$url/api/health" 2>/dev/null) || return 1
  printf '%s' "$body" | "$NODE_BIN" -e '
    let data=""; process.stdin.on("data",c=>data+=c).on("end",()=>{
      const [pid,token,root]=process.argv.slice(1); const value=JSON.parse(data);
      if(String(value.pid)!==pid || value.startToken!==token || value.root!==root || !value.ok) process.exit(1);
    });
  ' "$pid" "$token" "$ROOT"
}

status() {
  local pid rc
  pid=$(pid_identity); rc=$?
  if [ "$rc" -eq 3 ]; then echo "未运行"; return 3; fi
  if [ "$rc" -ne 0 ]; then echo "PID 文件指向不可信或无关进程，已拒绝操作" >&2; return 4; fi
  if health_matches; then echo "运行中 (PID $pid) → $(browser_url "$PID_FILE" 2>/dev/null || base_url "$PID_FILE")"; return 0; fi
  echo "进程存在但健康检查失败 (PID $pid)" >&2
  return 5
}

report_start_failure() {
  if ! sanitize_startup_log; then
    echo "✗ 启动失败，且启动诊断日志无法安全脱敏；未输出其内容" >&2
    return 1
  fi
  echo "✗ 启动失败，请查看 $STARTUP_LOG_FILE 和 $LOG_FILE" >&2
  tail -n 12 "$STARTUP_LOG_FILE" 2>/dev/null || true
  return 1
}

spawn_detached_service() {
  local launcher_started=$1
  (
    export ZTQ_HOST="$HOST" ZTQ_PORT="$REQUESTED_PORT" ZTQ_DATA_DIR="$DATA_DIR"
    export ZTQ_PID_FILE="$PID_FILE" ZTQ_READY_FILE="$READY_FILE" ZTQ_LOG_FILE="$LOG_FILE"
    export ZTQ_API_TOKEN_FILE="$API_TOKEN_FILE"
    export ZTQ_MIRROR_LOG_STDOUT=0
    "$NODE_EXECUTABLE" -e '
      const fs = require("fs");
      const { spawn } = require("child_process");
      const [node, script, cwd, logFile, gateFile, identityFile, identityTmp,
        ackFile, cancelFile, launchDir, lifecycleLock, launcherPid, launcherStarted, launcherUid] = process.argv.slice(1);
      const gateScript = String.raw`#!/bin/bash
set -u
identity_file=$1
shift
identity_tmp=$1
shift
ack_file=$1
shift
cancel_file=$1
shift
launch_dir=$1
shift
lifecycle_lock=$1
shift
launcher_pid=$1
shift
launcher_started=$1
shift
launcher_uid=$1
shift
node=$1
shift
server=$1
shift
root=$1

cleanup_gate() {
  /bin/rm -f -- "$identity_file" "$identity_tmp" "$ack_file" "$cancel_file" \
    "$launch_dir/ack.pre-observe" "$launch_dir/ack.observed" "$0"
  /bin/rmdir -- "$launch_dir" 2>/dev/null || true
}

abort_gate() {
  trap - INT TERM HUP
  cleanup_gate
  exit 1
}

parent_gone() {
  trap - INT TERM HUP
  lock_owner=$(/usr/bin/tr -d "[:space:]" < "$lifecycle_lock" 2>/dev/null || true)
  [ "$lock_owner" = "$launcher_pid" ] && /bin/rm -f -- "$lifecycle_lock"
  cleanup_gate
  exit 1
}

parent_alive() {
  kill -0 "$launcher_pid" 2>/dev/null || return 1
  actual_start=$(/bin/ps -o lstart= -p "$launcher_pid" 2>/dev/null | /usr/bin/sed "s/^[[:space:]]*//;s/[[:space:]]*$//")
  actual_uid=$(/bin/ps -o uid= -p "$launcher_pid" 2>/dev/null | /usr/bin/tr -d " ")
  [ "$actual_start" = "$launcher_started" ] && [ "$actual_uid" = "$launcher_uid" ]
}

trap abort_gate INT TERM HUP
parent_alive || parent_gone
self_start=$(/bin/ps -o lstart= -p "$$" 2>/dev/null | /usr/bin/sed "s/^[[:space:]]*//;s/[[:space:]]*$//")
self_uid=$(/bin/ps -o uid= -p "$$" 2>/dev/null | /usr/bin/tr -d " ")
self_cwd=$(/bin/pwd -P)
self_executable=$(/usr/sbin/lsof -a -p "$$" -d txt -Fn 2>/dev/null | /usr/bin/sed -n "s/^n//p" | /usr/bin/head -1)
self_command=$(/bin/ps -ww -o command= -p "$$" 2>/dev/null)
[ -n "$self_start" ] && [ "$self_uid" = "$launcher_uid" ] && [ "$self_cwd" = "$root" ] && [ -n "$self_executable" ] && [ -n "$self_command" ] || abort_gate
/usr/bin/printf "%s\n%s\n%s\n%s" "$$" "$self_start" "$self_executable" "$self_command" > "$identity_tmp" || abort_gate
/bin/chmod 600 "$identity_tmp" 2>/dev/null || true
/bin/mv "$identity_tmp" "$identity_file" || abort_gate

i=0
while [ "$i" -lt 1000 ]; do
  if [ "$ZTQ_TEST_MODE" = "1" ] && [ "$ZTQ_TEST_GATE_STOP_BEFORE_ACK_CHECK" = "1" ]; then
    : > "$launch_dir/ack.pre-observe" || abort_gate
    kill -STOP "$$" || abort_gate
  fi
  if [ -f "$ack_file" ]; then
    if [ "$ZTQ_TEST_MODE" = "1" ] && [ "$ZTQ_TEST_GATE_STOP_AFTER_ACK" = "1" ]; then
      : > "$launch_dir/ack.observed" || abort_gate
      kill -STOP "$$" || abort_gate
    fi
    trap - INT TERM HUP
    cleanup_gate
    cd -- "$root" || exit 1
    exec "$node" "$server"
  fi
  [ -f "$cancel_file" ] && abort_gate
  parent_alive || parent_gone
  i=$((i + 1))
  /bin/sleep 0.01
done
abort_gate
`;
      let logFd;
      try {
        fs.writeFileSync(gateFile, gateScript, { flag: "wx", mode: 0o700 });
        logFd = fs.openSync(logFile, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
        const child = spawn("/bin/bash", [gateFile, identityFile, identityTmp, ackFile, cancelFile,
          launchDir, lifecycleLock, launcherPid, launcherStarted, launcherUid, node, script, cwd], {
          cwd,
          env: {
            ...process.env,
            ZTQ_TEST_MODE: process.env.ZTQ_TEST_MODE || "0",
            ZTQ_TEST_GATE_STOP_BEFORE_ACK_CHECK: process.env.ZTQ_TEST_GATE_STOP_BEFORE_ACK_CHECK || "0",
            ZTQ_TEST_GATE_STOP_AFTER_ACK: process.env.ZTQ_TEST_GATE_STOP_AFTER_ACK || "0",
          },
          detached: true,
          stdio: ["ignore", logFd, logFd],
        });
        child.once("error", (error) => {
          console.error(`无法启动脱离引导进程: ${error.message}`);
          process.exitCode = 1;
        });
        child.once("spawn", () => {
          try { fs.closeSync(logFd); } catch {}
          logFd = undefined;
          child.unref();
        });
      } catch (error) {
        if (logFd !== undefined) try { fs.closeSync(logFd); } catch {}
        console.error(`无法创建脱离引导进程: ${error.message}`);
        process.exitCode = 1;
      }
    ' "$NODE_EXECUTABLE" "$ROOT/server.js" "$ROOT" "$STARTUP_LOG_FILE" "$LAUNCH_GATE_FILE" \
      "$LAUNCH_IDENTITY_FILE" "$LAUNCH_IDENTITY_TMP" "$LAUNCH_ACK_FILE" "$LAUNCH_CANCEL_FILE" \
      "$LAUNCH_DIR" "$LOCK_FILE" "$$" "$launcher_started" "$(id -u)"
  )
}

start_service() {
  local current_rc launch_identity launch_rc child launcher_started expected_gate_command
  local actual_node command i runtime_file cleanup_rc server_identity_ready=0
  status >/dev/null 2>&1; current_rc=$?
  if [ "$current_rc" -eq 0 ]; then status; return 0; fi
  if [ "$current_rc" -eq 4 ] || [ "$current_rc" -eq 5 ]; then status; return "$current_rc"; fi
  if [ "$REQUESTED_PORT" -ne 0 ]; then
    local listeners
    listeners=$(/usr/sbin/lsof -nP -iTCP:"$REQUESTED_PORT" -sTCP:LISTEN -t 2>/dev/null || true)
    if [ -n "$listeners" ]; then
      echo "✗ 端口 $REQUESTED_PORT 已由 PID $(printf '%s' "$listeners" | tr '\n' ',' | sed 's/,$//') 监听；未加载或迁移队列状态" >&2
      return 5
    fi
  fi
  rm -f -- "$PID_FILE" "$READY_FILE"
  mkdir -p -- "$DATA_DIR" "$(dirname -- "$PID_FILE")" "$(dirname -- "$READY_FILE")" "$(dirname -- "$LOG_FILE")"
  chmod 700 "$DATA_DIR" "$(dirname -- "$PID_FILE")" "$(dirname -- "$READY_FILE")" "$(dirname -- "$LOG_FILE")" 2>/dev/null || true
  : > "$STARTUP_LOG_FILE" || { echo "✗ 无法创建启动诊断日志: $STARTUP_LOG_FILE" >&2; return 2; }
  chmod 600 "$STARTUP_LOG_FILE" 2>/dev/null || true
  launcher_started=$(ps -o lstart= -p "$$" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [ -n "$launcher_started" ] || { echo "✗ 无法记录启动器进程身份" >&2; return 2; }
  LAUNCH_DIR=$(/usr/bin/mktemp -d "${PID_FILE}.launch.XXXXXX") || {
    echo "✗ 无法创建启动交接目录" >&2
    return 2
  }
  chmod 700 "$LAUNCH_DIR" 2>/dev/null || true
  LAUNCH_IDENTITY_FILE="$LAUNCH_DIR/identity"
  LAUNCH_IDENTITY_TMP="$LAUNCH_DIR/identity.tmp"
  LAUNCH_ACK_FILE="$LAUNCH_DIR/ack"
  LAUNCH_CANCEL_FILE="$LAUNCH_DIR/cancel"
  LAUNCH_GATE_FILE="$LAUNCH_DIR/gate.sh"
  spawn_detached_service "$launcher_started" >> "$STARTUP_LOG_FILE" 2>&1
  launch_rc=$?
  if [ "$launch_rc" -ne 0 ]; then
    cancel_launch_handshake || true
    sleep 0.05
    cleanup_launch_handshake || true
    report_start_failure
    return $?
  fi
  for i in $(seq 1 500); do
    [ -s "$LAUNCH_IDENTITY_FILE" ] && break
    sleep 0.01
  done
  launch_identity=$(sed -n '1,4p' "$LAUNCH_IDENTITY_FILE" 2>/dev/null || true)
  child=$(printf '%s\n' "$launch_identity" | sed -n '1p')
  if [ "$(printf '%s\n' "$launch_identity" | sed -n '$=')" -ne 4 ]; then
    cancel_launch_handshake || true
    case "$child" in
      ''|*[!0-9]*) ;;
      *) for i in $(seq 1 100); do kill -0 "$child" 2>/dev/null || break; sleep 0.01; done ;;
    esac
    case "$child" in
      ''|*[!0-9]*) cleanup_launch_handshake || true ;;
      *) kill -0 "$child" 2>/dev/null || cleanup_launch_handshake || true ;;
    esac
    report_start_failure
    return $?
  fi
  STARTING_CHILD=$child
  STARTING_CHILD_STARTED_AT=$(printf '%s\n' "$launch_identity" | sed -n '2p')
  STARTING_CHILD_EXECUTABLE=$(printf '%s\n' "$launch_identity" | sed -n '3p')
  STARTING_CHILD_COMMAND=$(printf '%s\n' "$launch_identity" | sed -n '4p')
  expected_gate_command="/bin/bash $LAUNCH_GATE_FILE $LAUNCH_IDENTITY_FILE $LAUNCH_IDENTITY_TMP $LAUNCH_ACK_FILE $LAUNCH_CANCEL_FILE $LAUNCH_DIR $LOCK_FILE $$ $launcher_started $(id -u) $NODE_EXECUTABLE $ROOT/server.js $ROOT"
  if [ "$STARTING_CHILD_EXECUTABLE" != "/bin/bash" ] \
    || [ "$STARTING_CHILD_COMMAND" != "$expected_gate_command" ] \
    || ! starting_child_identity_matches; then
    cancel_launch_handshake || true
    terminate_starting_child || true
    cleanup_launch_handshake || true
    echo "✗ 启动进程身份交接失败；已拒绝继续启动" >&2
    return 1
  fi
  : > "$LAUNCH_ACK_FILE" || {
    cancel_launch_handshake || true
    terminate_starting_child || true
    cleanup_launch_handshake || true
    echo "✗ 无法完成启动进程交接" >&2
    return 1
  }
  chmod 600 "$LAUNCH_ACK_FILE" 2>/dev/null || true
  for i in $(seq 1 200); do
    kill -0 "$child" 2>/dev/null || break
    actual_node=$(lsof -a -p "$child" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
    command=$(ps -ww -o command= -p "$child" 2>/dev/null || true)
    if [ "$actual_node" = "$NODE_EXECUTABLE" ] \
      && [ "$command" = "$NODE_EXECUTABLE $ROOT/server.js" ] \
      && starting_child_identity_matches; then
      STARTING_CHILD_EXECUTABLE=$actual_node
      STARTING_CHILD_COMMAND=$command
      server_identity_ready=1
      break
    fi
    sleep 0.01
  done
  cleanup_launch_handshake || true
  if [ "$server_identity_ready" -ne 1 ]; then
    cleanup_rc=0
    terminate_starting_child || cleanup_rc=$?
    echo "✗ 启动进程交接失败" >&2
    [ "$cleanup_rc" -eq 0 ] || return "$cleanup_rc"
    report_start_failure
    return $?
  fi
  for i in $(seq 1 "$START_WAIT_TENTHS"); do
    if [ "$(json_field "$PID_FILE" pid 2>/dev/null || true)" = "$child" ] \
      && pid_identity >/dev/null 2>&1 && health_matches; then
      status
      STARTING_CHILD=""
      STARTING_CHILD_STARTED_AT=""
      STARTING_CHILD_EXECUTABLE=""
      STARTING_CHILD_COMMAND=""
      return 0
    fi
    kill -0 "$child" 2>/dev/null || break
    sleep 0.1
  done
  cleanup_rc=0
  terminate_starting_child || cleanup_rc=$?
  if [ "$cleanup_rc" -ne 0 ]; then
    echo "✗ 启动失败，且无法安全确认服务进程已停止" >&2
    return "$cleanup_rc"
  fi
  for runtime_file in "$PID_FILE" "$READY_FILE"; do
    if ! kill -0 "$child" 2>/dev/null \
      && [ "$(json_field "$runtime_file" pid 2>/dev/null || true)" = "$child" ]; then
      rm -f -- "$runtime_file"
    fi
  done
  STARTING_CHILD=""
  STARTING_CHILD_STARTED_AT=""
  STARTING_CHILD_EXECUTABLE=""
  STARTING_CHILD_COMMAND=""
  report_start_failure
  return $?
}

stop_service() {
  local pid rc
  pid=$(pid_identity); rc=$?
  if [ "$rc" -eq 3 ]; then
    rm -f -- "$PID_FILE" "$READY_FILE"
    echo "未运行"
    return 0
  fi
  if [ "$rc" -ne 0 ]; then echo "PID 文件不可信，拒绝发送信号" >&2; return 4; fi
  kill -TERM "$pid"
  local i
  for i in $(seq 1 100); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    pid_identity >/dev/null 2>&1 || { echo "进程身份已变化，拒绝 SIGKILL" >&2; return 4; }
    kill -KILL "$pid"
    for i in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then echo "进程未能停止 (PID $pid)" >&2; return 5; fi
  fi
  rm -f -- "$PID_FILE" "$READY_FILE"
  echo "已停止"
}

restart_service() {
  stop_service && start_service
}

case "$ACTION" in
  preflight) start_preflight ;;
  start) start_preflight && run_locked start_service ;;
  stop) control_preflight >/dev/null && run_locked stop_service ;;
  restart) start_preflight && run_locked restart_service ;;
  status) control_preflight >/dev/null && status ;;
  *) echo "用法: $0 [preflight|start|stop|restart|status]" >&2; exit 2 ;;
esac
