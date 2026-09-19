'use strict';

const $ = (id) => document.getElementById(id);
const STATUS_TEXT = {
  pending: '等待中', waiting: '等待接单', running: '执行中', attention: '需确认',
  done: '已完成', failed: '失败', stopped: '已停止', timeout: '超时',
  completed: '已完成', error: '出错', idle: '空闲', stuck: '疑似卡住',
};
const TYPE_TEXT = { continue: '续跑会话', zcode: 'ZCode 新任务', shell: 'Shell' };
const TERMINAL = new Set(['done', 'failed', 'stopped', 'timeout']);
const TOKEN_STORAGE_KEY = 'zcode-task-queue.api-token';
const UNCERTAIN_STORAGE_KEY = 'zcode-task-queue.uncertain-operations.v2';
const LEGACY_UNCERTAIN_STORAGE_KEY = 'zcode-task-queue.uncertain-operations.v1';
const MAX_UNCERTENT_OPERATIONS = 500;
const guardFieldMap = {
  'schedule-enabled': 'scheduleEnabled',
  'schedule-start': 'scheduleStart',
  'schedule-end': 'scheduleEnd',
  'auto-stop-enabled': 'autoStopEnabled',
  'auto-stop-time': 'autoStopTime',
  'auto-enable-enabled': 'autoEnableEnabled',
  'auto-enable-time': 'autoEnableTime',
  'focus-on-dispatch': 'focusOnDispatch',
};

let state = null;
let instanceId = null;
let lastRevision = -1;
let connection = 'connecting';
let eventSource = null;
let reconnectTimer = null;
let pollTimer = null;
let pollDelay = 2000;
let notificationTimer = null;
let undoTimer = null;
let undoHandler = null;
let logTimer = null;
let logAbort = null;
let logTaskId = null;
let detailAbort = null;
let detailGeneration = 0;
let confirmHandler = null;
let confirmCancelHandler = null;
let guardDirty = false;
let guardBase = null;
let guardRefreshPending = false;
let settingsBase = null;
let apiToken = null;
let historyItems = [];
let trashItems = [];
let historyCursor = null;
let trashCursor = null;
let collectionRetryTimer = null;
let collectionRetryDelay = 1000;
let collectionRefreshGeneration = 0;
let collectionCounts = { history: -1, trash: -1 };
const collectionGeneration = { history: 0, trash: 0 };
let currentSignature = '';
let pendingSignature = '';
let sessionSignature = '';
const pendingOperations = new Map();
let uncertainStorageError = null;
const uncertainOperations = loadUncertainOperations();

function validApiToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,200}$/.test(value);
}

function operationFingerprint(path, body) {
  const value = JSON.stringify([path, body]);
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
    right ^= right >>> 13;
  }
  return `${value.length}:${(left >>> 0).toString(16).padStart(8, '0')}:${(right >>> 0).toString(16).padStart(8, '0')}`;
}

function uncertainIdentity(operation, fingerprint) {
  return `${operation}\n${fingerprint}`;
}

function parseUncertainOperations(raw) {
  const output = new Map();
  const parsed = JSON.parse(raw || '[]');
  if (!Array.isArray(parsed)) throw new Error('invalid uncertain operation store');
  for (const entry of parsed) {
    if (!entry || typeof entry.operation !== 'string' || !entry.operation || entry.operation.length > 500) continue;
    if (typeof entry.key !== 'string' || !entry.key || entry.key.length > 200) continue;
    if (typeof entry.fingerprint !== 'string' || !entry.fingerprint || entry.fingerprint.length > 100) continue;
    const firstSeenAt = Number(entry.firstSeenAt ?? entry.storedAt);
    if (!Number.isFinite(firstSeenAt) || firstSeenAt <= 0) continue;
    output.set(uncertainIdentity(entry.operation, entry.fingerprint), {
      operation: entry.operation,
      key: entry.key,
      fingerprint: entry.fingerprint,
      firstSeenAt,
      firstRevision: Number.isFinite(entry.firstRevision) ? entry.firstRevision : null,
      instanceId: typeof entry.instanceId === 'string' ? entry.instanceId : null,
    });
  }
  return output;
}

function loadUncertainOperations() {
  try {
    const current = localStorage.getItem(UNCERTAIN_STORAGE_KEY);
    if (current != null) {
      const loaded = parseUncertainOperations(current);
      uncertainStorageError = null;
      return loaded;
    }
    const legacy = sessionStorage.getItem(LEGACY_UNCERTAIN_STORAGE_KEY);
    if (legacy == null) {
      uncertainStorageError = null;
      return new Map();
    }
    const migrated = parseUncertainOperations(legacy);
    localStorage.setItem(UNCERTAIN_STORAGE_KEY, JSON.stringify([...migrated.values()]));
    sessionStorage.removeItem(LEGACY_UNCERTAIN_STORAGE_KEY);
    uncertainStorageError = null;
    return migrated;
  } catch (error) {
    uncertainStorageError = `无法读取安全重试记录：${error.message || error}`;
    return new Map();
  }
}

function persistUncertainOperations() {
  const entries = [...uncertainOperations.values()];
  try {
    if (entries.length > MAX_UNCERTENT_OPERATIONS) {
      // FIFO eviction: remove oldest entries
      const toRemove = entries.length - MAX_UNCERTENT_OPERATIONS;
      for (let i = 0; i < toRemove; i++) {
        const firstKey = Array.from(uncertainOperations.keys())[0];
        uncertainOperations.delete(firstKey);
      }
    }
    
    if (entries.length) localStorage.setItem(UNCERTAIN_STORAGE_KEY, JSON.stringify([...uncertainOperations.values()]));
    else localStorage.removeItem(UNCERTAIN_STORAGE_KEY);
    try { sessionStorage.removeItem(LEGACY_UNCERTAIN_STORAGE_KEY); } catch {}
    uncertainStorageError = null;
    return true;
  } catch (error) {
    uncertainStorageError = `无法保存安全重试记录：${error.message || error}`;
    return false;
  }
}

function reloadUncertainOperations() {
  const fresh = loadUncertainOperations();
  if (uncertainStorageError) return false;
  uncertainOperations.clear();
  for (const [identity, value] of fresh) uncertainOperations.set(identity, value);
  return true;
}

function rememberUncertainOperation(operation, key, fingerprint, firstSeenAt = Date.now()) {
  const identity = uncertainIdentity(operation, fingerprint);
  const previous = uncertainOperations.get(identity);
  uncertainOperations.set(identity, {
    operation,
    key,
    fingerprint,
    firstSeenAt,
    firstRevision: previous ? previous.firstRevision : state && Number.isFinite(state.revision) ? state.revision : null,
    instanceId: previous ? previous.instanceId : instanceId,
  });
  if (persistUncertainOperations()) return;
  if (previous) uncertainOperations.set(identity, previous);
  else uncertainOperations.delete(identity);
  throw new Error(`${uncertainStorageError}；为防止重复执行，本次请求未发送`);
}

function forgetUncertainOperation(operation, fingerprint) {
  const identity = uncertainIdentity(operation, fingerprint);
  const previous = uncertainOperations.get(identity);
  if (!previous) return;
  uncertainOperations.delete(identity);
  if (!persistUncertainOperations()) uncertainOperations.set(identity, previous);
}

function captureApiToken() {
  let stored = null;
  try { stored = sessionStorage.getItem(TOKEN_STORAGE_KEY); } catch {}
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (params.has('token')) {
    const supplied = params.get('token');
    stored = validApiToken(supplied) ? supplied : null;
    try {
      if (stored) sessionStorage.setItem(TOKEN_STORAGE_KEY, stored);
      else sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {}
    // Fragments are not sent to the server. Remove the secret from the address
    // bar and browser history as soon as it has been copied into this tab.
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  }
  return validApiToken(stored) ? stored : null;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`;
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.testId) node.dataset.testid = options.testId;
  if (options.dataset) for (const [key, value] of Object.entries(options.dataset)) node.dataset[key] = String(value);
  if (options.attrs) for (const [key, value] of Object.entries(options.attrs)) {
    if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) if (child) node.append(child);
  return node;
}

function notify(message) {
  const region = $('notification-region');
  region.textContent = message;
  region.classList.add('is-visible');
  clearTimeout(notificationTimer);
  notificationTimer = setTimeout(() => region.classList.remove('is-visible'), 3500);
}

function showUndo(message, handler) {
  clearTimeout(undoTimer);
  undoHandler = handler;
  $('undo-message').textContent = message;
  $('undo-toast').hidden = false;
  armUndoExpiry(handler);
}

function armUndoExpiry(handler) {
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    if (undoHandler !== handler) return;
    $('undo-toast').hidden = true;
    undoHandler = null;
    undoTimer = null;
  }, 10000);
}

function operationKey() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function request(path, { method = 'GET', body, key, replayOnly = false, signal } = {}) {
  if (!apiToken) {
    const error = new Error('页面缺少本机 API 令牌，请使用启动器输出的授权链接重新打开');
    error.status = 401;
    error.code = 'AUTH_REQUIRED';
    throw error;
  }
  const options = { method, signal, headers: { Authorization: `Bearer ${apiToken}` } };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.headers['X-ZTQ-Local'] = '1';
    options.body = JSON.stringify(body);
  }
  if (key) options.headers['Idempotency-Key'] = key;
  if (replayOnly) options.headers['Idempotency-Replay-Only'] = '1';
  const response = await fetch(path, options);
  if (response.status === 401) lockAuthorization();
  let value;
  try { value = await response.json(); }
  catch {
    const error = new Error(`服务返回了无法解析的结果 (${response.status})`);
    if (response.status >= 400 && response.status < 500) error.status = response.status;
    else { error.responseStatus = response.status; error.uncertain = true; }
    throw error;
  }
  if (!response.ok || value.error) {
    const error = new Error(value.error || `请求失败 (${response.status})`);
    if (response.status >= 400 && response.status < 500) error.status = response.status;
    else { error.responseStatus = response.status; error.uncertain = true; }
    error.code = value.code;
    throw error;
  }
  return value;
}

function withOperationLock(identity, handler) {
  if (navigator.locks && typeof navigator.locks.request === 'function') {
    return navigator.locks.request(`zcode-task-queue:${identity}`, handler);
  }
  return handler();
}

function confirmAsNewOperation() {
  return new Promise((resolve) => {
    confirmAction(
      '无法安全重放上次操作',
      '上次提交可能已经成功，但服务端已无法返回原结果。请先核对队列、历史和客户端状态；只有确认仍需再执行时，才作为新操作发送。继续可能造成重复。',
      '仍作为新操作发送',
      () => resolve(true),
      () => resolve(false),
    );
  });
}

async function mutate(operation, button, path, body, { idempotent = true } = {}) {
  if (!['online', 'polling'].includes(connection)) throw new Error('服务离线，暂时不能执行写操作');
  const fingerprint = operationFingerprint(path, body);
  const identity = uncertainIdentity(operation, fingerprint);
  if (pendingOperations.has(identity)) return pendingOperations.get(identity);
  const run = (async () => {
    if (button) { button.disabled = true; button.dataset.busy = 'true'; button.setAttribute('aria-busy', 'true'); }
    try {
      return await withOperationLock(identity, async () => {
        if (idempotent && !reloadUncertainOperations()) {
          throw new Error(`${uncertainStorageError}；为防止重复执行，写操作已禁用`);
        }
        const uncertain = idempotent ? uncertainOperations.get(identity) : null;
        let key = idempotent ? uncertain && uncertain.key || operationKey() : null;
        let replayOnly = Boolean(uncertain);
        let hadUnknownOutcome = replayOnly;
        if (key) rememberUncertainOperation(operation, key, fingerprint, uncertain && uncertain.firstSeenAt || Date.now());

        for (;;) {
          try {
            let result;
            try {
              result = await request(path, { method: 'POST', body, key, replayOnly });
            } catch (error) {
              if ((!(error instanceof TypeError) && !error.uncertain) || !key) throw error;
              hadUnknownOutcome = true;
              await new Promise((resolve) => setTimeout(resolve, 250));
              result = await request(path, { method: 'POST', body, key, replayOnly: true });
            }
            forgetUncertainOperation(operation, fingerprint);
            return result;
          } catch (error) {
            if (key && error.code === 'IDEMPOTENCY_REPLAY_UNKNOWN') {
              const approved = await confirmAsNewOperation();
              if (!approved) {
                const cancelled = new Error('本次未发送新操作；上次结果仍需人工核对');
                cancelled.code = 'UNCERTAIN_REPLAY_CANCELLED';
                throw cancelled;
              }
              key = operationKey();
              replayOnly = false;
              hadUnknownOutcome = false;
              rememberUncertainOperation(operation, key, fingerprint, Date.now());
              continue;
            }
            // A first-attempt 4xx proves that request did not commit. Once an
            // earlier response was lost, later errors cannot erase ambiguity.
            if (!key || !hadUnknownOutcome && error.status >= 400 && error.status < 500) {
              forgetUncertainOperation(operation, fingerprint);
            }
            throw error;
          }
        }
      });
    } finally {
      pendingOperations.delete(identity);
      if (button) { delete button.dataset.busy; button.removeAttribute('aria-busy'); }
      syncMutationControls();
    }
  })();
  pendingOperations.set(identity, run);
  return run;
}

function setAvailability(button, available) {
  button.dataset.available = available ? 'true' : 'false';
  button.dataset.mutation = '';
  syncMutationControl(button);
}

function syncMutationControl(button) {
  const storageWritable = !state || !state.storage || state.storage.healthy !== false;
  button.disabled = !['online', 'polling'].includes(connection) || !storageWritable || Boolean(uncertainStorageError) || button.dataset.available === 'false' || button.dataset.busy === 'true';
}

function syncMutationControls() {
  document.querySelectorAll('[data-mutation]').forEach(syncMutationControl);
  const attentionLocked = Boolean(state && state.paused && state.pauseReason && state.pauseReason.kind === 'attention');
  setAvailability($('queue-toggle'), Boolean(state) && !attentionLocked);
  setAvailability($('history-clear'), Boolean(state && state.counts.history));
  setAvailability($('guard-save'), guardDirty && Boolean(state));
}

function renderNotice() {
  const notice = $('global-notice');
  notice.classList.remove('danger');
  if (connection === 'locked') {
    notice.textContent = '页面未授权。请在项目目录运行启动器的 status 命令，并用它输出的完整链接重新打开。';
    notice.classList.add('danger');
    notice.hidden = false;
    return;
  }
  if (!['online', 'polling'].includes(connection)) {
    notice.textContent = state ? '服务连接已中断。页面保留最后一次状态，写操作已禁用，正在重连。' : '无法连接本机服务。正在后台重试；连接恢复前不会执行任何操作。';
    notice.classList.add('danger');
    notice.hidden = false;
    return;
  }
  if (uncertainStorageError) {
    notice.textContent = `${uncertainStorageError}。为防止重复执行，写操作已禁用；请先核对队列状态并重新打开授权页面。`;
    notice.classList.add('danger');
    notice.hidden = false;
    return;
  }
  if (state && state.storage && !state.storage.healthy) {
    notice.textContent = `存储不可用，队列已只读暂停：${state.storage.error || '请检查状态文件和磁盘权限'}`;
    notice.classList.add('danger');
    notice.hidden = false;
    return;
  }
  if (state && state.pauseReason && state.pauseReason.kind === 'attention') {
    notice.textContent = state.pauseReason.message || '有任务需要人工确认，队列不会继续派发。';
    notice.classList.add('danger');
    notice.hidden = false;
    return;
  }
  if (state && state.settings.scheduleEnabled && !state.settings.windowOpen && state.counts.pending) {
    notice.textContent = `当前不在执行时段（${state.settings.scheduleStart}–${state.settings.scheduleEnd}），${state.counts.pending} 个任务会保持排队。`;
    notice.hidden = false;
    return;
  }
  if (connection === 'polling') {
    notice.textContent = '实时连接暂时中断，已切换为定时刷新；页面操作仍会直接写入本机服务。';
    notice.hidden = false;
    return;
  }
  notice.hidden = true;
}

function setConnection(next) {
  connection = next;
  const app = $('app');
  app.dataset.connection = next;
  const status = $('connection-status');
  status.dataset.state = next;
  status.textContent = next === 'online' ? '本机服务在线' : next === 'polling' ? '轮询连接' : next === 'offline' ? '服务离线' : next === 'locked' ? '需要授权' : '连接中';
  if (state) renderHeader();
  renderNotice();
  syncMutationControls();
}

function statusChip(status) {
  return el('span', { className: `status-chip ${status || 'idle'}`, text: STATUS_TEXT[status] || status || '未知', testId: 'task-status' });
}

function actionButton(label, accessibleName, handler, { quiet = false, danger = false, testId, mutation = true } = {}) {
  const button = el('button', {
    className: `button${quiet ? ' button-quiet' : ''}${danger ? ' button-danger' : ''}`,
    text: label,
    testId,
    attrs: { type: 'button', 'aria-label': accessibleName },
  });
  if (mutation) setAvailability(button, true);
  button.addEventListener('click', handler);
  return button;
}

function taskSubtitle(task) {
  const values = [TYPE_TEXT[task.type] || task.type];
  if (task.attempt) values.push(`第 ${task.attempt} 轮`);
  if (task.activity) values.push(task.activity);
  else if (task.error) values.push(task.error);
  else if (task.finishedAt) values.push(formatTime(task.finishedAt));
  return values.filter(Boolean).join(' · ');
}

function createTaskRow(task, kind) {
  const title = el('span', { className: 'entity-title', text: task.name, testId: 'task-name' });
  const titleLine = el('div', { className: 'entity-title-line' }, [statusChip(task.status), title]);
  const subtitle = el('div', { className: 'entity-subtitle', text: taskSubtitle(task) });
  const main = el('div', { className: 'entity-main' }, [titleLine, subtitle]);
  const actions = el('div', { className: 'entity-actions', testId: 'task-actions', attrs: { 'aria-label': `任务操作：${task.name}` } });
  if (kind === 'pending') {
    actions.append(
      actionButton('立即', `立即执行：${task.name}`, (event) => runTaskAction(task, 'runNow', event.currentTarget), { testId: 'task-action-run-now' }),
      actionButton('置顶', `移到队首：${task.name}`, (event) => runTaskAction(task, 'top', event.currentTarget), { quiet: true, testId: 'task-action-top' }),
      actionButton('上移', `上移任务：${task.name}`, (event) => runTaskAction(task, 'up', event.currentTarget), { quiet: true, testId: 'task-action-up' }),
      actionButton('下移', `下移任务：${task.name}`, (event) => runTaskAction(task, 'down', event.currentTarget), { quiet: true, testId: 'task-action-down' }),
      actionButton('移除', `移入回收站：${task.name}`, (event) => confirmRemoveTask(task, event.currentTarget), { quiet: true, danger: true, testId: 'task-action-remove' }),
    );
  } else if (kind === 'history') {
    actions.append(
      actionButton('详情', `查看详情：${task.name}`, () => openTaskDetail(task.id), { quiet: true, mutation: false, testId: 'task-action-detail' }),
      actionButton('日志', `查看日志：${task.name}`, () => openTaskLog(task.id, task.name), { quiet: true, mutation: false, testId: 'task-action-log' }),
      actionButton('重试', `重试任务：${task.name}`, (event) => runTaskAction(task, 'retry', event.currentTarget), { testId: 'task-action-retry' }),
      actionButton('移除', `移入回收站：${task.name}`, (event) => confirmRemoveTask(task, event.currentTarget), { quiet: true, danger: true, testId: 'task-action-remove' }),
    );
  } else if (kind === 'trash') {
    actions.append(actionButton('恢复', `恢复任务：${task.name}`, (event) => runTaskAction(task, 'restore', event.currentTarget), { testId: 'task-action-restore' }));
  }
  return el('li', { className: 'entity-row', testId: 'task-row', dataset: { taskId: task.id, status: task.status } }, [main, actions]);
}

async function runTaskAction(task, action, button) {
  try {
    const result = await mutate(`task:${task.id}:${action}`, button, `/api/tasks/${encodeURIComponent(task.id)}/action`, { action });
    notify(action === 'restore' ? '任务已恢复' : action === 'retry' ? '已创建重试任务' : '队列已更新');
    if (action === 'remove') showUndo('任务已移入回收站', () => restoreIds([task.id]));
    await refreshState();
    if (TERMINAL.has(task.status) || action === 'restore' || action === 'remove') await refreshCollections();
    return result;
  } catch (error) { notify(error.message); return null; }
}

function confirmAction(title, message, actionLabel, handler, cancelHandler = null) {
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  $('confirm-action').textContent = actionLabel;
  confirmHandler = handler;
  confirmCancelHandler = cancelHandler;
  openDialog($('confirm-dialog'), document.activeElement);
}

function confirmRemoveTask(task, button) {
  confirmAction('移入回收站', `“${task.name}”会保留 7 天，可随时恢复。`, '移除', () => runTaskAction(task, 'remove', button));
}

async function restoreIds(ids) {
  await mutate(`restore:${ids.join(',')}`, $('undo-action'), '/api/queue', { action: 'restoreDeleted', ids });
  await refreshState();
  await refreshCollections();
  notify('已恢复');
}

function renderCurrent() {
  const task = state.tasks.find((item) => ['attention', 'running', 'waiting'].includes(item.status));
  const card = $('current-task');
  if (!task) {
    currentSignature = '';
    card.hidden = true;
    card.removeAttribute('data-status');
    $('current-actions').replaceChildren();
    return;
  }
  card.hidden = false;
  card.dataset.status = task.status;
  $('current-label').textContent = task.status === 'attention' ? '安全暂停 · 需要确认' : task.status === 'waiting' ? '等待客户端接单' : '当前任务';
  $('current-name').textContent = task.name;
  $('current-activity').textContent = task.activity || task.error || '正在准备…';
  const meta = [];
  meta.push(el('span', { text: TYPE_TEXT[task.type] || task.type }));
  if (task.attempt) meta.push(el('span', { text: `第 ${task.attempt} / ${state.settings.maxRounds} 轮` }));
  if (task.startedAt) meta.push(el('span', { text: `已运行 ${formatDuration(Date.now() - task.startedAt)}`, attrs: { id: 'current-elapsed' } }));
  if (task.clientMayStillBeRunning) meta.push(el('span', { text: '客户端可能仍在运行' }));
  $('current-meta').replaceChildren(...meta);
  const signature = JSON.stringify([task.id, task.status === 'attention' ? 'attention' : 'active', task.type, task.name]);
  if (signature === currentSignature) return;
  currentSignature = signature;
  const actions = [];
  actions.push(actionButton('详情', `查看详情：${task.name}`, () => openTaskDetail(task.id), { quiet: true, mutation: false }));
  actions.push(actionButton('日志', `查看日志：${task.name}`, () => openTaskLog(task.id, task.name), { quiet: true, mutation: false }));
  if (task.status === 'attention') {
    actions.push(actionButton('重新接管监控', `重新接管监控：${task.name}`, (event) => runTaskAction(task, 'reattach', event.currentTarget)));
    actions.push(actionButton('确认并继续队列', `确认客户端状态并继续队列：${task.name}`, (event) => {
      confirmAction('确认状态不确定', '只有在你确认该客户端任务不会与后续任务并发时才继续。原调度记录不会被伪装成已终止。', '确认继续', () => runTaskAction(task, 'acknowledge', event.currentTarget));
    }, { danger: true }));
  } else {
    const consequence = task.type === 'shell' ? '会终止 Shell 进程。' : '只停止队列监控；客户端会话可能继续运行，队列将安全暂停。';
    actions.push(actionButton('停止', `停止任务：${task.name}`, (event) => confirmAction('停止当前任务', consequence, '停止', async () => {
      try { await mutate(`queue:stop:${task.id}`, event.currentTarget, '/api/queue', { action: 'stopCurrent', taskId: task.id }); await refreshState(); }
      catch (error) { notify(error.message); }
    }), { danger: true }));
  }
  $('current-actions').replaceChildren(...actions);
}

function refreshCurrentElapsed() {
  const output = $('current-elapsed');
  if (!output || !state) return;
  const task = state.tasks.find((item) => ['attention', 'running', 'waiting'].includes(item.status));
  if (task && task.startedAt) output.textContent = `已运行 ${formatDuration(Date.now() - task.startedAt)}`;
}

function renderPending() {
  const tasks = state.tasks.filter((task) => task.status === 'pending');
  const signature = JSON.stringify(tasks);
  if (signature === pendingSignature) return;
  pendingSignature = signature;
  const scroll = window.scrollY;
  $('pending-list').replaceChildren(...tasks.map((task) => createTaskRow(task, 'pending')));
  $('pending-empty').hidden = tasks.length > 0;
  $('pending-count').textContent = tasks.length ? `${tasks.length} 个` : '';
  window.scrollTo({ top: scroll });
}

function renderHistory() {
  $('history-list').replaceChildren(...historyItems.map((task) => createTaskRow(task, 'history')));
  $('history-empty').hidden = historyItems.length > 0;
  $('history-more').hidden = !historyCursor;
  setAvailability($('history-clear'), historyItems.length > 0);
}

function renderTrash() {
  $('trash-list').replaceChildren(...trashItems.map((task) => createTaskRow(task, 'trash')));
  $('trash-empty').hidden = trashItems.length > 0;
  $('trash-more').hidden = !trashCursor;
  const count = state && state.counts.trash ? Number(state.counts.trash) : 0;
  $('trash-count').textContent = count ? String(count) : '';
  $('trash-count').hidden = !count;
}

async function loadCollection(kind, append = false) {
  const generation = ++collectionGeneration[kind];
  const cursor = append ? (kind === 'history' ? historyCursor : trashCursor) : null;
  const query = new URLSearchParams({ status: kind, limit: '50' });
  if (cursor) query.set('cursor', cursor);
  const result = await request(`/api/tasks?${query}`);
  if (generation !== collectionGeneration[kind]) return false;
  if (kind === 'history') {
    historyItems = append ? historyItems.concat(result.items) : result.items;
    historyCursor = result.nextCursor;
    renderHistory();
  } else {
    trashItems = append ? trashItems.concat(result.items) : result.items;
    trashCursor = result.nextCursor;
    renderTrash();
  }
  return true;
}

function scheduleCollectionRetry() {
  if (collectionRetryTimer || !apiToken) return;
  const delay = collectionRetryDelay;
  collectionRetryDelay = Math.min(30000, Math.round(collectionRetryDelay * 1.8));
  collectionRetryTimer = setTimeout(() => {
    collectionRetryTimer = null;
    refreshCollections().catch(() => {});
  }, delay);
}

async function refreshCollections() {
  const refreshGeneration = ++collectionRefreshGeneration;
  const targetCounts = state ? { history: state.counts.history, trash: state.counts.trash } : null;
  let applied;
  try {
    applied = await Promise.all([loadCollection('history'), loadCollection('trash')]);
  } catch (error) {
    if (refreshGeneration !== collectionRefreshGeneration) return false;
    scheduleCollectionRetry();
    throw error;
  }
  if (refreshGeneration !== collectionRefreshGeneration) return false;
  if (applied.some((value) => !value)) {
    scheduleCollectionRetry();
    return false;
  }
  clearTimeout(collectionRetryTimer);
  collectionRetryTimer = null;
  collectionRetryDelay = 1000;
  if (targetCounts) collectionCounts = targetCounts;
  if (state && (collectionCounts.history !== state.counts.history || collectionCounts.trash !== state.counts.trash)) scheduleCollectionRetry();
  return true;
}

function createSessionRow(session, hidden) {
  const title = el('span', { className: 'entity-title', text: session.title || '未命名会话', testId: 'session-title' });
  const titleLine = el('div', { className: 'entity-title-line' }, [statusChip(session.status), title]);
  const details = [session.directory, session.lastActivity].filter(Boolean).join(' · ');
  const main = el('div', { className: 'entity-main' }, [titleLine, el('div', { className: 'entity-subtitle', text: details })]);
  const actions = el('div', { className: 'entity-actions', testId: 'session-actions', attrs: { 'aria-label': `会话操作：${session.title || '未命名会话'}` } });
  if (hidden) {
    actions.append(actionButton('恢复显示', `恢复显示会话：${session.title}`, async (event) => {
      try { await mutate(`session:${session.sessionId}:unhide`, event.currentTarget, '/api/client-tasks/unhide', { sessionId: session.sessionId }); notify('会话已恢复显示'); await refreshState(); }
      catch (error) { notify(error.message); }
    }, { testId: 'session-action-restore' }));
  } else {
    actions.append(
      actionButton('续跑', `续跑会话：${session.title}`, async (event) => {
        try { const result = await mutate(`session:${session.sessionId}:continue`, event.currentTarget, '/api/client-tasks/continue', { sessionId: session.sessionId }); notify(result.duplicate ? '该会话已在队列中' : '已加入续跑队列'); await refreshState(); }
        catch (error) { notify(error.message); }
      }, { testId: 'session-action-continue' }),
      actionButton('导入为新任务', `导入会话：${session.title}`, async (event) => {
        try { await mutate(`session:${session.sessionId}:import`, event.currentTarget, '/api/client-tasks/import', { sessionId: session.sessionId }); notify('已导入为新任务'); await refreshState(); }
        catch (error) { notify(error.message); }
      }, { quiet: true, testId: 'session-action-import' }),
      actionButton('隐藏', `隐藏会话：${session.title}`, async (event) => {
        try {
          await mutate(`session:${session.sessionId}:hide`, event.currentTarget, '/api/client-tasks/hide', { sessionId: session.sessionId });
          showUndo('会话已隐藏', async () => { await mutate(`session:${session.sessionId}:unhide`, $('undo-action'), '/api/client-tasks/unhide', { sessionId: session.sessionId }); await refreshState(); });
          await refreshState();
        } catch (error) { notify(error.message); }
      }, { quiet: true, testId: 'session-action-hide' }),
    );
  }
  return el('li', { className: 'entity-row', testId: 'session-row', dataset: { sessionId: session.sessionId, status: session.status } }, [main, actions]);
}

function renderSessions() {
  const visible = state.clientTasks || [];
  const hidden = state.hiddenClientTasks || [];
  const signature = JSON.stringify([visible, hidden]);
  if (signature === sessionSignature) return;
  sessionSignature = signature;
  $('session-list').replaceChildren(...visible.map((session) => createSessionRow(session, false)));
  $('hidden-session-list').replaceChildren(...hidden.map((session) => createSessionRow(session, true)));
  $('session-empty').hidden = visible.length > 0;
  $('hidden-empty').hidden = hidden.length > 0;
  $('hidden-count').textContent = hidden.length ? String(hidden.length) : '';
  $('session-count').textContent = visible.length ? String(visible.length) : '';
  $('session-count').hidden = !visible.length;
}

function guardValues(settings = state.settings) {
  const values = {};
  for (const [id, key] of Object.entries(guardFieldMap)) values[key] = $(id).type === 'checkbox' ? $(id).checked : $(id).value;
  if (settings) return values;
  return values;
}

function fillGuard(settings) {
  for (const [id, key] of Object.entries(guardFieldMap)) {
    const input = $(id);
    if (input.type === 'checkbox') input.checked = Boolean(settings[key]);
    else input.value = settings[key] || '';
  }
  guardBase = guardValues(settings);
  guardDirty = false;
  guardRefreshPending = false;
  $('guard-form').dataset.editState = 'clean';
  $('guard-conflict').hidden = true;
  $('guard-save-status').textContent = '';
}

function renderGuard() {
  const form = $('guard-form');
  if (!guardDirty) {
    if (form.contains(document.activeElement)) guardRefreshPending = true;
    else fillGuard(state.settings);
  } else if (guardDirty && guardBase) {
    const changedRemote = Object.entries(guardBase).some(([key, value]) => state.settings[key] !== value);
    if (changedRemote) {
      form.dataset.editState = 'conflict';
      $('guard-conflict').textContent = '服务端设置已变化；当前编辑内容没有被覆盖。保存会以当前表单为准。';
      $('guard-conflict').hidden = false;
    }
  }
  const guardError = state.guardState && state.guardState.lastError;
  if (!guardDirty && guardError) {
    $('guard-conflict').textContent = guardError.message || '上次守护操作失败，将自动重试。';
    $('guard-conflict').hidden = false;
    $('guard-save-status').textContent = '守护将自动重试';
  }
}

function renderHeader() {
  const active = state.tasks.find((task) => ['running', 'waiting', 'attention'].includes(task.status));
  const beacon = $('status-beacon');
  beacon.className = 'status-beacon';
  if (active && active.status === 'attention') beacon.classList.add('attention');
  else if (state.paused) beacon.classList.add('paused');
  else if (['online', 'polling'].includes(connection)) beacon.classList.add('online');
  $('queue-status').textContent = active ? `${STATUS_TEXT[active.status]}：${active.name}` : state.paused ? '队列已暂停' : '队列空闲，等待下一个任务';
  $('queue-toggle').textContent = state.paused ? '恢复队列' : '暂停队列';
  $('queue-toggle').setAttribute('aria-pressed', String(state.paused));
  $('queue-toggle').title = state.pauseReason && state.pauseReason.kind === 'attention' ? '请先处理需要人工确认的任务' : '';
  const count = state.counts.active || state.counts.pending;
  $('queue-count').textContent = count ? String(count) : '';
  $('queue-count').hidden = !count;
  $('marker-hint').textContent = state.settings.completionMarker;
}

function applyState(next, { force = false } = {}) {
  if (!next || typeof next.revision !== 'number') return;
  let instanceChanged = false;
  if (instanceId && next.instanceId && instanceId !== next.instanceId) {
    instanceChanged = true;
    lastRevision = -1;
    currentSignature = '';
    pendingSignature = '';
    sessionSignature = '';
    historyItems = [];
    trashItems = [];
    historyCursor = null;
    trashCursor = null;
    collectionCounts = { history: -1, trash: -1 };
    collectionGeneration.history += 1;
    collectionGeneration.trash += 1;
  }
  if (next.instanceId === instanceId && (next.revision < lastRevision || !force && next.revision === lastRevision)) return;
  instanceId = next.instanceId || instanceId;
  lastRevision = next.revision;
  state = next;
  if (instanceChanged) { renderHistory(); renderTrash(); }
  $('app').dataset.revision = String(next.revision);
  $('last-updated').dateTime = new Date().toISOString();
  $('last-updated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  renderHeader();
  renderCurrent();
  renderPending();
  renderSessions();
  renderGuard();
  renderSettingsConflict();
  renderNotice();
  syncMutationControls();
  if (collectionCounts.history !== next.counts.history || collectionCounts.trash !== next.counts.trash) {
    refreshCollections().catch((error) => notify(error.message));
  }
}

async function refreshState(force = false) {
  const next = await request('/api/state?view=summary');
  applyState(next, { force });
  return next;
}

function stopPolling() { clearTimeout(pollTimer); pollTimer = null; pollDelay = 2000; }
function lockAuthorization() {
  apiToken = null;
  try { sessionStorage.removeItem(TOKEN_STORAGE_KEY); } catch {}
  if (eventSource) eventSource.close();
  eventSource = null;
  clearTimeout(reconnectTimer); reconnectTimer = null;
  stopPolling();
  clearTimeout(collectionRetryTimer); collectionRetryTimer = null;
  setConnection('locked');
}
function schedulePoll() {
  if (pollTimer || connection === 'online' || connection === 'locked') return;
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    try { await refreshState(); pollDelay = 2000; setConnection('polling'); }
    catch (error) {
      if (error.status === 401) return;
      setConnection('offline'); pollDelay = Math.min(30000, Math.round(pollDelay * 1.7));
    }
    schedulePoll();
  }, pollDelay);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectEvents(); }, Math.min(30000, pollDelay));
}

function recoverEventStream(source = eventSource) {
  if (source && eventSource !== source) return;
  if (source) source.close();
  eventSource = null;
  if (connection !== 'polling') setConnection('offline');
  schedulePoll();
  scheduleReconnect();
}

function connectEvents() {
  if (!apiToken || connection === 'locked') return;
  if (eventSource) eventSource.close();
  const url = new URL('/api/events', location.origin);
  url.searchParams.set('token', apiToken);
  const source = new EventSource(url);
  eventSource = source;
  source.addEventListener('open', () => { if (eventSource === source) { setConnection('online'); stopPolling(); } });
  source.addEventListener('state', (event) => {
    if (eventSource !== source) return;
    try { applyState(JSON.parse(event.data)); setConnection('online'); }
    catch { recoverEventStream(source); }
  });
  source.addEventListener('error', () => recoverEventStream(source));
}

function selectTab(tab, focus = false) {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  for (const button of tabs) {
    const selected = button.id === `tab-${tab}`;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    const panel = $(button.getAttribute('aria-controls'));
    panel.hidden = !selected;
    if (selected && focus) button.focus();
  }
}

function openDialog(dialog, opener) {
  dialog._opener = opener instanceof HTMLElement ? opener : document.activeElement;
  if (!dialog.open) dialog.showModal();
  queueMicrotask(() => {
    const heading = dialog.querySelector('h2[tabindex="-1"]');
    const first = dialog.querySelector('input, select, textarea, button');
    (heading || first)?.focus();
  });
}

function closeDialog(dialog) { if (dialog.open) dialog.close(); }

async function openTaskDetail(id) {
  const dialog = $('detail-dialog');
  const generation = ++detailGeneration;
  if (detailAbort) detailAbort.abort();
  detailAbort = new AbortController();
  $('detail-title').textContent = '正在读取任务详情…';
  $('detail-meta').replaceChildren();
  $('detail-prompt').textContent = '';
  $('detail-result').textContent = '';
  openDialog(dialog, document.activeElement);
  try {
    const task = await request(`/api/tasks/${encodeURIComponent(id)}`, { signal: detailAbort.signal });
    if (generation !== detailGeneration || !dialog.open) return;
    $('detail-title').textContent = task.name;
    const rows = [
      ['状态', STATUS_TEXT[task.status] || task.status], ['类型', TYPE_TEXT[task.type] || task.type],
      ['创建', formatTime(task.createdAt)], ['开始', formatTime(task.startedAt)], ['结束', formatTime(task.finishedAt)],
      ['轮次', String(task.attempt || 0)], ['错误', task.error || '—'],
    ];
    const nodes = [];
    for (const [label, value] of rows) nodes.push(el('dt', { text: label }), el('dd', { text: value }));
    $('detail-meta').replaceChildren(...nodes);
    $('detail-prompt').textContent = task.prompt || '';
    $('detail-result').textContent = task.result || '暂无结果';
  } catch (error) {
    if (error.name !== 'AbortError' && generation === detailGeneration && dialog.open) $('detail-result').textContent = error.message;
  }
}

async function refreshLog() {
  if (!logTaskId || !$('log-dialog').open) return;
  if (logAbort) logAbort.abort();
  logAbort = new AbortController();
  try {
    const value = await request(`/api/tasks/log?id=${encodeURIComponent(logTaskId)}`, { signal: logAbort.signal });
    $('log-content').textContent = (value.logs || []).join('\n') || '暂无日志';
    $('log-content').scrollTop = $('log-content').scrollHeight;
  } catch (error) { if (error.name !== 'AbortError') $('log-content').textContent = error.message; }
}

function openTaskLog(id, name) {
  logTaskId = id;
  $('log-title').textContent = `任务日志 · ${name}`;
  $('log-content').textContent = '正在读取…';
  openDialog($('log-dialog'), document.activeElement);
  refreshLog();
  clearInterval(logTimer);
  logTimer = setInterval(refreshLog, 1500);
}

function stopLogPolling() {
  clearInterval(logTimer); logTimer = null; logTaskId = null;
  if (logAbort) logAbort.abort();
  logAbort = null;
}

function fillSettingsDialog() {
  const plans = state.plans || {};
  const planSelect = $('setting-plan');
  planSelect.replaceChildren(...Object.entries(plans).map(([value, item]) => el('option', { text: item.label, attrs: { value } })));
  planSelect.value = state.settings.plan;
  fillModelOptions();
  $('setting-model').value = state.settings.model;
  $('setting-prompt').value = state.settings.continuePrompt;
  $('setting-marker').value = state.settings.completionMarker;
  $('setting-rounds').value = state.settings.maxRounds;
  $('setting-stall').value = state.settings.stallMin;
  $('setting-interval').value = state.settings.intervalSec;
  $('setting-timeout').value = state.settings.defaultTimeoutMin;
  $('setting-stop-on-fail').checked = Boolean(state.settings.stopOnFail);
  settingsBase = settingsFormValues();
  $('settings-error').hidden = true;
}

function settingsFormValues() {
  return {
    plan: $('setting-plan').value,
    model: $('setting-model').value,
    continuePrompt: $('setting-prompt').value,
    completionMarker: $('setting-marker').value,
    maxRounds: Number($('setting-rounds').value),
    stallMin: Number($('setting-stall').value),
    intervalSec: Number($('setting-interval').value),
    defaultTimeoutMin: Number($('setting-timeout').value),
    stopOnFail: $('setting-stop-on-fail').checked,
  };
}

function changedSettingKeys(left, right) {
  if (!left || !right) return [];
  return Object.keys(left).filter((key) => left[key] !== right[key]);
}

function renderSettingsConflict() {
  if (!$('settings-dialog').open || !settingsBase || !state) return;
  const remoteChanges = changedSettingKeys(settingsBase, state.settings);
  if (!remoteChanges.length) return;
  const error = $('settings-error');
  error.textContent = '执行参数已被其他操作更新。未编辑字段会保留服务端新值；同一字段冲突时需重新打开后保存。';
  error.hidden = false;
}

function fillModelOptions() {
  const selected = $('setting-plan').value;
  const models = state.planModels && state.planModels[selected] || [];
  $('setting-model').replaceChildren(...models.map((model) => el('option', { text: model, attrs: { value: model } })));
}

function setupEvents() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab.id.replace('tab-', '')));
    tab.addEventListener('keydown', (event) => {
      let target = null;
      if (event.key === 'ArrowRight') target = tabs[(index + 1) % tabs.length];
      else if (event.key === 'ArrowLeft') target = tabs[(index - 1 + tabs.length) % tabs.length];
      else if (event.key === 'Home') target = tabs[0];
      else if (event.key === 'End') target = tabs[tabs.length - 1];
      if (target) { event.preventDefault(); selectTab(target.id.replace('tab-', ''), true); }
    });
  });

  document.querySelectorAll('dialog').forEach((dialog) => {
    dialog.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(dialog); });
    dialog.addEventListener('close', () => {
      if (dialog.id === 'log-dialog') stopLogPolling();
      if (dialog.id === 'detail-dialog') {
        detailGeneration += 1;
        if (detailAbort) detailAbort.abort();
        detailAbort = null;
      }
      if (dialog.id === 'settings-dialog') settingsBase = null;
      const opener = dialog._opener;
      dialog._opener = null;
      if (opener && document.contains(opener)) opener.focus();
      if (dialog.id === 'confirm-dialog') {
        const cancel = confirmCancelHandler;
        confirmHandler = null;
        confirmCancelHandler = null;
        if (cancel) cancel();
      }
    });
    dialog.querySelectorAll('.dialog-close').forEach((button) => button.addEventListener('click', () => closeDialog(dialog)));
  });

  $('confirm-action').addEventListener('click', async () => {
    const handler = confirmHandler;
    confirmHandler = null;
    confirmCancelHandler = null;
    closeDialog($('confirm-dialog'));
    if (handler) await handler();
  });
  $('undo-action').addEventListener('click', async () => {
    const handler = undoHandler;
    if (!handler) return;
    clearTimeout(undoTimer); undoTimer = null;
    try {
      await handler();
      if (undoHandler === handler) {
        undoHandler = null;
        $('undo-toast').hidden = true;
      }
    } catch (error) {
      if (undoHandler === handler) armUndoExpiry(handler);
      notify(error.message);
    }
  });

  $('queue-toggle').addEventListener('click', async (event) => {
    if (!state) return;
    try { await mutate('queue:toggle', event.currentTarget, '/api/queue', { action: state.paused ? 'resume' : 'pause' }); await refreshState(true); }
    catch (error) { notify(error.message); }
  });
  $('new-task-open').addEventListener('click', (event) => {
    $('new-task-form').reset(); $('new-task-error').hidden = true; openDialog($('new-task-dialog'), event.currentTarget);
  });
  $('settings-open').addEventListener('click', (event) => {
    if (!state) { notify('尚未收到服务状态'); return; }
    fillSettingsDialog(); openDialog($('settings-dialog'), event.currentTarget);
  });
  $('setting-plan').addEventListener('change', fillModelOptions);

  $('new-task-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('new-task-error'); error.hidden = true;
    const rawTimeout = $('task-timeout').value.trim();
    const body = {
      type: $('task-type').value,
      name: $('task-name').value.trim(),
      prompt: $('task-prompt').value,
      cwd: $('task-cwd').value.trim(),
      timeoutMin: rawTimeout === '' ? null : Number(rawTimeout),
    };
    if ($('task-batch').checked) body.batch = body.prompt;
    try {
      const result = await mutate('new-task', $('new-task-submit'), '/api/tasks', body);
      closeDialog($('new-task-dialog'));
      notify(`已加入 ${result.created} 个任务`);
      await refreshState(true);
    } catch (reason) { error.textContent = reason.message; error.hidden = false; $('task-prompt').focus(); }
  });
  $('settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('settings-error'); error.hidden = true;
    const values = settingsFormValues();
    const changed = changedSettingKeys(settingsBase, values);
    const remoteChanges = changedSettingKeys(settingsBase, state.settings);
    const conflicts = changed.filter((key) => remoteChanges.includes(key));
    if (conflicts.length) {
      error.textContent = '你编辑的参数同时已在服务端改变。请取消并重新打开，确认新值后再保存。';
      error.hidden = false;
      return;
    }
    const body = Object.fromEntries(changed.map((key) => [key, values[key]]));
    if (!changed.length) { closeDialog($('settings-dialog')); return; }
    try {
      await mutate('settings:save', $('settings-save'), '/api/config', body);
      closeDialog($('settings-dialog')); notify('执行参数已保存'); await refreshState(true);
    } catch (reason) { error.textContent = reason.message; error.hidden = false; $('setting-marker').focus(); }
  });

  Object.keys(guardFieldMap).forEach((id) => $(id).addEventListener('input', () => {
    guardDirty = true; $('guard-form').dataset.editState = 'dirty'; $('guard-save-status').textContent = '有未保存更改'; syncMutationControls();
  }));
  $('guard-form').addEventListener('focusout', () => queueMicrotask(() => {
    if (!$('guard-form').contains(document.activeElement) && (guardRefreshPending || guardDirty)) {
      renderGuard();
      syncMutationControls();
    }
  }));
  $('guard-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = guardValues();
    $('guard-form').dataset.editState = 'saving'; $('guard-save-status').textContent = '正在保存…';
    try {
      const result = await mutate('guard:save', $('guard-save'), '/api/config', body);
      state.settings = { ...state.settings, ...result.settings };
      fillGuard(state.settings); $('guard-save-status').textContent = '已保存'; notify('守护设置已保存'); await refreshState(true);
    } catch (error) {
      $('guard-form').dataset.editState = 'error'; $('guard-conflict').textContent = error.message; $('guard-conflict').hidden = false; $('guard-save-status').textContent = '保存失败';
    }
  });
  $('stop-client-now').addEventListener('click', (event) => confirmAction('立即停止 ZCode', '这会退出 ZCode 并暂停队列。正在运行的客户端工作可能被中断。', '停止客户端', async () => {
    try { await mutate('guard:stop', event.currentTarget, '/api/guard', { action: 'stopClient' }, { idempotent: false }); notify('停止命令已执行'); await refreshState(true); }
    catch (error) { notify(error.message); }
  }));
  $('enable-client-now').addEventListener('click', async (event) => {
    try { await mutate('guard:enable', event.currentTarget, '/api/guard', { action: 'enableClient' }, { idempotent: false }); notify('已请求打开 ZCode'); }
    catch (error) { notify(error.message); }
  });
  $('history-clear').addEventListener('click', () => confirmAction('清理历史', '所有已完成、失败、停止和超时任务会移入回收站，可在 7 天内恢复。', '移入回收站', async () => {
    try {
      const result = await mutate('history:clear', $('history-clear'), '/api/queue', { action: 'clearFinished' });
      showUndo(`${result.ids.length} 个任务已移入回收站`, () => restoreIds(result.ids));
      await refreshState(true); await refreshCollections();
    } catch (error) { notify(error.message); }
  }));
  $('history-more').addEventListener('click', () => loadCollection('history', true).catch((error) => notify(error.message)));
  $('trash-more').addEventListener('click', () => loadCollection('trash', true).catch((error) => notify(error.message)));
}

async function boot() {
  apiToken = captureApiToken();
  setupEvents();
  setInterval(refreshCurrentElapsed, 1000);
  if (!apiToken) { setConnection('locked'); return; }
  setConnection('connecting');
  try { await refreshState(true); setConnection('online'); }
  catch (error) {
    if (error.status === 401) lockAuthorization();
    else { setConnection('offline'); schedulePoll(); }
  }
  connectEvents();
}

boot().catch((error) => {
  if (error.status === 401) lockAuthorization();
  else { setConnection('offline'); notify(error.message); schedulePoll(); }
});
