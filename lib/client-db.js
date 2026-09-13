'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { rowAfterCursor } = require('./core');

class AutomationConflictError extends Error {
  constructor(message, evidence = {}) {
    super(message);
    this.name = 'AutomationConflictError';
    this.code = 'AUTOMATION_CONFLICT';
    this.evidence = evidence;
  }
}

class ClientDatabase {
  constructor({ root, homeDir = os.homedir(), indexDbPath, sessionDbPath, clientConfigPath, logger = () => {}, now = () => Date.now() }) {
    this.root = path.resolve(root);
    this.homeDir = path.resolve(homeDir);
    this.explicit = {
      index: indexDbPath !== undefined,
      session: sessionDbPath !== undefined,
      config: clientConfigPath !== undefined,
    };
    const detected = this.detectPaths();
    const resolvedIndexDb = indexDbPath !== undefined ? path.resolve(indexDbPath) : detected.indexDb;
    this.paths = {
      indexDb: resolvedIndexDb,
      sessionDb: sessionDbPath !== undefined ? path.resolve(sessionDbPath) : detected.sessionDb,
      clientConfig: clientConfigPath !== undefined
        ? path.resolve(clientConfigPath)
        : resolvedIndexDb
          ? path.join(path.dirname(resolvedIndexDb), 'config.json')
          : detected.clientConfig,
    };
    this.logger = logger;
    this.now = now;
    this.indexDb = null;
    this.sessionDb = null;
    this.lastIndexError = '';
    this.lastSessionError = '';
  }

  detectPaths() {
    const candidates = [];
    let dir = this.root;
    for (let i = 0; i < 6; i += 1) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
      candidates.push(path.join(dir, '.zcode'));
    }
    candidates.push(path.join(this.homeDir, '.zcode'));
    const score = (file) => fs.existsSync(`${file}-wal`) ? 2 : fs.existsSync(file) ? 1 : 0;
    let indexDb = null;
    let bestScore = 0;
    let sessionDb = null;
    for (const zdir of candidates) {
      const index = path.join(zdir, 'v2', 'tasks-index.sqlite');
      const candidateScore = score(index);
      if (candidateScore > bestScore) { indexDb = index; bestScore = candidateScore; }
      const session = path.join(zdir, 'cli', 'db', 'db.sqlite');
      if (!sessionDb && fs.existsSync(session)) sessionDb = session;
    }
    const globalSession = path.join(this.homeDir, '.zcode', 'cli', 'db', 'db.sqlite');
    if (fs.existsSync(globalSession)) sessionDb = globalSession;
    return {
      indexDb,
      sessionDb,
      clientConfig: indexDb ? path.join(path.dirname(indexDb), 'config.json') : path.join(this.homeDir, '.zcode', 'v2', 'config.json'),
    };
  }

  refreshDetectedPaths() {
    if (this.explicit.index && this.explicit.session && this.explicit.config) return;
    const detected = this.detectPaths();
    if (!this.explicit.index && detected.indexDb !== this.paths.indexDb) {
      this.closeIndex();
      this.paths.indexDb = detected.indexDb;
      if (!this.explicit.config) this.paths.clientConfig = detected.clientConfig;
    }
    if (!this.explicit.session && detected.sessionDb !== this.paths.sessionDb) {
      this.closeSession();
      this.paths.sessionDb = detected.sessionDb;
    }
  }

  openIndex() {
    if (this.indexDb) return this.indexDb;
    this.refreshDetectedPaths();
    if (!this.paths.indexDb || !fs.existsSync(this.paths.indexDb)) return null;
    try {
      // This connection is shared by monitoring and dispatch. Keep it writable so
      // an earlier read-only health/list call cannot poison a later INSERT.
      this.indexDb = new DatabaseSync(this.paths.indexDb);
      this.indexDb.exec('PRAGMA busy_timeout = 5000');
      this.lastIndexError = '';
      return this.indexDb;
    } catch (error) {
      this.lastIndexError = error.message;
      this.logger(`打开任务索引库失败: ${error.message}`);
      return null;
    }
  }

  openSession() {
    if (this.sessionDb) return this.sessionDb;
    this.refreshDetectedPaths();
    if (!this.paths.sessionDb || !fs.existsSync(this.paths.sessionDb)) return null;
    try {
      this.sessionDb = new DatabaseSync(this.paths.sessionDb, { readOnly: true });
      this.sessionDb.exec('PRAGMA busy_timeout = 5000');
      this.lastSessionError = '';
      return this.sessionDb;
    } catch (error) {
      this.lastSessionError = error.message;
      this.logger(`打开会话库失败: ${error.message}`);
      return null;
    }
  }

  closeIndex() {
    if (this.indexDb) try { this.indexDb.close(); } catch {}
    this.indexDb = null;
  }

  closeSession() {
    if (this.sessionDb) try { this.sessionDb.close(); } catch {}
    this.sessionDb = null;
  }

  close() {
    this.closeIndex();
    this.closeSession();
  }

  reopen() {
    this.close();
    return Boolean(this.openIndex() && this.openSession());
  }

  health() {
    return {
      indexDbFound: Boolean(this.paths.indexDb && fs.existsSync(this.paths.indexDb)),
      sessionDbFound: Boolean(this.paths.sessionDb && fs.existsSync(this.paths.sessionDb)),
      indexDbError: this.lastIndexError || null,
      sessionDbError: this.lastSessionError || null,
    };
  }

  readPlanModels(plans) {
    const out = {};
    for (const [id, plan] of Object.entries(plans)) out[id] = [...plan.fallbackModels];
    try {
      const config = JSON.parse(fs.readFileSync(this.paths.clientConfig, 'utf8'));
      for (const id of Object.keys(plans)) {
        const models = config.provider && config.provider[id] && config.provider[id].models
          ? Object.keys(config.provider[id].models) : [];
        for (const model of models) if (!out[id].includes(model)) out[id].unshift(model);
      }
    } catch {}
    return out;
  }

  messageCursor(sessionId) {
    const db = this.openSession();
    if (!db || !sessionId) return null;
    try {
      const row = db.prepare(`
        SELECT id, sequence, time_created FROM message
        WHERE session_id = ?
        ORDER BY sequence DESC, time_created DESC, id DESC LIMIT 1
      `).get(sessionId);
      return row ? {
        sessionId,
        sequence: row.sequence == null ? null : Number(row.sequence),
        messageId: row.id,
        timeCreated: Number(row.time_created) || 0,
      } : { sessionId, sequence: -1, messageId: '', timeCreated: 0 };
    } catch (error) {
      this.lastSessionError = error.message;
      this.closeSession();
      this.logger(`读取会话消息基线失败: ${error.message}`);
      return null;
    }
  }

  messagesAfter(sessionId, cursor, { role, limit = 20 } = {}) {
    const db = this.openSession();
    if (!db) throw new Error(this.lastSessionError || '客户端会话数据库不可用');
    if (!sessionId) return [];
    try {
      const rows = db.prepare(`
        SELECT id, sequence, time_created, time_updated, data
        FROM message WHERE session_id = ?
        ORDER BY sequence ASC, time_created ASC, id ASC
      `).all(sessionId).filter((row) => rowAfterCursor(row, cursor));
      const filtered = role ? rows.filter((row) => {
        try { return JSON.parse(row.data).role === role; } catch { return false; }
      }) : rows;
      return filtered.slice(-limit);
    } catch (error) {
      this.lastSessionError = error.message;
      this.closeSession();
      throw new Error(`读取会话消息失败: ${error.message}`, { cause: error });
    }
  }

  assistantMessagesAfter(sessionId, cursor, limit = 5) {
    const db = this.openSession();
    if (!db) throw new Error(this.lastSessionError || '客户端会话数据库不可用');
    try {
      return this.messagesAfter(sessionId, cursor, { role: 'assistant', limit }).map((message) => {
        const parts = db.prepare(`SELECT data FROM part WHERE message_id = ? ORDER BY sequence ASC, time_created ASC, id ASC`).all(message.id);
        const text = [];
        for (const part of parts) {
          try {
            const data = JSON.parse(part.data);
            if (data.type === 'text' && data.text) text.push(String(data.text));
          } catch {}
        }
        return {
          id: message.id,
          sequence: message.sequence == null ? null : Number(message.sequence),
          timeCreated: Number(message.time_created) || 0,
          timeUpdated: Number(message.time_updated) || 0,
          text: text.join('\n').trim(),
        };
      }).filter((message) => message.text);
    } catch (error) {
      this.lastSessionError = error.message;
      this.closeSession();
      if (String(error.message).startsWith('读取会话消息失败:')) throw error;
      throw new Error(`读取助手回复失败: ${error.message}`, { cause: error });
    }
  }

  activityAfter(sessionId, cursor) {
    const db = this.openSession();
    if (!db) throw new Error(this.lastSessionError || '客户端会话数据库不可用');
    try {
      const messages = this.messagesAfter(sessionId, cursor, { limit: 500 });
      let latest = 0;
      for (const message of messages) {
        latest = Math.max(latest, Number(message.time_updated) || Number(message.time_created) || 0);
        const row = db.prepare(`SELECT max(time_updated) AS updated FROM part WHERE message_id = ?`).get(message.id);
        latest = Math.max(latest, Number(row && row.updated) || 0);
      }
      return latest;
    } catch (error) {
      this.lastSessionError = error.message;
      this.closeSession();
      if (String(error.message).startsWith('读取会话消息失败:')) throw error;
      throw new Error(`读取会话活动失败: ${error.message}`, { cause: error });
    }
  }

  sessionStatus(sessionId) {
    const db = this.openSession();
    if (!db) return { available: false, error: this.lastSessionError || '客户端会话数据库不可用', lastActivity: '', toolRunning: false, todos: null, lastPartType: '', lastUpdated: 0 };
    let lastActivity = '';
    let lastPartType = '';
    let lastUpdated = 0;
    try {
      // Activity is a bounded presentation detail, but tool liveness is a safety
      // decision. Resolve the newest state of every call across the whole
      // session so an old running tool cannot disappear behind 40 newer parts.
      const latestToolState = new Map();
      const toolParts = db.prepare(`
        SELECT id, data FROM part WHERE session_id = ?
        ORDER BY sequence DESC, time_updated DESC, time_created DESC, id DESC
      `).all(sessionId);
      for (const part of toolParts) {
        let data; try { data = JSON.parse(part.data); } catch { continue; }
        if (data.type !== 'tool') continue;
        const key = data.callID || data.id || part.id;
        if (!latestToolState.has(key)) latestToolState.set(key, data.state && data.state.status || '');
      }
      const parts = db.prepare(`
        SELECT id, time_updated, data FROM part WHERE session_id = ?
        ORDER BY sequence DESC, time_created DESC, id DESC LIMIT 40
      `).all(sessionId);
      for (const part of parts) {
        lastUpdated = Math.max(lastUpdated, Number(part.time_updated) || 0);
        let data; try { data = JSON.parse(part.data); } catch { continue; }
        if (!lastPartType && ['step-start', 'step-finish', 'tool', 'text'].includes(data.type)) lastPartType = data.type;
        if (data.type === 'tool') {
          if (!lastActivity) lastActivity = `🔧 ${data.tool || '工具'}${data.state && data.state.status ? `(${data.state.status})` : ''}`;
        } else if (!lastActivity && data.type === 'text' && String(data.text || '').trim()) {
          lastActivity = `💬 ${String(data.text).trim().slice(0, 80)}`;
        }
      }
      const rows = db.prepare(`SELECT status, count(*) AS count FROM todo WHERE session_id = ? GROUP BY status`).all(sessionId);
      let todos = null;
      if (rows.length) {
        todos = { done: 0, total: 0 };
        for (const row of rows) {
          const count = Number(row.count) || 0;
          todos.total += count;
          if (row.status === 'completed') todos.done += count;
        }
      }
      return { available: true, error: null, lastActivity, toolRunning: [...latestToolState.values()].some((status) => status === 'running'), todos, lastPartType, lastUpdated };
    } catch (error) {
      this.lastSessionError = error.message;
      this.closeSession();
      return { available: false, error: error.message, lastActivity: '', toolRunning: false, todos: null, lastPartType: '', lastUpdated: 0 };
    }
  }

  sessionPrompt(sessionId) {
    const db = this.openSession();
    if (!db) throw new Error('客户端会话数据库不可用');
    const message = db.prepare(`
      SELECT id FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
      ORDER BY sequence ASC, time_created ASC LIMIT 1
    `).get(sessionId);
    if (!message) return '';
    const text = [];
    for (const row of db.prepare(`SELECT data FROM part WHERE message_id = ? ORDER BY sequence ASC, time_created ASC`).all(message.id)) {
      try {
        const data = JSON.parse(row.data);
        if (data.type === 'text' && data.text) text.push(String(data.text).trim());
      } catch {}
    }
    return text.join('\n').slice(0, 20000);
  }

  registeredProjects() {
    const projects = new Set();
    const files = new Set([path.join(this.homeDir, '.zcode', 'v2', 'setting.json')]);
    if (this.paths.indexDb) files.add(path.join(path.dirname(this.paths.indexDb), 'setting.json'));
    for (const file of files) {
      try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const project of value.recentProjects || []) if (typeof project === 'string' && project) projects.add(project);
      } catch {}
    }
    return projects;
  }

  readClientTasks(hiddenIds = []) {
    const db = this.openSession();
    if (!db) return { visible: [], hidden: [], error: '未找到客户端会话数据库（客户端是否运行过？）' };
    try {
      const projects = this.registeredProjects();
      const rows = projects.size
        ? db.prepare(`SELECT id, title, directory, time_created, time_updated FROM session WHERE task_type = 'interactive' AND directory IN (${[...projects].map(() => '?').join(',')}) ORDER BY time_updated DESC LIMIT 100`).all(...projects)
        : db.prepare(`SELECT id, title, directory, time_created, time_updated FROM session WHERE task_type = 'interactive' ORDER BY time_updated DESC LIMIT 100`).all();
      const indexStatus = new Map();
      const archived = new Set();
      const index = this.openIndex({ readOnly: true });
      if (index) {
        for (const row of index.prepare(`SELECT task_id, task_status, archived FROM tasks WHERE deleted = 0`).all()) {
          indexStatus.set(row.task_id, row.task_status);
          if (Number(row.archived) === 1) archived.add(row.task_id);
        }
      }
      const hiddenSet = new Set(hiddenIds);
      const tasks = rows.filter((row) => !archived.has(row.id)).map((row) => {
        const statusInfo = this.sessionStatus(row.id);
        if (statusInfo.available === false) throw new Error(statusInfo.error || '客户端会话数据库不可用');
        const age = this.now() - Number(row.time_updated);
        const fresh = age < 2 * 60 * 1000;
        let status = indexStatus.get(row.id) || 'idle';
        if (fresh && (statusInfo.toolRunning || statusInfo.lastPartType === 'step-start' || status === 'running')) status = 'running';
        else if (statusInfo.lastPartType === 'step-start' && age > 30 * 60 * 1000) status = 'stuck';
        return {
          sessionId: row.id,
          title: row.title,
          directory: row.directory,
          status,
          lastActivity: statusInfo.lastActivity,
          todos: statusInfo.todos,
          timeCreated: Number(row.time_created),
          timeUpdated: Number(row.time_updated),
          fresh,
        };
      });
      return {
        visible: tasks.filter((task) => !hiddenSet.has(task.sessionId)).slice(0, 30),
        hidden: tasks.filter((task) => hiddenSet.has(task.sessionId)).slice(0, 200),
        error: '',
      };
    } catch (error) {
      this.lastSessionError = error.message;
      return { visible: [], hidden: [], error: `读取客户端任务失败: ${error.message}` };
    }
  }

  taskWorkspace(sessionId, fallbackDir) {
    try {
      const db = this.openIndex({ readOnly: true });
      if (db && sessionId) {
        const row = db.prepare(`SELECT workspace_path FROM tasks WHERE task_id = ? AND deleted = 0`).get(sessionId);
        if (row && row.workspace_path && fs.existsSync(row.workspace_path)) return row.workspace_path;
      }
    } catch {}
    return fallbackDir && fs.existsSync(fallbackDir) ? fallbackDir : this.root;
  }

  automationFingerprint(fields) {
    return {
      title: String(fields.title || ''),
      prompt: String(fields.prompt || ''),
      model: fields.modelRef || null,
      workspacePath: path.resolve(fields.workspace),
      targetTaskId: fields.targetTaskId || null,
    };
  }

  automationTaskMappings(db, automationId) {
    const row = db.prepare(`
      WITH mapped AS (
        SELECT task_id, task_status, updated_at
        FROM tasks WHERE cron_automation_id = ? AND deleted = 0
      )
      SELECT
        (SELECT task_id FROM mapped ORDER BY updated_at DESC, task_id DESC LIMIT 1) AS task_id,
        (SELECT task_status FROM mapped ORDER BY updated_at DESC, task_id DESC LIMIT 1) AS task_status,
        (SELECT updated_at FROM mapped ORDER BY updated_at DESC, task_id DESC LIMIT 1) AS updated_at,
        COUNT(*) AS mapping_count,
        COALESCE(SUM(CASE WHEN task_status = 'completed' THEN 0 ELSE 1 END), 0) AS non_completed_mapping_count
      FROM mapped
    `).get(automationId);
    const mappingCount = Number(row && row.mapping_count || 0);
    return {
      mappedTask: mappingCount ? {
        task_id: row.task_id,
        task_status: row.task_status,
        updated_at: row.updated_at,
      } : null,
      mappingCount,
      nonCompletedMappingCount: Number(row && row.non_completed_mapping_count || 0),
    };
  }

  insertOrAdoptAutomation({ automationId, title, prompt, workspace, targetTaskId, modelRef }) {
    const db = this.openIndex();
    if (!db) throw new Error(this.paths.indexDb ? '任务索引库打开失败' : '未找到客户端任务索引库');
    const expected = this.automationFingerprint({ title, prompt, workspace, targetTaskId, modelRef });
    let transactionOpen = false;
    try {
      // Take the writer lock before checking for an existing intent or orphaned
      // evidence. Otherwise another scheduler can commit the same deterministic
      // ID between our reads and INSERT, turning an idempotent replay into a
      // UNIQUE error (or hiding a newly-created orphan).
      db.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      const existing = db.prepare(`SELECT automation_id, title, prompt, model, workspace_path, target_task_id FROM automations WHERE automation_id = ?`).get(automationId);
      const orphan = db.prepare(`SELECT run_id, outcome, session_id, dispatch_status FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC, updated_at DESC, run_id DESC LIMIT 1`).get(automationId);
      const mapping = this.automationTaskMappings(db, automationId);
      if (existing) {
        const actual = {
          title: String(existing.title || ''),
          prompt: String(existing.prompt || ''),
          model: existing.model || null,
          workspacePath: path.resolve(existing.workspace_path),
          targetTaskId: existing.target_task_id || null,
        };
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new AutomationConflictError('确定性 automation ID 已存在，但内容与派发意图不一致', { expected, actual, orphan });
        }
        db.exec('COMMIT');
        transactionOpen = false;
        return { automationId, adopted: true };
      }
      if (orphan || mapping.mappingCount) {
        throw new AutomationConflictError(
          'automation 记录缺失但存在关联运行或任务记录，拒绝重建',
          { orphan: orphan || null, ...mapping, expected },
        );
      }
      const fireAt = this.now() + 8000;
      const at = new Date(fireAt);
      const cron = `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`;
      db.prepare(`INSERT INTO automations (
        automation_id, title, cron_expr, prompt, model, provider, thought_level,
        workspace_key, workspace_path, target_task_id, recurring, max_runs,
        next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'glm', 'max', ?, ?, ?, 0, 1, ?, ?, ?)`)
        .run(automationId, title, cron, prompt, modelRef || null, workspace, workspace, targetTaskId || null, fireAt, this.now(), this.now());
      const verified = db.prepare(`SELECT automation_id FROM automations WHERE automation_id = ?`).get(automationId);
      if (!verified) throw new Error('automation 写入后无法回读');
      db.exec('COMMIT');
      transactionOpen = false;
      return { automationId, adopted: false };
    } catch (error) {
      if (transactionOpen) try { db.exec('ROLLBACK'); } catch {}
      if (error instanceof AutomationConflictError) throw error;
      throw new Error(`写入客户端调度队列失败: ${error.message}`);
    }
  }

  queryAutomation(automationId) {
    const db = this.openIndex();
    if (!db) return { phase: 'no-db', error: this.lastIndexError || '任务索引库不可用' };
    try {
      const automation = db.prepare(`
        SELECT automation_id, dispatch_status, running, claimed_at, last_error,
               title, prompt, model, workspace_path, target_task_id,
               lifecycle_status, enabled, retry_at, dispatch_attempts
        FROM automations WHERE automation_id = ?
      `).get(automationId);
      const run = db.prepare(`
        SELECT run_id, outcome, session_id, error, dispatch_status, created_at, updated_at
        FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC, updated_at DESC, run_id DESC LIMIT 1
      `).get(automationId);
      const mapping = this.automationTaskMappings(db, automationId);
      const { mappedTask } = mapping;
      if (!automation && !run && !mapping.mappingCount) return { phase: 'gone' };
      const sessionId = run && run.session_id || automation && automation.target_task_id || mappedTask && mappedTask.task_id || null;
      const runOutcome = String(run && run.outcome || '').toLowerCase();
      const runDispatchStatus = String(run && run.dispatch_status || '').toLowerCase();
      // ZCode keeps the claimed run row when dispatch itself reaches a terminal
      // failure.  A transient failure uses the same run status, but leaves the
      // automation active/enabled with retry_at set.  Only treat the combination
      // below as final; conflicting task mappings remain conservative claim
      // evidence instead of being silently discarded.
      const terminalDispatchFailure = Boolean(
        automation
        && run
        && !runOutcome
        && ['failed_to_dispatch', 'skipped'].includes(runDispatchStatus)
        && Number(automation.enabled) === 0
        && Number(automation.running) === 0
        && !automation.claimed_at
        && ['failed', 'completed'].includes(String(automation.lifecycle_status || '').toLowerCase())
        && mapping.mappingCount === 0
      );
      return {
        phase: 'tracked',
        orphan: !automation && Boolean(run || mapping.mappingCount),
        automation: automation || null,
        run: run || null,
        ...mapping,
        sessionId,
        dispatchFailed: Boolean(automation && automation.last_error && !run),
        terminalDispatchFailure,
        possiblyClaimed: Boolean(
          run
          || mapping.mappingCount
          || automation && (automation.running || automation.claimed_at || ['claimed', 'running', 'dispatched'].includes(automation.dispatch_status)),
        ),
      };
    } catch (error) {
      this.lastIndexError = error.message;
      this.closeIndex();
      return { phase: 'error', error: error.message };
    }
  }

  revokeUnclaimedAutomation(automationId) {
    if (!automationId) return { revoked: true, phase: 'gone' };
    const db = this.openIndex();
    if (!db) return { revoked: false, phase: 'error', error: this.lastIndexError || '任务索引库不可用' };
    try {
      db.exec('BEGIN IMMEDIATE');
      const automation = db.prepare(`
        SELECT automation_id, dispatch_status, running, claimed_at, last_error,
               lifecycle_status, enabled, retry_at, dispatch_attempts
        FROM automations WHERE automation_id = ?
      `).get(automationId);
      const run = db.prepare(`
        SELECT run_id, outcome, session_id, error, dispatch_status, created_at, updated_at
        FROM automation_runs WHERE automation_id = ?
        ORDER BY created_at DESC, updated_at DESC, run_id DESC LIMIT 1
      `).get(automationId);
      const mapping = this.automationTaskMappings(db, automationId);
      if (!automation && !run && !mapping.mappingCount) {
        db.exec('COMMIT');
        return { revoked: true, phase: 'gone' };
      }
      const claimed = Boolean(run || mapping.mappingCount || automation && (
        automation.running || automation.claimed_at
        || ['claimed', 'running', 'dispatched'].includes(automation.dispatch_status)
      ));
      if (!automation || claimed) {
        db.exec('COMMIT');
        return { revoked: false, phase: 'claimed', automation: automation || null, run: run || null, ...mapping };
      }
      const deleted = db.prepare(`
        DELETE FROM automations
        WHERE automation_id = ?
          AND running = 0
          AND claimed_at IS NULL
          AND dispatch_status NOT IN ('claimed', 'running', 'dispatched')
          AND NOT EXISTS (
            SELECT 1 FROM automation_runs WHERE automation_runs.automation_id = automations.automation_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM tasks
            WHERE tasks.cron_automation_id = automations.automation_id AND tasks.deleted = 0
          )
      `).run(automationId);
      if (Number(deleted.changes) !== 1) {
        const current = db.prepare(`SELECT dispatch_status, running, claimed_at FROM automations WHERE automation_id = ?`).get(automationId);
        const currentRun = db.prepare(`SELECT run_id, outcome, session_id, dispatch_status FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC, updated_at DESC, run_id DESC LIMIT 1`).get(automationId);
        db.exec('COMMIT');
        return { revoked: false, phase: current || currentRun ? 'claimed' : 'gone-uncertain', automation: current || null, run: currentRun || null };
      }
      db.exec('COMMIT');
      return { revoked: true, phase: 'revoked' };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      this.lastIndexError = error.message;
      this.logger(`原子撤销 automation 失败: ${error.message}`);
      return { revoked: false, phase: 'error', error: error.message };
    }
  }

  cleanupAutomation(automationId, { preserveRuns = false } = {}) {
    if (!automationId) return true;
    const db = this.openIndex();
    if (!db) return false;
    try {
      db.exec('BEGIN IMMEDIATE');
      if (!preserveRuns) db.prepare(`DELETE FROM automation_runs WHERE automation_id = ?`).run(automationId);
      db.prepare(`DELETE FROM automations WHERE automation_id = ?`).run(automationId);
      db.exec('COMMIT');
      const remains = db.prepare(`
        SELECT 1 AS present FROM automations WHERE automation_id = ?
        UNION ALL
        SELECT 1 AS present FROM automation_runs WHERE automation_id = ? LIMIT 1
      `).get(automationId, automationId);
      return !remains;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      this.logger(`清理 automation 失败: ${error.message}`);
      return false;
    }
  }
}

module.exports = { AutomationConflictError, ClientDatabase };
