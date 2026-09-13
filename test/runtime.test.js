'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');
const { ClientDatabase } = require('../lib/client-db');
const { latestDueGuardEvent } = require('../lib/core');
const { QueueRuntime, RuntimeError, TASK_PHASE } = require('../lib/queue-runtime');
const { StateStore, StorageFatalError } = require('../lib/state-store');
const { makeFixture } = require('./helpers/fixture');

function startContinuation(fx, id = 'sess-1') {
  const info = fx.session(id);
  fx.message(id, 'assistant', '旧回复\n[[ZTQ_TASK_DONE]]', fx.clock.value - 100000);
  fx.runtime.state.settings.intervalSec = 0;
  fx.runtime.createContinuation(info, 'continue-key');
  fx.timers.advance(0);
  return fx.runtime.tasks[0];
}

async function waitUntil(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

test('running text cannot complete; succeeded exact final marker can', (t) => {
  const fx = makeFixture(t);
  const task = startContinuation(fx);
  const runId = fx.run(task.automationId, { outcome: 'running' });
  fx.message('sess-1', 'assistant', '报告\n[[ZTQ_TASK_DONE]]');
  fx.runtime.pollClientTask(task);
  assert.equal(task.status, 'running');
  fx.updateRun(runId, 'succeeded');
  fx.runtime.pollClientTask(task);
  assert.equal(task.status, 'done');
  assert.equal(task.attempt, 1);
});

test('an in-flight attempt keeps the completion marker it dispatched with', (t) => {
  const fx = makeFixture(t);
  const task = startContinuation(fx);
  const dispatchedMarker = task.execution.completionMarker;
  fx.runtime.settings.completionMarker = 'A-DIFFERENT-MARKER';
  const runId = fx.run(task.automationId, { outcome: 'running' });
  fx.message('sess-1', 'assistant', `完成报告\n${dispatchedMarker}`);
  fx.updateRun(runId, 'succeeded');
  fx.runtime.pollClientTask(task);
  assert.equal(task.status, 'done');
});

test('negated completion advances exactly one new attempt and old poll cannot fail it', (t) => {
  const fx = makeFixture(t);
  const task = startContinuation(fx);
  const run1 = fx.run(task.automationId, { outcome: 'running' });
  fx.message('sess-1', 'assistant', '尚未全部完成，下一轮继续');
  fx.updateRun(run1, 'succeeded');
  fx.runtime.pollClientTask(task);
  assert.equal(task.phase, TASK_PHASE.BETWEEN_ATTEMPTS);
  assert.equal(task.attempt, 1);
  fx.timers.advance(0);
  assert.equal(task.attempt, 2);
  assert.equal(task.phase, TASK_PHASE.WAITING_DISPATCH);
  const run2 = fx.run(task.automationId, { id: 'run-2', outcome: 'succeeded' });
  fx.message('sess-1', 'assistant', '全部事项已验证。\n[[ZTQ_TASK_DONE]]');
  fx.runtime.pollClientTask(task);
  assert.equal(task.status, 'done');
  assert.equal(task.attempt, 2);
  fx.timers.advance(1000);
  assert.equal(task.attempt, 2);
  assert.ok(run2);
});

test('a completed client-task mapping left by a successful prior round does not block the next round', (t) => {
  const fx = makeFixture(t);
  const task = startContinuation(fx);
  const runId = fx.run(task.automationId, { outcome: 'running' });
  const oldAutomationId = task.automationId;
  const db = new DatabaseSync(fx.indexDbPath);
  db.prepare(`UPDATE tasks SET cron_automation_id = ?, task_status = 'completed' WHERE task_id = 'sess-1'`).run(oldAutomationId);
  db.close();
  fx.client.closeIndex();
  fx.message('sess-1', 'assistant', '还需要继续');
  fx.updateRun(runId, 'succeeded');
  fx.runtime.pollClientTask(task);
  assert.equal(task.phase, TASK_PHASE.BETWEEN_ATTEMPTS);
  fx.timers.advance(0);
  assert.equal(task.attempt, 2);
  assert.equal(task.phase, TASK_PHASE.WAITING_DISPATCH);
  assert.notEqual(task.automationId, oldAutomationId);
});

test('any non-completed mapping from the prior round blocks the next round', (t) => {
  const fx = makeFixture(t);
  const task = startContinuation(fx);
  const other = fx.session('sess-other');
  const runId = fx.run(task.automationId, { outcome: 'running' });
  const oldAutomationId = task.automationId;
  const db = new DatabaseSync(fx.indexDbPath);
  db.prepare(`UPDATE tasks SET cron_automation_id = ?, task_status = 'completed' WHERE task_id = 'sess-1'`).run(oldAutomationId);
  db.prepare(`UPDATE tasks SET cron_automation_id = ?, task_status = 'running' WHERE task_id = ?`).run(oldAutomationId, other.sessionId);
  db.close();
  fx.client.closeIndex();
  fx.message('sess-1', 'assistant', '还需要继续');
  fx.updateRun(runId, 'succeeded');
  fx.runtime.pollClientTask(task);
  assert.equal(task.phase, TASK_PHASE.BETWEEN_ATTEMPTS);
  fx.timers.advance(0);
  assert.equal(task.phase, TASK_PHASE.ATTENTION);
  assert.equal(task.attention.code, 'late-previous-task-mapping');
  assert.equal(task.clientMayStillBeRunning, true);
  assert.equal(fx.runtime.nextTimer, null);
});

test('maxRounds=1 never creates attempt two', (t) => {
  const fx = makeFixture(t);
  fx.runtime.state.settings.maxRounds = 1;
  const task = startContinuation(fx);
  const runId = fx.run(task.automationId, { outcome: 'running' });
  fx.message('sess-1', 'assistant', '还有工作');
  fx.updateRun(runId, 'succeeded');
  fx.runtime.pollClientTask(task);
  assert.equal(task.status, 'failed');
  assert.equal(task.attempt, 1);
  const db = new DatabaseSync(fx.indexDbPath, { readOnly: true });
  assert.equal(db.prepare(`SELECT count(*) AS count FROM automations WHERE automation_id LIKE 'automation-ztq-v1-%'`).get().count, 0);
  db.close();
});

test('the total timeout blocks a delayed next attempt before it can dispatch', (t) => {
  const fx = makeFixture(t);
  fx.runtime.settings.defaultTimeoutMin = 1;
  const task = startContinuation(fx);
  fx.runtime.settings.intervalSec = 120;
  const runId = fx.run(task.automationId, { outcome: 'running' });
  fx.message('sess-1', 'assistant', '还需要继续');
  fx.updateRun(runId, 'succeeded');
  fx.runtime.pollClientTask(task);
  assert.equal(task.phase, TASK_PHASE.BETWEEN_ATTEMPTS);
  fx.timers.advance(120 * 1000);
  assert.equal(task.status, 'timeout');
  assert.equal(task.attempt, 1);
  const db = new DatabaseSync(fx.indexDbPath, { readOnly: true });
  assert.equal(db.prepare(`SELECT count(*) AS count FROM automations`).get().count, 0);
  db.close();
});

test('a succeeded run without run.session_id completes through the continuation target', (t) => {
  const fx = makeFixture(t);
  const task = startContinuation(fx);
  const runId = fx.run(task.automationId, { outcome: 'running', sessionId: null });
  fx.message('sess-1', 'assistant', '已完成\n[[ZTQ_TASK_DONE]]');
  fx.updateRun(runId, 'succeeded');
  fx.runtime.pollClientTask(task);
  assert.equal(task.status, 'done');
  assert.equal(task.sessionId, 'sess-1');
});

test('a terminal new-task run needs no session mapping to finish', (t) => {
  const fx = makeFixture(t);
  fx.runtime.queue.paused = true;
  const id = fx.runtime.createTasks({ type: 'zcode', prompt: 'do it' }, 'terminal-no-session-key').ids[0];
  const task = fx.runtime.findTask(id);
  fx.runtime.queue.paused = false;
  fx.runtime.runTask(task);
  fx.run(task.automationId, { outcome: 'succeeded', sessionId: null });
  fx.runtime.pollClientTask(task);
  assert.equal(task.status, 'done');
});

test('old session timestamps do not trigger an early stall; a real post-dispatch stall pauses safely', (t) => {
  const fx = makeFixture(t);
  fx.runtime.state.settings.stallMin = 3;
  const task = startContinuation(fx);
  fx.run(task.automationId, { outcome: 'running' });
  fx.runtime.pollClientTask(task);
  assert.equal(task.status, 'running');
  fx.clock.value += 3 * 60 * 1000 + 1;
  fx.runtime.pollClientTask(task);
  assert.equal(task.phase, TASK_PHASE.ATTENTION);
  assert.equal(task.clientMayStillBeRunning, true);
  assert.equal(fx.runtime.queue.paused, true);
  assert.throws(() => fx.runtime.queueAction({ action: 'resume' }), (error) => error instanceof RuntimeError && error.statusCode === 409);
});

test('a succeeded run with a stale running tool enters attention instead of hanging forever', (t) => {
  const fx = makeFixture(t);
  fx.runtime.settings.stallMin = 3;
  const task = startContinuation(fx);
  fx.run(task.automationId, { outcome: 'succeeded' });
  fx.client.sessionStatus = () => ({ available: true, toolRunning: true, lastActivity: 'stale tool' });
  fx.client.activityAfter = () => task.execution.dispatchedAt;
  fx.runtime.pollClientTask(task);
  assert.equal(task.status, 'running');
  fx.clock.value += 3 * 60 * 1000 + 1;
  fx.runtime.pollClientTask(task);
  assert.equal(task.phase, TASK_PHASE.ATTENTION);
  assert.equal(task.attention.code, 'client-stalled');
  assert.equal(task.clientMayStillBeRunning, true);
});

test('restart adopts the same waiting automation without another attempt', (t) => {
  const fx = makeFixture(t);
  const task = startContinuation(fx);
  const automationId = task.automationId;
  fx.runtime.clearRuntimeTimers();
  fx.client.close();
  const client2 = new ClientDatabase({ root: fx.root, homeDir: fx.root, indexDbPath: fx.indexDbPath, sessionDbPath: fx.sessionDbPath, clientConfigPath: `${fx.root}/none`, now: fx.clock.now });
  const runtime2 = new QueueRuntime({
    root: fx.root, store: new StateStore({ dataDir: fx.dataDir }), client: client2,
    plans: fx.runtime.plans, now: fx.clock.now, timers: fx.timers, pollMs: 100, resultGraceMs: 0,
  });
  runtime2.start();
  const restored = runtime2.tasks[0];
  assert.equal(restored.attempt, 1);
  assert.equal(restored.automationId, automationId);
  const db = new DatabaseSync(fx.indexDbPath, { readOnly: true });
  assert.equal(db.prepare(`SELECT count(*) AS count FROM automations`).get().count, 1);
  db.close();
  runtime2.clearRuntimeTimers();
  client2.close();
});

test('dispatching intent with no row is recreated once on restart', (t) => {
  const fx = makeFixture(t);
  const task = startContinuation(fx);
  fx.client.cleanupAutomation(task.automationId);
  task.phase = TASK_PHASE.DISPATCHING;
  fx.runtime.commit();
  fx.runtime.clearRuntimeTimers();
  fx.client.close();
  const client2 = new ClientDatabase({ root: fx.root, homeDir: fx.root, indexDbPath: fx.indexDbPath, sessionDbPath: fx.sessionDbPath, clientConfigPath: `${fx.root}/none`, now: fx.clock.now });
  const runtime2 = new QueueRuntime({ root: fx.root, store: new StateStore({ dataDir: fx.dataDir }), client: client2, plans: fx.runtime.plans, now: fx.clock.now, timers: fx.timers, pollMs: 100 });
  runtime2.start();
  assert.equal(runtime2.tasks[0].attempt, 1);
  assert.equal(runtime2.tasks[0].phase, TASK_PHASE.WAITING_DISPATCH);
  const db = new DatabaseSync(fx.indexDbPath, { readOnly: true });
  assert.equal(db.prepare(`SELECT count(*) AS count FROM automations`).get().count, 1);
  db.close();
  runtime2.clearRuntimeTimers(); client2.close();
});

test('a transient SQLite busy error retries the same persisted dispatch intent', (t) => {
  const fx = makeFixture(t, { pollMs: 100 });
  const info = fx.session();
  fx.message('sess-1', 'assistant', 'old');
  fx.runtime.queue.paused = true;
  fx.runtime.createContinuation(info, 'busy-retry-key');
  const originalInsert = fx.client.insertOrAdoptAutomation.bind(fx.client);
  let calls = 0;
  fx.client.insertOrAdoptAutomation = (fields) => {
    calls += 1;
    if (calls === 1) throw new Error('database is locked');
    return originalInsert(fields);
  };
  fx.runtime.queue.paused = false;
  fx.runtime.kick();
  fx.timers.advance(0);
  const task = fx.runtime.tasks[0];
  assert.equal(task.phase, TASK_PHASE.DISPATCHING);
  assert.equal(task.attempt, 1);
  fx.timers.advance(100);
  assert.equal(task.phase, TASK_PHASE.WAITING_DISPATCH);
  assert.equal(task.attempt, 1);
  assert.equal(calls, 2);
  const db = new DatabaseSync(fx.indexDbPath, { readOnly: true });
  assert.equal(db.prepare(`SELECT count(*) AS count FROM automations`).get().count, 1);
  db.close();
});

test('idempotency and timeout tri-state are persisted', (t) => {
  const fx = makeFixture(t);
  fx.runtime.queue.paused = true;
  const first = fx.runtime.createTasks({ type: 'shell', prompt: 'true', timeoutMin: 0 }, 'same-key');
  const second = fx.runtime.createTasks({ type: 'shell', prompt: 'true', timeoutMin: 0 }, 'same-key');
  assert.equal(second.replayed, true);
  assert.deepEqual(second.ids, first.ids);
  assert.equal(fx.runtime.tasks.length, 1);
  assert.equal(fx.runtime.tasks[0].timeoutMin, 0);
  assert.throws(() => fx.runtime.createTasks({ type: 'shell', prompt: 'false' }, 'same-key'), (error) => error.statusCode === 409);
  assert.equal(fx.runtime.createTasks(
    { type: 'shell', prompt: 'true', timeoutMin: 0 },
    'same-key',
    { replayOnly: true },
  ).replayed, true);
  const taskCount = fx.runtime.tasks.length;
  assert.throws(
    () => fx.runtime.createTasks(
      { type: 'shell', prompt: 'printf unsafe-new-write' },
      'missing-replay-key',
      { replayOnly: true },
    ),
    (error) => error.statusCode === 409 && error.code === 'IDEMPOTENCY_REPLAY_UNKNOWN',
  );
  assert.equal(fx.runtime.tasks.length, taskCount);
});

test('idempotency replay expires strictly after 24 hours and permits safe key reuse', (t) => {
  const fx = makeFixture(t);
  fx.runtime.queue.paused = true;
  const dayMs = 24 * 60 * 60 * 1000;
  const createdAt = fx.clock.value;
  const first = fx.runtime.createTasks({ type: 'shell', prompt: 'first operation' }, 'ttl-key');
  assert.equal(first.replayed, undefined);
  assert.equal(fx.runtime.state.idempotency.find((entry) => entry.key === 'ttl-key').createdAt, createdAt);

  fx.clock.value = createdAt + dayMs;
  fx.runtime.commit({ notify: false });
  assert.equal(fx.runtime.state.idempotency.filter((entry) => entry.key === 'ttl-key').length, 1);
  assert.equal(fx.runtime.createTasks(
    { type: 'shell', prompt: 'first operation' },
    'ttl-key',
    { replayOnly: true },
  ).replayed, true);

  fx.clock.value += 1;
  assert.throws(
    () => fx.runtime.createTasks(
      { type: 'shell', prompt: 'first operation' },
      'ttl-key',
      { replayOnly: true },
    ),
    (error) => error instanceof RuntimeError && error.code === 'IDEMPOTENCY_REPLAY_UNKNOWN',
  );
  assert.equal(fx.runtime.state.idempotency.some((entry) => entry.key === 'ttl-key'), false);

  const renewed = fx.runtime.createTasks({ type: 'shell', prompt: 'new operation' }, 'ttl-key');
  assert.equal(renewed.replayed, undefined);
  assert.equal(fx.runtime.tasks.length, 2);
  const records = fx.runtime.state.idempotency.filter((entry) => entry.key === 'ttl-key');
  assert.equal(records.length, 1);
  assert.equal(records[0].createdAt, fx.clock.value);
  assert.equal(fx.runtime.createTasks(
    { type: 'shell', prompt: 'new operation' },
    'ttl-key',
    { replayOnly: true },
  ).replayed, true);
});

test('task payload bounds reject oversized names, prompts, and batches before persistence', (t) => {
  const fx = makeFixture(t);
  fx.runtime.queue.paused = true;
  assert.throws(() => fx.runtime.createTasks({ type: 'shell', name: 'x'.repeat(121), prompt: 'true' }, 'large-name'), /120/);
  assert.throws(() => fx.runtime.createTasks({ type: 'shell', prompt: 'x'.repeat(100001) }, 'large-prompt'), /100000/);
  assert.throws(() => fx.runtime.createTasks({ type: 'shell', batch: Array.from({ length: 201 }, () => 'true').join('\n') }, 'large-batch'), /200/);
  assert.throws(() => fx.runtime.createTasks({ type: 'shell', prompt: 'true', timeoutMin: 10081 }, 'large-timeout'), /10080/);
  assert.equal(fx.runtime.tasks.length, 0);
});

test('hidden session IDs are bounded at ingress and malformed persisted values are repaired', (t) => {
  const fx = makeFixture(t);
  assert.throws(() => fx.runtime.hideSession({ object: true }, 'bad-hidden-object'), /sessionId/);
  assert.throws(() => fx.runtime.hideSession('x'.repeat(201), 'bad-hidden-long'), /200/);
  assert.throws(() => fx.runtime.unhideSession('   ', 'bad-hidden-empty'), /sessionId/);
  fx.runtime.settings.hiddenSessions = ['kept', 'kept', {}, ' ', 'x'.repeat(201)];
  fx.runtime.commit();
  fx.client.close();
  const client2 = new ClientDatabase({
    root: fx.root, homeDir: fx.root, indexDbPath: fx.indexDbPath,
    sessionDbPath: fx.sessionDbPath, clientConfigPath: `${fx.root}/none`, now: fx.clock.now,
  });
  const runtime2 = new QueueRuntime({
    root: fx.root, store: new StateStore({ dataDir: fx.dataDir }), client: client2,
    plans: fx.runtime.plans, now: fx.clock.now, timers: fx.timers,
  });
  assert.deepEqual(runtime2.settings.hiddenSessions, ['kept']);
  client2.close();
});

test('a keyed duplicate continuation remains a no-op after the original task finishes', (t) => {
  const fx = makeFixture(t);
  fx.runtime.queue.paused = true;
  const info = fx.session();
  const original = fx.runtime.createContinuation(info, 'original-key');
  const duplicate = fx.runtime.createContinuation(info, 'duplicate-key');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.id, original.id);
  fx.runtime.tasks[0].status = 'done';
  const replay = fx.runtime.createContinuation(info, 'duplicate-key');
  assert.equal(replay.replayed, true);
  assert.equal(replay.duplicate, true);
  assert.equal(fx.runtime.tasks.length, 1);
});

test('a previously observed automation disappearing pauses instead of advancing', (t) => {
  const fx = makeFixture(t);
  const task = startContinuation(fx);
  assert.equal(fx.client.cleanupAutomation(task.automationId), true);
  fx.runtime.pollClientTask(task);
  assert.equal(task.phase, TASK_PHASE.ATTENTION);
  assert.equal(task.attention.code, 'automation-records-lost');
  assert.equal(task.clientMayStillBeRunning, true);
  assert.equal(fx.runtime.queue.paused, true);
});

test('manual stop fails safe when an unclaimed automation cannot be revoked', (t) => {
  const fx = makeFixture(t);
  const task = startContinuation(fx);
  fx.client.revokeUnclaimedAutomation = () => ({ revoked: false, phase: 'claimed' });
  const response = fx.runtime.queueAction({ action: 'stopCurrent', taskId: task.id }, 'stop-key');
  assert.equal(response.attention, true);
  assert.equal(task.phase, TASK_PHASE.ATTENTION);
  assert.equal(task.attention.code, 'manual-revoke-failed');
  assert.equal(fx.runtime.queue.paused, true);
  const replay = fx.runtime.queueAction({ action: 'stopCurrent', taskId: task.id }, 'stop-key');
  assert.equal(replay.replayed, true);
});

test('ordinary kicks preserve the inter-task delay while runNow explicitly bypasses it', (t) => {
  const fx = makeFixture(t);
  const current = startContinuation(fx);
  fx.runtime.settings.intervalSec = 10;
  const nextId = fx.runtime.createTasks({ type: 'zcode', prompt: 'next delayed task' }, 'delayed-next').ids[0];
  const stoppedAt = fx.clock.value;

  fx.runtime.queueAction({ action: 'stopCurrent', taskId: current.id }, 'stop-before-delay');

  const delayedTimer = fx.runtime.nextTimer;
  assert.ok(delayedTimer);
  assert.equal(fx.timers.entries.get(delayedTimer).at, stoppedAt + 10000);
  assert.equal(fx.runtime.findTask(nextId).status, 'pending');
  fx.runtime.kick();
  assert.equal(fx.runtime.nextTimer, delayedTimer);
  fx.timers.advance(9999);
  assert.equal(fx.runtime.findTask(nextId).status, 'pending');

  fx.runtime.taskAction(nextId, 'runNow', 'run-now-bypasses-delay');
  assert.notEqual(fx.runtime.nextTimer, delayedTimer);
  assert.equal(fx.timers.entries.get(fx.runtime.nextTimer).at, fx.clock.value);
  fx.timers.advance(0);
  assert.equal(fx.runtime.findTask(nextId).phase, TASK_PHASE.WAITING_DISPATCH);
});

test('dispatch failure with claimed evidence enters attention without deleting the automation', (t) => {
  const fx = makeFixture(t);
  const task = startContinuation(fx);
  let cleanupCalls = 0;
  fx.client.queryAutomation = () => ({
    phase: 'tracked',
    dispatchFailed: true,
    possiblyClaimed: true,
    automation: { last_error: 'stale dispatch error', running: 1, dispatch_status: 'claimed' },
    run: null,
  });
  fx.client.cleanupAutomation = () => { cleanupCalls += 1; return true; };
  fx.runtime.pollClientTask(task);
  assert.equal(task.phase, TASK_PHASE.ATTENTION);
  assert.equal(task.attention.code, 'dispatch-failed-possibly-claimed');
  assert.equal(task.clientMayStillBeRunning, true);
  assert.equal(cleanupCalls, 0);
});

test('retryable dispatch failure remains monitored, then a permanent failure finishes immediately', (t) => {
  const fx = makeFixture(t);
  fx.runtime.settings.stopOnFail = false;
  const task = startContinuation(fx);
  const oldAutomationId = task.automationId;
  const nextId = fx.runtime.createTasks({ type: 'zcode', prompt: 'next task' }, 'after-terminal-dispatch').ids[0];
  fx.client.closeIndex();

  const db = new DatabaseSync(fx.indexDbPath);
  db.prepare(`UPDATE automations
    SET lifecycle_status = 'active', enabled = 1, running = 0, claimed_at = NULL,
        dispatch_status = 'idle', retry_at = ?, dispatch_attempts = 1,
        last_error = 'temporary dispatch error'
    WHERE automation_id = ?`).run(fx.clock.value + 1000, oldAutomationId);
  db.prepare(`INSERT INTO automation_runs (
    run_id, automation_id, workspace_key, dispatch_status, outcome, session_id, error, created_at, updated_at
  ) VALUES ('retry-run', ?, ?, 'failed_to_dispatch', NULL, NULL, 'temporary dispatch error', ?, ?)`)
    .run(oldAutomationId, fx.root, fx.clock.value, fx.clock.value);
  db.close();

  fx.runtime.pollClientTask(task);
  assert.equal(task.status, 'running');
  assert.equal(task.clientMayStillBeRunning, true);

  fx.client.closeIndex();
  const terminal = new DatabaseSync(fx.indexDbPath);
  terminal.prepare(`UPDATE automations
    SET lifecycle_status = 'failed', enabled = 0, running = 0, claimed_at = NULL,
        retry_at = NULL, last_error = 'permanent dispatch error'
    WHERE automation_id = ?`).run(oldAutomationId);
  terminal.prepare(`UPDATE automation_runs SET error = 'permanent dispatch error' WHERE run_id = 'retry-run'`).run();
  terminal.close();

  fx.runtime.pollClientTask(task);
  assert.equal(task.status, 'failed');
  assert.match(task.error, /permanent dispatch error/);
  assert.equal(task.clientMayStillBeRunning, false);
  const verified = new DatabaseSync(fx.indexDbPath, { readOnly: true });
  assert.equal(verified.prepare(`SELECT count(*) AS count FROM automations WHERE automation_id = ?`).get(oldAutomationId).count, 0);
  assert.equal(verified.prepare(`SELECT count(*) AS count FROM automation_runs WHERE automation_id = ?`).get(oldAutomationId).count, 0);
  verified.close();

  fx.timers.advance(0);
  const next = fx.runtime.findTask(nextId);
  assert.equal(next.phase, TASK_PHASE.WAITING_DISPATCH);
  assert.equal(next.attempt, 1);
});

test('a skipped one-shot client run is an immediate terminal failure', (t) => {
  const fx = makeFixture(t);
  fx.runtime.queue.paused = true;
  const id = fx.runtime.createTasks({ type: 'zcode', prompt: 'one-shot task' }, 'skipped-one-shot').ids[0];
  const task = fx.runtime.findTask(id);
  fx.runtime.queue.paused = false;
  fx.runtime.runTask(task);
  fx.client.closeIndex();

  const db = new DatabaseSync(fx.indexDbPath);
  db.prepare(`UPDATE automations
    SET lifecycle_status = 'completed', enabled = 0, running = 0, claimed_at = NULL,
        dispatch_status = 'idle', last_error = 'missed one-shot window'
    WHERE automation_id = ?`).run(task.automationId);
  db.prepare(`INSERT INTO automation_runs (
    run_id, automation_id, workspace_key, dispatch_status, outcome, session_id, error, created_at, updated_at
  ) VALUES ('skipped-run', ?, ?, 'skipped', NULL, NULL, 'missed one-shot window', ?, ?)`)
    .run(task.automationId, fx.root, fx.clock.value, fx.clock.value);
  db.close();

  fx.runtime.pollClientTask(task);
  assert.equal(task.status, 'failed');
  assert.match(task.error, /missed one-shot window/);
  assert.equal(task.clientMayStillBeRunning, false);
});

test('a concurrent client claim between dispatch observation and revocation is preserved', async (t) => {
  const fx = makeFixture(t);
  fx.runtime.settings.stopOnFail = false;
  const task = startContinuation(fx);
  const automationId = task.automationId;
  const nextId = fx.runtime.createTasks({ type: 'zcode', prompt: 'must stay pending' }, 'after-claim-race').ids[0];
  fx.client.closeIndex();

  const setup = new DatabaseSync(fx.indexDbPath);
  setup.exec('PRAGMA journal_mode = WAL');
  setup.prepare(`UPDATE automations
    SET lifecycle_status = 'active', enabled = 1, running = 0, claimed_at = NULL,
        dispatch_status = 'idle', last_error = 'observed dispatch failure'
    WHERE automation_id = ?`).run(automationId);
  setup.close();

  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.indexDbPath);
    db.exec('PRAGMA busy_timeout = 5000');
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare(\`UPDATE automations
        SET running = 1, claimed_at = ?, dispatch_status = 'claimed', last_error = NULL
        WHERE automation_id = ?\`).run(workerData.now, workerData.automationId);
      db.prepare(\`INSERT INTO automation_runs (
        run_id, automation_id, workspace_key, dispatch_status, outcome, session_id, created_at, updated_at
      ) VALUES ('racing-run', ?, ?, 'claimed', 'running', ?, ?, ?)\`)
        .run(workerData.automationId, workerData.root, workerData.sessionId, workerData.now, workerData.now);
      db.prepare(\`UPDATE tasks SET cron_automation_id = ?, task_status = 'running' WHERE task_id = ?\`)
        .run(workerData.automationId, workerData.sessionId);
      parentPort.postMessage({ phase: 'claimed' });
      setTimeout(() => {
        try {
          db.exec('COMMIT');
          db.close();
          parentPort.postMessage({ phase: 'committed' });
        } catch (error) {
          parentPort.postMessage({ phase: 'error', error: error.message });
        }
      }, workerData.holdMs);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      try { db.close(); } catch {}
      parentPort.postMessage({ phase: 'error', error: error.message });
    }
  `, {
    eval: true,
    workerData: {
      indexDbPath: fx.indexDbPath,
      automationId,
      root: fx.root,
      sessionId: 'sess-1',
      now: fx.clock.value,
      holdMs: 500,
    },
  });
  t.after(() => worker.terminate());
  const claimed = new Promise((resolve, reject) => {
    worker.on('message', (message) => {
      if (message.phase === 'claimed') resolve();
      if (message.phase === 'error') reject(new Error(message.error));
    });
    worker.once('error', reject);
  });
  const committed = new Promise((resolve, reject) => {
    worker.on('message', (message) => {
      if (message.phase === 'committed') resolve();
      if (message.phase === 'error') reject(new Error(message.error));
    });
    worker.once('error', reject);
  });
  await claimed;

  fx.runtime.pollClientTask(task);
  await committed;

  assert.equal(task.phase, TASK_PHASE.ATTENTION);
  assert.equal(task.attention.code, 'dispatch-failed-revoke-failed');
  assert.equal(task.clientMayStillBeRunning, true);
  assert.equal(fx.runtime.queue.paused, true);
  assert.equal(fx.runtime.findTask(nextId).status, 'pending');
  const verify = new DatabaseSync(fx.indexDbPath, { readOnly: true });
  assert.equal(verify.prepare(`SELECT count(*) AS count FROM automations WHERE automation_id = ?`).get(automationId).count, 1);
  assert.equal(verify.prepare(`SELECT count(*) AS count FROM automation_runs WHERE automation_id = ?`).get(automationId).count, 1);
  assert.equal(verify.prepare(`SELECT task_status FROM tasks WHERE task_id = 'sess-1'`).get().task_status, 'running');
  verify.close();
});

test('attention reattach verifies the complete persisted dispatch fingerprint', (t) => {
  const fx = makeFixture(t);
  const task = startContinuation(fx);
  fx.runtime.enterAttention(task, 'test-attention', 'test attention', {}, false);

  const db = new DatabaseSync(fx.indexDbPath);
  db.prepare(`UPDATE automations SET prompt = 'tampered' WHERE automation_id = ?`).run(task.automationId);
  db.close();
  fx.client.closeIndex();

  assert.throws(
    () => fx.runtime.taskAction(task.id, 'reattach', 'reattach-key'),
    (error) => error instanceof RuntimeError && error.statusCode === 409 && error.code === 'REATTACH_CONFLICT',
  );
  assert.equal(task.phase, TASK_PHASE.ATTENTION);
  assert.equal(fx.runtime.queue.paused, true);
});

test('a late nonterminal run from the previous attempt blocks the next attempt', (t) => {
  const fx = makeFixture(t);
  const task = startContinuation(fx);
  fx.runtime.settings.intervalSec = 1;
  const firstAutomation = task.automationId;
  const runId = fx.run(firstAutomation, { outcome: 'running' });
  fx.message('sess-1', 'assistant', '还需要继续');
  fx.updateRun(runId, 'succeeded');
  fx.runtime.pollClientTask(task);
  assert.equal(task.phase, TASK_PHASE.BETWEEN_ATTEMPTS);

  const db = new DatabaseSync(fx.indexDbPath);
  db.prepare(`INSERT INTO automation_runs (run_id, automation_id, workspace_key, dispatch_status, outcome, session_id, created_at, updated_at) VALUES ('late-run', ?, ?, 'dispatched', 'running', 'sess-1', ?, ?)`) 
    .run(firstAutomation, fx.root, fx.clock.value, fx.clock.value);
  db.close();
  fx.client.closeIndex();

  fx.timers.advance(1000);
  assert.equal(task.attempt, 1);
  assert.equal(task.phase, TASK_PHASE.ATTENTION);
  assert.equal(task.attention.code, 'late-previous-attempt');
});

test('database errors after dispatch receive their own grace period', (t) => {
  const fx = makeFixture(t, { dbErrorGraceMs: 1000 });
  const task = startContinuation(fx);
  fx.run(task.automationId, { outcome: 'running' });
  fx.runtime.pollClientTask(task);
  assert.equal(task.status, 'running');
  fx.clock.value = task.execution.dispatchDeadlineAt + 1;
  fx.client.queryAutomation = () => ({ phase: 'error', error: 'locked' });
  fx.runtime.pollClientTask(task);
  assert.equal(task.status, 'running');
  fx.clock.value += 999;
  fx.runtime.pollClientTask(task);
  assert.equal(task.status, 'running');
  fx.clock.value += 2;
  fx.runtime.pollClientTask(task);
  assert.equal(task.phase, TASK_PHASE.ATTENTION);
  assert.equal(task.attention.code, 'client-database-unavailable');
});

test('a continuation is never dispatched without a readable message baseline', (t) => {
  const fx = makeFixture(t);
  fx.runtime.state.settings.intervalSec = 0;
  const info = fx.session();
  fx.client.messageCursor = () => null;
  fx.runtime.createContinuation(info, 'missing-baseline-key');
  fx.timers.advance(0);
  const task = fx.runtime.tasks[0];
  assert.equal(task.status, 'failed');
  assert.match(task.error, /消息基线/);
  const db = new DatabaseSync(fx.indexDbPath, { readOnly: true });
  assert.equal(db.prepare(`SELECT count(*) AS count FROM automations`).get().count, 0);
  db.close();
});

test('session database failures retain one grace window and never auto-advance', (t) => {
  const fx = makeFixture(t, { dbErrorGraceMs: 1000 });
  const task = startContinuation(fx);
  fx.run(task.automationId, { outcome: 'succeeded' });
  fx.client.sessionStatus = () => ({ available: false, error: 'session locked' });
  fx.client.reopen = () => false;
  fx.runtime.pollClientTask(task);
  const firstErrorAt = task.execution.dbErrorSince;
  assert.equal(task.status, 'running');
  assert.equal(task.attempt, 1);
  fx.clock.value += 999;
  fx.runtime.pollClientTask(task);
  assert.equal(task.execution.dbErrorSince, firstErrorAt);
  assert.equal(task.attempt, 1);
  fx.clock.value += 2;
  fx.runtime.pollClientTask(task);
  assert.equal(task.phase, TASK_PHASE.ATTENTION);
  assert.equal(task.attention.code, 'client-database-unavailable');
  assert.equal(task.attempt, 1);
});

test('startup can synchronously observe a terminal run without leaving a stale poll', (t) => {
  const fx = makeFixture(t);
  const task = startContinuation(fx);
  fx.run(task.automationId, { outcome: 'succeeded' });
  fx.message('sess-1', 'assistant', '全部验证通过\n[[ZTQ_TASK_DONE]]');
  fx.runtime.clearRuntimeTimers();
  fx.client.close();
  const client2 = new ClientDatabase({ root: fx.root, homeDir: fx.root, indexDbPath: fx.indexDbPath, sessionDbPath: fx.sessionDbPath, clientConfigPath: `${fx.root}/none`, now: fx.clock.now });
  const runtime2 = new QueueRuntime({ root: fx.root, store: new StateStore({ dataDir: fx.dataDir }), client: client2, plans: fx.runtime.plans, now: fx.clock.now, timers: fx.timers, pollMs: 100, resultGraceMs: 0 });
  assert.doesNotThrow(() => runtime2.start());
  assert.equal(runtime2.tasks[0].status, 'done');
  assert.equal(runtime2.current, null);
  runtime2.clearRuntimeTimers();
  client2.close();
});

test('first migration establishes a guard baseline without replaying an old stop event', (t) => {
  const fx = makeFixture(t);
  fx.runtime.settings.autoStopEnabled = true;
  fx.runtime.settings.autoStopTime = '08:55';
  fx.runtime.settings.autoEnableEnabled = true;
  fx.runtime.settings.autoEnableTime = '23:00';
  assert.equal(fx.runtime.storage.migrated, true);
  assert.equal(fx.runtime.queue.guardState.lastAppliedAt, fx.clock.value);
  assert.equal(latestDueGuardEvent(fx.runtime.settings, fx.runtime.queue.guardState, new Date(fx.clock.value)), null);
});

test('the first migrated state already contains the guard baseline if runtime normalization cannot commit', (t) => {
  const fx = makeFixture(t, { now: new Date(2026, 8, 13, 9, 0, 0, 0).getTime() });
  fx.runtime.clearRuntimeTimers();
  fx.client.close();
  fs.rmSync(fx.dataDir, { recursive: true, force: true });
  fs.mkdirSync(fx.dataDir, { recursive: true });
  fs.writeFileSync(path.join(fx.dataDir, 'tasks.json'), '[]');
  fs.writeFileSync(path.join(fx.dataDir, 'settings.json'), JSON.stringify({
    autoStopEnabled: true,
    autoStopTime: '08:55',
    autoEnableEnabled: true,
    autoEnableTime: '23:00',
  }));

  class FailRuntimeNormalizationStore extends StateStore {
    save(snapshot, options) {
      this.saveCalls = Number(this.saveCalls || 0) + 1;
      if (this.saveCalls === 2) throw new StorageFatalError('simulated post-migration ENOSPC');
      return super.save(snapshot, options);
    }
  }
  const failingClient = new ClientDatabase({
    root: fx.root,
    homeDir: fx.root,
    indexDbPath: fx.indexDbPath,
    sessionDbPath: fx.sessionDbPath,
    clientConfigPath: `${fx.root}/config.json`,
    now: fx.clock.now,
  });
  assert.throws(() => new QueueRuntime({
    root: fx.root,
    store: new FailRuntimeNormalizationStore({ dataDir: fx.dataDir }),
    client: failingClient,
    plans: fx.runtime.plans,
    now: fx.clock.now,
    timers: fx.timers,
  }), /simulated post-migration ENOSPC/);
  failingClient.close();

  const persisted = JSON.parse(fs.readFileSync(path.join(fx.dataDir, 'state.json'), 'utf8'));
  assert.equal(persisted.queue.guardState.stopLastAt, fx.clock.value);
  assert.equal(persisted.queue.guardState.enableLastAt, fx.clock.value);
  assert.equal(persisted.queue.guardState.lastAppliedAt, fx.clock.value);
  assert.equal(fs.existsSync(path.join(fx.dataDir, '.state-v2-initialized')), true);

  const restartedClient = new ClientDatabase({
    root: fx.root,
    homeDir: fx.root,
    indexDbPath: fx.indexDbPath,
    sessionDbPath: fx.sessionDbPath,
    clientConfigPath: `${fx.root}/config.json`,
    now: fx.clock.now,
  });
  const restarted = new QueueRuntime({
    root: fx.root,
    store: new StateStore({ dataDir: fx.dataDir }),
    client: restartedClient,
    plans: fx.runtime.plans,
    now: fx.clock.now,
    timers: fx.timers,
  });
  t.after(() => { restarted.clearRuntimeTimers(); restartedClient.close(); });
  assert.equal(restarted.storage.migrated, false);
  assert.equal(latestDueGuardEvent(restarted.settings, restarted.queue.guardState, new Date(fx.clock.value)), null);
});

test('backup recovery persists a guard baseline before runtime normalization can fail', (t) => {
  const fixedNow = new Date(2026, 8, 13, 9, 0, 0, 0).getTime();
  const fx = makeFixture(t, { now: fixedNow });
  fx.runtime.clearRuntimeTimers();
  fx.client.close();

  const stateFile = path.join(fx.dataDir, 'state.json');
  const backupFile = path.join(fx.dataDir, 'state.json.bak');
  const stale = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  stale.settings.autoStopEnabled = true;
  stale.settings.autoStopTime = '08:55';
  stale.settings.autoEnableEnabled = true;
  stale.settings.autoEnableTime = '23:00';
  stale.queue.guardState.stopLastAt = 0;
  stale.queue.guardState.enableLastAt = 0;
  stale.queue.guardState.lastAppliedAt = 0;
  fs.writeFileSync(backupFile, JSON.stringify(stale));
  fs.writeFileSync(stateFile, '{');

  class FailRuntimeNormalizationStore extends StateStore {
    save(snapshot, options) {
      this.saveCalls = Number(this.saveCalls || 0) + 1;
      // Recovery durably writes primary and backup first; the runtime's
      // settings-aware normalization is the third write.
      if (this.saveCalls === 3) throw new StorageFatalError('simulated recovery normalization ENOSPC');
      return super.save(snapshot, options);
    }
  }
  const failingClient = new ClientDatabase({
    root: fx.root,
    homeDir: fx.root,
    indexDbPath: fx.indexDbPath,
    sessionDbPath: fx.sessionDbPath,
    clientConfigPath: `${fx.root}/config.json`,
    now: fx.clock.now,
  });
  assert.throws(() => new QueueRuntime({
    root: fx.root,
    store: new FailRuntimeNormalizationStore({ dataDir: fx.dataDir }),
    client: failingClient,
    plans: fx.runtime.plans,
    now: fx.clock.now,
    timers: fx.timers,
  }), /simulated recovery normalization ENOSPC/);
  failingClient.close();

  for (const name of ['state.json', 'state.json.bak']) {
    const persisted = JSON.parse(fs.readFileSync(path.join(fx.dataDir, name), 'utf8'));
    assert.equal(persisted.queue.guardState.stopLastAt, fixedNow);
    assert.equal(persisted.queue.guardState.enableLastAt, fixedNow);
    assert.equal(persisted.queue.guardState.lastAppliedAt, fixedNow);
  }

  const restartedClient = new ClientDatabase({
    root: fx.root,
    homeDir: fx.root,
    indexDbPath: fx.indexDbPath,
    sessionDbPath: fx.sessionDbPath,
    clientConfigPath: `${fx.root}/config.json`,
    now: fx.clock.now,
  });
  const restarted = new QueueRuntime({
    root: fx.root,
    store: new StateStore({ dataDir: fx.dataDir }),
    client: restartedClient,
    plans: fx.runtime.plans,
    now: fx.clock.now,
    timers: fx.timers,
  });
  t.after(() => { restarted.clearRuntimeTimers(); restartedClient.close(); });
  assert.equal(restarted.storage.recovered, false);
  assert.equal(latestDueGuardEvent(restarted.settings, restarted.queue.guardState, new Date(fixedNow)), null);
});

test('backup recovery preserves a legacy guard-stop ownership latch below the recovery pause', (t) => {
  const fx = makeFixture(t);
  fx.runtime.clearRuntimeTimers();
  fx.client.close();
  const stateFile = path.join(fx.dataDir, 'state.json');
  const backupFile = path.join(fx.dataDir, 'state.json.bak');
  const legacy = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const futureWatermark = fx.clock.value + 60 * 1000;
  legacy.queue.guardState.stopLastAt = futureWatermark;
  legacy.queue.guardState.enableLastAt = futureWatermark;
  legacy.queue.guardState.lastAppliedAt = futureWatermark;
  legacy.queue.paused = true;
  legacy.queue.pausedBySystem = true;
  legacy.queue.pauseReason = {
    kind: 'attention',
    source: 'guard-stop-ownership',
    message: 'legacy ownership cannot be proven',
    since: fx.clock.value - 1000,
    eventTime: fx.clock.value - 2000,
  };
  delete legacy.queue.guardState.stopOwnershipPending;
  delete legacy.queue.guardState.stopBasePause;
  fs.writeFileSync(backupFile, JSON.stringify(legacy));
  fs.writeFileSync(stateFile, '{');

  const client2 = new ClientDatabase({
    root: fx.root,
    homeDir: fx.root,
    indexDbPath: fx.indexDbPath,
    sessionDbPath: fx.sessionDbPath,
    clientConfigPath: `${fx.root}/config.json`,
    now: fx.clock.now,
  });
  const runtime2 = new QueueRuntime({
    root: fx.root,
    store: new StateStore({ dataDir: fx.dataDir }),
    client: client2,
    plans: fx.runtime.plans,
    now: fx.clock.now,
    timers: fx.timers,
  });
  t.after(() => { runtime2.clearRuntimeTimers(); client2.close(); });
  assert.equal(runtime2.storage.recovered, true);
  assert.equal(runtime2.queue.pauseReason.kind, 'storage-recovery');
  assert.equal(runtime2.hasGuardStopOwnershipPending(), true);
  assert.equal(runtime2.guardStopOwnershipPending().message, 'legacy ownership cannot be proven');
  assert.equal(runtime2.guardStopBasePause().kind, 'storage-recovery');
  assert.equal(runtime2.queue.guardState.stopLastAt, futureWatermark);
  assert.equal(runtime2.queue.guardState.enableLastAt, futureWatermark);
  assert.equal(runtime2.queue.guardState.lastAppliedAt, futureWatermark);
  assert.throws(
    () => runtime2.queueAction({ action: 'resume' }, 'resume-legacy-latch'),
    (error) => error.code === 'GUARD_STOP_UNVERIFIED',
  );
  for (const name of ['state.json', 'state.json.bak']) {
    const persisted = JSON.parse(fs.readFileSync(path.join(fx.dataDir, name), 'utf8'));
    assert.ok(persisted.queue.guardState.stopOwnershipPending);
  }
});

test('task attention cannot erase the explicit resume gate after backup recovery', (t) => {
  const fx = makeFixture(t);
  fx.runtime.queue.paused = true;
  const taskId = fx.runtime.createTasks({ type: 'shell', name: 'recovered active shell', prompt: 'true' }, 'recovery-active-shell').ids[0];
  const task = fx.runtime.findTask(taskId);
  task.status = 'running';
  task.phase = TASK_PHASE.RUNNING;
  task.execution = { startedAt: fx.clock.value - 1000 };
  fx.runtime.queue.paused = false;
  fx.runtime.queue.pausedBySystem = false;
  fx.runtime.queue.pauseReason = null;
  fx.runtime.queue.guardState.stopBasePause = null;
  fx.runtime.commit();
  task.activity = 'newer primary generation';
  fx.runtime.commit();
  fx.runtime.clearRuntimeTimers();
  fx.client.close();
  fs.writeFileSync(path.join(fx.dataDir, 'state.json'), '{');

  const client2 = new ClientDatabase({
    root: fx.root,
    homeDir: fx.root,
    indexDbPath: fx.indexDbPath,
    sessionDbPath: fx.sessionDbPath,
    clientConfigPath: `${fx.root}/config.json`,
    now: fx.clock.now,
  });
  const runtime2 = new QueueRuntime({
    root: fx.root,
    store: new StateStore({ dataDir: fx.dataDir }),
    client: client2,
    plans: fx.runtime.plans,
    now: fx.clock.now,
    timers: fx.timers,
  });
  t.after(() => { runtime2.clearRuntimeTimers(); client2.close(); });
  assert.equal(runtime2.storage.recovered, true);
  runtime2.start();
  assert.equal(runtime2.findTask(taskId).status, 'attention');
  assert.equal(runtime2.queue.pauseReason.kind, 'attention');
  assert.equal(runtime2.guardStopBasePause().kind, 'storage-recovery');

  runtime2.taskAction(taskId, 'acknowledge', 'ack-recovered-active');
  assert.equal(runtime2.queue.paused, true);
  assert.equal(runtime2.queue.pauseReason.kind, 'storage-recovery');
  runtime2.queueAction({ action: 'resume' }, 'confirm-recovered-state');
  assert.equal(runtime2.queue.paused, false);
  assert.equal(runtime2.guardStopBasePause(), null);
});

test('queue mutations replay from persisted idempotency records', (t) => {
  const fx = makeFixture(t);
  const first = fx.runtime.queueAction({ action: 'pause' }, 'queue-key');
  const revision = fx.runtime.revision;
  const replay = fx.runtime.queueAction({ action: 'pause' }, 'queue-key');
  assert.equal(first.paused, true);
  assert.equal(replay.replayed, true);
  assert.equal(fx.runtime.revision, revision);
  assert.throws(() => fx.runtime.queueAction({ action: 'resume' }, 'queue-key'), (error) => error.statusCode === 409);
});

test('stale stop requests cannot stop a different current task', (t) => {
  const fx = makeFixture(t);
  fx.runtime.queue.paused = true;
  const first = fx.runtime.createTasks({ type: 'shell', name: 'first', prompt: 'true' }, 'first-key').ids[0];
  const second = fx.runtime.createTasks({ type: 'shell', name: 'second', prompt: 'true' }, 'second-key').ids[0];
  fx.runtime.queue.paused = false;
  fx.runtime.current = { taskId: second, kind: 'shell', child: { kill: () => { throw new Error('must not be called'); } } };
  const response = fx.runtime.queueAction({ action: 'stopCurrent', taskId: first }, 'stale-stop-key');
  assert.equal(response.stale, true);
  assert.equal(fx.runtime.current.taskId, second);
});

test('automatic stop cannot overwrite manual or attention pauses', (t) => {
  const fx = makeFixture(t);
  fx.runtime.queueAction({ action: 'pause' }, 'manual-pause-key');
  assert.equal(fx.runtime.setSystemPause('auto-stop', 'scheduled stop'), false);
  assert.equal(fx.runtime.queue.pauseReason.kind, 'manual');
  fx.runtime.clearSystemPause('auto-stop');
  assert.equal(fx.runtime.queue.paused, true);

  fx.runtime.queue.paused = true;
  fx.runtime.queue.pausedBySystem = true;
  fx.runtime.queue.pauseReason = { kind: 'attention', taskId: 'a', message: 'uncertain', since: fx.clock.value };
  assert.equal(fx.runtime.setSystemPause('auto-stop', 'scheduled stop'), false);
  fx.runtime.queueAction({ action: 'pause' }, 'attention-pause-key');
  assert.equal(fx.runtime.queue.pauseReason.kind, 'attention');
  assert.throws(() => fx.runtime.queueAction({ action: 'resume' }, 'resume-attention-key'), (error) => error.statusCode === 409);
});

test('guard stop ownership latch survives restart and blocks resume and dispatch independently of the visible pause', (t) => {
  const fx = makeFixture(t);
  fx.runtime.queueAction({ action: 'pause' }, 'latch-manual-pause');
  const taskId = fx.runtime.createTasks({ type: 'zcode', name: 'latched task', prompt: 'do not dispatch' }, 'latch-task').ids[0];
  const eventTime = fx.clock.value - 1000;
  fx.runtime.setGuardStopOwnershipPending({
    source: 'scheduled',
    eventTime,
    message: 'ownership is not yet verified',
    guardPauseApplied: false,
  });

  assert.equal(fx.runtime.queue.pauseReason.kind, 'manual');
  assert.equal(fx.runtime.queue.guardState.stopOwnershipPending.eventTime, eventTime);
  assert.throws(
    () => fx.runtime.queueAction({ action: 'resume' }, 'latch-resume'),
    (error) => error instanceof RuntimeError && error.code === 'GUARD_STOP_UNVERIFIED',
  );

  // The latch is an independent dispatch gate. Even if a future regression
  // accidentally clears the visible pause, none of the dispatch entry points
  // may create an automation while stop ownership is unresolved.
  fx.runtime.queue.paused = false;
  fx.runtime.queue.pausedBySystem = false;
  fx.runtime.queue.pauseReason = null;
  const task = fx.runtime.findTask(taskId);
  fx.runtime.kick();
  fx.timers.advance(0);
  fx.runtime.runTask(task);
  assert.equal(task.status, 'pending');
  assert.equal(fx.runtime.current, null);
  const index = new DatabaseSync(fx.indexDbPath, { readOnly: true });
  assert.equal(index.prepare('SELECT count(*) AS n FROM automations').get().n, 0);
  index.close();

  fx.client.close();
  const client2 = new ClientDatabase({
    root: fx.root,
    homeDir: fx.root,
    indexDbPath: fx.indexDbPath,
    sessionDbPath: fx.sessionDbPath,
    clientConfigPath: `${fx.root}/config.json`,
    now: fx.clock.now,
  });
  const runtime2 = new QueueRuntime({
    root: fx.root,
    store: new StateStore({ dataDir: fx.dataDir }),
    client: client2,
    plans: fx.runtime.plans,
    now: fx.clock.now,
    timers: fx.timers,
    pollMs: 100,
    resultGraceMs: 0,
  });
  t.after(() => { runtime2.clearRuntimeTimers(); client2.close(); });
  runtime2.start();
  assert.equal(runtime2.hasGuardStopOwnershipPending(), true);
  assert.equal(runtime2.queue.paused, true);
  assert.equal(runtime2.queue.pauseReason.kind, 'manual');
  assert.equal(runtime2.findTask(taskId).status, 'pending');

  runtime2.clearGuardStopOwnershipPending();
  assert.equal(runtime2.hasGuardStopOwnershipPending(), false);
  assert.equal(runtime2.queue.paused, true);
  assert.equal(runtime2.queue.pauseReason.kind, 'manual');
});

test('restart cannot materialize a persisted dispatch intent while the guard stop latch is active', (t) => {
  const fx = makeFixture(t);
  const originalInsert = fx.client.insertOrAdoptAutomation.bind(fx.client);
  fx.client.insertOrAdoptAutomation = () => {
    const error = new Error('database is busy');
    error.code = 'SQLITE_BUSY';
    throw error;
  };
  const taskId = fx.runtime.createTasks({ type: 'zcode', name: 'restart latch', prompt: 'must wait' }, 'restart-latch-task').ids[0];
  fx.timers.advance(0);
  const task = fx.runtime.findTask(taskId);
  assert.equal(task.phase, TASK_PHASE.DISPATCHING);
  assert.equal(fx.runtime.current.taskId, taskId);
  fx.runtime.setGuardStopOwnershipPending({
    source: 'manual-api',
    eventTime: fx.clock.value,
    message: 'stop verification pending',
  });

  const automationCount = () => {
    const db = new DatabaseSync(fx.indexDbPath, { readOnly: true });
    const count = db.prepare('SELECT count(*) AS n FROM automations').get().n;
    db.close();
    return count;
  };
  assert.equal(automationCount(), 0);
  fx.runtime.clearRuntimeTimers();
  fx.client.insertOrAdoptAutomation = originalInsert;
  fx.client.close();

  const client2 = new ClientDatabase({
    root: fx.root,
    homeDir: fx.root,
    indexDbPath: fx.indexDbPath,
    sessionDbPath: fx.sessionDbPath,
    clientConfigPath: `${fx.root}/config.json`,
    now: fx.clock.now,
  });
  const runtime2 = new QueueRuntime({
    root: fx.root,
    store: new StateStore({ dataDir: fx.dataDir }),
    client: client2,
    plans: fx.runtime.plans,
    now: fx.clock.now,
    timers: fx.timers,
    pollMs: 100,
    resultGraceMs: 0,
  });
  t.after(() => { runtime2.clearRuntimeTimers(); client2.close(); });
  runtime2.start();
  assert.equal(runtime2.hasGuardStopOwnershipPending(), true);
  assert.equal(runtime2.findTask(taskId).phase, TASK_PHASE.DISPATCHING);
  assert.equal(automationCount(), 0);

  runtime2.clearGuardStopOwnershipPending();
  runtime2.queueAction({ action: 'resume' }, 'restart-latch-resume');
  assert.equal(automationCount(), 1);
  assert.equal(runtime2.findTask(taskId).phase, TASK_PHASE.WAITING_DISPATCH);
});

test('acknowledging one of multiple attention tasks keeps the queue paused for the rest', (t) => {
  const fx = makeFixture(t);
  fx.runtime.queue.paused = true;
  const firstId = fx.runtime.createTasks({ type: 'shell', name: 'first attention', prompt: 'true' }, 'multi-attn-a').ids[0];
  const secondId = fx.runtime.createTasks({ type: 'shell', name: 'second attention', prompt: 'true' }, 'multi-attn-b').ids[0];
  const pendingId = fx.runtime.createTasks({ type: 'shell', name: 'pending', prompt: 'true' }, 'multi-attn-c').ids[0];
  const first = fx.runtime.findTask(firstId);
  const second = fx.runtime.findTask(secondId);
  fx.runtime.markAttentionWithoutCommit(first, 'first', 'first attention', {}, false);
  fx.runtime.markAttentionWithoutCommit(second, 'second', 'second attention', {}, false);
  fx.runtime.commit();

  fx.runtime.taskAction(firstId, 'acknowledge', 'ack-first');
  assert.equal(first.status, 'failed');
  assert.equal(second.status, 'attention');
  assert.equal(fx.runtime.queue.paused, true);
  assert.equal(fx.runtime.queue.pauseReason.taskId, secondId);
  assert.equal(fx.runtime.queue.pauseReason.count, 1);
  fx.timers.advance(0);
  assert.equal(fx.runtime.findTask(pendingId).status, 'pending');
});

test('a second attention task cannot replace the task already reattached to monitoring', (t) => {
  const fx = makeFixture(t);
  const first = startContinuation(fx, 'sess-a');
  fx.runtime.enterAttention(first, 'first-attention', 'first', {}, true);
  const firstAutomation = first.automationId;

  const secondInfo = fx.session('sess-b');
  fx.message('sess-b', 'assistant', 'old');
  fx.runtime.queue.paused = false;
  fx.runtime.current = null;
  fx.runtime.createContinuation(secondInfo, 'second-attention-key');
  fx.timers.advance(0);
  const second = fx.runtime.tasks.find((task) => task.targetSessionId === 'sess-b');
  fx.runtime.enterAttention(second, 'second-attention', 'second', {}, true);

  fx.runtime.reattachAttention(first);
  assert.equal(fx.runtime.current.taskId, first.id);
  assert.equal(first.automationId, firstAutomation);
  assert.throws(
    () => fx.runtime.reattachAttention(second),
    (error) => error instanceof RuntimeError && error.code === 'ACTIVE_TASK_EXISTS',
  );
  assert.equal(fx.runtime.current.taskId, first.id);
  assert.equal(first.status, 'waiting');
  assert.equal(second.status, 'attention');
  assert.equal(fx.runtime.queue.paused, true);
});

test('terminal state is persisted before external automation evidence is cleaned', (t) => {
  const fx = makeFixture(t);
  const task = startContinuation(fx);
  let cleanupCalls = 0;
  fx.client.cleanupAutomation = () => { cleanupCalls += 1; return true; };
  fx.store.save = () => { throw new Error('simulated ENOSPC'); };
  assert.throws(() => fx.runtime.finishTask(task, 'failed', null, 'failed'), /ENOSPC/);
  assert.equal(cleanupCalls, 0);
});

test('an explicit missing working directory fails instead of running in the project root', (t) => {
  let spawnCalls = 0;
  const fx = makeFixture(t, { spawn: () => { spawnCalls += 1; throw new Error('must not spawn'); } });
  fx.runtime.queue.paused = true;
  const missing = `${fx.root}/does-not-exist`;
  const id = fx.runtime.createTasks({ type: 'shell', prompt: 'touch danger', cwd: missing }, 'missing-cwd-key').ids[0];
  const task = fx.runtime.findTask(id);
  fx.runtime.queue.paused = false;
  fx.runtime.runTask(task);
  assert.equal(task.status, 'failed');
  assert.match(task.error, /工作目录不可用/);
  assert.equal(spawnCalls, 0);
});

test('a shell timeout never sends a late SIGKILL after the child has exited', (t) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = null;
  const signals = [];
  child.kill = (signal) => { signals.push(signal); return true; };
  const fx = makeFixture(t, { spawn: () => child });
  fx.runtime.queue.paused = true;
  const id = fx.runtime.createTasks({ type: 'shell', name: 'timeout child', prompt: 'sleep forever', timeoutMin: 0.001 }, 'shell-timeout-key').ids[0];
  const task = fx.runtime.findTask(id);
  fx.runtime.queue.paused = false;
  fx.runtime.runTask(task);
  fx.timers.advance(60);
  assert.deepEqual(signals, ['SIGTERM']);
  child.emit('close', null, 'SIGTERM');
  assert.equal(task.status, 'timeout');
  fx.timers.advance(5000);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('manual Shell stop finalizes when the process disappears without a close event', async (t) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = null;
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') child.signalCode = signal;
    return true;
  };
  const fx = makeFixture(t, { spawn: () => child, shellShutdownGraceMs: 5, shellKillWaitMs: 5 });
  fx.runtime.queue.paused = true;
  const id = fx.runtime.createTasks({ type: 'shell', prompt: 'wait forever' }, 'manual-no-close').ids[0];
  const task = fx.runtime.findTask(id);
  fx.runtime.queue.paused = false;
  fx.runtime.runTask(task);

  const response = fx.runtime.queueAction({ action: 'stopCurrent', taskId: id }, 'manual-no-close-stop');
  assert.equal(response.clientMayStillBeRunning, true);
  await waitUntil(() => task.status === 'stopped', 'manual Shell stop did not finalize without close');

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(task.execution.stopRequested.kind, 'manual');
  assert.match(task.error, /手动停止/);
  assert.equal(fx.runtime.current, null);
  assert.equal(task.logs.filter((line) => line.includes('任务结束:')).length, 1);
});

test('Shell timeout finalizes as timeout when the process disappears without a close event', async (t) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = null;
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') child.signalCode = signal;
    return true;
  };
  const fx = makeFixture(t, { spawn: () => child, shellShutdownGraceMs: 5, shellKillWaitMs: 5 });
  fx.runtime.queue.paused = true;
  const id = fx.runtime.createTasks({ type: 'shell', prompt: 'wait forever', timeoutMin: 0.001 }, 'timeout-no-close').ids[0];
  const task = fx.runtime.findTask(id);
  fx.runtime.queue.paused = false;
  fx.runtime.runTask(task);

  fx.timers.advance(60);
  await waitUntil(() => task.status === 'timeout', 'Shell timeout did not finalize without close');

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(task.execution.stopRequested.kind, 'timeout');
  assert.match(task.error, /超时/);
  assert.equal(fx.runtime.current, null);
  assert.equal(task.logs.filter((line) => line.includes('任务结束:')).length, 1);
});

test('Shell termination enters attention when the process group survives TERM and KILL', async (t) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = null;
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => { signals.push(signal); return true; };
  const fx = makeFixture(t, { spawn: () => child, shellShutdownGraceMs: 5, shellKillWaitMs: 5 });
  fx.runtime.queue.paused = true;
  const id = fx.runtime.createTasks({ type: 'shell', prompt: 'unresponsive process' }, 'shell-survives-kill').ids[0];
  const task = fx.runtime.findTask(id);
  fx.runtime.queue.paused = false;
  fx.runtime.runTask(task);

  fx.runtime.queueAction({ action: 'stopCurrent', taskId: id }, 'shell-survives-kill-stop');
  await waitUntil(() => task.status === 'attention', 'unconfirmed Shell termination did not enter attention');

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(task.attention.code, 'shell-termination-uncertain');
  assert.equal(task.clientMayStillBeRunning, true);
  assert.equal(fx.runtime.queue.paused, true);
  assert.equal(fx.runtime.current, null);
});

test('runtime shutdown terminates the active Shell process group and records a stopped task', async (t) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = null;
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGTERM') {
      child.exitCode = 0;
      queueMicrotask(() => child.emit('close', 0, null));
    }
    return true;
  };
  const fx = makeFixture(t, { spawn: () => child });
  fx.runtime.queue.paused = true;
  const id = fx.runtime.createTasks({ type: 'shell', name: 'shutdown child', prompt: 'sleep forever' }, 'shutdown-shell-key').ids[0];
  const task = fx.runtime.findTask(id);
  fx.runtime.queue.paused = false;
  fx.runtime.runTask(task);

  await fx.runtime.shutdown();

  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(task.status, 'stopped');
  assert.equal(fx.runtime.current, null);
  assert.equal(fx.runtime.stopped, true);
});

test('manual Shell stop stays stopped when the child handles SIGTERM and exits zero', async (t) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = null;
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGTERM') {
      child.exitCode = 0;
      queueMicrotask(() => child.emit('close', 0, null));
    }
    return true;
  };
  const fx = makeFixture(t, { spawn: () => child });
  fx.runtime.queue.paused = true;
  const id = fx.runtime.createTasks({ type: 'shell', name: 'manual stop child', prompt: 'wait' }, 'manual-shell-key').ids[0];
  const task = fx.runtime.findTask(id);
  fx.runtime.queue.paused = false;
  fx.runtime.runTask(task);
  const result = fx.runtime.queueAction({ action: 'stopCurrent', taskId: id }, 'manual-shell-stop-key');
  assert.equal(result.stopped, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(task.status, 'stopped');
  assert.equal(task.execution.stopRequested.kind, 'manual');
  assert.match(task.error, /手动停止/);
  assert.equal(task.logs.filter((line) => line.includes('任务结束:')).length, 1);
});

test('real Shell commands receive EOF on stdin instead of blocking the queue', async (t) => {
  const fx = makeFixture(t, { shellShutdownGraceMs: 500, shellKillWaitMs: 500 });
  fx.runtime.queue.paused = true;
  const id = fx.runtime.createTasks({ type: 'shell', name: 'stdin eof', prompt: 'cat', timeoutMin: 0 }, 'shell-stdin-eof').ids[0];
  const task = fx.runtime.findTask(id);
  fx.runtime.queue.paused = false;
  fx.runtime.runTask(task);

  await waitUntil(() => task.status === 'done', 'cat did not receive EOF and finish');
  assert.equal(task.exitCode, 0);
  assert.equal(fx.runtime.current, null);
  await fx.runtime.shutdown();
  fx.client.close();
});

test('a successful Shell command cannot leave a redirected background descendant alive', async (t) => {
  const fx = makeFixture(t, { shellShutdownGraceMs: 1000, shellKillWaitMs: 1000 });
  const pidFile = `${fx.root}/background.pid`;
  let descendantPid = null;
  t.after(() => {
    if (descendantPid) try { process.kill(descendantPid, 'SIGKILL'); } catch {}
  });
  fx.runtime.queue.paused = true;
  const id = fx.runtime.createTasks({
    type: 'shell',
    name: 'background cleanup',
    prompt: `sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'`,
    timeoutMin: 0,
  }, 'shell-background-cleanup').ids[0];
  const task = fx.runtime.findTask(id);
  fx.runtime.queue.paused = false;
  fx.runtime.runTask(task);

  await waitUntil(() => fs.existsSync(pidFile), 'background descendant PID was not recorded');
  descendantPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(descendantPid > 0);
  await waitUntil(() => task.status === 'done', 'Shell task did not finish after descendant cleanup');
  await waitUntil(() => {
    try { process.kill(descendantPid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  }, 'background descendant survived a successful Shell task');
  assert.equal(fx.runtime.current, null);
  await fx.runtime.shutdown();
  fx.client.close();
});
