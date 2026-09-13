#!/bin/bash
# Fully isolated smoke service. Production queue/SQLite files are only read for before/after hashes.

set -u

ROOT=$(cd -- "$(dirname -- "$0")" && pwd -P)
NODE_BIN=$(command -v node 2>/dev/null || true)
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || { echo "✗ 找不到可执行 Node" >&2; exit 2; }
NODE_BIN=$(cd -- "$(dirname -- "$NODE_BIN")" && printf '%s/%s' "$(pwd -P)" "$(basename -- "$NODE_BIN")")
RUN_ID="smoke-$(date +%s)-$$"
TMP_PARENT=$(cd -- "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P) || { echo "✗ 无法访问临时目录" >&2; exit 2; }
TEST_ROOT=$(mktemp -d "$TMP_PARENT/ztq-smoke.XXXXXX") || { echo "✗ 无法创建隔离测试目录" >&2; exit 2; }
case "$TEST_ROOT" in "$TMP_PARENT"/ztq-smoke.*) ;; *) echo "✗ 临时目录范围校验失败" >&2; exit 2 ;; esac
[ -d "$TEST_ROOT" ] || { echo "✗ 隔离测试目录不存在" >&2; exit 2; }
TEST_HOME="$TEST_ROOT/home"
TEST_API_TOKEN_FILE="$TEST_HOME/.zcode-task-queue/api-token"
TEST_DATA="$TEST_ROOT/data"
TEST_WORK="$TEST_ROOT/work"
INDEX_DB="$TEST_ROOT/zcode/v2/tasks-index.sqlite"
SESSION_DB="$TEST_ROOT/zcode/cli/db/db.sqlite"
PID_FILE="$TEST_ROOT/run/server.pid.json"
READY_FILE="$TEST_ROOT/run/ready.json"
REPORT_FILE=${ZTQ_TEST_REPORT:-$ROOT/test-report.md}
BEFORE="$TEST_ROOT/production.before"
AFTER="$TEST_ROOT/production.after"
PASS=0
FAIL=0
REPORT=""
CREATED_IDS=""
BASE=""
API_TOKEN=""
REAL_INDEX_DB=""
REAL_SESSION_DB=""

log() { printf '%s\n' "$*"; REPORT="${REPORT}$*"$'\n'; }
pass() { PASS=$((PASS + 1)); log "  ✅ PASS  $1"; }
fail() { local detail=${2:-}; FAIL=$((FAIL + 1)); log "  ❌ FAIL  $1${detail:+：$detail}"; }
check_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "实际=$2，期望=$3"; fi; }

real_paths() {
  "$NODE_BIN" - "$ROOT" <<'NODE'
const {ClientDatabase}=require(process.argv[2] + '/lib/client-db');
const db=new ClientDatabase({root:process.argv[2]});
console.log(db.paths.indexDb || '');
console.log(db.paths.sessionDb || '');
NODE
}

production_manifest() {
  local file
  for file in "$ROOT/data/tasks.json" "$ROOT/data/settings.json" \
              "$ROOT/data/tasks.json.legacy.bak" "$ROOT/data/settings.json.legacy.bak" \
              "$ROOT/data/state.json" "$ROOT/data/state.json.bak" "$ROOT/data/.state-v2-initialized" \
              "$REAL_INDEX_DB" "${REAL_INDEX_DB}-wal" "${REAL_INDEX_DB}-shm" \
              "$REAL_SESSION_DB" "${REAL_SESSION_DB}-wal" "${REAL_SESSION_DB}-shm"; do
    [ -n "$file" ] || continue
    if [ -e "$file" ]; then shasum -a 256 "$file"; else printf 'MISSING  %s\n' "$file"; fi
  done
}

cleanup() {
  local incoming=$?
  local retain=0
  if [ -f "$PID_FILE" ]; then
    if ! ZTQ_HOME_DIR="$TEST_HOME" ZTQ_DATA_DIR="$TEST_DATA" ZTQ_CLIENT_INDEX_DB="$INDEX_DB" \
      ZTQ_CLIENT_SESSION_DB="$SESSION_DB" ZTQ_PID_FILE="$PID_FILE" ZTQ_READY_FILE="$READY_FILE" \
      ZTQ_API_TOKEN_FILE="$TEST_API_TOKEN_FILE" ZTQ_HOST=127.0.0.1 ZTQ_PORT=0 ZTQ_TEST_MODE=1 \
      "$ROOT/start.sh" stop >/dev/null 2>&1; then
      fail "隔离服务已停止" "停止失败，为便于排查已保留临时目录"
      retain=1
    fi
  fi
  production_manifest > "$AFTER" 2>/dev/null || true
  if ! diff -u "$BEFORE" "$AFTER" >/dev/null 2>&1; then
    fail "生产数据和真实 SQLite 哈希保持不变" "检测到外部状态变化；报告不能证明由测试引起，请在维护窗口复核"
  else
    pass "生产数据和真实 SQLite 哈希保持不变"
  fi
  log ""
  log "## 汇总"
  log "- Run ID：$RUN_ID"
  log "- Node：$("$NODE_BIN" -p 'process.versions.node')"
  log "- 系统：$(uname -sr)"
  log "- 隔离目录：$TEST_ROOT"
  log "- 通过：${PASS}；失败：${FAIL}"
  log "- 生产哈希：$([ "$FAIL" -eq 0 ] && echo '前后一致' || echo '见失败项')"
  [ "$retain" -eq 1 ] && log "- 隔离目录已保留：$TEST_ROOT"
  printf '%s' "$REPORT" > "$REPORT_FILE"
  [ "$retain" -eq 1 ] || rm -rf -- "$TEST_ROOT"
  trap - EXIT INT TERM
  [ "$incoming" -ne 0 ] && [ "$FAIL" -eq 0 ] && FAIL=$incoming
  exit "$FAIL"
}
trap cleanup EXIT INT TERM

api() {
  local method=$1 route=$2 body=${3:-} key=${4:-$RUN_ID-$RANDOM}
  if [ "$method" = GET ]; then
    curl --fail-with-body --silent --show-error --connect-timeout 2 --max-time 10 \
      -H "Authorization: Bearer $API_TOKEN" "$BASE$route"
  else
    curl --fail-with-body --silent --show-error --connect-timeout 2 --max-time 10 \
      -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
      -H 'X-ZTQ-Local: 1' -H "Idempotency-Key: $key" \
      -X POST "$BASE$route" -d "$body"
  fi
}

json_expr() {
  "$NODE_BIN" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);const f=new Function("s",`return (${process.argv[1]})`);const v=f(s);process.stdout.write(typeof v==="string"?v:JSON.stringify(v));})' "$1"
}

state_expr() { api GET '/api/state' | json_expr "$1"; }

create_task() {
  local name=$1 prompt=$2 timeout=${3:-null}
  local response id
  response=$(api POST '/api/tasks' "{\"type\":\"shell\",\"name\":\"$name\",\"prompt\":\"$prompt\",\"cwd\":\"$TEST_WORK\",\"timeoutMin\":$timeout}") || return 1
  id=$(printf '%s' "$response" | json_expr 's.ids[0]')
  LAST_ID=$id
}

wait_status() {
  local id=$1 wanted=$2 max=${3:-100} value=""
  local i
  for i in $(seq 1 "$max"); do
    value=$(state_expr "(()=>{const t=s.tasks.find(t=>t.id==='$id');return t?t.status:'missing'})()" 2>/dev/null || true)
    [ "$value" = "$wanted" ] && { printf '%s' "$value"; return 0; }
    sleep 0.1
  done
  printf '%s' "$value"
  return 1
}

export ZTQ_HOME_DIR="$TEST_HOME"
export ZTQ_API_TOKEN_FILE="$TEST_API_TOKEN_FILE"
export ZTQ_DATA_DIR="$TEST_DATA"
export ZTQ_CLIENT_INDEX_DB="$INDEX_DB"
export ZTQ_CLIENT_SESSION_DB="$SESSION_DB"
export ZTQ_CLIENT_CONFIG="$TEST_ROOT/zcode/v2/config.json"
export ZTQ_PID_FILE="$PID_FILE"
export ZTQ_READY_FILE="$READY_FILE"
export ZTQ_LOG_FILE="$TEST_DATA/server.log"
export ZTQ_HOST=127.0.0.1
export ZTQ_PORT=0
export ZTQ_TEST_MODE=1
export ZTQ_NODE_BIN="$NODE_BIN"
export ZTQ_START_WAIT_TENTHS=100
export ZTQ_DISPATCH_WAIT_MS=300000
export ZTQ_DB_ERROR_GRACE_MS=60000
export ZTQ_RESULT_GRACE_MS=5000
export ZTQ_POLL_MS=2000
export ZTQ_CLIENT_REFRESH_MS=60000
export ZTQ_GUARD_INTERVAL_MS=60000
export ZTQ_ENABLE_RESUME_MS=60000
export ZTQ_SHELL_SHUTDOWN_GRACE_MS=2000
export ZTQ_SHELL_KILL_WAIT_MS=1000
export ZTQ_STARTUP_DELAY_MS=0

if [ "${1:-}" = "--check-isolated-environment" ]; then
  "$NODE_BIN" -e '
    const keys = process.argv.slice(1);
    process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key]]))));
  ' ZTQ_HOME_DIR ZTQ_API_TOKEN_FILE ZTQ_DATA_DIR ZTQ_CLIENT_INDEX_DB ZTQ_CLIENT_SESSION_DB \
    ZTQ_PID_FILE ZTQ_READY_FILE ZTQ_LOG_FILE ZTQ_HOST ZTQ_PORT ZTQ_TEST_MODE ZTQ_NODE_BIN \
    ZTQ_START_WAIT_TENTHS ZTQ_DISPATCH_WAIT_MS ZTQ_DB_ERROR_GRACE_MS ZTQ_RESULT_GRACE_MS \
    ZTQ_POLL_MS ZTQ_CLIENT_REFRESH_MS ZTQ_GUARD_INTERVAL_MS ZTQ_ENABLE_RESUME_MS \
    ZTQ_SHELL_SHUTDOWN_GRACE_MS ZTQ_SHELL_KILL_WAIT_MS ZTQ_STARTUP_DELAY_MS || {
      trap - EXIT INT TERM
      rm -rf -- "$TEST_ROOT"
      exit 2
    }
  trap - EXIT INT TERM
  rm -rf -- "$TEST_ROOT"
  exit 0
fi
[ "$#" -eq 0 ] || { echo "用法: $0 [--check-isolated-environment]" >&2; exit 2; }

PATHS=$(real_paths)
REAL_INDEX_DB=$(printf '%s\n' "$PATHS" | sed -n '1p')
REAL_SESSION_DB=$(printf '%s\n' "$PATHS" | sed -n '2p')
production_manifest > "$BEFORE"
mkdir -p "$TEST_HOME" "$TEST_WORK" "$(dirname -- "$INDEX_DB")" "$(dirname -- "$SESSION_DB")" "$(dirname -- "$PID_FILE")"
"$NODE_BIN" -e "const f=require(process.argv[1]);f.createIndexDb(process.argv[2]);f.createSessionDb(process.argv[3]);" "$ROOT/test/helpers/fixture.js" "$INDEX_DB" "$SESSION_DB"

log "# zcode-task-queue 隔离回归报告"
log "- 时间：$(date '+%Y-%m-%d %H:%M:%S')"
log "- Run ID：$RUN_ID"
log "- 模式：临时数据、临时 SQLite、随机端口；真实队列/SQLite 仅做前后只读哈希"
log ""

if ! "$ROOT/start.sh" start >/dev/null; then fail "隔离服务启动"; exit 1; fi
PORT=$("$NODE_BIN" -p "require(process.argv[1]).port" "$READY_FILE")
BASE="http://127.0.0.1:$PORT"
API_TOKEN=$(tr -d '\r\n' < "$TEST_API_TOKEN_FILE")
if api GET '/api/health' >/dev/null; then pass "随机端口健康检查"; else fail "随机端口健康检查"; fi

NO_TOKEN=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 "$BASE/api/state")
NO_HEADER=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' -X POST "$BASE/api/queue" -d '{"action":"pause"}')
BAD_ORIGIN=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' -H 'X-ZTQ-Local: 1' -H 'Origin: https://evil.example' -X POST "$BASE/api/queue" -d '{"action":"pause"}')
check_eq "无令牌的读请求被拒绝" "$NO_TOKEN" "401"
check_eq "有令牌但无本机头的写请求被拒绝" "$NO_HEADER" "403"
check_eq "恶意 Origin 被拒绝" "$BAD_ORIGIN" "403"
TOKEN_MODE=$("$NODE_BIN" -p "(require('fs').statSync(process.argv[1]).mode & 0o777).toString(8)" "$TEST_API_TOKEN_FILE")
check_eq "API 令牌文件仅当前用户可读写" "$TOKEN_MODE" "600"
STATUS_OUTPUT=$("$ROOT/start.sh" status 2>/dev/null || true)
case "$STATUS_OUTPUT" in *"#token=$API_TOKEN"*) pass "status 输出可用的授权链接" ;; *) fail "status 输出可用的授权链接" ;; esac

HEADER=$(curl -sD - -o /dev/null "$BASE/")
printf '%s' "$HEADER" | grep -qi "content-security-policy:.*frame-ancestors 'none'" && pass "页面禁止嵌入" || fail "页面禁止嵌入"

log ""
log "## 串行、暂停与时段"
create_task "$RUN_ID-serial-1" 'sleep 0.2'; ID1=$LAST_ID; CREATED_IDS="$CREATED_IDS $ID1"
create_task "$RUN_ID-serial-2" 'sleep 0.2'; ID2=$LAST_ID; CREATED_IDS="$CREATED_IDS $ID2"
wait_status "$ID1" done >/dev/null || true
wait_status "$ID2" done >/dev/null || true
SERIAL=$(state_expr "(()=>{const a=s.tasks.find(t=>t.id==='$ID1'),b=s.tasks.find(t=>t.id==='$ID2');return a&&b&&a.finishedAt<=b.startedAt?'serial':'overlap'})()")
check_eq "两个 Shell 任务严格串行" "$SERIAL" "serial"

api POST '/api/queue' '{"action":"pause"}' >/dev/null
create_task "$RUN_ID-paused" 'true'; ID3=$LAST_ID; CREATED_IDS="$CREATED_IDS $ID3"
sleep 0.3
check_eq "暂停期间保持 pending" "$(state_expr "s.tasks.find(t=>t.id==='$ID3').status")" "pending"
api POST '/api/queue' '{"action":"resume"}' >/dev/null
check_eq "恢复后完成" "$(wait_status "$ID3" done || true)" "done"

WINDOW=$("$NODE_BIN" -e 'const d=new Date(Date.now()+5*60000);const e=new Date(Date.now()+6*60000);const f=x=>`${String(x.getHours()).padStart(2,"0")}:${String(x.getMinutes()).padStart(2,"0")}`;process.stdout.write(JSON.stringify({scheduleEnabled:true,scheduleStart:f(d),scheduleEnd:f(e)}));')
api POST '/api/config' "$WINDOW" >/dev/null
create_task "$RUN_ID-window" 'true'; ID4=$LAST_ID; CREATED_IDS="$CREATED_IDS $ID4"
sleep 0.3
check_eq "时段外保持 pending" "$(state_expr "s.tasks.find(t=>t.id==='$ID4').status")" "pending"
api POST '/api/config' '{"scheduleStart":"00:00","scheduleEnd":"00:00"}' >/dev/null
check_eq "进入全天时段后完成" "$(wait_status "$ID4" done || true)" "done"

log ""
log "## 失败、超时、停止与重启"
create_task "$RUN_ID-fail" 'exit 7'; ID5=$LAST_ID; CREATED_IDS="$CREATED_IDS $ID5"
check_eq "非零退出码标记失败" "$(wait_status "$ID5" failed || true)" "failed"
create_task "$RUN_ID-timeout" 'sleep 5' 0.001; ID6=$LAST_ID; CREATED_IDS="$CREATED_IDS $ID6"
check_eq "Shell 超时准确标记" "$(wait_status "$ID6" timeout 150 || true)" "timeout"
create_task "$RUN_ID-stop" 'sleep 10'; ID7=$LAST_ID; CREATED_IDS="$CREATED_IDS $ID7"
wait_status "$ID7" running >/dev/null || true
api POST '/api/queue' "{\"action\":\"stopCurrent\",\"taskId\":\"$ID7\"}" >/dev/null
check_eq "Shell 手动停止准确标记" "$(wait_status "$ID7" stopped 150 || true)" "stopped"

api POST '/api/queue' '{"action":"pause"}' >/dev/null
create_task "$RUN_ID-restart" 'true'; ID8=$LAST_ID; CREATED_IDS="$CREATED_IDS $ID8"
"$ROOT/start.sh" stop >/dev/null
BASE=""
"$ROOT/start.sh" start >/dev/null
PORT=$("$NODE_BIN" -p "require(process.argv[1]).port" "$READY_FILE")
BASE="http://127.0.0.1:$PORT"
check_eq "冷启动保留 pending" "$(state_expr "s.tasks.find(t=>t.id==='$ID8').status")" "pending"
api POST '/api/queue' '{"action":"resume"}' >/dev/null
check_eq "冷启动恢复后只执行一次" "$(wait_status "$ID8" done || true)" "done"

for id in $CREATED_IDS; do
  api POST "/api/tasks/$id/action" '{"action":"remove"}' >/dev/null 2>&1 || true
done
TRASH=$(api GET '/api/tasks?status=trash&limit=100' | json_expr 's.items.length' 2>/dev/null || true)
check_eq "只清理本次精确任务 ID" "${TRASH:-8}" "8"

exit "$FAIL"
