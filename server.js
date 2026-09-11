#!/usr/bin/env node
/**
 * ZCode 任务队列 — 逐个续跑客户端里已有的会话，带 Web 进度页
 *
 * 零依赖，Node >= 22（内置 node:sqlite）。启动：node server.js （默认 http://127.0.0.1:8787）
 *
 * 核心机制（全部经过实测）：
 *  - 续跑已有会话：向客户端自动化调度器（.zcode/v2/tasks-index.sqlite 的 automations 表）
 *    插入一条一次性自动化，target_task_id 指向目标会话。客户端派发时对带 target_task_id
 *    的自动化执行 resumeTask（在客户端内给该会话追加提示词继续跑），而不是新建任务。
 *  - 推进话术（可配置）默认：“继续，如果这项完成好了，告诉我全部完成，并给出完成报告。”
 *    一轮跑完若最新回复里没有完成标记（默认“全部完成”），休息片刻自动再发一轮，直到
 *    收到标记（任务完成，进历史）或达到最大轮数（失败）。
 *  - 模型/套餐：automation.model = “<套餐provider>/<模型ID>”。套餐分体验套餐
 *    （builtin:bigmodel-start-plan）与个人套餐（builtin:bigmodel-coding-plan），
 *    模型列表从客户端 v2/config.json 读取。
 *  - 自动停止/启用：可配置每日定时——停止=退出 ZCode 客户端（逻辑同 zcode-night-guard，
 *    优先调用该脚本，缺失时内置兜底），启用=open -a ZCode 拉起客户端。停止时自动暂停队列。
 *
 * 实时进度：只读打开客户端会话库（~/.zcode/cli/db/db.sqlite），展示运行中会话的
 * 最新工具/文本活动、todo 进度，以及客户端全部任务列表。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------- 常量与路径

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = Number(process.env.ZTQ_PORT || 8787);
const HOST = process.env.ZTQ_HOST || '127.0.0.1';

const CLIENT_ACTIVE_MS = 2 * 60 * 1000;  // 会话在此毫秒内更新视为进行中
const STUCK_AFTER_MS = 30 * 60 * 1000;   // turn 未闭合且这么久无输出 = 卡住
const AUTOMATION_LEAD_MS = 8 * 1000;     // 自动化的触发提前量
const DISPATCH_WAIT_MS = 5 * 60 * 1000;  // 客户端不接单的等待上限
const GUARD_SCRIPT = path.join(os.homedir(), 'bin/zcode-night-guard.sh');
const GUARD_IGNORE_FILE = path.join(os.homedir(), '.zcode-night-guard-ignore');

const DEFAULT_CONTINUE_PROMPT = '继续，如果这项完成好了，告诉我全部完成，并给出完成报告。';
const DEFAULT_COMPLETION_MARKER = '全部完成';

const TASK_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  WAIT_DISPATCH: 'waiting',
  DONE: 'done',
  FAILED: 'failed',
  STOPPED: 'stopped',
  TIMEOUT: 'timeout',
};

// ---------------------------------------------------------------- 客户端数据目录探测

/** 客户端 v2 数据目录随工作区根变化；优先带 -wal（正在使用）的库 */
function detectClientPaths() {
  const candidates = [];
  let dir = ROOT;
  for (let i = 0; i < 6; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    candidates.push(path.join(dir, '.zcode'));
  }
  candidates.push(path.join(os.homedir(), '.zcode'));

  const score = (idx) => fs.existsSync(idx + '-wal') ? 2 : fs.existsSync(idx) ? 1 : 0;
  let best = null, bestScore = 0, sdb = null;
  for (const zdir of candidates) {
    const idx = path.join(zdir, 'v2', 'tasks-index.sqlite');
    const sc = score(idx);
    if (sc > bestScore) { best = idx; bestScore = sc; }
    if (!sdb && fs.existsSync(path.join(zdir, 'cli', 'db', 'db.sqlite'))) {
      sdb = path.join(zdir, 'cli', 'db', 'db.sqlite');
    }
  }
  // 会话库全局共用 ~/.zcode/cli
  if (fs.existsSync(path.join(os.homedir(), '.zcode/cli/db/db.sqlite'))) {
    sdb = path.join(os.homedir(), '.zcode/cli/db/db.sqlite');
  }
  return { indexDb: best, sessionDb: sdb, clientConfig: best ? path.join(path.dirname(best), 'config.json') : path.join(os.homedir(), '.zcode/v2/config.json') };
}

// ---------------------------------------------------------------- 套餐与模型

const PLANS = {
  'builtin:bigmodel-start-plan': { label: '体验套餐', fallbackModels: ['GLM-5.3-Flash'] },
  'builtin:bigmodel-coding-plan': { label: '个人套餐', fallbackModels: ['GLM-5.3', 'GLM-5.3-Flash'] },
};

/** 从客户端 v2/config.json 读各套餐的模型目录 */
function readPlanModels() {
  const out = {};
  for (const pid of Object.keys(PLANS)) out[pid] = [...PLANS[pid].fallbackModels];
  try {
    const cfg = JSON.parse(fs.readFileSync(clientPaths.clientConfig, 'utf8'));
    const prov = cfg.provider || {};
    for (const pid of Object.keys(PLANS)) {
      const models = prov[pid] && prov[pid].models ? Object.keys(prov[pid].models) : [];
      for (const m of models) if (!out[pid].includes(m)) out[pid].unshift(m);
    }
  } catch { /* 用 fallback */ }
  return out;
}

// ---------------------------------------------------------------- 设置

const DEFAULT_SETTINGS = {
  intervalSec: 5,                 // 一轮结束/上一任务结束后多少秒排下一个
  stopOnFail: false,
  defaultTimeoutMin: 0,
  plan: 'builtin:bigmodel-coding-plan',            // 套餐 provider
  model: 'GLM-5.3-Flash',                          // 模型 ID
  continuePrompt: DEFAULT_CONTINUE_PROMPT,         // 续跑话术
  completionMarker: DEFAULT_COMPLETION_MARKER,     // 完成标记
  maxRounds: 20,                                   // 单任务最大续跑轮数
  stallMin: 15,                                   // 已接单但会话无输出多少分钟后判卡
  autoStopEnabled: false,
  autoStopTime: '08:55',          // 每日自动停止客户端（对齐夜间守护）
  autoEnableEnabled: false,
  autoEnableTime: '23:00',        // 每日自动拉起客户端（夜间免费时段开始）
  focusOnDispatch: false,         // 派发时把客户端切到对应工作区（zcode:// 深链）
  hiddenSessions: [],             // 手动从面板隐藏的客户端会话（客户端归档落盘有延迟，这里即时生效）
  scheduleEnabled: false,         // 仅在预约时段内执行任务（谷时分流）
  scheduleStart: '23:00',
  scheduleEnd: '09:00',
};

let settings = { ...DEFAULT_SETTINGS };

// ---------------------------------------------------------------- 状态

/** @type {Array<any>} */
let tasks = [];
let paused = false;
let nextTimer = null;
let current = null;    // { taskId, kind, child?, startedAt, timeoutHandle, pollHandle, automationId, dispatchedAt, baselineMsgTime, round }
let clientPaths = detectClientPaths();
let planModels = readPlanModels();

const sseClients = new Set();
let broadcastTimer = null;

// ---------------------------------------------------------------- 工具

const now = () => Date.now();
const genId = () => 't' + crypto.randomBytes(5).toString('hex');

function log(...args) {
  console.log(new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...args);
}

function modelRef() {
  const plan = PLANS[settings.plan] ? settings.plan : 'builtin:bigmodel-coding-plan';
  const model = settings.model || 'GLM-5.3-Flash';
  return `${plan}/${model}`;
}

function loadPersisted() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    for (const t of tasks) {
      t.logs = [];
      t.activity = '';
      if (t.status === TASK_STATUS.RUNNING || t.status === TASK_STATUS.WAIT_DISPATCH) {
        t.status = TASK_STATUS.PENDING;
        t.error = '服务重启，任务重新排队';
        t.round = 0;
      }
    }
  } catch { tasks = []; }
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    if (!PLANS[settings.plan]) settings.plan = DEFAULT_SETTINGS.plan;
  } catch { settings = { ...DEFAULT_SETTINGS }; }
}

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const slim = tasks.map(({ logs, activity, ...rest }) => rest);
      fs.writeFileSync(TASKS_FILE, JSON.stringify(slim, null, 2));
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    } catch (e) { log('持久化失败:', e.message); }
  }, 200);
}

// ---------------------------------------------------------------- 客户端数据库

let clientSessionDb = null;
let clientIndexDb = null;
let clientTasksError = '';

function openSessionDb() {
  if (clientSessionDb) return clientSessionDb;
  if (!clientPaths.sessionDb) return null;
  try {
    clientSessionDb = new DatabaseSync(clientPaths.sessionDb, { readOnly: true });
    return clientSessionDb;
  } catch (e) { log('打开会话库失败:', e.message); return null; }
}

function openIndexDbWritable() {
  if (clientIndexDb) return clientIndexDb;
  if (!clientPaths.indexDb) return null;
  try {
    clientIndexDb = new DatabaseSync(clientPaths.indexDb);
    return clientIndexDb;
  } catch (e) { log('打开任务索引库失败:', e.message); return null; }
}

/** 会话实时状态：最新活动、工具是否在跑、最新助手文本、todo 进度 */
function sessionStatus(sessionId) {
  const db = openSessionDb();
  if (!db) return { lastActivity: '', toolRunning: false, lastAssistantText: '', todos: null, lastPartType: '' };
  let lastActivity = '', toolRunning = false, lastAssistantText = '', todos = null, lastPartType = '';
  try {
    const parts = db.prepare(
      `SELECT data FROM part WHERE session_id = ? ORDER BY sequence DESC, time_created DESC LIMIT 12`
    ).all(sessionId);
    let needActivity = true;
    for (const p of parts) {
      let j; try { j = JSON.parse(p.data); } catch { continue; }
      // 最新一个有意义的 part 类型（step-start 挂着没闭合 = turn 未正常结束）
      if (!lastPartType && ['step-start', 'step-finish', 'tool', 'text'].includes(j.type)) {
        lastPartType = j.type;
      }
      if (needActivity && j.type === 'tool') {
        const st = (j.state && j.state.status) || '';
        if (st === 'running') toolRunning = true;
        lastActivity = '🔧 ' + (j.tool || '工具') + (st ? `(${st})` : '');
        needActivity = false;
      }
      if (needActivity && j.type === 'text' && j.text && String(j.text).trim()) {
        lastActivity = '💬 ' + String(j.text).trim().slice(0, 80);
        needActivity = false;
      }
      // 最新一条含文本的助手消息（按 sequence 从新到旧找第一条）
      if (!lastAssistantText && j.type === 'text' && j.text) {
        lastAssistantText = String(j.text).trim();
      }
    }
    const rows = db.prepare(
      `SELECT status, count(*) AS n FROM todo WHERE session_id = ? GROUP BY status`
    ).all(sessionId);
    if (rows.length) {
      todos = { done: 0, total: 0 };
      for (const r of rows) { todos.done += r.status === 'completed' ? r.n : 0; todos.total += r.n; }
    }
  } catch { /* 忽略 */ }
  return { lastActivity, toolRunning, lastAssistantText, todos, lastPartType };
}

/** 会话内最后一条消息的时间（用于识别“新回复”） */
function lastMessageTime(sessionId) {
  const db = openSessionDb();
  if (!db) return 0;
  try {
    const r = db.prepare(`SELECT max(time_created) AS t FROM message WHERE session_id = ?`).get(sessionId);
    return Number(r && r.t) || 0;
  } catch { return 0; }
}

/** 会话最近一次输出更新时间（message 或 part 的最大 time_updated，判卡用） */
function lastSessionUpdate(sessionId) {
  const db = openSessionDb();
  if (!db) return 0;
  try {
    const r = db.prepare(`
      SELECT max(t) AS t FROM (
        SELECT max(time_updated) AS t FROM message WHERE session_id = ?
        UNION ALL
        SELECT max(time_updated) AS t FROM part WHERE session_id = ?
      )
    `).get(sessionId, sessionId);
    return Number(r && r.t) || 0;
  } catch { return 0; }
}

/** 某时间之后的新助手文本（找完成标记用） */
function assistantTextSince(sessionId, sinceMs) {
  const db = openSessionDb();
  if (!db) return '';
  try {
    const msgs = db.prepare(`
      SELECT m.id, m.time_created FROM message m
      WHERE m.session_id = ? AND m.time_created > ? AND json_extract(m.data, '$.role') = 'assistant'
      ORDER BY m.sequence DESC LIMIT 5
    `).all(sessionId, sinceMs);
    for (const m of msgs) {
      const parts = db.prepare(
        `SELECT data FROM part WHERE message_id = ? AND data LIKE '%"text"%' ORDER BY sequence DESC`
      ).all(m.id);
      let text = '';
      for (const p of parts) {
        try {
          const j = JSON.parse(p.data);
          if (j.type === 'text' && j.text) { text += (text ? '\n' : '') + j.text; }
        } catch { /* 跳过 */ }
      }
      if (text.trim()) return text.trim();
    }
  } catch { /* 忽略 */ }
  return '';
}

// ---------------------------------------------------------------- 客户端任务监控（面板）

let clientTasks = [];

function readClientTasks() {
  const db = openSessionDb();
  if (!db) { clientTasksError = '未找到客户端会话数据库（客户端是否运行过？）'; return; }
  try {
    const nowMs = now();
    const sessions = db.prepare(`
      SELECT id, title, directory, time_created, time_updated
      FROM session WHERE task_type = 'interactive'
      ORDER BY time_updated DESC LIMIT 30
    `).all();

    // 桌面端任务索引：状态标注 + 归档/删除过滤（与客户端左侧任务列表保持一致）
    const indexStatus = new Map();
    const archivedSet = new Set();
    if (clientPaths.indexDb) {
      try {
        const idx = new DatabaseSync(clientPaths.indexDb, { readOnly: true });
        for (const row of idx.prepare(`SELECT task_id, task_status, archived FROM tasks WHERE deleted = 0`).all()) {
          indexStatus.set(row.task_id, row.task_status);
          if (row.archived === 1) archivedSet.add(row.task_id);
        }
        idx.close();
      } catch { /* 可选 */ }
    }
    const hiddenSet = new Set(settings.hiddenSessions || []);


    clientTasks = sessions
      .filter((s) => !archivedSet.has(s.id) && !hiddenSet.has(s.id))
      .map((s) => {
      const { lastActivity, toolRunning, lastPartType, todos } = sessionStatus(s.id);
      // 进行中 = 会话刚更新过 且（工具在跑 / 最新执行标记是 step-start / 客户端自己标了 running）
      // 卡住   = 最新执行标记是 step-start（一轮开了没结束）但已 30 分钟无输出
      // 只看更新时间会把卡死/被碰过的会话误判成进行中。
      const fresh = nowMs - Number(s.time_updated) < CLIENT_ACTIVE_MS;
      const staleMs = nowMs - Number(s.time_updated);
      let status;
      if (fresh && (toolRunning || lastPartType === 'step-start' || indexStatus.get(s.id) === 'running')) status = 'running';
      else if (lastPartType === 'step-start' && staleMs > STUCK_AFTER_MS) status = 'stuck';
      else status = indexStatus.get(s.id) || 'idle';
      return {
        sessionId: s.id,
        title: s.title,
        directory: s.directory,
        status,
        lastActivity,
        todos,
        timeCreated: Number(s.time_created),
        timeUpdated: Number(s.time_updated),
        fresh,
      };
    });
    clientTasksError = '';
  } catch (e) {
    clientTasksError = '读取客户端任务失败: ' + e.message;
  }
}

/** 提取某个客户端会话的原始提示词（导入用） */
function clientSessionPrompt(sessionId) {
  const db = openSessionDb();
  if (!db) throw new Error(clientTasksError || '客户端会话数据库不可用');
  const msg = db.prepare(`
    SELECT id FROM message
    WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
    ORDER BY sequence LIMIT 1
  `).get(sessionId);
  if (!msg) return '';
  const parts = db.prepare(`SELECT data FROM part WHERE message_id = ? ORDER BY sequence`).all(msg.id);
  const texts = [];
  for (const p of parts) {
    try {
      const j = JSON.parse(p.data);
      if (j.type === 'text' && j.text) texts.push(String(j.text).trim());
    } catch { /* 跳过 */ }
  }
  return texts.join('\n').slice(0, 20000);
}

/** 目标任务的 workspace（续跑绑定用）：优先任务索引库，回退会话 directory */
function taskWorkspace(sessionId, fallbackDir) {
  try {
    if (clientPaths.indexDb) {
      const idx = new DatabaseSync(clientPaths.indexDb, { readOnly: true });
      const row = idx.prepare(`SELECT workspace_path FROM tasks WHERE task_id = ? AND deleted = 0`).get(sessionId);
      idx.close();
      if (row && row.workspace_path && fs.existsSync(row.workspace_path)) return row.workspace_path;
    }
  } catch { /* 回退 */ }
  return fs.existsSync(fallbackDir || '') ? fallbackDir : ROOT;
}

// ---------------------------------------------------------------- 客户端执行：一次性自动化

function insertClientAutomation({ title, prompt, workspace, targetTaskId, modelRef: mRef }) {
  const fresh = detectClientPaths();
  if (fresh.indexDb !== clientPaths.indexDb) {
    log(`客户端任务索引库切换: ${clientPaths.indexDb} → ${fresh.indexDb}`);
    clientPaths.indexDb = fresh.indexDb;
    clientPaths.clientConfig = fresh.clientConfig;
    if (clientIndexDb) { try { clientIndexDb.close(); } catch {} clientIndexDb = null; }
  }
  const db = openIndexDbWritable();
  if (!db) throw new Error(clientPaths.indexDb ? '任务索引库打开失败' : '未找到客户端任务索引库（客户端数据目录）');
  const fireAt = now() + AUTOMATION_LEAD_MS;
  const d = new Date(fireAt);
  const cron = `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
  const id = 'automation-' + crypto.randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO automations (
      automation_id, title, cron_expr, prompt, model, provider, thought_level,
      workspace_key, workspace_path, target_task_id,
      recurring, max_runs, next_run_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'glm', 'max', ?, ?, ?, 0, 1, ?, ?, ?)`)
      .run(id, title, cron, prompt, mRef || null, workspace, workspace, targetTaskId || null, fireAt, now(), now());
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw new Error('写入客户端调度队列失败: ' + e.message);
  }
  const back = db.prepare(`SELECT automation_id FROM automations WHERE automation_id = ?`).get(id);
  if (!back) throw new Error('自动化写入后无法回读，目标库异常: ' + clientPaths.indexDb);
  log(`已排入客户端调度器: ${id}${targetTaskId ? ' (续跑 ' + targetTaskId.slice(0, 14) + '…)' : ''}${mRef ? ' model=' + mRef : ' model=沿用会话'}`);
  return id;
}

function queryAutomation(id) {
  const db = openIndexDbWritable();
  if (!db) return { phase: 'no-db' };
  try {
    const a = db.prepare(`SELECT dispatch_status, last_error FROM automations WHERE automation_id = ?`).get(id);
    if (!a) return { phase: 'gone' };
    if (a.last_error) return { phase: 'dispatch-failed', error: a.last_error };
    const run = db.prepare(
      `SELECT outcome, session_id, error FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(id);
    return {
      phase: 'tracked',
      dispatchStatus: a.dispatch_status,
      outcome: run ? run.outcome : null,
      sessionId: run ? run.session_id : null,
      runError: run ? run.error : null,
    };
  } catch (e) {
    return { phase: 'error', error: e.message };
  }
}

function cleanupAutomation(id) {
  try {
    const db = openIndexDbWritable();
    if (!db) return;
    db.prepare(`DELETE FROM automation_runs WHERE automation_id = ?`).run(id);
    db.prepare(`DELETE FROM automations WHERE automation_id = ?`).run(id);
  } catch { /* 清理失败不影响主流程 */ }
}

// ---------------------------------------------------------------- 客户端自动停止 / 启用

function zcodePids() {
  const out = execSync(`ps -axo pid=,command= | awk '$2 == "ZCode" || $0 ~ /\\/Applications\\/ZCode\\.app\\// || $2 ~ /^(zcode-cli|zcode-host-local|zcode-node-repl)/ || $0 ~ /ZCode Computer Use\\.app/ {print $1}'`, { shell: '/bin/zsh' }).toString().trim();
  return out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * 停止 ZCode 客户端（内置逻辑，不受时间窗/忽略文件限制——手动点击是明确意图）：
 * 先给全部相关进程发 SIGTERM 让主程序存档退出，最多等 20 秒，残留的 SIGKILL 兜底。
 * 每日定时的自动停止走 guardTick → 夜间守护脚本（带 08:55–09:30 窗口与忽略文件校验）。
 */
function stopClient(dryRun = false) {
  const pids = zcodePids();
  if (dryRun) return { dryRun: true, pids };
  if (!pids.length) { log('ZCode 未在运行'); return { stopped: false }; }
  try { execSync(`kill -TERM ${pids.join(' ')} 2>/dev/null`); } catch {}
  for (let i = 0; i < 20; i++) {
    try { execSync('sleep 1'); } catch {}
    if (!zcodePids().length) break;
  }
  const left = zcodePids();
  if (left.length) {
    try { execSync(`kill -9 ${left.join(' ')} 2>/dev/null`); } catch {}
    try { execSync('sleep 2'); } catch {}
  }
  const gone = !zcodePids().length;
  log(gone ? `已停止 ZCode 客户端 (${pids.length} 个进程)` : '警告：仍有 ZCode 相关进程存活，请手动检查');
  return { stopped: gone, count: pids.length };
}

/** 每日定时的自动停止：优先复用夜间守护脚本（它自带窗口/日期/忽略文件校验与通知） */
function scheduledStop() {
  if (fs.existsSync(GUARD_SCRIPT)) {
    try {
      spawn('/bin/zsh', [GUARD_SCRIPT], { detached: true, stdio: 'ignore' }).unref();
      log('已调用夜间守护脚本停止客户端');
      return { via: 'script' };
    } catch (e) { log('守护脚本调用失败，改用内置逻辑:', e.message); }
  }
  return stopClient();
}

function enableClient() {
  try {
    execSync('/usr/bin/open -a ZCode 2>&1', { timeout: 10000, encoding: 'utf8' });
    log('已拉起 ZCode 客户端');
    return { ok: true };
  } catch (e) {
    const msg = String((e.stdout || '') + (e.stderr || '') || e.message).trim().slice(0, 200);
    log('拉起客户端失败:', msg);
    return { ok: false, error: msg || e.message };
  }
}

// 每日定时守护 + 执行时段门控
const guardState = { stopLastDate: '', enableLastDate: '', lastWindowOpen: true };
function guardTick() {
  const d = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = d.toISOString().slice(0, 10);
  if (settings.autoStopEnabled && hhmm === settings.autoStopTime && guardState.stopLastDate !== today) {
    guardState.stopLastDate = today;
    log('⏰ 自动停止客户端触发');
    paused = true;
    clearTimeout(nextTimer);
    scheduledStop();
    broadcast();
  }
  if (settings.autoEnableEnabled && hhmm === settings.autoEnableTime && guardState.enableLastDate !== today) {
    guardState.enableLastDate = today;
    log('⏰ 自动启用客户端触发');
    enableClient();
    // 给客户端一点启动时间再恢复队列
    setTimeout(() => { paused = false; broadcast(); kick(); }, 60 * 1000);
    broadcast();
  }
  // 执行时段切换沿：进入时段自动开跑，离开时段停止派发新任务
  const win = executionWindowOpen();
  if (win !== guardState.lastWindowOpen) {
    guardState.lastWindowOpen = win;
    log(win ? `▶ 进入预约执行时段（${settings.scheduleStart}–${settings.scheduleEnd}）` : `⏳ 离开预约执行时段，新任务暂停派发`);
    broadcast();
    if (win) kick();
  } else if (win && !paused && !current) {
    kick(); // 时段内每 15 秒兜底检查（比如手动加了新任务时正好没触发）
  }
}

// ---------------------------------------------------------------- 广播（SSE）

function publicState() {
  return {
    paused,
    settings: {
      intervalSec: settings.intervalSec,
      stopOnFail: settings.stopOnFail,
      defaultTimeoutMin: settings.defaultTimeoutMin,
      plan: settings.plan,
      model: settings.model,
      continuePrompt: settings.continuePrompt,
      completionMarker: settings.completionMarker,
      maxRounds: settings.maxRounds,
      stallMin: settings.stallMin,
      autoStopEnabled: settings.autoStopEnabled,
      autoStopTime: settings.autoStopTime,
      autoEnableEnabled: settings.autoEnableEnabled,
      autoEnableTime: settings.autoEnableTime,
      focusOnDispatch: settings.focusOnDispatch,
      scheduleEnabled: settings.scheduleEnabled,
      scheduleStart: settings.scheduleStart,
      scheduleEnd: settings.scheduleEnd,
      windowOpen: executionWindowOpen(),
    },
    plans: PLANS,
    planModels,
    clientTasks,
    clientTasksError,
    clientPathsFound: Boolean(clientPaths.indexDb && clientPaths.sessionDb),
    guardScriptFound: fs.existsSync(GUARD_SCRIPT),
    clientRunning: current ? true : undefined,
    runningId: current ? current.taskId : null,
    runningElapsedSec: current ? Math.round((now() - current.startedAt) / 1000) : 0,
    tasks: tasks.map((t) => ({
      ...t,
      logs: undefined,
      logTail: (t.logs || []).slice(-3),
    })),
  };
}

function broadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    const data = `data: ${JSON.stringify(publicState())}\n\n`;
    for (const res of sseClients) { try { res.write(data); } catch { sseClients.delete(res); } }
  }, 150);
}

// ---------------------------------------------------------------- 队列调度

function pendingTasks() {
  return tasks.filter((t) => t.status === TASK_STATUS.PENDING);
}

function scheduleNext(delaySec) {
  clearTimeout(nextTimer);
  if (paused) return;
  if (pendingTasks().length) nextTimer = setTimeout(startNext, Math.max(0, delaySec * 1000));
}

function kick() {
  if (!current && !paused && pendingTasks().length) scheduleNext(0);
}

/** 当前是否处于预约执行时段（未启用时段分流时恒为 true；起止相同视为全天） */
function executionWindowOpen() {
  if (!settings.scheduleEnabled) return true;
  const d = new Date();
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const { scheduleStart: s, scheduleEnd: e } = settings;
  if (!/^\d{1,2}:\d{2}$/.test(s) || !/^\d{1,2}:\d{2}$/.test(e) || s === e) return true;
  const norm = (x) => x.split(':').map((n) => n.padStart(2, '0')).join(':');
  const [ss, ee, tt] = [norm(s), norm(e), norm(t)];
  if (ss < ee) return tt >= ss && tt <= ee;      // 同日窗口，如 01:00–08:00
  return tt >= ss || tt <= ee;                   // 跨午夜窗口，如 23:00–09:00
}

let bypassWindowOnce = false; // 「立即执行」用：无视一次执行时段限制

function startNext() {
  if (current || paused) return;
  const bypass = bypassWindowOnce;
  if (!executionWindowOpen() && !bypass) {
    if (pendingTasks().length) {
      log(`⏳ 未到预约执行时段（${settings.scheduleStart}–${settings.scheduleEnd}），任务保持排队`);
      broadcast();
    }
    return; // guardTick 每 15 秒检查一次，进入时段后自动 kick
  }
  bypassWindowOnce = false;
  const next = pendingTasks()[0];
  if (next) runTask(next);
}

function pushLog(task, line) {
  if (!task.logs) task.logs = [];
  task.logs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}`);
  if (task.logs.length > 800) task.logs.splice(0, task.logs.length - 800);
}

// ---- 客户端任务（新任务 / 续跑）的轮询推进 ----

function pollClientTask(task) {
  const st = queryAutomation(task.automationId);
  if (st.phase === 'dispatch-failed') {
    finishTask(task, TASK_STATUS.FAILED, null, '客户端派发失败: ' + st.error);
    return;
  }
  if (st.phase !== 'tracked') return; // 数据库暂时读不到，等下一轮

  if (st.sessionId && !current.dispatchedAt) {
    current.dispatchedAt = now();
    task.sessionId = st.sessionId;
    current.baselineMsgTime = lastMessageTime(st.sessionId) - 1; // 只认派发之后的新消息
    pushLog(task, `客户端已接单，会话 ${st.sessionId}${task.type === 'continue' ? '（续跑）' : ''}`);
  }

  if (st.sessionId) {
    const { lastActivity, toolRunning, todos } = sessionStatus(st.sessionId);
    task.usage.turns = todos ? todos.total : task.usage.turns;
    task.activity = (task.round > 1 ? `第 ${task.round} 轮 · ` : '') + (lastActivity || '客户端执行中…');
    const newText = assistantTextSince(st.sessionId, current.baselineMsgTime || 0);
    if (newText && newText.includes(settings.completionMarker) && !toolRunning) {
      task.result = newText.slice(0, 2000);
      pushLog(task, '✅ 检测到完成标记，任务完成');
      finishTask(task, TASK_STATUS.DONE, 0, null);
      return;
    }
    // 卡住检测：已接单、outcome 还是 running，但会话长时间没有任何新输出
    if (current.dispatchedAt && st.outcome === 'running') {
      const stallMs = Math.max(3, settings.stallMin || 15) * 60 * 1000;
      const lastUpdate = lastSessionUpdate(st.sessionId);
      if (lastUpdate && now() - lastUpdate > stallMs) {
        finishTask(task, TASK_STATUS.FAILED, null,
          `会话超过 ${settings.stallMin || 15} 分钟无输出（模型请求疑似挂起），已放弃等待`);
        return;
      }
    }
  }

  // 接单超时
  if (!st.sessionId && now() - current.startedAt > DISPATCH_WAIT_MS) {
    finishTask(task, TASK_STATUS.FAILED, null, '客户端长时间未接单（ZCode 客户端是否在运行？）');
    return;
  }

  // 一轮结束（outcome 终态）但没收到完成标记 → 下一轮继续推
  if (st.outcome && st.outcome !== 'running' && st.outcome !== 'succeeded') {
    finishTask(task, TASK_STATUS.FAILED, null, '客户端执行失败: ' + (st.runError || st.outcome));
    return;
  }
  if (st.outcome === 'succeeded' && current.dispatchedAt) {
    // 已接单且本轮跑完；消息写入可能有延迟，若确无新文本再开下一轮
    const newText = assistantTextSince(st.sessionId, current.baselineMsgTime || 0);
    if (!newText) {
      // 稍等 5 秒再确认一次
      if (!current.roundEndGrace) { current.roundEndGrace = now() + 5000; return; }
      if (now() < current.roundEndGrace) return;
    }
    current.roundEndGrace = null;
    nextRound(task);
  }
}

function nextRound(task) {
  if (task.type === 'continue' && task.round >= settings.maxRounds) {
    finishTask(task, TASK_STATUS.FAILED, null, `已达最大续跑轮数（${settings.maxRounds}）仍未收到「${settings.completionMarker}」标记`);
    return;
  }
  if (task.type !== 'continue') {
    // 新任务跑完一轮即结束（找不到完成标记也如实标注）
    finishTask(task, TASK_STATUS.DONE, 0, null);
    return;
  }
  const round = (task.round || 0) + 1;
  pushLog(task, `本轮跑完未见完成标记，${settings.intervalSec} 秒后发起第 ${round + 1} 轮推进`);
  cleanupAutomation(task.automationId);
  task.automationId = null;
  current.automationId = null;
  current.dispatchedAt = null;
  current.roundEndGrace = null;
  task.round = round;
  task.activity = `等待第 ${round + 1} 轮推进…`;
  persist(); broadcast();
  setTimeout(() => {
    if (!current || current.taskId !== task.id) return;
    try {
      const ws = taskWorkspace(task.targetSessionId, task.cwd);
      task.automationId = insertClientAutomation({
        title: task.name,
        prompt: settings.continuePrompt,
        workspace: ws,
        targetTaskId: task.type === 'continue' ? task.targetSessionId : undefined,
        modelRef: modelRef(),
      });
      current.automationId = task.automationId;
      task.status = TASK_STATUS.WAIT_DISPATCH;
      pushLog(task, `第 ${round + 1} 轮已排入客户端`);
    } catch (e) {
      finishTask(task, TASK_STATUS.FAILED, null, e.message);
      return;
    }
    persist(); broadcast();
  }, Math.max(1, settings.intervalSec) * 1000);
}

function runTask(task) {
  task.status = TASK_STATUS.RUNNING;
  task.startedAt = now();
  task.finishedAt = null;
  task.exitCode = null;
  task.error = null;
  task.result = null;
  task.sessionId = null;
  task.automationId = null;
  task.round = 0;
  task.usage = { turns: 0, events: 0 };
  if (!task.logs) task.logs = [];
  persist(); broadcast();

  const timeoutMin = task.timeoutMin != null ? task.timeoutMin : settings.defaultTimeoutMin;

  if (task.type === 'shell') {
    task.activity = '执行命令…';
    let child;
    try {
      child = spawn('/bin/zsh', ['-lc', task.prompt], { cwd: fs.existsSync(task.cwd || '') ? task.cwd : ROOT });
    } catch (e) {
      finishTask(task, TASK_STATUS.FAILED, null, '进程启动失败: ' + e.message);
      return;
    }
    current = { taskId: task.id, kind: 'shell', child, startedAt: now(), timeoutHandle: null };

    if (timeoutMin > 0) {
      current.timeoutHandle = setTimeout(() => {
        pushLog(task, `[超时] 已运行 ${timeoutMin} 分钟，强制终止`);
        task.error = `超时（${timeoutMin} 分钟）`;
        task.status = TASK_STATUS.TIMEOUT;
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
      }, timeoutMin * 60 * 1000);
    }

    let buf = '';
    const onLine = (line, isErr) => {
      line = line.trim(); if (!line) return;
      pushLog(task, (isErr ? '[stderr] ' : '') + line);
      if (isErr) task.activity = line.slice(0, 200);
    };
    child.stdout.on('data', (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i), false); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', (d) => { for (const l of d.toString().split('\n')) onLine(l, true); });
    child.on('error', (e) => {
      if (current && current.taskId === task.id) { clearTimeout(current.timeoutHandle); current = null; }
      finishTask(task, TASK_STATUS.FAILED, null, '进程错误: ' + e.message);
    });
    child.on('close', (code, signal) => {
      if (!current || current.taskId !== task.id) return;
      clearTimeout(current.timeoutHandle);
      current = null;
      if (buf.trim()) onLine(buf, false);
      let status = code === 0 ? TASK_STATUS.DONE : TASK_STATUS.FAILED;
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        status = task.status === TASK_STATUS.TIMEOUT ? TASK_STATUS.TIMEOUT : TASK_STATUS.STOPPED;
      }
      finishTask(task, status, code, task.error || (status === TASK_STATUS.FAILED ? `退出码 ${code}` : null));
    });
  } else {
    // ---- ZCode 客户端任务：新任务 or 续跑已有会话 ----
    let ws;
    try {
      ws = task.type === 'continue'
        ? taskWorkspace(task.targetSessionId, task.cwd)
        : (fs.existsSync(task.cwd || '') ? task.cwd : ROOT);
      task.automationId = insertClientAutomation({
        title: task.name,
        prompt: task.type === 'continue' ? settings.continuePrompt : task.prompt,
        workspace: ws,
        targetTaskId: task.type === 'continue' ? task.targetSessionId : undefined,
        // 统一用用户选的套餐模型。续跑若沿用会话快照里的旧模型，客户端会在
        // 该模型已下架时直接拒绝派发（实测报“当前会话使用的模型已不可用”）；
        // 显式指定当前可用模型则客户端允许以新模型恢复该会话。
        modelRef: modelRef(),
      });
    } catch (e) {
      finishTask(task, TASK_STATUS.FAILED, null, e.message);
      return;
    }
    task.activity = task.type === 'continue' ? '已排入客户端，等待续跑接单…' : '已排入客户端，等待接单…';
    task.status = TASK_STATUS.WAIT_DISPATCH;
    current = { taskId: task.id, kind: 'client', startedAt: now(), timeoutHandle: null, pollHandle: null, automationId: task.automationId, dispatchedAt: null, baselineMsgTime: 0 };

    // 可选：把客户端切到对应工作区，方便点开该会话围观进度
    if (settings.focusOnDispatch) {
      try {
        execSync(`open "zcode://workspace/open?path=${encodeURIComponent(ws)}"`, { timeout: 5000, stdio: 'ignore' });
      } catch (e) { log('聚焦工作区失败:', e.message); }
    }

    if (timeoutMin > 0) {
      current.timeoutHandle = setTimeout(() => {
        task.error = `超时（${timeoutMin} 分钟，客户端任务不会被终止，将继续在客户端运行）`;
        finishTask(task, TASK_STATUS.TIMEOUT, null, task.error);
      }, timeoutMin * 60 * 1000);
    }

    current.pollHandle = setInterval(() => {
      try { pollClientTask(task); } catch (e) { log('轮询异常:', e.message); }
    }, 2000);
  }
  persist(); broadcast();
}

function finishTask(task, status, exitCode, error) {
  if (current && current.taskId === task.id) {
    clearTimeout(current.timeoutHandle);
    clearInterval(current.pollHandle);
    current = null;
  }
  if (task.automationId) cleanupAutomation(task.automationId);

  task.status = status;
  task.exitCode = exitCode;
  task.finishedAt = now();
  if (error) task.error = error;
  log(`■ 任务 [${task.name}] 结束: ${status}${error ? ' (' + String(error).slice(0, 100) + ')' : ''}`);
  persist(); broadcast();

  if (status !== TASK_STATUS.DONE && settings.stopOnFail) {
    paused = true;
    log('任务失败，按设置自动暂停队列');
    return;
  }
  scheduleNext(settings.intervalSec || 0);
}

function stopCurrent() {
  if (!current) return;
  const task = tasks.find((t) => t.id === current.taskId);
  if (!task) return;
  if (current.kind === 'shell') {
    task.activity = '手动停止中…';
    const { child } = current;
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
  } else {
    const aid = current.automationId;
    if (aid && !current.dispatchedAt) cleanupAutomation(aid);
    finishTask(task, TASK_STATUS.STOPPED, null,
      current.dispatchedAt ? '已停止推进；会话将继续在客户端里保留' : '已撤销（客户端尚未接单）');
  }
}

// ---------------------------------------------------------------- HTTP 服务

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function addTask(fields) {
  const { name, type = 'continue', prompt, cwd, timeoutMin = null, targetSessionId = null, targetTitle = null } = fields;
  if (type === 'continue' && !targetSessionId) throw new Error('续跑任务需要 targetSessionId');
  if (type !== 'continue' && (!prompt || !String(prompt).trim())) throw new Error('任务内容不能为空');
  if (!['continue', 'zcode', 'shell'].includes(type)) throw new Error('未知任务类型');
  const task = {
    id: genId(),
    name: (name || '').trim() || (type === 'continue' ? (targetTitle || '续跑会话') : String(prompt).trim().split('\n')[0].slice(0, 40)) || '未命名任务',
    type,
    prompt: type === 'continue' ? settings.continuePrompt : String(prompt || ''),
    cwd: (cwd || '').trim() || null,
    targetSessionId,
    targetTitle,
    timeoutMin: timeoutMin != null && Number(timeoutMin) > 0 ? Number(timeoutMin) : null,
    status: TASK_STATUS.PENDING,
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
    result: null,
    activity: '',
    sessionId: null,
    automationId: null,
    round: 0,
    usage: { turns: 0, events: 0 },
  };
  tasks.push(task);
  return task;
}

async function handleAPI(req, res, pathname) {
  const seg = pathname.split('/').filter(Boolean);

  if (pathname === '/api/state' && req.method === 'GET') return sendJSON(res, 200, publicState());

  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(publicState())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (pathname === '/api/tasks/log' && req.method === 'GET') {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const t = tasks.find((x) => x.id === id);
    return sendJSON(res, 200, { id, logs: t ? t.logs || [] : [] });
  }

  if (pathname === '/api/tasks' && req.method === 'POST') {
    const body = await readBody(req);
    const created = [];
    const batch = body.batch && String(body.batch).trim();
    if (batch) {
      const lines = batch.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!lines.length) return sendJSON(res, 400, { error: '没有可用内容' });
      for (const line of lines) created.push(addTask({ type: body.type === 'shell' ? 'shell' : 'zcode', prompt: line, cwd: body.cwd, timeoutMin: body.timeoutMin }));
    } else {
      created.push(addTask(body));
    }
    persist(); broadcast(); kick();
    return sendJSON(res, 200, { ok: true, created: created.length, ids: created.map((t) => t.id) });
  }

  // ---- 续跑：把客户端已有会话加入队列 ----
  if (seg[0] === 'api' && seg[1] === 'client-tasks' && seg[2] === 'continue' && req.method === 'POST') {
    const { sessionId } = await readBody(req);
    const info = clientTasks.find((t) => t.sessionId === sessionId);
    if (!info) return sendJSON(res, 404, { error: '会话不在最近列表里' });
    let task;
    try {
      task = addTask({ type: 'continue', targetSessionId: sessionId, targetTitle: info.title, cwd: info.directory });
    } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    persist(); broadcast(); kick();
    return sendJSON(res, 200, { ok: true, id: task.id, name: task.name });
  }

  // ---- 隐藏客户端会话（面板内即时生效，不写入客户端；客户端归档落盘后本来也会消失）----
  if (seg[0] === 'api' && seg[1] === 'client-tasks' && seg[2] === 'hide' && req.method === 'POST') {
    const { sessionId } = await readBody(req);
    if (!sessionId) return sendJSON(res, 400, { error: '缺少 sessionId' });
    if (!settings.hiddenSessions.includes(sessionId)) settings.hiddenSessions.push(sessionId);
    if (settings.hiddenSessions.length > 200) settings.hiddenSessions = settings.hiddenSessions.slice(-200);
    clientTasks = clientTasks.filter((t) => t.sessionId !== sessionId);
    persist(); broadcast();
    return sendJSON(res, 200, { ok: true });
  }

  // ---- 导入为新任务 ----
  if (seg[0] === 'api' && seg[1] === 'client-tasks' && seg[2] === 'import' && req.method === 'POST') {
    const { sessionId } = await readBody(req);
    if (!sessionId) return sendJSON(res, 400, { error: '缺少 sessionId' });
    const info = clientTasks.find((t) => t.sessionId === sessionId);
    let prompt = '';
    try { prompt = clientSessionPrompt(sessionId); } catch (e) { return sendJSON(res, 500, { error: e.message }); }
    if (!prompt) return sendJSON(res, 400, { error: '该会话没有可提取的用户提示词' });
    const task = addTask({
      name: info ? info.title : '导入任务',
      type: 'zcode',
      prompt,
      cwd: info ? info.directory : '',
    });
    persist(); broadcast(); kick();
    return sendJSON(res, 200, { ok: true, id: task.id, name: task.name });
  }

  if (seg[0] === 'api' && seg[1] === 'queue' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.action === 'pause') { paused = true; clearTimeout(nextTimer); log('⏸ 队列已暂停'); }
    else if (body.action === 'resume') { paused = false; log('▶ 队列已恢复'); kick(); }
    else if (body.action === 'clearFinished') {
      tasks = tasks.filter((t) => ![TASK_STATUS.DONE, TASK_STATUS.FAILED, TASK_STATUS.STOPPED, TASK_STATUS.TIMEOUT].includes(t.status));
    }
    else if (body.action === 'stopCurrent') stopCurrent();
    else return sendJSON(res, 400, { error: '未知操作' });
    persist(); broadcast();
    return sendJSON(res, 200, { ok: true });
  }

  // ---- 守护：手动停止/启用客户端 ----
  if (seg[0] === 'api' && seg[1] === 'guard' && req.method === 'POST') {
    const { action, dryRun } = await readBody(req);
    if (action === 'stopClient') {
      const r = stopClient(Boolean(dryRun));
      // 手动停止 = 明确意图：不受守护脚本时间窗限制，并同步暂停队列
      if (!dryRun && r.stopped !== false) {
        paused = true;
        clearTimeout(nextTimer);
        log('队列已随客户端停止而暂停');
        broadcast();
      }
      return sendJSON(res, 200, { ...r, queuePaused: paused });
    }
    if (action === 'enableClient') {
      const r = enableClient();
      return sendJSON(res, 200, r);
    }
    return sendJSON(res, 400, { error: '未知操作' });
  }

  if (seg[0] === 'api' && seg[1] === 'tasks' && seg[2] && seg[3] === 'action' && req.method === 'POST') {
    const id = seg[2];
    const { action } = await readBody(req);
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx < 0) return sendJSON(res, 404, { error: '任务不存在' });
    const t = tasks[idx];

    if (action === 'remove') {
      if (t.status === TASK_STATUS.RUNNING || t.status === TASK_STATUS.WAIT_DISPATCH) {
        return sendJSON(res, 400, { error: '任务正在执行，请先停止' });
      }
      tasks.splice(idx, 1);
    } else if (action === 'up' || action === 'down') {
      const cur = tasks.indexOf(t);
      const target = action === 'up' ? cur - 1 : cur + 1;
      if (target >= 0 && target < tasks.length && tasks[target].status === TASK_STATUS.PENDING && t.status === TASK_STATUS.PENDING) {
        [tasks[cur], tasks[target]] = [tasks[target], tasks[cur]];
      }
    } else if (action === 'top') {
      if (t.status === TASK_STATUS.PENDING) {
        tasks.splice(idx, 1);
        const firstPendingIdx = tasks.findIndex((x) => x.status === TASK_STATUS.PENDING);
        tasks.splice(firstPendingIdx < 0 ? tasks.length : firstPendingIdx, 0, t);
      }
    } else if (action === 'retry') {
      if (t.status === TASK_STATUS.RUNNING || t.status === TASK_STATUS.WAIT_DISPATCH) {
        return sendJSON(res, 400, { error: '任务正在执行' });
      }
      const copy = { ...t, id: genId(), status: TASK_STATUS.PENDING, createdAt: now(), startedAt: null, finishedAt: null, exitCode: null, error: null, result: null, sessionId: null, automationId: null, round: 0 };
      const lastPending = tasks.map((x) => x.status === TASK_STATUS.PENDING).lastIndexOf(true);
      tasks.splice(lastPending < 0 ? tasks.length : lastPending + 1, 0, copy);
    } else if (action === 'runNow') {
      if (current) return sendJSON(res, 400, { error: '已有任务在执行，请先停止或等待完成' });
      if (t.status === TASK_STATUS.RUNNING || t.status === TASK_STATUS.WAIT_DISPATCH) {
        return sendJSON(res, 400, { error: '任务已在执行' });
      }
      if (t.status !== TASK_STATUS.PENDING) {
        const copy = { ...t, id: genId(), status: TASK_STATUS.PENDING, createdAt: now(), startedAt: null, finishedAt: null, exitCode: null, error: null, sessionId: null, automationId: null, round: 0 };
        tasks.splice(tasks.indexOf(t) + 1, 0, copy);
      } else {
        tasks.splice(idx, 1);
        const firstPendingIdx = tasks.findIndex((x) => x.status === TASK_STATUS.PENDING);
        tasks.splice(firstPendingIdx < 0 ? tasks.length : firstPendingIdx, 0, t);
      }
      clearTimeout(nextTimer);
      bypassWindowOnce = true; // 用户显式点了立即执行，忽略时段限制一次
      scheduleNext(0);
    } else return sendJSON(res, 400, { error: '未知操作' });

    persist(); broadcast(); kick();
    return sendJSON(res, 200, { ok: true });
  }

  // ---- 设置 ----
  if (pathname === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.intervalSec != null) settings.intervalSec = Math.max(0, Number(body.intervalSec) || 0);
    if (body.stopOnFail != null) settings.stopOnFail = Boolean(body.stopOnFail);
    if (body.defaultTimeoutMin != null) settings.defaultTimeoutMin = Math.max(0, Number(body.defaultTimeoutMin) || 0);
    if (body.plan != null && PLANS[body.plan]) settings.plan = body.plan;
    if (body.model != null && String(body.model).trim()) settings.model = String(body.model).trim();
    if (body.continuePrompt != null && String(body.continuePrompt).trim()) settings.continuePrompt = String(body.continuePrompt).trim();
    if (body.completionMarker != null && String(body.completionMarker).trim()) settings.completionMarker = String(body.completionMarker).trim();
    if (body.maxRounds != null) settings.maxRounds = Math.min(200, Math.max(1, Number(body.maxRounds) || 1));
    if (body.stallMin != null) settings.stallMin = Math.min(180, Math.max(3, Number(body.stallMin) || 15));
    if (body.autoStopEnabled != null) settings.autoStopEnabled = Boolean(body.autoStopEnabled);
    if (body.autoStopTime != null && /^\d{1,2}:\d{2}$/.test(body.autoStopTime)) settings.autoStopTime = body.autoStopTime;
    if (body.autoEnableEnabled != null) settings.autoEnableEnabled = Boolean(body.autoEnableEnabled);
    if (body.autoEnableTime != null && /^\d{1,2}:\d{2}$/.test(body.autoEnableTime)) settings.autoEnableTime = body.autoEnableTime;
    if (body.focusOnDispatch != null) settings.focusOnDispatch = Boolean(body.focusOnDispatch);
    if (body.scheduleEnabled != null) settings.scheduleEnabled = Boolean(body.scheduleEnabled);
    if (body.scheduleStart != null && /^\d{1,2}:\d{2}$/.test(body.scheduleStart)) settings.scheduleStart = body.scheduleStart;
    if (body.scheduleEnd != null && /^\d{1,2}:\d{2}$/.test(body.scheduleEnd)) settings.scheduleEnd = body.scheduleEnd;
    guardState.lastWindowOpen = executionWindowOpen();
    if (guardState.lastWindowOpen) kick();
    persist(); broadcast();
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { error: 'not found' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (pathname.startsWith('/api/')) {
      // 本机 API 防护：写操作必须携带自定义头（浏览器跨站请求无法伪造），
      // 且 Origin 若存在必须是本机来源，防止恶意网页触发停止客户端/派发任务等操作
      if (req.method === 'POST') {
        if (req.headers['x-ztq-local'] !== '1') {
          return sendJSON(res, 403, { error: '本机 API 防护：POST 请求缺少 X-ZTQ-Local 头' });
        }
      }
      const origin = req.headers['origin'];
      if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
        return sendJSON(res, 403, { error: '本机 API 防护：拒绝跨站来源 ' + origin });
      }
      return await handleAPI(req, res, pathname);
    }
    let file = pathname === '/' ? '/index.html' : pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    try {
      const data = fs.readFileSync(full);
      // 页面与脚本禁止缓存，避免浏览器拿着旧 JS 与新接口不兼容
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
    }
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
});

// ---------------------------------------------------------------- 启动

loadPersisted();
readClientTasks();
setInterval(() => {
  const before = JSON.stringify(clientTasks);
  readClientTasks();
  if (JSON.stringify(clientTasks) !== before) broadcast();
}, 3000);
setInterval(guardTick, 15000);

server.listen(PORT, HOST, () => {
  log(`ZCode 任务队列已启动: http://${HOST}:${PORT}`);
  log(`客户端任务索引库: ${clientPaths.indexDb || '未找到'}`);
  log(`客户端会话库: ${clientPaths.sessionDb || '未找到'}`);
  log(`套餐模型: ${Object.entries(planModels).map(([p, ms]) => `${PLANS[p].label}=[${ms.join('/')}]`).join('  ')}`);
  log(`任务数: ${tasks.length}，等待中: ${pendingTasks().length}，队列状态: ${paused ? '暂停' : '运行'}`);
  kick();
});

process.on('SIGINT', () => { log('退出'); process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });
