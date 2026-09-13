'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { ClientDatabase } = require('../../lib/client-db');
const { QueueRuntime } = require('../../lib/queue-runtime');
const { StateStore } = require('../../lib/state-store');

class FakeClock {
  constructor(value = new Date(2026, 8, 12, 12, 0).getTime()) { this.value = value; }
  now = () => this.value;
}

class FakeTimers {
  constructor(clock) { this.clock = clock; this.nextId = 1; this.entries = new Map(); }
  setTimeout = (fn, delay = 0) => this.add(fn, delay, 0);
  setInterval = (fn, delay = 0) => this.add(fn, delay, Math.max(1, delay));
  clearTimeout = (id) => this.entries.delete(id);
  clearInterval = (id) => this.entries.delete(id);
  add(fn, delay, interval) {
    const id = this.nextId++;
    this.entries.set(id, { fn, at: this.clock.value + Math.max(0, Number(delay) || 0), interval });
    return id;
  }
  advance(ms) {
    const end = this.clock.value + ms;
    let guard = 0;
    while (guard++ < 10000) {
      const due = [...this.entries.entries()].filter(([, entry]) => entry.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, entry] = due;
      this.clock.value = entry.at;
      if (!entry.interval) this.entries.delete(id);
      entry.fn();
      if (entry.interval && this.entries.has(id)) entry.at += entry.interval;
    }
    if (guard >= 10000) throw new Error('fake timer runaway');
    this.clock.value = end;
  }
}

function createIndexDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE automations (
      automation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', cron_expr TEXT NOT NULL,
      prompt TEXT NOT NULL, model TEXT, provider TEXT, mode TEXT, thought_level TEXT,
      workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT,
      target_task_id TEXT, bot_delivery_target TEXT, location_kind TEXT NOT NULL DEFAULT 'local',
      recurring INTEGER NOT NULL DEFAULT 1, max_runs INTEGER, end_at INTEGER, schedule_rule TEXT,
      schedule_edited_by_user INTEGER NOT NULL DEFAULT 0, run_count INTEGER NOT NULL DEFAULT 0,
      scheduled_run_count INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
      lifecycle_status TEXT NOT NULL DEFAULT 'active', next_run_at INTEGER, last_run_at INTEGER,
      running INTEGER NOT NULL DEFAULT 0, claimed_at INTEGER, dispatch_status TEXT NOT NULL DEFAULT 'idle',
      dispatch_attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, last_error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE automation_runs (
      run_id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, workspace_key TEXT NOT NULL,
      scheduled_at INTEGER, trigger TEXT NOT NULL DEFAULT 'schedule',
      dispatch_status TEXT NOT NULL DEFAULT 'claimed', outcome TEXT, session_id TEXT, error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE tasks (
      workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT,
      task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT, provider TEXT,
      mode TEXT NOT NULL DEFAULT 'build', model TEXT, migration_source TEXT, forked_from_task_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, unread_at INTEGER,
      last_unread_at INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
      title_overridden INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}',
      searchable_text TEXT NOT NULL DEFAULT '', cron_automation_id TEXT, off_peak_task_id TEXT,
      PRIMARY KEY(workspace_key, task_id)
    );
  `);
  db.close();
}

function createSessionDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL,
      version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER,
      summary_files INTEGER, summary_diffs TEXT, revert TEXT, permission TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_compacting INTEGER,
      time_archived INTEGER, task_type TEXT NOT NULL DEFAULT 'interactive',
      title_source TEXT NOT NULL DEFAULT 'first_input', title_message_id TEXT,
      time_title_updated INTEGER, trace_id TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, sequence INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      data TEXT NOT NULL, sequence INTEGER
    );
    CREATE TABLE todo (
      session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE, content TEXT NOT NULL,
      status TEXT NOT NULL, priority TEXT NOT NULL, position INTEGER NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, PRIMARY KEY(session_id, position)
    );
  `);
  db.close();
}

function makeFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztq-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const indexDbPath = path.join(root, 'zcode', 'v2', 'tasks-index.sqlite');
  const sessionDbPath = path.join(root, 'zcode', 'cli', 'db', 'db.sqlite');
  createIndexDb(indexDbPath);
  createSessionDb(sessionDbPath);
  const clock = new FakeClock(options.now);
  const timers = new FakeTimers(clock);
  const client = new ClientDatabase({ root, homeDir: root, indexDbPath, sessionDbPath, clientConfigPath: path.join(root, 'config.json'), now: clock.now });
  const store = new StateStore({ dataDir });
  const runtime = new QueueRuntime({
    root, store, client,
    plans: {
      'builtin:bigmodel-coding-plan': { label: '个人套餐', fallbackModels: ['GLM-5.3-Flash'] },
      'builtin:bigmodel-start-plan': { label: '体验套餐', fallbackModels: ['GLM-5.3-Flash'] },
    },
    now: clock.now,
    timers,
    pollMs: options.pollMs || 100,
    resultGraceMs: options.resultGraceMs === undefined ? 0 : options.resultGraceMs,
    dbErrorGraceMs: options.dbErrorGraceMs || 1000,
    dispatchWaitMs: options.dispatchWaitMs || 1000,
    shellShutdownGraceMs: options.shellShutdownGraceMs === undefined ? 100 : options.shellShutdownGraceMs,
    shellKillWaitMs: options.shellKillWaitMs === undefined ? 100 : options.shellKillWaitMs,
    spawn: options.spawn,
  });
  function session(id = 'sess-1', title = 'Fixture session') {
    const db = new DatabaseSync(sessionDbPath);
    db.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'p', ?, ?, ?, '1', ?, ?)`)
      .run(id, id, root, title, clock.value - 100000, clock.value - 100000);
    db.close();
    const index = new DatabaseSync(indexDbPath);
    index.prepare(`INSERT INTO tasks (workspace_key, workspace_path, task_id, title, task_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'idle', ?, ?)`)
      .run(root, root, id, title, clock.value - 100000, clock.value - 100000);
    index.close();
    client.closeIndex();
    return { sessionId: id, title, directory: root };
  }
  let sequence = 0;
  function message(sessionId, role, text, at = clock.value) {
    sequence += 1;
    const db = new DatabaseSync(sessionDbPath);
    const messageId = `m-${sequence}`;
    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(messageId, sessionId, at, at, JSON.stringify({ role }), sequence);
    db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(`p-${sequence}`, messageId, sessionId, at, at, JSON.stringify({ type: 'text', text }), sequence);
    db.prepare(`UPDATE session SET time_updated = ? WHERE id = ?`).run(at, sessionId);
    db.close();
    client.closeSession();
    return { messageId, sequence };
  }
  function run(automationId, { id = `run-${Date.now()}-${Math.random()}`, sessionId = 'sess-1', outcome = 'running', createdAt = clock.value } = {}) {
    client.closeIndex();
    const db = new DatabaseSync(indexDbPath);
    db.prepare(`UPDATE automations SET dispatch_status='claimed', running=1, claimed_at=? WHERE automation_id=?`).run(createdAt, automationId);
    db.prepare(`INSERT INTO automation_runs (run_id, automation_id, workspace_key, dispatch_status, outcome, session_id, created_at, updated_at) VALUES (?, ?, ?, 'dispatched', ?, ?, ?, ?)`)
      .run(id, automationId, root, outcome, sessionId, createdAt, createdAt);
    db.close();
    return id;
  }
  function updateRun(runId, outcome, error = null) {
    client.closeIndex();
    const db = new DatabaseSync(indexDbPath);
    db.prepare(`UPDATE automation_runs SET outcome=?, error=?, updated_at=? WHERE run_id=?`).run(outcome, error, clock.value, runId);
    db.close();
  }
  return { root, dataDir, indexDbPath, sessionDbPath, clock, timers, client, store, runtime, session, message, run, updateRun };
}

module.exports = { FakeClock, FakeTimers, createIndexDb, createSessionDb, makeFixture };
