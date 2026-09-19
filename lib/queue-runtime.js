'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn: spawnProcess } = require('child_process');
const {
  ACTIVE_STATUSES,
  DEFAULT_COMPLETION_MARKER,
  DEFAULT_CONTINUE_PROMPT,
  TERMINAL_STATUSES,
  deterministicAutomationId,
  executionWindowOpen,
  hasExactCompletionMarker,
  migrateCompletionDefaults,
  normalizeTimeout,
  validateConfigPatch,
} = require('./core');
const { AutomationConflictError } = require('./client-db');
const { SCHEMA_VERSION, StorageFatalError } = require('./state-store');

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  WAITING: 'waiting',
  ATTENTION: 'attention',
  DONE: 'done',
  FAILED: 'failed',
  STOPPED: 'stopped',
  TIMEOUT: 'timeout',
});

const TASK_PHASE = Object.freeze({
  DISPATCHING: 'dispatching',
  WAITING_DISPATCH: 'waiting_dispatch',
  RUNNING: 'running',
  BETWEEN_ATTEMPTS: 'between_attempts',
  ATTENTION: 'attention',
});

const DEFAULT_SETTINGS = Object.freeze({
  intervalSec: 5,
  stopOnFail: false,
  defaultTimeoutMin: 0,
  plan: 'builtin:bigmodel-coding-plan',
  model: 'GLM-5.3-Flash',
  continuePrompt: DEFAULT_CONTINUE_PROMPT,
  completionMarker: DEFAULT_COMPLETION_MARKER,
  maxRounds: 20,
  stallMin: 15,
  autoStopEnabled: false,
  autoStopTime: '08:55',
  autoEnableEnabled: false,
  autoEnableTime: '23:00',
  focusOnDispatch: false,
  hiddenSessions: [],
  scheduleEnabled: false,
  scheduleStart: '23:00',
  scheduleEnd: '09:00',
});

class RuntimeError extends Error {
  constructor(message, statusCode = 400, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'RuntimeError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function defaultQueue() {
  return {
    paused: false,
    pausedBySystem: false,
    pauseReason: null,
    guardState: {
      stopLastAt: 0,
      enableLastAt: 0,
      enableResumeAt: 0,
      lastAppliedAt: 0,
      lastWindowOpen: true,
      lastError: null,
      stopOwnershipPending: null,
      stopBasePause: null,
    },
  };
}

function defaultSnapshot() {
  return {
    schemaVersion: SCHEMA_VERSION,
    generation: 0,
    revision: 0,
    queue: defaultQueue(),
    settings: { ...DEFAULT_SETTINGS },
    tasks: [],
    idempotency: [],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizedStopBasePause(value, fallbackNow = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['manual', 'auto-stop', 'failure', 'storage-recovery', 'storage-fatal'].includes(value.kind)) return null;
  const since = Number(value.since);
  const defaults = {
    manual: '用户手动暂停',
    'auto-stop': '每日自动停止客户端',
    failure: '任务失败',
    'storage-recovery': '状态由备份恢复，确认无误后再恢复队列',
    'storage-fatal': '存储不可用',
  };
  const normalized = {
    kind: value.kind,
    message: String(value.message || defaults[value.kind]).slice(0, 500),
    since: Number.isFinite(since) ? since : fallbackNow,
  };
  if (value.kind === 'failure' && value.taskId) normalized.taskId = String(value.taskId).slice(0, 200);
  return normalized;
}

function basePausePriority(value) {
  return { 'auto-stop': 1, manual: 2, failure: 3, 'storage-recovery': 4, 'storage-fatal': 5 }[value && value.kind] || 0;
}

function strongestBasePause(...values) {
  return values.filter(Boolean).reduce((selected, value) =>
    basePausePriority(value) > basePausePriority(selected) ? value : selected, null);
}

function nonTerminal(task) {
  return !task.deletedAt && !TERMINAL_STATUSES.has(task.status);
}

function validSessionId(value) {
  return typeof value === 'string' && value.length <= 200 && Boolean(value.trim());
}

function normalizeHiddenSessions(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(validSessionId))].slice(-200);
}

function requireSessionId(value) {
  if (!validSessionId(value)) throw new RuntimeError('sessionId 必须是 1–200 个字符的字符串');
  return value;
}

function normalizedTask(task) {
  const out = {
    ...task,
    logs: Array.isArray(task.logs) ? task.logs.slice(-200) : [],
    activity: task.activity || '',
    attempt: Number.isInteger(task.attempt) ? task.attempt : Math.max(0, Number(task.round || 0) + (task.startedAt ? 1 : 0)),
    phase: task.phase || null,
    execution: task.execution || null,
    attention: task.attention || null,
    clientMayStillBeRunning: Boolean(task.clientMayStillBeRunning),
    deletedAt: task.deletedAt || null,
    deleteBatchId: task.deleteBatchId || null,
  };
  out.round = Math.max(0, out.attempt - 1);
  if (ACTIVE_STATUSES.has(out.status) && !out.phase) {
    out.phase = out.status === TASK_STATUS.WAITING ? TASK_PHASE.WAITING_DISPATCH : TASK_PHASE.RUNNING;
    out.execution = {
      automationId: out.automationId || null,
      attempt: Math.max(1, out.attempt || 1),
      runId: null,
      startedAt: out.startedAt || Date.now(),
      dispatchStartedAt: out.startedAt || Date.now(),
      automationObservedAt: null,
      dispatchedAt: null,
      dispatchDeadlineAt: (out.startedAt || Date.now()) + 5 * 60 * 1000,
      baselineCursor: null,
      nextAttemptAt: null,
      dbErrorSince: null,
      terminalOutcome: null,
      terminalObservedAt: null,
      dispatchErrorSince: null,
      fingerprint: null,
    };
  }
  return out;
}

class QueueRuntime {
  constructor({
    root,
    store,
    client,
    plans,
    logger = () => {},
    now = () => Date.now(),
    timers = globalThis,
    spawn = spawnProcess,
    onChange = () => {},
    focusWorkspace = () => {},
    dispatchWaitMs = 5 * 60 * 1000,
    dbErrorGraceMs = 60 * 1000,
    resultGraceMs = 5 * 1000,
    pollMs = 2000,
    shellShutdownGraceMs = 2000,
    shellKillWaitMs = 1000,
    checkpoint = () => {},
  }) {
    this.root = path.resolve(root);
    this.store = store;
    this.client = client;
    this.plans = plans;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.spawn = spawn;
    this.onChange = onChange;
    this.focusWorkspace = focusWorkspace;
    this.dispatchWaitMs = dispatchWaitMs;
    this.dbErrorGraceMs = dbErrorGraceMs;
    this.resultGraceMs = resultGraceMs;
    this.pollMs = pollMs;
    this.shellShutdownGraceMs = shellShutdownGraceMs;
    this.shellKillWaitMs = shellKillWaitMs;
    this.checkpoint = checkpoint;
    this.current = null;
    this.nextTimer = null;
    this.stopped = false;
    this.storage = { healthy: true, recovered: false, migrated: false, error: null };

    // StateStore persists its first migrated generation and initialization
    // marker before returning. Seed the destructive guard-event watermark into
    // that very first generation so a later QueueRuntime normalization write
    // can fail without exposing lastAt=0 on restart.
    const activationTime = this.now();
    const startupSnapshot = defaultSnapshot();
    startupSnapshot.queue.guardState = {
      ...startupSnapshot.queue.guardState,
      stopLastAt: activationTime,
      enableLastAt: activationTime,
      lastAppliedAt: activationTime,
      lastWindowOpen: executionWindowOpen(startupSnapshot.settings, new Date(activationTime)),
    };
    let snapshot;
    try {
      const loaded = store.load(startupSnapshot);
      snapshot = loaded.snapshot;
      this.storage.recovered = Boolean(loaded.recovered);
      this.storage.migrated = Boolean(loaded.migrated);
    } catch (error) {
      if (!(error instanceof StorageFatalError)) throw error;
      snapshot = startupSnapshot;
      snapshot.queue.paused = true;
      snapshot.queue.pausedBySystem = true;
      snapshot.queue.pauseReason = { kind: 'storage-fatal', message: error.message, since: this.now() };
      this.storage.healthy = false;
      this.storage.error = error.message;
      this.logger(`存储进入只读安全模式: ${error.message}`);
    }
    this.state = snapshot;
    this.state.queue = { ...defaultQueue(), ...this.state.queue, guardState: { ...defaultQueue().guardState, ...(this.state.queue.guardState || {}) } };
    const storedStopOwnershipPending = this.state.queue.guardState.stopOwnershipPending;
    const storedStopBasePause = this.state.queue.guardState.stopBasePause;
    const legacyGuardAttention = this.state.queue.pauseReason
      && this.state.queue.pauseReason.kind === 'attention'
      && this.state.queue.pauseReason.source === 'guard-stop-ownership';
    this.state.queue.guardState.stopBasePause = strongestBasePause(
      normalizedStopBasePause(storedStopBasePause, this.now()),
      normalizedStopBasePause(this.state.queue.pauseReason, this.now()),
    );
    if (storedStopOwnershipPending && typeof storedStopOwnershipPending === 'object' && !Array.isArray(storedStopOwnershipPending)) {
      const source = storedStopOwnershipPending.source === 'manual-api' ? 'manual-api' : 'scheduled';
      const since = Number(storedStopOwnershipPending.since) || this.now();
      this.state.queue.guardState.stopOwnershipPending = {
        source,
        eventTime: storedStopOwnershipPending.eventTime != null
          && Number.isFinite(Number(storedStopOwnershipPending.eventTime))
          ? Number(storedStopOwnershipPending.eventTime) : null,
        since,
        message: String(storedStopOwnershipPending.message || 'ZCode.app 停止状态尚未验证').slice(0, 500),
        guardPauseApplied: Boolean(storedStopOwnershipPending.guardPauseApplied),
        basePause: strongestBasePause(
          normalizedStopBasePause(storedStopOwnershipPending.basePause, since),
          this.state.queue.guardState.stopBasePause,
          normalizedStopBasePause({ kind: source === 'manual-api' ? 'manual' : 'auto-stop', since }, since),
        ),
      };
    } else if (legacyGuardAttention) {
      const since = Number(this.state.queue.pauseReason.since) || this.now();
      this.state.queue.guardState.stopOwnershipPending = {
        source: 'scheduled',
        eventTime: this.state.queue.pauseReason.eventTime != null
          && Number.isFinite(Number(this.state.queue.pauseReason.eventTime))
          ? Number(this.state.queue.pauseReason.eventTime) : null,
        since,
        message: String(this.state.queue.pauseReason.message || 'ZCode.app 停止状态尚未验证').slice(0, 500),
        guardPauseApplied: true,
        basePause: normalizedStopBasePause({ kind: 'auto-stop', since }, since),
      };
    } else {
      this.state.queue.guardState.stopOwnershipPending = null;
    }
    const migration = migrateCompletionDefaults({ ...DEFAULT_SETTINGS, ...this.state.settings });
    this.state.settings = migration.settings;
    const storedHiddenSessions = this.state.settings.hiddenSessions;
    const hiddenSessions = normalizeHiddenSessions(storedHiddenSessions);
    const hiddenSessionsNormalized = !Array.isArray(storedHiddenSessions)
      || storedHiddenSessions.length !== hiddenSessions.length
      || storedHiddenSessions.some((value, index) => value !== hiddenSessions[index]);
    this.state.settings.hiddenSessions = hiddenSessions;
    this.state.tasks = this.state.tasks.map(normalizedTask);
    this.state.idempotency = Array.isArray(this.state.idempotency) ? this.state.idempotency : [];
    if (this.storage.migrated || this.storage.recovered) {
      this.state.queue.guardState = {
        ...this.state.queue.guardState,
        stopLastAt: Math.max(Number(this.state.queue.guardState.stopLastAt) || 0, activationTime),
        enableLastAt: Math.max(Number(this.state.queue.guardState.enableLastAt) || 0, activationTime),
        lastAppliedAt: Math.max(Number(this.state.queue.guardState.lastAppliedAt) || 0, activationTime),
        lastWindowOpen: executionWindowOpen(this.state.settings, new Date(activationTime)),
      };
      this.logger(this.storage.recovered
        ? '状态由备份恢复：从当前时刻重新计算守护计划，不补执行恢复前的停止/启用事件'
        : '首次启用新版状态：从当前时刻开始计算守护计划，不补执行迁移前的停止/启用事件');
    }
    this.pruneExpired();
    const guardLatchNormalized = Boolean(legacyGuardAttention)
      || JSON.stringify(storedStopOwnershipPending || null) !== JSON.stringify(this.state.queue.guardState.stopOwnershipPending)
      || JSON.stringify(storedStopBasePause || null) !== JSON.stringify(this.state.queue.guardState.stopBasePause);
    if (this.hasGuardStopOwnershipPending()) this.enforceGuardStopOwnershipPause();
    if ((migration.migrated || this.storage.migrated || this.storage.recovered || hiddenSessionsNormalized || guardLatchNormalized) && this.storage.healthy) {
      if (migration.migrated) this.logger(`已把旧版完成判定迁移为精确末行标记 ${DEFAULT_COMPLETION_MARKER}`);
      if (hiddenSessionsNormalized) this.logger('已清理无效或重复的隐藏会话记录');
      this.commit();
    }
  }

  get settings() { return this.state.settings; }
  get tasks() { return this.state.tasks; }
  get queue() { return this.state.queue; }
  get revision() { return this.state.revision; }

  modelRef() {
    const plan = this.plans[this.settings.plan] ? this.settings.plan : DEFAULT_SETTINGS.plan;
    return `${plan}/${this.settings.model || DEFAULT_SETTINGS.model}`;
  }

  pruneExpired() {
    const cutoff = this.now() - IDEMPOTENCY_TTL_MS;
    this.state.idempotency = this.state.idempotency.filter((entry) => Number(entry.createdAt) >= cutoff).slice(-200);
    const trashCutoff = this.now() - 7 * 24 * 60 * 60 * 1000;
    this.state.tasks = this.state.tasks.filter((task) => !task.deletedAt || Number(task.deletedAt) >= trashCutoff);
  }

  commit({ notify = true } = {}) {
    if (!this.storage.healthy) throw new RuntimeError(`存储不可写：${this.storage.error}`, 503, 'STORAGE_UNAVAILABLE');
    this.pruneExpired();
    this.state.generation += 1;
    this.state.revision += 1;
    try {
      this.store.save(this.state);
    } catch (error) {
      this.storage.healthy = false;
      this.storage.error = error.message;
      this.queue.paused = true;
      this.queue.pausedBySystem = true;
      this.queue.pauseReason = { kind: 'storage-fatal', message: error.message, since: this.now() };
      this.onChange();
      throw new RuntimeError(`状态保存失败，队列已安全暂停：${error.message}`, 503, 'STORAGE_WRITE_FAILED');
    }
    if (notify) this.onChange();
    return this.state.revision;
  }

  logTask(task, line) {
    if (!Array.isArray(task.logs)) task.logs = [];
    task.logs.push(`[${new Date(this.now()).toLocaleTimeString('zh-CN', { hour12: false })}] ${line}`);
    if (task.logs.length > 200) task.logs.splice(0, task.logs.length - 200);
  }

  findTask(id) {
    return this.tasks.find((task) => task.id === id);
  }

  pendingTasks() {
    return this.tasks.filter((task) => !task.deletedAt && task.status === TASK_STATUS.PENDING);
  }

  guardStopOwnershipPending() {
    const pending = this.queue.guardState && this.queue.guardState.stopOwnershipPending;
    return pending && typeof pending === 'object' && !Array.isArray(pending) ? pending : null;
  }

  hasGuardStopOwnershipPending() {
    return Boolean(this.guardStopOwnershipPending());
  }

  guardStopBasePause() {
    return normalizedStopBasePause(this.queue.guardState && this.queue.guardState.stopBasePause, this.now());
  }

  setGuardStopBasePause(value, { commit = true } = {}) {
    const requested = normalizedStopBasePause(value, this.now());
    if (!requested) return null;
    const current = this.guardStopBasePause();
    // Safety pauses form a base layer below task/guard attention. Weaker
    // automatic pauses cannot erase explicit or recovery/failure gates.
    const selected = current && basePausePriority(current) > basePausePriority(requested)
      ? current : requested;
    this.queue.guardState.stopBasePause = selected;
    if (commit) this.commit();
    return selected;
  }

  clearGuardStopBasePause(kind = null, { commit = true } = {}) {
    const current = this.guardStopBasePause();
    if (!current || kind && current.kind !== kind) return false;
    this.queue.guardState.stopBasePause = null;
    if (commit) this.commit();
    return true;
  }

  enforceGuardStopOwnershipPause() {
    const pending = this.guardStopOwnershipPending();
    if (!pending) return false;
    this.queue.paused = true;
    const reason = this.queue.pauseReason;
    const ownsVisiblePause = !reason
      || reason.kind === 'attention' && reason.source === 'guard-stop-ownership'
      || pending.guardPauseApplied && reason.kind === 'auto-stop';
    if (ownsVisiblePause) {
      this.queue.pausedBySystem = true;
      this.queue.pauseReason = {
        kind: 'attention',
        source: 'guard-stop-ownership',
        message: pending.message,
        since: pending.since,
      };
    }
    if (this.nextTimer) this.timers.clearTimeout(this.nextTimer);
    this.nextTimer = null;
    if (this.current && this.current.nextAttemptHandle) {
      this.timers.clearTimeout(this.current.nextAttemptHandle);
      this.current.nextAttemptHandle = null;
    }
    return true;
  }

  setGuardStopOwnershipPending({ source = 'scheduled', eventTime = null, message, guardPauseApplied = false, basePause = null } = {}, { commit = true } = {}) {
    const existing = this.guardStopOwnershipPending();
    const resolvedSource = existing && existing.source || (source === 'manual-api' ? 'manual-api' : 'scheduled');
    const since = existing && existing.since || this.now();
    const requestedBase = normalizedStopBasePause(basePause, since);
    const currentBase = strongestBasePause(
      normalizedStopBasePause(existing && existing.basePause, since),
      this.guardStopBasePause(),
      normalizedStopBasePause(this.queue.pauseReason, since),
    );
    let resolvedBase = currentBase || requestedBase || normalizedStopBasePause({
      kind: resolvedSource === 'manual-api' ? 'manual' : 'auto-stop', since,
    }, since);
    if (requestedBase && basePausePriority(requestedBase) >= basePausePriority(resolvedBase)) resolvedBase = requestedBase;
    const pending = {
      source: resolvedSource,
      eventTime: existing && existing.eventTime != null ? existing.eventTime
        : eventTime != null && Number.isFinite(Number(eventTime)) ? Number(eventTime) : null,
      since,
      message: String(message || existing && existing.message || 'ZCode.app 停止状态尚未验证').slice(0, 500),
      guardPauseApplied: Boolean(existing && existing.guardPauseApplied || guardPauseApplied),
      basePause: resolvedBase,
    };
    this.queue.guardState.stopOwnershipPending = pending;
    this.enforceGuardStopOwnershipPause();
    if (commit) this.commit();
    return pending;
  }

  clearGuardStopOwnershipPending({ commit = true } = {}) {
    const pending = this.guardStopOwnershipPending();
    if (!pending) return null;
    const basePause = normalizedStopBasePause(pending.basePause, pending.since)
      || normalizedStopBasePause({
        kind: pending.source === 'manual-api' ? 'manual' : 'auto-stop',
        since: pending.since,
      }, pending.since);
    this.setGuardStopBasePause(basePause, { commit: false });
    this.queue.guardState.stopOwnershipPending = null;
    if (this.queue.pauseReason && this.queue.pauseReason.kind === 'attention'
      && this.queue.pauseReason.source === 'guard-stop-ownership') {
      this.queue.paused = true;
      this.queue.pausedBySystem = basePause.kind !== 'manual';
      this.queue.pauseReason = clone(basePause);
    }
    if (commit) this.commit();
    return pending;
  }

  dispatchBlocked() {
    return this.queue.paused || this.hasGuardStopOwnershipPending();
  }

  clearRuntimeTimers() {
    if (this.nextTimer) this.timers.clearTimeout(this.nextTimer);
    this.nextTimer = null;
    if (this.current) {
      if (this.current.pollHandle) this.timers.clearInterval(this.current.pollHandle);
      if (this.current.timeoutHandle) this.timers.clearTimeout(this.current.timeoutHandle);
      if (this.current.nextAttemptHandle) this.timers.clearTimeout(this.current.nextAttemptHandle);
      this.current.pollHandle = null;
      this.current.timeoutHandle = null;
      this.current.nextAttemptHandle = null;
    }
  }

  handleCallbackError(context, error) {
    this.logger(`${context}: ${error.stack || error.message}`);
    if (!this.storage.healthy) {
      this.clearRuntimeTimers();
      this.current = null;
    }
  }

  start() {
    this.stopped = false;
    this.reconcileOnStartup();
    this.kick();
  }

  shellGroupAlive(shell) {
    if (process.platform === 'win32') {
      // Windows does not support Unix process groups, only monitor the main process
      return !shell.closed && shell.child.exitCode === null;
    }
    
    if (!shell.pgid) return false;
    
    try {
      process.kill(-shell.pgid, 0);
      // Success indicates process group exists
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') {
        // Clearly proven that process group does not exist
        return false;
      }
      if (error.code === 'EPERM') {
        // Process group exists but no access permission, conservatively assume still alive
        return true;
      }
      // Other errors unknown, handle conservatively
      return true;
    }
  }

  async signalShellAndWait(shell, signal, timeoutMs) {
    const onClose = () => { shell.closed = true; };
    shell.child.once('close', onClose);
    // Signal the process group even when the shell leader already has an exit
    // code: background descendants can still be alive under the same PGID.
    try {
      shell.lastSignal = signal;
      if (shell.terminate) shell.terminate(signal);
      else shell.child.kill(signal);
    } catch {}
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.shellGroupAlive(shell) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
    }
    if (typeof shell.child.off === 'function') shell.child.off('close', onClose);
    return !this.shellGroupAlive(shell);
  }

  finishShellResult(shell, task, code, signal, stdout = shell.stdout || '') {
    task.result = String(stdout).slice(-4000).trim() || null;
    const stopReason = shell.stopReason || task.execution && task.execution.stopRequested && task.execution.stopRequested.kind;
    const timedOut = stopReason === 'timeout' || Boolean(task.error && task.error.startsWith('超时'));
    const status = timedOut ? TASK_STATUS.TIMEOUT
      : stopReason || signal === 'SIGTERM' || signal === 'SIGKILL' ? TASK_STATUS.STOPPED
        : code === 0 ? TASK_STATUS.DONE : TASK_STATUS.FAILED;
    const stoppedMessage = stopReason === 'manual' ? '已手动停止'
      : stopReason === 'shutdown' ? '服务停止时已终止 Shell 进程组' : null;
    this.finishTask(task, status, code, task.error || stoppedMessage || (status === TASK_STATUS.FAILED ? `退出码 ${code}` : null));
  }

  async finalizeShellClose(shell, task, code, signal, stdout) {
    if (!this.current || this.current !== shell || shell.finalizing) return;
    shell.closed = true;
    shell.finalizing = true;
    try {
      let groupGone = !this.shellGroupAlive(shell);
      if (!groupGone) {
        this.logTask(task, 'Shell 主进程已结束，正在清理仍存活的后台子进程');
        groupGone = await this.signalShellAndWait(shell, 'SIGTERM', this.shellShutdownGraceMs);
        if (!groupGone) groupGone = await this.signalShellAndWait(shell, 'SIGKILL', this.shellKillWaitMs);
      }
      if (!this.current || this.current !== shell) return;
      if (!groupGone) {
        task.clientMayStillBeRunning = true;
        return this.enterAttention(
          task,
          'shell-descendants-uncertain',
          'Shell 已结束，但未能确认其后台子进程已退出',
          { pid: shell.child.pid || null },
          true,
        );
      }
      this.finishShellResult(shell, task, code, signal, stdout);
    } catch (error) {
      this.handleCallbackError('记录 Shell 结果失败', error);
    }
  }

  terminateShellWithWatchdog(shell, task, reason) {
    if (!shell || !this.current || this.current !== shell) return Promise.resolve(false);
    if (shell.stopWatchdog) return shell.stopWatchdog;
    shell.stopReason ||= reason;
    if (task.execution && !task.execution.stopRequested) {
      task.execution.stopRequested = { kind: shell.stopReason, at: this.now() };
    }
    const watchdog = (async () => {
      const stoppedAfterTerm = await this.signalShellAndWait(shell, 'SIGTERM', this.shellShutdownGraceMs);
      if (!this.current || this.current !== shell) return stoppedAfterTerm;
      if (shell.finalizing) {
        if (shell.closeFinalizer) await shell.closeFinalizer;
        return !this.shellGroupAlive(shell);
      }
      const groupGone = stoppedAfterTerm || await this.signalShellAndWait(shell, 'SIGKILL', this.shellKillWaitMs);
      if (!this.current || this.current !== shell) return groupGone;
      if (shell.finalizing) {
        if (shell.closeFinalizer) await shell.closeFinalizer;
        return !this.shellGroupAlive(shell);
      }
      if (groupGone) {
        const code = shell.child.exitCode === undefined ? null : shell.child.exitCode;
        const signal = shell.child.signalCode || shell.lastSignal || null;
        // The process-group probe is our exit evidence when Node's close event is
        // lost. Claim finalization before recording the result so a late close
        // callback cannot finalize the same task a second time.
        shell.closed = true;
        shell.finalizing = true;
        this.finishShellResult(shell, task, code, signal, shell.stdout || '');
        return true;
      }
      shell.finalizing = true;
      task.clientMayStillBeRunning = true;
      this.enterAttention(
        task,
        'shell-termination-uncertain',
        '已发送 TERM 和 KILL，但未能确认 Shell 进程组已退出',
        {
          pid: shell.child.pid || null,
          stopReason: shell.stopReason || reason,
          termGraceMs: this.shellShutdownGraceMs,
          killWaitMs: this.shellKillWaitMs,
        },
        true,
      );
      return false;
    })().catch((error) => {
      if (this.current && this.current === shell && !shell.finalizing) {
        shell.finalizing = true;
        task.clientMayStillBeRunning = true;
        try {
          this.enterAttention(
            task,
            'shell-termination-watchdog-error',
            `终止 Shell 进程组时发生错误：${error.message}`,
            { pid: shell.child.pid || null, stopReason: shell.stopReason || reason },
            true,
          );
        } catch (attentionError) {
          this.handleCallbackError('记录 Shell 终止异常失败', attentionError);
        }
      } else {
        this.handleCallbackError('Shell 终止监控异常', error);
      }
      return false;
    });
    shell.stopWatchdog = watchdog;
    return watchdog;
  }

  async shutdown() {
    this.stopped = true;
    const activeShell = this.current && this.current.kind === 'shell' && this.current.child ? this.current : null;
    if (activeShell) {
      activeShell.stopReason ||= 'shutdown';
      const activeTask = this.findTask(activeShell.taskId);
      if (activeTask && activeTask.execution && !activeTask.execution.stopRequested) {
        activeTask.execution.stopRequested = { kind: activeShell.stopReason, at: this.now() };
      }
    }
    const existingStopWatchdog = activeShell && activeShell.stopWatchdog;
    const shell = activeShell
      ? { ...activeShell, task: this.findTask(activeShell.taskId) }
      : null;
    this.clearRuntimeTimers();
    if (existingStopWatchdog) {
      await existingStopWatchdog;
    } else if (shell) {
      if (shell.task) {
        shell.task.activity = '服务停止中，正在终止 Shell 进程组…';
        this.logTask(shell.task, '服务停止：正在终止 Shell 进程组');
      }
      const closedAfterTerm = await this.signalShellAndWait(shell, 'SIGTERM', this.shellShutdownGraceMs);
      const groupGone = closedAfterTerm || await this.signalShellAndWait(shell, 'SIGKILL', this.shellKillWaitMs);
      if (this.current && this.current.taskId === shell.taskId) {
        if (groupGone && shell.task) {
          this.finishTask(shell.task, TASK_STATUS.STOPPED, null, '服务停止时已终止 Shell 进程组');
        } else {
          this.clearRuntimeTimers();
          this.current = null;
        }
        if (!groupGone && shell.task) {
          shell.task.clientMayStillBeRunning = true;
          this.markAttentionWithoutCommit(
            shell.task,
            'shell-shutdown-uncertain',
            '服务停止时未能确认 Shell 进程组已退出',
            { pid: shell.child.pid || null },
            true,
          );
        }
      }
    }
    if (this.storage.healthy) this.commit({ notify: false });
  }

  reconcileOnStartup() {
    const active = this.tasks.filter((task) => nonTerminal(task) && task.status !== TASK_STATUS.PENDING);
    if (active.length > 1) {
      for (const task of active) this.markAttentionWithoutCommit(task, 'multiple-active-tasks', '重启时发现多个非终态任务，已阻止自动派发', { activeTaskIds: active.map((item) => item.id) }, true);
      this.commit();
      return;
    }
    const task = active[0];
    if (!task) return;
    if (task.phase === TASK_PHASE.ATTENTION || task.status === TASK_STATUS.ATTENTION) {
      const alreadyPaused = this.queue.paused && this.queue.pausedBySystem
        && this.queue.pauseReason && this.queue.pauseReason.kind === 'attention'
        && this.queue.pauseReason.taskId === task.id;
      this.queue.paused = true;
      this.queue.pausedBySystem = true;
      if (!alreadyPaused) {
        this.queue.pauseReason = { kind: 'attention', taskId: task.id, message: task.attention && task.attention.message || '任务需要人工确认', since: task.attention && task.attention.since || this.now() };
        this.commit();
      }
      return;
    }
    if (task.type === 'shell') {
      this.markAttentionWithoutCommit(task, 'shell-process-unknown', '服务重启后无法确认 Shell 子进程是否仍在运行', {}, true);
      this.commit();
      return;
    }
    this.current = { taskId: task.id, kind: 'client', pollHandle: null, timeoutHandle: null, nextAttemptHandle: null };
    if (!task.execution || !task.execution.automationId) {
      this.enterAttention(task, 'missing-execution-context', '缺少可对账的派发记录，拒绝自动重派', {}, true);
      return;
    }
    if (task.phase === TASK_PHASE.BETWEEN_ATTEMPTS) {
      this.scheduleAttempt(task);
      return;
    }
    if (task.phase === TASK_PHASE.DISPATCHING) {
      // A persisted dispatch intent is not permission to write it while the
      // queue is paused (especially while guard ownership is unresolved).
      // Keep `current` attached to the intent so a later resume/kick can
      // continue the exact same attempt without creating a duplicate.
      if (this.dispatchBlocked()) return;
      const status = this.client.queryAutomation(task.execution.automationId);
      if (status.phase === 'gone') {
        try {
          this.insertPersistedIntent(task);
          task.phase = TASK_PHASE.WAITING_DISPATCH;
          task.status = TASK_STATUS.WAITING;
          task.execution.automationObservedAt = this.now();
          this.commit();
        } catch (error) {
          this.enterAttention(task, 'reconcile-dispatch-failed', error.message, error.evidence || {}, true);
          return;
        }
      } else if (status.phase === 'tracked') {
        try { if (status.automation) this.insertPersistedIntent(task); }
        catch (error) { this.enterAttention(task, 'reconcile-intent-conflict', error.message, error.evidence || status, true); return; }
        if (status.run) task.execution.runId = status.run.run_id || null;
        const sessionId = status.sessionId || task.targetSessionId || null;
        task.phase = status.run && sessionId ? TASK_PHASE.RUNNING : TASK_PHASE.WAITING_DISPATCH;
        task.status = status.run && sessionId ? TASK_STATUS.RUNNING : TASK_STATUS.WAITING;
        if (status.run && sessionId) {
          task.sessionId = sessionId;
          task.execution.dispatchedAt = Number(status.run.created_at) || task.execution.dispatchedAt || this.now();
          task.clientMayStillBeRunning = !status.run.outcome || status.run.outcome === 'running';
        }
        task.execution.automationObservedAt = this.now();
        this.commit();
      } else {
        this.enterAttention(task, 'reconcile-database-unavailable', status.error || '客户端数据库不可用', status, true);
        return;
      }
    }
    if (task.phase !== TASK_PHASE.DISPATCHING) {
      const status = this.client.queryAutomation(task.execution.automationId);
      if (status.phase === 'gone') {
        this.enterAttention(task, 'reconcile-automation-missing', '重启时找不到已观察过的调度记录，无法证明客户端是否执行过', status, true);
        return;
      }
      if (status.phase !== 'tracked') {
        this.enterAttention(task, 'reconcile-database-unavailable', status.error || '客户端数据库不可用', status, true);
        return;
      }
      try { if (status.automation) this.insertPersistedIntent(task); }
      catch (error) { this.enterAttention(task, 'reconcile-intent-conflict', error.message, error.evidence || status, true); return; }
    }
    this.ensureClientPoll(task, 0);
  }

  scheduleNext(delaySec = 0) {
    if (this.stopped || this.current || this.dispatchBlocked() || !this.pendingTasks().length) return;
    if (this.nextTimer) this.timers.clearTimeout(this.nextTimer);
    this.nextTimer = this.timers.setTimeout(() => {
      this.nextTimer = null;
      try {
        this.startNext();
      } catch (error) {
        // Timer callbacks must never turn an operational failure (for example a
        // temporarily unreadable client DB) into an uncaught process crash.
        this.logger(`启动下一个任务失败: ${error.stack || error.message}`);
        if (!this.storage.healthy) {
          this.clearRuntimeTimers();
          this.current = null;
          return;
        }
        const task = this.current && this.findTask(this.current.taskId);
        if (task && !TERMINAL_STATUSES.has(task.status) && task.phase !== TASK_PHASE.ATTENTION) {
          this.enterAttention(task, 'runtime-start-failed', `任务启动失败：${error.message}`, {}, false);
        }
      }
    }, Math.max(0, Number(delaySec) || 0) * 1000);
  }

  kick() {
    if (this.dispatchBlocked()) return;
    if (this.current) {
      const task = this.findTask(this.current.taskId);
      if (!task || this.current.nextAttemptHandle) return;
      if (task.phase === TASK_PHASE.BETWEEN_ATTEMPTS) this.scheduleAttempt(task);
      else if (task.phase === TASK_PHASE.DISPATCHING) this.tryPersistDispatch(task);
      return;
    }
    if (!this.nextTimer && this.pendingTasks().length) this.scheduleNext(0);
  }

  startNext() {
    if (this.current || this.dispatchBlocked()) return;
    const next = this.pendingTasks()[0];
    if (!next) return;
    const bypass = this.bypassWindowTaskId === next.id;
    if (!executionWindowOpen(this.settings, new Date(this.now())) && !bypass) return;
    this.bypassWindowTaskId = null;
    this.runTask(next);
  }

  resolveTimeoutMinutes(task) {
    return task.timeoutMin === null || task.timeoutMin === undefined ? Number(this.settings.defaultTimeoutMin || 0) : Number(task.timeoutMin);
  }

  runTask(task) {
    if (!task || task.status !== TASK_STATUS.PENDING || this.dispatchBlocked()) return;
    if (task.cwd) {
      try {
        if (!fs.statSync(task.cwd).isDirectory()) throw new Error('不是目录');
      } catch (error) {
        task.startedAt = this.now();
        return this.finishTask(task, TASK_STATUS.FAILED, null, `工作目录不可用: ${task.cwd} (${error.message})`);
      }
    }
    task.startedAt = this.now();
    task.finishedAt = null;
    task.error = null;
    task.result = null;
    task.activity = '';
    task.attempt = 0;
    task.round = 0;
    task.phase = null;
    task.execution = null;
    task.attention = null;
    task.clientMayStillBeRunning = false;
    if (task.type === 'shell') this.startShellTask(task);
    else this.startClientTask(task);
  }

  startShellTask(task) {
    const timeoutMin = this.resolveTimeoutMinutes(task);
    task.status = TASK_STATUS.RUNNING;
    task.phase = TASK_PHASE.RUNNING;
    task.activity = '执行命令…';
    task.execution = {
      startedAt: task.startedAt,
      timeoutDeadlineAt: timeoutMin > 0 ? task.startedAt + timeoutMin * 60 * 1000 : null,
    };
    this.current = {
      taskId: task.id,
      kind: 'shell',
      child: null,
      pollHandle: null,
      timeoutHandle: null,
      nextAttemptHandle: null,
      stopWatchdog: null,
      closeFinalizer: null,
      stdout: '',
      lastSignal: null,
    };
    this.commit();
    let child;
    try {
      child = this.spawn('/bin/zsh', ['-lc', task.prompt], {
        cwd: task.cwd || this.root,
        // A separate process group lets stop/timeout terminate descendants too,
        // instead of leaving a grandchild command running after the shell exits.
        detached: process.platform !== 'win32',
        // Queue commands are non-interactive. Give stdin an immediate EOF so a
        // command such as `cat` cannot occupy the queue forever waiting on a
        // pipe that the server will never write to.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.current.child = child;
      this.current.pgid = process.platform !== 'win32' && child.pid ? child.pid : null;
      this.current.closed = false;
      this.current.finalizing = false;
    } catch (error) {
      this.finishTask(task, TASK_STATUS.FAILED, null, `进程启动失败: ${error.message}`);
      return;
    }
    const terminate = (signal) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    this.current.terminate = terminate;
    const shell = this.current;
    if (timeoutMin > 0) {
      this.current.timeoutHandle = this.timers.setTimeout(() => {
        if (!this.current || this.current !== shell) return;
        shell.stopReason ||= 'timeout';
        if (task.execution && !task.execution.stopRequested) task.execution.stopRequested = { kind: shell.stopReason, at: this.now() };
        task.clientMayStillBeRunning = true;
        task.error = `超时（${timeoutMin} 分钟）`;
        this.logTask(task, `[超时] 已运行 ${timeoutMin} 分钟，正在终止`);
        this.terminateShellWithWatchdog(shell, task, 'timeout');
      }, timeoutMin * 60 * 1000);
    }
    const append = (chunk, isError) => {
      for (const raw of String(chunk).split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        this.logTask(task, `${isError ? '[stderr] ' : ''}${line}`);
        task.activity = line.slice(0, 200);
      }
      this.onChange();
    };
    child.stdout.on('data', (chunk) => {
      // The task result only exposes the tail. Bound memory for noisy or
      // long-running commands while the per-line task log is capped separately.
      shell.stdout = `${shell.stdout}${String(chunk)}`.slice(-16000);
      append(chunk, false);
    });
    child.stderr.on('data', (chunk) => append(chunk, true));
    child.on('error', (error) => {
      if (this.current && this.current.taskId === task.id) {
        if (shell.finalizing) return;
        shell.finalizing = true;
        try { this.finishTask(task, TASK_STATUS.FAILED, null, `进程错误: ${error.message}`); }
        catch (finishError) { this.handleCallbackError('记录 Shell 进程错误失败', finishError); }
      }
    });
    child.on('close', (code, signal) => {
      shell.closeFinalizer ||= this.finalizeShellClose(shell, task, code, signal, shell.stdout);
    });
  }

  startClientTask(task) {
    this.current = { taskId: task.id, kind: 'client', pollHandle: null, timeoutHandle: null, nextAttemptHandle: null };
    task.status = TASK_STATUS.WAITING;
    task.execution = { startedAt: task.startedAt };
    this.beginClientAttempt(task);
  }

  dispatchFields(task) {
    const workspace = this.client.taskWorkspace(task.targetSessionId, task.cwd);
    return {
      title: task.name,
      prompt: task.type === 'continue' ? this.settings.continuePrompt : task.prompt,
      workspace,
      targetTaskId: task.type === 'continue' ? task.targetSessionId : null,
      modelRef: this.modelRef(),
    };
  }

  beginClientAttempt(task) {
    if (this.dispatchBlocked()) return;
    const timeoutMin = this.resolveTimeoutMinutes(task);
    const timeoutDeadlineAt = task.execution && task.execution.timeoutDeadlineAt
      || (timeoutMin > 0 ? task.startedAt + timeoutMin * 60 * 1000 : null);
    if (timeoutDeadlineAt && this.now() >= timeoutDeadlineAt) {
      return this.finishTask(task, TASK_STATUS.TIMEOUT, null, '等待下一轮时已达到任务总超时');
    }
    const attempt = Number(task.attempt || 0) + 1;
    const fields = this.dispatchFields(task);
    const automationId = deterministicAutomationId(task.id, attempt);
    const baselineCursor = task.type === 'continue' ? this.client.messageCursor(task.targetSessionId) : null;
    if (task.type === 'continue' && !baselineCursor) {
      return this.finishTask(task, TASK_STATUS.FAILED, null, '无法读取续跑会话的消息基线，未向客户端派发');
    }
    task.attempt = attempt;
    task.round = attempt - 1;
    task.status = TASK_STATUS.WAITING;
    task.phase = TASK_PHASE.DISPATCHING;
    task.activity = `第 ${attempt} 轮：正在写入客户端调度器…`;
    task.automationId = automationId;
    task.execution = {
      automationId,
      attempt,
      runId: null,
      startedAt: task.startedAt,
      timeoutDeadlineAt,
      dispatchStartedAt: this.now(),
      automationObservedAt: null,
      dispatchedAt: null,
      dispatchDeadlineAt: this.now() + this.dispatchWaitMs,
      baselineCursor,
      completionMarker: this.settings.completionMarker,
      nextAttemptAt: null,
      dbErrorSince: null,
      terminalOutcome: null,
      terminalObservedAt: null,
      dispatchErrorSince: null,
      fingerprint: fields,
    };
    this.commit();
    this.checkpoint('after-dispatch-intent', clone(task));
    this.tryPersistDispatch(task);
  }

  isTransientDatabaseError(error) {
    const text = String(error && (error.code || error.message || error) || '');
    return /SQLITE_(?:BUSY|LOCKED)|database (?:table )?is locked|database is busy/i.test(text);
  }

  completePersistedDispatch(task) {
    const execution = task.execution;
    task.phase = TASK_PHASE.WAITING_DISPATCH;
    task.activity = `第 ${task.attempt} 轮：已排入客户端，等待接单…`;
    execution.automationObservedAt = this.now();
    execution.dispatchErrorSince = null;
    this.logTask(task, `第 ${task.attempt} 轮已排入客户端 (${execution.automationId})`);
    this.commit();
    if (this.settings.focusOnDispatch) this.focusWorkspace(execution.fingerprint.workspace);
    this.ensureClientPoll(task);
  }

  scheduleDispatchRetry(task, error) {
    const execution = task.execution;
    if (!execution.dispatchErrorSince) execution.dispatchErrorSince = this.now();
    task.activity = `第 ${task.attempt} 轮：客户端数据库繁忙，将自动重试…`;
    this.logTask(task, `派发暂遇数据库锁：${String(error.message || error).slice(0, 200)}`);
    this.commit();
    if (this.dispatchBlocked()) return;
    if (this.current.nextAttemptHandle) this.timers.clearTimeout(this.current.nextAttemptHandle);
    const remaining = Math.max(0, Number(execution.dispatchDeadlineAt) - this.now());
    this.current.nextAttemptHandle = this.timers.setTimeout(() => {
      if (!this.current || this.current.taskId !== task.id || task.phase !== TASK_PHASE.DISPATCHING) return;
      this.current.nextAttemptHandle = null;
      if (this.dispatchBlocked()) return;
      try { this.tryPersistDispatch(task); }
      catch (retryError) { this.handleCallbackError('重试派发异常', retryError); }
    }, Math.min(this.pollMs, remaining));
  }

  tryPersistDispatch(task) {
    const execution = task.execution;
    if (!execution || task.phase !== TASK_PHASE.DISPATCHING || this.dispatchBlocked()) return;
    if (execution.timeoutDeadlineAt && this.now() >= execution.timeoutDeadlineAt) {
      return this.finishTask(task, TASK_STATUS.TIMEOUT, null, '任务在派发前已达到总超时');
    }
    try {
      this.insertPersistedIntent(task);
      this.checkpoint('after-automation-insert', clone(task));
      this.completePersistedDispatch(task);
    } catch (error) {
      const observed = this.client.queryAutomation(execution.automationId);
      if (this.isTransientDatabaseError(error)
        && this.now() < Number(execution.dispatchDeadlineAt)
        && ['gone', 'error', 'no-db'].includes(observed.phase)) {
        this.scheduleDispatchRetry(task, error);
      } else if (observed.phase === 'gone' && !(error instanceof AutomationConflictError)) {
        this.finishTask(task, TASK_STATUS.FAILED, null, error.message);
      } else {
        this.enterAttention(task, 'dispatch-uncertain', error.message, error.evidence || observed, true);
      }
    }
  }

  insertPersistedIntent(task) {
    const fields = task.execution && task.execution.fingerprint;
    if (!fields) throw new Error('派发意图缺少 fingerprint');
    return this.client.insertOrAdoptAutomation({ automationId: task.execution.automationId, ...fields });
  }

  ensureClientPoll(task, delay = this.pollMs) {
    if (!this.current || this.current.taskId !== task.id) this.current = { taskId: task.id, kind: 'client', pollHandle: null, timeoutHandle: null, nextAttemptHandle: null };
    if (this.current.pollHandle) this.timers.clearInterval(this.current.pollHandle);
    const poll = () => {
      if (!this.current || this.current.taskId !== task.id || task.phase === TASK_PHASE.ATTENTION) return;
      try { this.pollClientTask(task); } catch (error) { this.handleCallbackError('轮询异常', error); }
    };
    if (delay === 0) poll();
    if (!this.current || this.current.taskId !== task.id || task.phase === TASK_PHASE.ATTENTION || TERMINAL_STATUSES.has(task.status)) return;
    this.current.pollHandle = this.timers.setInterval(poll, this.pollMs);
  }

  pollClientTask(task) {
    const execution = task.execution;
    const now = this.now();
    if (!execution) return this.enterAttention(task, 'missing-execution-context', '运行任务缺少执行上下文', {}, true);
    const status = this.client.queryAutomation(execution.automationId);
    if (status.phase === 'no-db' || status.phase === 'error') return this.handleDatabaseError(task, status);
    const timedOut = Boolean(execution.timeoutDeadlineAt && now >= execution.timeoutDeadlineAt);
    if (status.phase === 'gone') {
      return this.enterAttention(task, 'automation-records-lost', '已观察过的调度记录消失，无法证明客户端是否执行过，拒绝自动推进', status, true);
    }
    if (status.terminalDispatchFailure) {
      const dispatchStatus = String(status.run && status.run.dispatch_status || '派发失败');
      const detail = status.run && status.run.error || status.automation && status.automation.last_error || dispatchStatus;
      execution.terminalOutcome = dispatchStatus;
      execution.terminalObservedAt = now;
      task.clientMayStillBeRunning = false;
      return this.finishTask(task, TASK_STATUS.FAILED, null, `客户端未执行任务: ${detail}`);
    }
    if (status.dispatchFailed) {
      if (status.possiblyClaimed) {
        return this.enterAttention(
          task,
          'dispatch-failed-possibly-claimed',
          '客户端报告派发失败，但同时留有可能已接单的证据，拒绝自动清理或推进',
          status,
          true,
        );
      }
      const revoked = this.client.revokeUnclaimedAutomation(execution.automationId);
      if (!revoked.revoked) {
        return this.enterAttention(
          task,
          'dispatch-failed-revoke-failed',
          '客户端报告派发失败，但原子撤销时发现调度可能已接单',
          { observed: status, revoke: revoked },
          true,
        );
      }
      return this.finishTask(task, TASK_STATUS.FAILED, null, `客户端派发失败: ${status.automation.last_error}`);
    }

    const run = status.run;
    if (run) {
      let changed = false;
      const outcome = String(run.outcome || '').toLowerCase();
      const terminalOutcome = Boolean(outcome && outcome !== 'running');
      const sessionId = status.sessionId || task.targetSessionId || null;
      if (!execution.dispatchedAt) {
        execution.dispatchedAt = Number(run.created_at) || now;
        execution.runId = run.run_id || null;
        task.phase = sessionId ? TASK_PHASE.RUNNING : TASK_PHASE.WAITING_DISPATCH;
        task.status = sessionId ? TASK_STATUS.RUNNING : TASK_STATUS.WAITING;
        task.clientMayStillBeRunning = !terminalOutcome;
        this.logTask(task, sessionId ? `客户端已接单，会话 ${sessionId}` : '客户端已接单，正在等待会话映射');
        changed = true;
      }
      if (sessionId && task.sessionId !== sessionId) { task.sessionId = sessionId; changed = true; }
      if (outcome === 'succeeded') {
        if (execution.terminalOutcome !== outcome) {
          execution.terminalOutcome = outcome;
          execution.terminalObservedAt = now;
          changed = true;
        }
        if (changed) this.commit();
        if (now - Number(execution.terminalObservedAt) < this.resultGraceMs) return;
        if (task.type !== 'continue') {
          task.clientMayStillBeRunning = false;
          return this.finishTask(task, TASK_STATUS.DONE, 0, null);
        }
        if (!sessionId) {
          return this.enterAttention(task, 'completed-session-missing', '客户端报告已完成，但无法确定续跑会话', status, false);
        }
        const info = this.client.sessionStatus(sessionId);
        if (info.available === false) return this.handleDatabaseError(task, { phase: 'session-error', error: info.error || '客户端会话数据库不可用' });
        if (execution.dbErrorSince) { execution.dbErrorSince = null; this.commit(); }
        if (info.toolRunning) {
          task.clientMayStillBeRunning = true;
          if (timedOut) return this.enterAttention(task, 'task-timeout', '任务已超时，但会话中仍有工具在运行', { runId: run.run_id }, true);
          let activityAt;
          try { activityAt = this.client.activityAfter(sessionId, execution.baselineCursor); }
          catch (error) { return this.handleDatabaseError(task, { phase: 'session-error', error: error.message }); }
          const activeAt = Math.max(Number(execution.dispatchedAt) || 0, activityAt);
          const stallMs = Number(this.settings.stallMin) * 60 * 1000;
          if (activeAt && now - activeAt >= stallMs) {
            return this.enterAttention(
              task,
              'client-stalled',
              `客户端已报告运行结束，但会话工具状态超过 ${this.settings.stallMin} 分钟未更新`,
              { activeAt, runId: run.run_id, toolRunning: true },
              true,
            );
          }
          return;
        }
        let messages;
        try { messages = this.client.assistantMessagesAfter(sessionId, execution.baselineCursor, 8); }
        catch (error) { return this.handleDatabaseError(task, { phase: 'session-error', error: error.message }); }
        const latest = messages[messages.length - 1];
        const completionMarker = execution.completionMarker || this.settings.completionMarker;
        if (latest && hasExactCompletionMarker(latest.text, completionMarker)) {
          task.result = latest.text.slice(-10000);
          task.clientMayStillBeRunning = false;
          return this.finishTask(task, TASK_STATUS.DONE, 0, null);
        }
        return this.completeAttemptWithoutMarker(task);
      }
      if (outcome && outcome !== 'running') {
        execution.terminalOutcome = outcome;
        execution.terminalObservedAt = now;
        task.clientMayStillBeRunning = false;
        return this.finishTask(task, TASK_STATUS.FAILED, null, `客户端执行失败: ${run.error || outcome}`);
      }
      if (timedOut) return this.enterAttention(task, 'task-timeout', '任务已超时，但客户端任务可能仍在运行', { runId: run.run_id }, true);
      if (!sessionId) {
        if (now >= Number(execution.dispatchDeadlineAt)) {
          return this.enterAttention(task, 'dispatch-timeout-claimed', '客户端已接单但未返回会话，拒绝自动推进', status, true);
        }
        if (changed) this.commit();
        return;
      }
      const info = this.client.sessionStatus(sessionId);
      if (info.available === false) return this.handleDatabaseError(task, { phase: 'session-error', error: info.error || '客户端会话数据库不可用' });
      if (execution.dbErrorSince) { execution.dbErrorSince = null; changed = true; }
      const activity = `第 ${task.attempt} 轮 · ${info.lastActivity || '客户端执行中…'}`;
      if (task.activity !== activity) { task.activity = activity; changed = true; }
      let activityAt;
      try { activityAt = this.client.activityAfter(sessionId, execution.baselineCursor); }
      catch (error) { return this.handleDatabaseError(task, { phase: 'session-error', error: error.message }); }
      const activeAt = Math.max(Number(execution.dispatchedAt) || 0, activityAt);
      const stallMs = Number(this.settings.stallMin) * 60 * 1000;
      if (activeAt && now - activeAt >= stallMs) {
        return this.enterAttention(task, 'client-stalled', `会话超过 ${this.settings.stallMin} 分钟没有本轮新活动，客户端可能仍在运行`, { activeAt, runId: run.run_id }, true);
      }
      if (changed) this.commit();
      return;
    }

    if (execution.dbErrorSince) { execution.dbErrorSince = null; this.commit(); }
    if (timedOut) {
      if (status.possiblyClaimed) return this.enterAttention(task, 'task-timeout-claimed', '任务已超时，客户端可能已接单但尚未返回会话，拒绝自动推进', status, true);
      const revoked = this.client.revokeUnclaimedAutomation(execution.automationId);
      if (!revoked.revoked) {
        return this.enterAttention(task, 'task-timeout-revoke-failed', '任务超时，但原子撤销时发现调度可能已接单', { observed: status, revoke: revoked }, true);
      }
      return this.finishTask(task, TASK_STATUS.TIMEOUT, null, '任务在客户端接单前超时');
    }
    if (now >= Number(execution.dispatchDeadlineAt)) {
      if (status.possiblyClaimed) return this.enterAttention(task, 'dispatch-timeout-claimed', '客户端可能已接单但未返回会话，拒绝自动推进', status, true);
      const revoked = this.client.revokeUnclaimedAutomation(execution.automationId);
      if (!revoked.revoked) {
        return this.enterAttention(task, 'dispatch-timeout-revoke-failed', '客户端长时间未接单，但原子撤销时发现调度可能已接单', { observed: status, revoke: revoked }, true);
      }
      return this.finishTask(task, TASK_STATUS.FAILED, null, '客户端长时间未接单（请确认 ZCode 正在运行）');
    }
  }

  handleDatabaseError(task, status) {
    const execution = task.execution;
    if (!execution.dbErrorSince) {
      execution.dbErrorSince = this.now();
      this.logTask(task, `客户端数据库暂时不可用: ${status.error || status.phase}`);
      this.commit();
    }
    this.client.reopen();
    if (this.now() - Number(execution.dbErrorSince) >= this.dbErrorGraceMs
      || !execution.dispatchedAt && this.now() >= Number(execution.dispatchDeadlineAt || Infinity)
      || execution.timeoutDeadlineAt && this.now() >= execution.timeoutDeadlineAt) {
      return this.enterAttention(task, 'client-database-unavailable', '客户端数据库持续不可用，无法确认任务是否已经执行', status, true);
    }
  }

  completeAttemptWithoutMarker(task) {
    task.clientMayStillBeRunning = false;
    const completionMarker = task.execution && task.execution.completionMarker || this.settings.completionMarker;
    if (task.attempt >= Number(this.settings.maxRounds)) {
      return this.finishTask(task, TASK_STATUS.FAILED, null, `已执行 ${this.settings.maxRounds} 轮，最终回复仍未以 ${completionMarker} 结束`);
    }
    if (this.current && this.current.pollHandle) {
      this.timers.clearInterval(this.current.pollHandle);
      this.current.pollHandle = null;
    }
    const oldId = task.execution.automationId;
    task.phase = TASK_PHASE.BETWEEN_ATTEMPTS;
    task.status = TASK_STATUS.WAITING;
    task.execution.nextAttemptAt = this.now() + Math.max(0, Number(this.settings.intervalSec) || 0) * 1000;
    task.activity = `等待第 ${task.attempt + 1} 轮推进…`;
    this.logTask(task, `第 ${task.attempt} 轮结束但没有精确完成标记`);
    this.commit();
    this.checkpoint('after-between-attempts', clone(task));
    if (!this.client.cleanupAutomation(oldId)) {
      return this.enterAttention(task, 'completed-attempt-cleanup-failed', '上一轮已结束，但无法确认旧调度记录已清理，拒绝派发下一轮', { automationId: oldId }, true);
    }
    this.scheduleAttempt(task);
  }

  scheduleAttempt(task) {
    if (!this.current || this.current.taskId !== task.id) this.current = { taskId: task.id, kind: 'client', pollHandle: null, timeoutHandle: null, nextAttemptHandle: null };
    if (this.current.nextAttemptHandle) this.timers.clearTimeout(this.current.nextAttemptHandle);
    this.current.nextAttemptHandle = null;
    if (this.dispatchBlocked()) return;
    const delay = Math.max(0, Number(task.execution.nextAttemptAt || this.now()) - this.now());
    this.current.nextAttemptHandle = this.timers.setTimeout(() => {
      try {
        if (!this.current || this.current.taskId !== task.id || task.phase !== TASK_PHASE.BETWEEN_ATTEMPTS) return;
        this.current.nextAttemptHandle = null;
        if (this.dispatchBlocked()) return;
        if (task.execution && task.execution.timeoutDeadlineAt && this.now() >= task.execution.timeoutDeadlineAt) {
          this.finishTask(task, TASK_STATUS.TIMEOUT, null, '等待下一轮时已达到任务总超时');
          return;
        }
        const previousId = task.execution && task.execution.automationId;
        const previous = this.client.queryAutomation(previousId);
        if (previous.phase === 'no-db' || previous.phase === 'error') {
          this.enterAttention(task, 'next-attempt-database-unavailable', '准备下一轮时无法核对上一轮调度状态', previous, true);
          return;
        }
        if (previous.phase === 'tracked') {
          const mappingCount = Number(previous.mappingCount || (previous.mappedTask ? 1 : 0));
          const nonCompletedMappingCount = Number(
            previous.nonCompletedMappingCount
            ?? (previous.mappedTask && previous.mappedTask.task_status !== 'completed' ? 1 : 0),
          );
          const persistedOutcome = String(task.execution && task.execution.terminalOutcome || '').toLowerCase();
          const observedOutcome = String(previous.run && previous.run.outcome || '').toLowerCase();
          if (nonCompletedMappingCount > 0) {
            this.enterAttention(task, 'late-previous-task-mapping', '上一轮仍关联非 completed 客户端任务，拒绝并发派发下一轮', previous, true);
            return;
          }
          const completedMappingOnly = mappingCount > 0
            && !previous.automation
            && !previous.run
            && persistedOutcome === 'succeeded';
          if (!completedMappingOnly) {
            if (persistedOutcome !== 'succeeded' || observedOutcome !== 'succeeded') {
              this.enterAttention(task, 'late-previous-attempt', '上一轮记录与已持久化的成功结果不一致，拒绝并发派发下一轮', previous, true);
              return;
            }
            if (!this.client.cleanupAutomation(previousId)) {
              this.enterAttention(task, 'previous-attempt-cleanup-failed', '准备下一轮时无法清理上一轮终态记录', previous, true);
              return;
            }
          }
        }
        this.beginClientAttempt(task);
      } catch (error) {
        this.logger(`启动下一轮失败: ${error.stack || error.message}`);
        if (!this.storage.healthy) {
          this.clearRuntimeTimers();
          this.current = null;
        } else if (task.phase !== TASK_PHASE.ATTENTION && !TERMINAL_STATUSES.has(task.status)) {
          this.enterAttention(task, 'next-attempt-start-failed', `启动下一轮失败：${error.message}`, {}, false);
        }
      }
    }, delay);
  }

  markAttentionWithoutCommit(task, code, message, evidence, possible) {
    task.status = TASK_STATUS.ATTENTION;
    task.phase = TASK_PHASE.ATTENTION;
    task.clientMayStillBeRunning = Boolean(possible);
    task.attention = task.attention || { code, since: this.now(), message, evidence: clone(evidence || {}) };
    task.error = message;
    task.activity = '需要人工确认后才能继续队列';
    this.syncAttentionPause(task);
  }

  syncAttentionPause(preferredTask = null) {
    const attentionTasks = this.tasks.filter((item) => !item.deletedAt && item.status === TASK_STATUS.ATTENTION);
    if (attentionTasks.length) {
      const visibleBase = normalizedStopBasePause(this.queue.pauseReason, this.now());
      if (visibleBase) this.setGuardStopBasePause(visibleBase, { commit: false });
      const currentId = this.queue.pauseReason && this.queue.pauseReason.kind === 'attention'
        ? this.queue.pauseReason.taskId : null;
      const selected = preferredTask && attentionTasks.includes(preferredTask) ? preferredTask
        : attentionTasks.find((item) => item.id === currentId) || attentionTasks[0];
      this.queue.paused = true;
      this.queue.pausedBySystem = true;
      this.queue.pauseReason = {
        kind: 'attention', taskId: selected.id,
        message: selected.attention && selected.attention.message || selected.error || '任务需要人工确认',
        since: selected.attention && selected.attention.since || this.now(),
        count: attentionTasks.length,
      };
      return true;
    }
    if (this.queue.pauseReason && this.queue.pauseReason.kind === 'attention'
      && this.queue.pauseReason.source !== 'guard-stop-ownership') {
      this.queue.paused = false;
      this.queue.pausedBySystem = false;
      this.queue.pauseReason = null;
    }
    if (this.hasGuardStopOwnershipPending()) return this.enforceGuardStopOwnershipPause();
    const basePause = this.guardStopBasePause();
    if (basePause) {
      this.queue.paused = true;
      this.queue.pausedBySystem = basePause.kind !== 'manual';
      this.queue.pauseReason = clone(basePause);
      return true;
    }
    return false;
  }

  enterAttention(task, code, message, evidence = {}, possible = true) {
    this.clearRuntimeTimers();
    this.current = null;
    this.markAttentionWithoutCommit(task, code, message, evidence, possible);
    this.logTask(task, `⚠ ${message}`);
    this.commit();
  }

  finishTask(task, status, exitCode, error) {
    const execution = task.execution;
    if (this.current && this.current.taskId === task.id) {
      this.clearRuntimeTimers();
      this.current = null;
    }
    const shouldCleanup = Boolean(execution && execution.automationId && !task.clientMayStillBeRunning);
    task.status = status;
    task.phase = null;
    task.exitCode = exitCode;
    task.finishedAt = this.now();
    task.activity = '';
    task.clientMayStillBeRunning = false;
    if (error) task.error = error;
    this.logTask(task, `任务结束: ${status}${error ? ` (${error})` : ''}`);
    this.syncAttentionPause();
    const taskAttentionRemains = this.tasks.some((item) => !item.deletedAt && item.status === TASK_STATUS.ATTENTION);
    if (!taskAttentionRemains && status !== TASK_STATUS.DONE && this.settings.stopOnFail) {
      const failurePause = { kind: 'failure', taskId: task.id, message: error || '任务失败', since: this.now() };
      this.setGuardStopBasePause(failurePause, { commit: false });
      this.queue.paused = true;
      this.queue.pausedBySystem = true;
      this.queue.pauseReason = failurePause;
    }
    this.commit();
    // Preserve the external run as recovery evidence until our terminal state is
    // durable. Cleanup failure is safe: a terminal queue task will not redispatch.
    if (shouldCleanup && !this.client.cleanupAutomation(execution.automationId)) {
      this.logger(`任务 ${task.id} 已持久化为 ${status}，但外部调度记录清理失败`);
    }
    if (!this.queue.paused) this.scheduleNext(Number(this.settings.intervalSec) || 0);
  }

  stopCurrent(expectedTaskId) {
    if (!expectedTaskId) throw new RuntimeError('停止当前任务必须携带 taskId');
    if (!this.current || this.current.taskId !== expectedTaskId) return { ok: true, stopped: false, stale: true, taskId: expectedTaskId };
    const task = this.findTask(this.current.taskId);
    if (!task) return { ok: true, stopped: false };
    if (this.current.kind === 'shell') {
      const shell = this.current;
      shell.stopReason ||= 'manual';
      if (task.execution && !task.execution.stopRequested) task.execution.stopRequested = { kind: shell.stopReason, at: this.now() };
      task.clientMayStillBeRunning = true;
      task.activity = '手动停止中…';
      this.logTask(task, '用户请求停止 Shell 进程组');
      this.commit();
      this.terminateShellWithWatchdog(shell, task, 'manual');
      return { ok: true, stopped: true, clientMayStillBeRunning: true };
    }
    const execution = task.execution;
    if (execution && execution.dispatchedAt) {
      const observed = this.client.queryAutomation(execution.automationId);
      this.enterAttention(task, 'manual-monitor-stop', '已停止队列监控，但客户端会话可能仍在运行', observed, true);
      return { ok: true, stopped: true, clientMayStillBeRunning: true, attention: true };
    }
    if (execution) {
      const revoked = this.client.revokeUnclaimedAutomation(execution.automationId);
      if (!revoked.revoked) {
        this.enterAttention(task, 'manual-revoke-failed', '原子撤销时发现调度可能已接单，队列已安全暂停', revoked, true);
        return { ok: true, stopped: true, clientMayStillBeRunning: true, attention: true };
      }
    }
    this.finishTask(task, TASK_STATUS.STOPPED, null, '已在客户端接单前撤销');
    return { ok: true, stopped: true, clientMayStillBeRunning: false };
  }

  idempotencyFingerprint(operation, value) {
    return crypto.createHash('sha256').update(operation).update('\0').update(JSON.stringify(value)).digest('hex');
  }

  replay(key, fingerprint, { replayOnly = false } = {}) {
    if (!key) {
      if (replayOnly) throw new RuntimeError('安全重放必须携带 Idempotency-Key', 400, 'IDEMPOTENCY_KEY_REQUIRED');
      return null;
    }
    const cutoff = this.now() - IDEMPOTENCY_TTL_MS;
    const expired = (entry) => {
      const createdAt = Number(entry.createdAt);
      return !Number.isFinite(createdAt) || createdAt < cutoff;
    };
    if (this.state.idempotency.some((entry) => entry.key === key && expired(entry))) {
      // Remove expired instances before looking up the key again. An ordinary
      // request may now reuse the key and append a fresh record; retaining the
      // stale entry would make a later find() resolve to the wrong operation.
      this.state.idempotency = this.state.idempotency.filter((entry) => entry.key !== key || !expired(entry));
    }
    const found = this.state.idempotency.find((entry) => entry.key === key);
    if (!found) {
      if (replayOnly) {
        throw new RuntimeError(
          '服务端已无法证明上次操作的结果；本次未执行任何写入',
          409,
          'IDEMPOTENCY_REPLAY_UNKNOWN',
        );
      }
      return null;
    }
    if (found.fingerprint !== fingerprint) throw new RuntimeError('同一个 Idempotency-Key 被用于不同请求', 409, 'IDEMPOTENCY_CONFLICT');
    return { ...clone(found.response), replayed: true };
  }

  recordIdempotency(key, fingerprint, response) {
    if (!key) return;
    this.state.idempotency.push({ key, fingerprint, response: clone(response), createdAt: this.now() });
  }

  makeTask(fields) {
    const type = fields.type || 'continue';
    if (!['continue', 'zcode', 'shell'].includes(type)) throw new RuntimeError('未知任务类型');
    const targetSessionId = String(fields.targetSessionId || '');
    const prompt = type === 'continue' ? this.settings.continuePrompt : String(fields.prompt || '');
    const requestedName = String(fields.name || '').trim();
    const cwd = String(fields.cwd || '').trim();
    if (type === 'continue' && (!targetSessionId || targetSessionId.length > 200)) throw new RuntimeError('续跑任务需要 1–200 个字符的 targetSessionId');
    if (type !== 'continue' && !prompt.trim()) throw new RuntimeError('任务内容不能为空');
    if (prompt.length > 100000) throw new RuntimeError('单个任务内容不能超过 100000 个字符');
    if (requestedName.length > 120) throw new RuntimeError('任务名称不能超过 120 个字符');
    if (cwd.length > 4096) throw new RuntimeError('工作目录路径过长');
    let timeoutMin;
    try { timeoutMin = normalizeTimeout(fields.timeoutMin); } catch (error) { throw new RuntimeError(error.message); }
    return {
      id: `t${crypto.randomBytes(5).toString('hex')}`,
      name: requestedName || (type === 'continue' ? String(fields.targetTitle || '续跑会话').slice(0, 120) : prompt.trim().split('\n')[0].slice(0, 60)) || '未命名任务',
      type,
      prompt,
      cwd: cwd || null,
      targetSessionId: targetSessionId || null,
      targetTitle: fields.targetTitle ? String(fields.targetTitle).slice(0, 200) : null,
      timeoutMin,
      status: TASK_STATUS.PENDING,
      phase: null,
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      error: null,
      result: null,
      activity: '',
      sessionId: null,
      automationId: null,
      attempt: 0,
      round: 0,
      execution: null,
      attention: null,
      clientMayStillBeRunning: false,
      deletedAt: null,
      deleteBatchId: null,
      logs: [],
      usage: { turns: 0, events: 0 },
    };
  }

  createTasks(body, key, replayOptions) {
    const fingerprint = this.idempotencyFingerprint('create-tasks', body);
    const replayed = this.replay(key, fingerprint, replayOptions);
    if (replayed) return replayed;
    const created = [];
    const batch = String(body.batch || '').trim();
    if (batch) {
      let lineCount = 1;
      for (let i = 0; i < batch.length; i += 1) {
        if (batch.charCodeAt(i) === 10 && ++lineCount > 200) throw new RuntimeError('批量任务每次最多 200 条');
      }
      const lines = batch.split('\n').map((line) => line.trim()).filter(Boolean);
      if (!lines.length) throw new RuntimeError('没有可用内容');
      if (lines.length > 200) throw new RuntimeError('批量任务每次最多 200 条');
      lines.forEach((line, index) => created.push(this.makeTask({
        type: body.type === 'shell' ? 'shell' : 'zcode',
        prompt: line,
        name: body.name ? `${String(body.name).trim()} #${index + 1}` : '',
        cwd: body.cwd,
        timeoutMin: body.timeoutMin,
      })));
    } else {
      created.push(this.makeTask(body));
    }
    this.tasks.push(...created);
    const response = { ok: true, created: created.length, ids: created.map((task) => task.id) };
    this.recordIdempotency(key, fingerprint, response);
    this.commit();
    this.kick();
    return response;
  }

  createContinuation(info, key, replayOptions) {
    const body = { sessionId: info.sessionId };
    const fingerprint = this.idempotencyFingerprint('continue-session', body);
    const replayed = this.replay(key, fingerprint, replayOptions);
    if (replayed) return replayed;
    const existing = this.tasks.find((task) => !task.deletedAt && task.type === 'continue' && task.targetSessionId === info.sessionId && nonTerminal(task));
    if (existing) {
      const response = { ok: true, id: existing.id, name: existing.name, duplicate: true };
      // Persist a keyed no-op too. Otherwise a network retry arriving after the
      // existing task finishes could unexpectedly enqueue a second task.
      if (key) {
        this.recordIdempotency(key, fingerprint, response);
        this.commit();
      }
      return response;
    }
    const task = this.makeTask({ type: 'continue', targetSessionId: info.sessionId, targetTitle: info.title, cwd: info.directory });
    this.tasks.push(task);
    const response = { ok: true, id: task.id, name: task.name };
    this.recordIdempotency(key, fingerprint, response);
    this.commit();
    this.kick();
    return response;
  }

  importSession(info, prompt, key, replayOptions) {
    const request = { sessionId: info.sessionId };
    const fingerprint = this.idempotencyFingerprint('import-session', request);
    const replayed = this.replay(key, fingerprint, replayOptions);
    if (replayed) return replayed;
    if (!prompt) throw new RuntimeError('该会话没有可提取的用户提示词');
    const task = this.makeTask({
      name: info.title || '导入任务',
      type: 'zcode',
      prompt,
      cwd: info.directory || '',
    });
    this.tasks.push(task);
    const response = { ok: true, created: 1, ids: [task.id] };
    this.recordIdempotency(key, fingerprint, response);
    this.commit();
    this.kick();
    return response;
  }

  taskAction(id, action, key, replayOptions) {
    const fingerprint = this.idempotencyFingerprint(`task-action:${id}`, { action });
    const replayed = this.replay(key, fingerprint, replayOptions);
    if (replayed) return replayed;
    const index = this.tasks.findIndex((task) => task.id === id);
    if (index < 0) throw new RuntimeError('任务不存在', 404, 'NOT_FOUND');
    const task = this.tasks[index];
    let response = { ok: true, id };
    if (action === 'remove') {
      if ([TASK_STATUS.RUNNING, TASK_STATUS.WAITING, TASK_STATUS.ATTENTION].includes(task.status)) throw new RuntimeError('任务尚未终结，请先停止或处理异常状态');
      task.deletedAt = this.now();
      task.deleteBatchId = `delete-${crypto.randomUUID()}`;
      response = { ...response, deletedAt: task.deletedAt, batchId: task.deleteBatchId };
    } else if (action === 'restore') {
      task.deletedAt = null;
      task.deleteBatchId = null;
    } else if (action === 'up' || action === 'down') {
      if (task.status !== TASK_STATUS.PENDING || task.deletedAt) throw new RuntimeError('只有等待任务可以排序');
      const candidates = this.tasks.map((item, i) => ({ item, i })).filter(({ item }) => item.status === TASK_STATUS.PENDING && !item.deletedAt);
      const pos = candidates.findIndex(({ item }) => item.id === task.id);
      const other = candidates[action === 'up' ? pos - 1 : pos + 1];
      if (other) [this.tasks[index], this.tasks[other.i]] = [this.tasks[other.i], this.tasks[index]];
    } else if (action === 'top') {
      if (task.status !== TASK_STATUS.PENDING || task.deletedAt) throw new RuntimeError('只有等待任务可以排序');
      this.tasks.splice(index, 1);
      const first = this.tasks.findIndex((item) => item.status === TASK_STATUS.PENDING && !item.deletedAt);
      this.tasks.splice(first < 0 ? this.tasks.length : first, 0, task);
    } else if (action === 'retry' || action === 'runNow') {
      if ([TASK_STATUS.RUNNING, TASK_STATUS.WAITING, TASK_STATUS.ATTENTION].includes(task.status)) throw new RuntimeError('任务尚未终结');
      let target = task;
      if (task.status !== TASK_STATUS.PENDING) {
        target = this.makeTask({ ...task, timeoutMin: task.timeoutMin });
        target.name = task.name;
        this.tasks.splice(index + 1, 0, target);
      }
      if (action === 'runNow') {
        if (this.current) throw new RuntimeError('已有任务正在执行');
        const targetIndex = this.tasks.indexOf(target);
        this.tasks.splice(targetIndex, 1);
        const first = this.tasks.findIndex((item) => item.status === TASK_STATUS.PENDING && !item.deletedAt);
        this.tasks.splice(first < 0 ? this.tasks.length : first, 0, target);
        this.bypassWindowTaskId = target.id;
      }
      response = { ...response, id: target.id, sourceId: task.id };
    } else if (action === 'reattach') {
      this.reattachAttention(task);
      response = { ...response, reattached: true };
    } else if (action === 'acknowledge') {
      this.acknowledgeAttention(task);
      response = { ...response, acknowledged: true };
    } else {
      throw new RuntimeError('未知操作');
    }
    this.recordIdempotency(key, fingerprint, response);
    this.commit();
    if (action === 'runNow') this.scheduleNext(0); else this.kick();
    return response;
  }

  reattachAttention(task) {
    if (task.phase !== TASK_PHASE.ATTENTION || !task.execution || !task.execution.automationId) throw new RuntimeError('任务不在可重新接管状态');
    if (this.current && this.current.taskId !== task.id) {
      throw new RuntimeError('已有另一个任务由队列监控，必须先处理该任务', 409, 'ACTIVE_TASK_EXISTS');
    }
    const status = this.client.queryAutomation(task.execution.automationId);
    if (status.phase !== 'tracked') throw new RuntimeError('当前无法重新接管：调度记录不可用', 409, 'REATTACH_UNAVAILABLE');
    try {
      // Reattachment is only safe when the persisted automation is exactly the
      // one this queue intended to create. An ID match alone is insufficient.
      this.insertPersistedIntent(task);
    } catch (error) {
      throw new RuntimeError(`当前无法重新接管：${error.message}`, 409, 'REATTACH_CONFLICT');
    }
    task.attention = null;
    task.clientMayStillBeRunning = Boolean(status.possiblyClaimed);
    const sessionId = status.sessionId || task.targetSessionId || null;
    task.phase = status.run && sessionId ? TASK_PHASE.RUNNING : TASK_PHASE.WAITING_DISPATCH;
    task.status = status.run && sessionId ? TASK_STATUS.RUNNING : TASK_STATUS.WAITING;
    task.execution.automationObservedAt ||= this.now();
    if (status.run) task.execution.runId = status.run.run_id || task.execution.runId || null;
    if (status.run && sessionId) {
      task.sessionId = sessionId;
      task.execution.dispatchedAt ||= Number(status.run.created_at) || this.now();
    }
    this.syncAttentionPause();
    this.current = { taskId: task.id, kind: 'client', pollHandle: null, timeoutHandle: null, nextAttemptHandle: null };
    this.ensureClientPoll(task);
  }

  acknowledgeAttention(task) {
    if (task.phase !== TASK_PHASE.ATTENTION) throw new RuntimeError('任务不需要人工确认');
    task.status = TASK_STATUS.FAILED;
    task.phase = null;
    task.finishedAt = this.now();
    task.attention = null;
    task.error = `${task.error || '状态不确定'}（用户已确认继续队列）`;
    this.syncAttentionPause();
  }

  queueAction(body, key, replayOptions) {
    const action = body.action;
    const fingerprint = this.idempotencyFingerprint('queue-action', body);
    const replayed = this.replay(key, fingerprint, replayOptions);
    if (replayed) return replayed;
    let response;
    if (action === 'pause') {
      const safetyPause = this.queue.pauseReason && ['attention', 'storage-fatal', 'storage-recovery'].includes(this.queue.pauseReason.kind);
      const manualPause = { kind: 'manual', message: '用户手动暂停', since: this.now() };
      const pending = this.guardStopOwnershipPending();
      if (pending) pending.basePause = manualPause;
      this.setGuardStopBasePause(manualPause, { commit: false });
      this.queue.paused = true;
      if (!safetyPause) {
        this.queue.pausedBySystem = false;
        this.queue.pauseReason = manualPause;
      }
      if (this.nextTimer) this.timers.clearTimeout(this.nextTimer);
      this.nextTimer = null;
    } else if (action === 'resume') {
      if (this.hasGuardStopOwnershipPending()) {
        throw new RuntimeError('ZCode.app 停止状态尚未验证，不能恢复队列', 409, 'GUARD_STOP_UNVERIFIED');
      }
      if (this.queue.pauseReason && this.queue.pauseReason.kind === 'attention') throw new RuntimeError('请先处理需要人工确认的任务', 409, 'ATTENTION_REQUIRED');
      if (!this.storage.healthy) throw new RuntimeError('存储不可用，不能恢复队列', 503, 'STORAGE_UNAVAILABLE');
      this.queue.paused = false;
      this.queue.pausedBySystem = false;
      this.queue.pauseReason = null;
      this.queue.guardState.stopBasePause = null;
    } else if (action === 'clearFinished') {
      const ids = [];
      const batchId = `delete-${crypto.randomUUID()}`;
      for (const task of this.tasks) {
        if (!task.deletedAt && TERMINAL_STATUSES.has(task.status)) {
          task.deletedAt = this.now();
          task.deleteBatchId = batchId;
          ids.push(task.id);
        }
      }
      response = { ok: true, ids, batchId };
    } else if (action === 'restoreDeleted') {
      const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
      for (const task of this.tasks) if (ids.has(task.id)) { task.deletedAt = null; task.deleteBatchId = null; }
    } else if (action === 'stopCurrent') {
      response = this.stopCurrent(body.taskId);
    } else {
      throw new RuntimeError('未知操作');
    }
    response ||= { ok: true, paused: this.queue.paused };
    this.recordIdempotency(key, fingerprint, response);
    this.commit();
    this.kick();
    return response;
  }

  updateConfig(body, key, replayOptions) {
    const fingerprint = this.idempotencyFingerprint('update-config', body);
    const replayed = this.replay(key, fingerprint, replayOptions);
    if (replayed) return replayed;
    try { this.state.settings = validateConfigPatch(body, this.settings, this.plans); }
    catch (error) { throw new RuntimeError(error.message); }
    const response = { ok: true, settings: clone(this.settings) };
    this.recordIdempotency(key, fingerprint, response);
    this.commit();
    this.kick();
    return response;
  }

  hideSession(sessionId, key, replayOptions) {
    sessionId = requireSessionId(sessionId);
    const fingerprint = this.idempotencyFingerprint('hide-session', { sessionId });
    const replayed = this.replay(key, fingerprint, replayOptions);
    if (replayed) return replayed;
    if (!this.settings.hiddenSessions.includes(sessionId)) this.settings.hiddenSessions.push(sessionId);
    this.settings.hiddenSessions = this.settings.hiddenSessions.slice(-200);
    const response = { ok: true };
    this.recordIdempotency(key, fingerprint, response);
    this.commit();
    return response;
  }

  unhideSession(sessionId, key, replayOptions) {
    sessionId = requireSessionId(sessionId);
    const fingerprint = this.idempotencyFingerprint('unhide-session', { sessionId });
    const replayed = this.replay(key, fingerprint, replayOptions);
    if (replayed) return replayed;
    this.settings.hiddenSessions = this.settings.hiddenSessions.filter((id) => id !== sessionId);
    const response = { ok: true };
    this.recordIdempotency(key, fingerprint, response);
    this.commit();
    return response;
  }

  setSystemPause(kind, message) {
    if (this.queue.paused && (!this.queue.pausedBySystem || this.queue.pauseReason && this.queue.pauseReason.kind !== kind)) return false;
    const since = this.now();
    this.queue.paused = true;
    this.queue.pausedBySystem = true;
    this.queue.pauseReason = { kind, message, since };
    if (kind === 'auto-stop') this.setGuardStopBasePause({ kind, message, since }, { commit: false });
    if (this.nextTimer) this.timers.clearTimeout(this.nextTimer);
    this.nextTimer = null;
    this.commit();
    return true;
  }

  clearSystemPause(kind) {
    if (this.hasGuardStopOwnershipPending()) {
      this.enforceGuardStopOwnershipPause();
      return;
    }
    const clearedBase = this.clearGuardStopBasePause(kind, { commit: false });
    if (this.queue.pausedBySystem && (!kind || this.queue.pauseReason && this.queue.pauseReason.kind === kind)) {
      this.queue.paused = false;
      this.queue.pausedBySystem = false;
      this.queue.pauseReason = null;
      this.commit();
      this.kick();
    } else if (clearedBase) {
      this.commit();
    }
  }

  recordGuardEvent(event) {
    const eventTime = Number(event.time);
    if (!Number.isFinite(eventTime)) throw new RuntimeError('守护事件时间无效');
    if (event.type === 'stop') {
      this.queue.guardState.stopLastAt = Math.max(Number(this.queue.guardState.stopLastAt) || 0, eventTime);
    } else {
      this.queue.guardState.enableLastAt = Math.max(Number(this.queue.guardState.enableLastAt) || 0, eventTime);
    }
    this.queue.guardState.lastAppliedAt = Math.max(Number(this.queue.guardState.lastAppliedAt) || 0, eventTime);
    this.queue.guardState.lastError = null;
    this.commit();
  }

  recordGuardFailure(event, message) {
    this.queue.guardState.lastError = {
      type: event.type,
      eventTime: event.time,
      failedAt: this.now(),
      message: String(message || '守护操作失败').slice(0, 500),
    };
    this.commit();
  }

  taskSummary(task) {
    return {
      id: task.id,
      name: task.name,
      type: task.type,
      status: task.status,
      phase: task.phase,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      timeoutMin: task.timeoutMin,
      error: task.error,
      activity: task.activity,
      attempt: task.attempt,
      round: Math.max(0, Number(task.attempt || 0) - 1),
      clientMayStillBeRunning: Boolean(task.clientMayStillBeRunning),
      deletedAt: task.deletedAt,
      targetSessionId: task.targetSessionId,
      usage: task.usage,
      logTail: (task.logs || []).slice(-3),
    };
  }

  publicState({ summary = false, clientState = {} } = {}) {
    const visible = this.tasks.filter((task) => !task.deletedAt);
    const active = visible.filter((task) => !TERMINAL_STATUSES.has(task.status));
    const settings = { ...clone(this.settings), windowOpen: executionWindowOpen(this.settings, new Date(this.now())) };
    const base = {
      schemaVersion: SCHEMA_VERSION,
      revision: this.state.revision,
      generation: this.state.generation,
      paused: this.queue.paused,
      pauseReason: this.queue.pauseReason,
      guardState: clone(this.queue.guardState),
      settings,
      runningId: this.current && this.current.taskId || null,
      runningElapsedSec: this.current ? Math.round((this.now() - Number(this.findTask(this.current.taskId).startedAt || this.now())) / 1000) : 0,
      counts: {
        pending: visible.filter((task) => task.status === TASK_STATUS.PENDING).length,
        active: active.length,
        history: visible.filter((task) => TERMINAL_STATUSES.has(task.status)).length,
        trash: this.tasks.filter((task) => task.deletedAt).length,
      },
      storage: clone(this.storage),
      ...clientState,
    };
    if (summary) {
      base.tasks = active.map((task) => this.taskSummary(task));
      return base;
    }
    base.tasks = visible.map((task) => ({ ...clone(task), logs: undefined, logTail: (task.logs || []).slice(-3) }));
    return base;
  }

  listTasks({ status = 'history', cursor, limit = 50 } = {}) {
    const max = Math.min(100, Math.max(1, Number(limit) || 50));
    let rows = status === 'trash'
      ? this.tasks.filter((task) => task.deletedAt)
      : this.tasks.filter((task) => !task.deletedAt && TERMINAL_STATUSES.has(task.status));
    rows.sort((a, b) => Number(b.deletedAt || b.finishedAt || b.createdAt) - Number(a.deletedAt || a.finishedAt || a.createdAt) || String(b.id).localeCompare(String(a.id)));
    if (cursor) {
      const index = rows.findIndex((task) => task.id === cursor);
      if (index >= 0) rows = rows.slice(index + 1);
    }
    const page = rows.slice(0, max);
    return { items: page.map((task) => this.taskSummary(task)), nextCursor: rows.length > max ? page[page.length - 1].id : null };
  }

  taskDetail(id) {
    const task = this.findTask(id);
    if (!task) throw new RuntimeError('任务不存在', 404, 'NOT_FOUND');
    return clone(task);
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  QueueRuntime,
  RuntimeError,
  TASK_PHASE,
  TASK_STATUS,
  defaultSnapshot,
};
