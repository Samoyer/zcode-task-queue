#!/bin/bash
# ZCode 任务队列 最小回归测试（smoke test）
# 只用 Shell 命令任务，不消耗套餐额度。要求队列服务已在本机运行。
# 运行: ./smoke-test.sh   （结果同时写入 test-report.md）

set -u
BASE="http://127.0.0.1:8787"
HDR=(-H 'Content-Type: application/json' -H 'X-ZTQ-Local: 1')
PASS=0; FAIL=0
REPORT=""

log() { echo "$*"; REPORT="${REPORT}$*"$'\n'; }
check() { # check <名称> <实际> <期望>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); log "  ✅ PASS  $1 （$2）";
  else FAIL=$((FAIL+1)); log "  ❌ FAIL  $1 （实际=$2 期望=$3）"; fi
}
api() { curl -s "${HDR[@]}" -X POST "$BASE/api/$1" -d "$2"; }
state_field() { curl -s "$BASE/api/state" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d);console.log($1)})"; }
wait_status() { # wait_status <任务名> <期望状态> [最大秒数]
  local n="$1" want="$2" max="${3:-20}" got=""
  for i in $(seq 1 "$max"); do
    got=$(state_field "(()=>{const t=s.tasks.find(t=>t.name==='$n');return t?t.status:'missing'})()")
    [ "$got" = "$want" ] && { echo "$got"; return 0; }
    sleep 1
  done
  echo "$got"
}

log "# zcode-task-queue 回归测试报告"
log "- 时间：$(date '+%Y-%m-%d %H:%M:%S')"
log "- 方式：Shell 模拟任务，不消耗套餐额度"
log ""

curl -s "$BASE/api/state" > /dev/null 2>&1 || { log "❌ 服务未运行（node server.js）"; printf '%s' "$REPORT" > test-report.md; exit 1; }

# 保存用户的时段配置，测试期间临时关闭（用例3 自行开关时段验证门控）
SAVED=$(state_field "JSON.stringify({scheduleEnabled:s.settings.scheduleEnabled,scheduleStart:s.settings.scheduleStart,scheduleEnd:s.settings.scheduleEnd})")
case "$SAVED" in \{*scheduleEnabled*\}) ;; *) SAVED='{"scheduleEnabled":false,"scheduleStart":"23:00","scheduleEnd":"09:00"}' ;; esac
api config '{"scheduleEnabled":false}' > /dev/null
log "- 已临时关闭时段分流（测试结束自动恢复为：${SAVED}）"

# ---------- 用例1：顺序执行 ----------
log ""
log "## 用例1 顺序执行（前一个完成后下一个才开始）"
api tasks '{"type":"shell","name":"smoke-顺序-1","prompt":"sleep 1"}' > /dev/null
api tasks '{"type":"shell","name":"smoke-顺序-2","prompt":"sleep 1"}' > /dev/null
for i in $(seq 1 30); do
  DONE=$(state_field "s.tasks.filter(t=>t.name.startsWith('smoke-顺序')).filter(t=>t.status==='done').length")
  [ "$DONE" = "2" ] && break
  sleep 1
done
check "两个任务均完成" "${DONE:-0}" "2"
if [ "${DONE:-0}" = "2" ]; then
  ORDER=$(state_field "(()=>{const a=s.tasks.find(t=>t.name==='smoke-顺序-1'),b=s.tasks.find(t=>t.name==='smoke-顺序-2');return a.finishedAt<=b.startedAt?'串行':'并行'})()")
  check "严格串行（任务1结束时间 ≤ 任务2开始时间）" "$ORDER" "串行"
fi

# ---------- 用例2：暂停 / 恢复 ----------
log ""
log "## 用例2 暂停队列后不派发，恢复后继续"
api queue '{"action":"pause"}' > /dev/null
api tasks '{"type":"shell","name":"smoke-暂停","prompt":"sleep 1"}' > /dev/null
sleep 2
ST=$(state_field "(()=>{const t=s.tasks.find(t=>t.name==='smoke-暂停');return t?t.status:'missing'})()")
check "暂停期间保持 pending" "$ST" "pending"
api queue '{"action":"resume"}' > /dev/null
ST=$(wait_status "smoke-暂停" "done" 20)
check "恢复后执行完成" "$ST" "done"

# ---------- 用例3：执行时段门控 ----------
log ""
log "## 用例3 执行时段门控（时段外排队，进入时段自动执行）"
api config '{"scheduleEnabled":true,"scheduleStart":"03:00","scheduleEnd":"03:01"}' > /dev/null
api tasks '{"type":"shell","name":"smoke-时段","prompt":"sleep 1"}' > /dev/null
sleep 3
ST=$(state_field "(()=>{const t=s.tasks.find(t=>t.name==='smoke-时段');return t?t.status:'missing'})()")
check "时段外保持 pending" "$ST" "pending"
api config '{"scheduleStart":"00:00","scheduleEnd":"23:59"}' > /dev/null
ST=$(wait_status "smoke-时段" "done" 20)
check "进入时段后自动执行" "$ST" "done"

# ---------- 恢复用户配置 + 清理 ----------
api config "$SAVED" > /dev/null
for t in $(state_field "s.tasks.filter(t=>t.name.startsWith('smoke-')).map(t=>t.id).join(' ')"); do
  api "tasks/$t/action" '{"action":"remove"}' > /dev/null
done

log ""
log "## 汇总"
log "- 通过：$PASS  失败：$FAIL"
log "- 已恢复时段配置：${SAVED}，并清理全部测试任务"
if [ "$FAIL" = "0" ]; then log "- 总体结论：✅ 通过"; else log "- 总体结论：❌ 存在失败项"; fi
printf '%s' "$REPORT" > test-report.md
[ "$FAIL" = "0" ]
