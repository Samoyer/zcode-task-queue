'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 2;

class StorageFatalError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'StorageFatalError';
  }
}

function validateSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('状态根必须是对象');
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error(`不支持的 schemaVersion: ${value.schemaVersion}`);
  if (!Number.isInteger(value.generation) || value.generation < 0) throw new Error('generation 无效');
  if (!Number.isInteger(value.revision) || value.revision < 0) throw new Error('revision 无效');
  if (!value.queue || typeof value.queue !== 'object' || Array.isArray(value.queue)) throw new Error('queue 无效');
  if (typeof value.queue.paused !== 'boolean') throw new Error('queue.paused 无效');
  if (!value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)) throw new Error('settings 无效');
  if (!Array.isArray(value.tasks)) throw new Error('tasks 必须是数组');
  if (!Array.isArray(value.idempotency || [])) throw new Error('idempotency 必须是数组');
  const ids = new Set();
  for (const task of value.tasks) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('task 必须是对象');
    if (typeof task.id !== 'string' || !task.id) throw new Error('task.id 无效');
    if (typeof task.status !== 'string' || !task.status) throw new Error(`task.status 无效: ${task.id}`);
    if (ids.has(task.id)) throw new Error(`task.id 重复: ${task.id}`);
    ids.add(task.id);
  }
  for (const entry of value.idempotency || []) {
    if (!entry || typeof entry !== 'object' || typeof entry.key !== 'string' || typeof entry.fingerprint !== 'string') throw new Error('idempotency 记录无效');
  }
  return value;
}

function readJson(file, fsImpl = fs) {
  return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
}

function fsyncDirectory(dir, fsImpl = fs) {
  let fd;
  try {
    fd = fsImpl.openSync(dir, fsImpl.constants.O_RDONLY);
    fsImpl.fsyncSync(fd);
  } finally {
    if (fd != null) fsImpl.closeSync(fd);
  }
}

class StateStore {
  constructor({ dataDir, logger = () => {}, fsImpl = fs }) {
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, 'state.json');
    this.backupFile = path.join(this.dataDir, 'state.json.bak');
    this.initializedFile = path.join(this.dataDir, '.state-v2-initialized');
    this.legacyTasksFile = path.join(this.dataDir, 'tasks.json');
    this.legacySettingsFile = path.join(this.dataDir, 'settings.json');
    this.logger = logger;
    this.fs = fsImpl;
    this.lastSnapshot = null;
  }

  ensureDirectory() {
    this.fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    try { this.fs.chmodSync(this.dataDir, 0o700); } catch {}
  }

  ensureInitializedMarker() {
    if (this.fs.existsSync(this.initializedFile)) return;
    const marker = `${this.initializedFile}.${process.pid}.${Date.now()}.tmp`;
    let fd;
    try {
      fd = this.fs.openSync(marker, this.fs.constants.O_WRONLY | this.fs.constants.O_CREAT | this.fs.constants.O_EXCL, 0o600);
      this.fs.writeFileSync(fd, 'zcode-task-queue state v2\n', 'utf8');
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd); fd = null;
      this.fs.renameSync(marker, this.initializedFile);
      try { this.fs.chmodSync(this.initializedFile, 0o600); } catch {}
      fsyncDirectory(this.dataDir, this.fs);
    } catch (error) {
      if (fd != null) try { this.fs.closeSync(fd); } catch {}
      try { this.fs.unlinkSync(marker); } catch {}
      throw new StorageFatalError(`无法写入状态初始化标记：${error.message}`, error);
    }
  }

  hasPriorStateEvidence() {
    if (this.fs.existsSync(this.initializedFile)) return true;
    try {
      return this.fs.readdirSync(this.dataDir).some((name) =>
        name.startsWith('state.json.corrupt.') || name.endsWith('.legacy.bak'));
    } catch {
      return false;
    }
  }

  applyActivationGuardBaseline(snapshot, defaultSnapshot) {
    const baseline = defaultSnapshot && defaultSnapshot.queue && defaultSnapshot.queue.guardState || {};
    const current = snapshot.queue.guardState && typeof snapshot.queue.guardState === 'object'
      ? snapshot.queue.guardState : {};
    snapshot.queue.guardState = {
      ...current,
      stopLastAt: Math.max(Number(current.stopLastAt) || 0, Number(baseline.stopLastAt) || 0),
      enableLastAt: Math.max(Number(current.enableLastAt) || 0, Number(baseline.enableLastAt) || 0),
      lastAppliedAt: Math.max(Number(current.lastAppliedAt) || 0, Number(baseline.lastAppliedAt) || 0),
      lastWindowOpen: typeof baseline.lastWindowOpen === 'boolean'
        ? baseline.lastWindowOpen : current.lastWindowOpen,
    };
    return snapshot;
  }

  persistActivationSnapshot(snapshot) {
    // Both primary and backup must contain the activation watermark before the
    // marker becomes durable. Otherwise a later backup recovery could restore
    // lastAt=0 even though initialization had apparently completed.
    this.save(snapshot, { skipBackup: true, ensureMarker: false });
    this.save(snapshot, { ensureMarker: false });
  }

  preserveLegacyGuardStopOwnership(snapshot) {
    const reason = snapshot.queue && snapshot.queue.pauseReason;
    if (!reason || reason.kind !== 'attention' || reason.source !== 'guard-stop-ownership') return;
    const guardState = snapshot.queue.guardState && typeof snapshot.queue.guardState === 'object'
      && !Array.isArray(snapshot.queue.guardState) ? snapshot.queue.guardState : {};
    const pending = guardState.stopOwnershipPending;
    if (pending && typeof pending === 'object' && !Array.isArray(pending)) return;
    const since = Number.isFinite(Number(reason.since)) ? Number(reason.since) : Date.now();
    guardState.stopOwnershipPending = {
      source: 'scheduled',
      eventTime: reason.eventTime != null && Number.isFinite(Number(reason.eventTime))
        ? Number(reason.eventTime) : null,
      since,
      message: String(reason.message || 'ZCode.app 停止状态尚未验证').slice(0, 500),
      guardPauseApplied: true,
      basePause: { kind: 'auto-stop', message: '每日自动停止客户端', since },
    };
    snapshot.queue.guardState = guardState;
  }

  load(defaultSnapshot) {
    this.ensureDirectory();
    if (!this.fs.existsSync(this.file)) {
      // A crash during recovery can leave the primary absent while the previous
      // complete generation is still safely present. Prefer that backup over
      // replaying legacy files or silently constructing an empty queue.
      if (this.fs.existsSync(this.backupFile)) {
        return this.recoverBackup(new Error('主状态文件缺失'), defaultSnapshot);
      }
      if (this.hasPriorStateEvidence()) {
        throw new StorageFatalError('主状态与备份均缺失，但检测到此目录曾经初始化或发生过损坏；拒绝创建空队列');
      }
      return this.loadLegacy(defaultSnapshot);
    }
    let snapshot;
    try {
      snapshot = validateSnapshot(readJson(this.file, this.fs));
    } catch (primaryError) {
      const corrupt = `${this.file}.corrupt.${Date.now()}.${process.pid}`;
      let quarantined = false;
      try { this.fs.renameSync(this.file, corrupt); quarantined = true; } catch {
        try { this.fs.copyFileSync(this.file, corrupt, this.fs.constants.COPYFILE_EXCL); quarantined = true; } catch {}
      }
      this.logger(quarantined
        ? `主状态损坏，已隔离为 ${path.basename(corrupt)}: ${primaryError.message}`
        : `主状态损坏，但无法隔离原文件: ${primaryError.message}`);
      return this.recoverBackup(primaryError, defaultSnapshot);
    }
    if (!this.fs.existsSync(this.initializedFile)) {
      this.applyActivationGuardBaseline(snapshot, defaultSnapshot);
      snapshot.generation += 1;
      snapshot.revision += 1;
      // A persistence failure is not evidence that the parsed primary was
      // corrupt. Leave it in place so activation can be retried safely.
      this.persistActivationSnapshot(snapshot);
      this.backupLegacyFiles();
      this.ensureInitializedMarker();
      return { snapshot, recovered: false, migrated: true };
    }
    this.lastSnapshot = snapshot;
    return { snapshot, recovered: false, migrated: false };
  }

  recoverBackup(primaryError, defaultSnapshot = null) {
    let snapshot;
    try {
      snapshot = validateSnapshot(readJson(this.backupFile, this.fs));
    } catch (backupError) {
      throw new StorageFatalError(`主状态与备份均不可用：${primaryError.message}；${backupError.message}`, backupError);
    }
    const activating = !this.fs.existsSync(this.initializedFile);
    // Recovery replaces the visible pause reason, so first retain the legacy
    // guard-stop latch in durable guard state. Otherwise a recovery resume
    // could bypass the required process-ownership re-verification.
    this.preserveLegacyGuardStopOwnership(snapshot);
    snapshot.queue = {
      ...snapshot.queue,
      paused: true,
      pausedBySystem: true,
      pauseReason: { kind: 'storage-recovery', message: '状态由备份恢复，确认无误后再恢复队列', since: Date.now() },
    };
    snapshot.generation += 1;
    snapshot.revision += 1;
    // A recovered backup can lag an external stop/enable side effect. Treat
    // every recovery like a fresh activation and persist the watermark to both
    // copies before any guard tick can run.
    this.applyActivationGuardBaseline(snapshot, defaultSnapshot);
    this.persistActivationSnapshot(snapshot);
    if (activating) {
      this.backupLegacyFiles();
      this.ensureInitializedMarker();
    }
    return { snapshot, recovered: true, migrated: activating, warning: primaryError.message };
  }

  loadLegacy(defaultSnapshot) {
    let tasks = defaultSnapshot.tasks;
    let settings = defaultSnapshot.settings;
    try {
      if (this.fs.existsSync(this.legacyTasksFile)) {
        tasks = readJson(this.legacyTasksFile, this.fs);
        if (!Array.isArray(tasks)) throw new Error('旧 tasks.json 不是数组');
      }
      if (this.fs.existsSync(this.legacySettingsFile)) {
        settings = readJson(this.legacySettingsFile, this.fs);
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('旧 settings.json 不是对象');
      }
    } catch (error) {
      throw new StorageFatalError(`旧状态无法安全迁移：${error.message}`, error);
    }
    const snapshot = validateSnapshot({
      ...defaultSnapshot,
      schemaVersion: SCHEMA_VERSION,
      generation: 0,
      revision: 0,
      settings: { ...defaultSnapshot.settings, ...settings },
      tasks: tasks.map((task) => task && typeof task === 'object' && !Array.isArray(task)
        ? { ...task, status: typeof task.status === 'string' && task.status ? task.status : 'pending' }
        : task),
    });
    this.lastSnapshot = snapshot;
    this.save(snapshot, { skipBackup: true, ensureMarker: false });
    this.backupLegacyFiles();
    this.ensureInitializedMarker();
    return { snapshot, recovered: false, migrated: true };
  }

  backupLegacyFiles() {
    for (const file of [this.legacyTasksFile, this.legacySettingsFile]) {
      if (!this.fs.existsSync(file)) continue;
      const backup = `${file}.legacy.bak`;
      if (this.fs.existsSync(backup)) continue;
      this.fs.copyFileSync(file, backup, this.fs.constants.COPYFILE_EXCL);
      try { this.fs.chmodSync(backup, 0o600); } catch {}
    }
  }

  save(snapshot, { skipBackup = false, ensureMarker = true } = {}) {
    this.ensureDirectory();
    const next = validateSnapshot(JSON.parse(JSON.stringify(snapshot)));
    const payload = `${JSON.stringify(next, null, 2)}\n`;
    const tmp = path.join(this.dataDir, `.state.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
    const backupTmp = `${this.backupFile}.${process.pid}.${Date.now()}.tmp`;
    let fd;
    try {
      fd = this.fs.openSync(tmp, this.fs.constants.O_WRONLY | this.fs.constants.O_CREAT | this.fs.constants.O_EXCL, 0o600);
      this.fs.writeFileSync(fd, payload, 'utf8');
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd); fd = null;
      if (!skipBackup && this.fs.existsSync(this.file)) {
        this.fs.copyFileSync(this.file, backupTmp);
        try { this.fs.chmodSync(backupTmp, 0o600); } catch {}
        let backupFd;
        try { backupFd = this.fs.openSync(backupTmp, this.fs.constants.O_RDONLY); this.fs.fsyncSync(backupFd); } finally { if (backupFd != null) this.fs.closeSync(backupFd); }
        this.fs.renameSync(backupTmp, this.backupFile);
      }
      this.fs.renameSync(tmp, this.file);
      try { this.fs.chmodSync(this.file, 0o600); } catch {}
      fsyncDirectory(this.dataDir, this.fs);
      this.lastSnapshot = next;
      if (ensureMarker) this.ensureInitializedMarker();
      return next;
    } catch (error) {
      if (fd != null) try { this.fs.closeSync(fd); } catch {}
      try { this.fs.unlinkSync(tmp); } catch {}
      try { this.fs.unlinkSync(backupTmp); } catch {}
      throw new StorageFatalError(`原子写入失败：${error.message}`, error);
    }
  }
}

module.exports = { SCHEMA_VERSION, StateStore, StorageFatalError, validateSnapshot };
