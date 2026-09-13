'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');
const { AutomationConflictError, ClientDatabase } = require('../lib/client-db');
const { deterministicAutomationId } = require('../lib/core');
const { makeFixture } = require('./helpers/fixture');

function holdConcurrentIndexInsert(workerData) {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.indexDbPath);
    db.exec('PRAGMA busy_timeout = 5000');
    try {
      db.exec('BEGIN IMMEDIATE');
      if (workerData.kind === 'automation') {
        db.prepare(\`INSERT INTO automations (
          automation_id, title, cron_expr, prompt, model, workspace_key, workspace_path,
          target_task_id, recurring, max_runs, next_run_at, created_at, updated_at
        ) VALUES (?, ?, '0 0 1 1 *', ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)\`).run(
          workerData.automationId, workerData.title, workerData.prompt, workerData.modelRef,
          workerData.root, workerData.root, workerData.targetTaskId,
          workerData.now + 8000, workerData.now, workerData.now,
        );
      } else {
        db.prepare(\`INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, dispatch_status, outcome, session_id, created_at, updated_at
        ) VALUES (?, ?, ?, 'claimed', 'running', NULL, ?, ?)\`).run(
          \`orphan-\${workerData.automationId}\`, workerData.automationId,
          workerData.root, workerData.now, workerData.now,
        );
      }
      parentPort.postMessage({ phase: 'inserted' });
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
  `, { eval: true, workerData });
  let resolveReady;
  let rejectReady;
  let resolveDone;
  let rejectDone;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // Attach a rejection handler immediately; callers still await the original
  // promise, but worker startup failures cannot become transiently unhandled.
  done.catch(() => {});
  const fail = (error) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    rejectReady(normalized);
    rejectDone(normalized);
  };
  worker.on('message', (message) => {
    if (message.phase === 'inserted') resolveReady();
    else if (message.phase === 'committed') resolveDone();
    else if (message.phase === 'error') fail(message.error);
  });
  worker.once('error', fail);
  worker.once('exit', (code) => {
    if (code === 0) resolveDone();
    else fail(new Error(`concurrent SQLite writer exited with code ${code}`));
  });
  return { worker, ready, done };
}

test('deterministic automation insertion adopts exact replays and rejects conflicts', (t) => {
  const fx = makeFixture(t);
  const id = deterministicAutomationId('task-a', 1);
  const fields = { automationId: id, title: 'A', prompt: 'continue', workspace: fx.root, targetTaskId: 'sess-1', modelRef: 'plan/model' };
  assert.equal(fx.client.insertOrAdoptAutomation(fields).adopted, false);
  assert.equal(fx.client.insertOrAdoptAutomation(fields).adopted, true);
  assert.throws(() => fx.client.insertOrAdoptAutomation({ ...fields, prompt: 'different' }), AutomationConflictError);
  const db = new DatabaseSync(fx.indexDbPath, { readOnly: true });
  assert.equal(db.prepare(`SELECT count(*) AS count FROM automations`).get().count, 1);
  db.close();
});

test('an explicit client index path derives its sibling config path when config is omitted', (t) => {
  const fx = makeFixture(t);
  const indexDbPath = path.join(fx.root, 'custom-zcode', 'v2', 'tasks-index.sqlite');
  const client = new ClientDatabase({
    root: fx.root,
    homeDir: fx.root,
    indexDbPath,
    sessionDbPath: fx.sessionDbPath,
  });
  t.after(() => client.close());

  assert.equal(client.paths.indexDb, indexDbPath);
  assert.equal(client.paths.clientConfig, path.join(path.dirname(indexDbPath), 'config.json'));
  client.refreshDetectedPaths();
  assert.equal(client.paths.clientConfig, path.join(path.dirname(indexDbPath), 'config.json'));
});

test('insert-or-adopt rechecks same, conflicting, and orphaned IDs after acquiring the write lock', async (t) => {
  const fx = makeFixture(t);
  const setup = new DatabaseSync(fx.indexDbPath);
  setup.exec('PRAGMA journal_mode = WAL');
  setup.close();
  const fields = {
    title: 'Concurrent intent',
    prompt: 'continue safely',
    workspace: fx.root,
    targetTaskId: 'sess-1',
    modelRef: 'plan/model',
  };
  const runCase = async ({ taskId, kind = 'automation', insertedPrompt = fields.prompt, assertion }) => {
    const automationId = deterministicAutomationId(taskId, 1);
    const held = holdConcurrentIndexInsert({
      indexDbPath: fx.indexDbPath,
      automationId,
      root: fx.root,
      now: fx.clock.value,
      holdMs: 300,
      kind,
      title: fields.title,
      prompt: insertedPrompt,
      modelRef: fields.modelRef,
      targetTaskId: fields.targetTaskId,
    });
    t.after(() => held.worker.terminate());
    await held.ready;
    assertion(automationId);
    await held.done;
  };

  await runCase({
    taskId: 'concurrent-same',
    assertion: (automationId) => {
      const result = fx.client.insertOrAdoptAutomation({ ...fields, automationId });
      assert.equal(result.adopted, true);
    },
  });
  await runCase({
    taskId: 'concurrent-different',
    insertedPrompt: 'different concurrent intent',
    assertion: (automationId) => {
      assert.throws(
        () => fx.client.insertOrAdoptAutomation({ ...fields, automationId }),
        (error) => error instanceof AutomationConflictError && error.code === 'AUTOMATION_CONFLICT',
      );
    },
  });
  await runCase({
    taskId: 'concurrent-orphan',
    kind: 'orphan',
    assertion: (automationId) => {
      assert.throws(
        () => fx.client.insertOrAdoptAutomation({ ...fields, automationId }),
        (error) => error instanceof AutomationConflictError
          && error.code === 'AUTOMATION_CONFLICT'
          && error.evidence.orphan.run_id === `orphan-${automationId}`,
      );
    },
  });
});

test('automation task mapping returns latest row and counts from one SQLite snapshot', async (t) => {
  const fx = makeFixture(t);
  const first = fx.session('mapping-first');
  const second = fx.session('mapping-second');
  const automationId = deterministicAutomationId('mapping-snapshot', 1);
  fx.client.closeIndex();
  const setup = new DatabaseSync(fx.indexDbPath);
  setup.exec('PRAGMA journal_mode = WAL');
  setup.prepare(`UPDATE tasks
    SET cron_automation_id = ?, task_status = 'completed', updated_at = ?
    WHERE task_id = ?`).run(automationId, fx.clock.value + 10, first.sessionId);
  setup.close();

  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const control = new Int32Array(controlBuffer);
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const control = new Int32Array(workerData.controlBuffer);
    const db = new DatabaseSync(workerData.indexDbPath);
    db.exec('PRAGMA busy_timeout = 5000');
    parentPort.postMessage({ phase: 'ready' });
    Atomics.wait(control, 0, 0);
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare(\`UPDATE tasks
        SET task_status = 'running', updated_at = ? WHERE task_id = ?\`)
        .run(workerData.now + 20, workerData.firstId);
      db.prepare(\`UPDATE tasks
        SET cron_automation_id = ?, task_status = 'running', updated_at = ? WHERE task_id = ?\`)
        .run(workerData.automationId, workerData.now + 30, workerData.secondId);
      db.exec('COMMIT');
      Atomics.store(control, 1, 1);
      Atomics.notify(control, 1);
      db.close();
      parentPort.postMessage({ phase: 'committed' });
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      try { db.close(); } catch {}
      Atomics.store(control, 1, -1);
      Atomics.notify(control, 1);
      parentPort.postMessage({ phase: 'error', error: error.message });
    }
  `, {
    eval: true,
    workerData: {
      indexDbPath: fx.indexDbPath,
      automationId,
      firstId: first.sessionId,
      secondId: second.sessionId,
      now: fx.clock.value,
      controlBuffer,
    },
  });
  t.after(() => worker.terminate());
  const ready = new Promise((resolve, reject) => {
    worker.on('message', (message) => {
      if (message.phase === 'ready') resolve();
      else if (message.phase === 'error') reject(new Error(message.error));
    });
    worker.once('error', reject);
  });
  const done = new Promise((resolve, reject) => {
    worker.on('message', (message) => {
      if (message.phase === 'committed') resolve();
      else if (message.phase === 'error') reject(new Error(message.error));
    });
    worker.once('error', reject);
  });
  done.catch(() => {});
  await ready;

  const db = new DatabaseSync(fx.indexDbPath);
  let getCalls = 0;
  const synchronizedDb = {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        get(...args) {
          const row = statement.get(...args);
          getCalls += 1;
          if (getCalls === 1) {
            Atomics.store(control, 0, 1);
            Atomics.notify(control, 0);
            const result = Atomics.wait(control, 1, 0, 5000);
            if (result === 'timed-out') throw new Error('concurrent mapping writer did not commit');
            if (Atomics.load(control, 1) !== 1) throw new Error('concurrent mapping writer failed');
          }
          return row;
        },
      };
    },
  };
  const mapping = fx.client.automationTaskMappings(synchronizedDb, automationId);
  await done;
  db.close();

  assert.equal(getCalls, 1);
  assert.deepEqual(mapping, {
    mappedTask: {
      task_id: first.sessionId,
      task_status: 'completed',
      updated_at: fx.clock.value + 10,
    },
    mappingCount: 1,
    nonCompletedMappingCount: 0,
  });
  const verify = new DatabaseSync(fx.indexDbPath, { readOnly: true });
  assert.deepEqual(
    verify.prepare(`SELECT task_id, task_status FROM tasks WHERE cron_automation_id = ? ORDER BY task_id`)
      .all(automationId).map((row) => ({ task_id: row.task_id, task_status: row.task_status })),
    [
      { task_id: first.sessionId, task_status: 'running' },
      { task_id: second.sessionId, task_status: 'running' },
    ],
  );
  verify.close();
});

test('orphan automation run is visible and prevents unsafe recreation', (t) => {
  const fx = makeFixture(t);
  const id = deterministicAutomationId('task-orphan', 1);
  const db = new DatabaseSync(fx.indexDbPath);
  db.prepare(`INSERT INTO automation_runs (run_id, automation_id, workspace_key, outcome, session_id, created_at, updated_at) VALUES ('r', ?, ?, 'running', 'sess-1', ?, ?)`)
    .run(id, fx.root, fx.clock.value, fx.clock.value);
  db.close();
  const status = fx.client.queryAutomation(id);
  assert.equal(status.phase, 'tracked');
  assert.equal(status.orphan, true);
  assert.equal(status.possiblyClaimed, true);
  assert.throws(() => fx.client.insertOrAdoptAutomation({ automationId: id, title: 'A', prompt: 'x', workspace: fx.root, targetTaskId: 'sess-1', modelRef: 'plan/model' }), AutomationConflictError);
});

test('orphan mapped client task is visible and prevents unsafe automation recreation', (t) => {
  const fx = makeFixture(t);
  const session = fx.session('mapped-orphan');
  const id = deterministicAutomationId('mapped-orphan', 1);
  const fields = {
    automationId: id,
    title: 'A',
    prompt: 'continue',
    workspace: fx.root,
    targetTaskId: null,
    modelRef: 'plan/model',
  };
  fx.client.insertOrAdoptAutomation(fields);
  fx.client.closeIndex();
  const db = new DatabaseSync(fx.indexDbPath);
  db.prepare(`UPDATE tasks SET cron_automation_id = ?, task_status = 'running' WHERE task_id = ?`)
    .run(id, session.sessionId);
  db.prepare(`DELETE FROM automations WHERE automation_id = ?`).run(id);
  db.close();

  const status = fx.client.queryAutomation(id);
  assert.equal(status.phase, 'tracked');
  assert.equal(status.orphan, true);
  assert.equal(status.possiblyClaimed, true);
  assert.equal(status.sessionId, session.sessionId);
  assert.equal(status.mappingCount, 1);
  assert.equal(status.nonCompletedMappingCount, 1);
  assert.throws(() => fx.client.insertOrAdoptAutomation(fields), AutomationConflictError);
});

test('automation mapping evidence accounts for every linked nondeleted task', (t) => {
  const fx = makeFixture(t);
  const completed = fx.session('mapped-completed');
  const running = fx.session('mapped-running');
  const id = deterministicAutomationId('mapped-group', 1);
  const db = new DatabaseSync(fx.indexDbPath);
  db.prepare(`UPDATE tasks SET cron_automation_id = ?, task_status = 'completed', updated_at = ? WHERE task_id = ?`)
    .run(id, fx.clock.value + 10, completed.sessionId);
  db.prepare(`UPDATE tasks SET cron_automation_id = ?, task_status = 'running', updated_at = ? WHERE task_id = ?`)
    .run(id, fx.clock.value, running.sessionId);
  db.close();
  fx.client.closeIndex();

  const status = fx.client.queryAutomation(id);
  assert.equal(status.phase, 'tracked');
  assert.equal(status.mappingCount, 2);
  assert.equal(status.nonCompletedMappingCount, 1);
  assert.equal(status.mappedTask.task_id, completed.sessionId);
  assert.equal(status.possiblyClaimed, true);
});

test('message cursor uses sequence when timestamps collide', (t) => {
  const fx = makeFixture(t);
  fx.session();
  fx.message('sess-1', 'assistant', 'old', 1000);
  const cursor = fx.client.messageCursor('sess-1');
  fx.message('sess-1', 'assistant', 'new', 1000);
  const rows = fx.client.assistantMessagesAfter('sess-1', cursor);
  assert.deepEqual(rows.map((row) => row.text), ['new']);
});

test('session status detects a running tool call beyond the latest 40 display parts', (t) => {
  const fx = makeFixture(t);
  const session = fx.session('deep-running-tool');
  const { messageId } = fx.message(session.sessionId, 'assistant', 'placeholder');
  fx.client.closeSession();
  const db = new DatabaseSync(fx.sessionDbPath);
  db.prepare(`UPDATE part SET data = ?, sequence = 1 WHERE message_id = ?`)
    .run(JSON.stringify({ type: 'tool', callID: 'deep-call', tool: 'long-job', state: { status: 'running' } }), messageId);
  const insert = db.prepare(`INSERT INTO part (
    id, message_id, session_id, time_created, time_updated, data, sequence
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (let sequence = 2; sequence <= 42; sequence += 1) {
    insert.run(
      `deep-padding-${sequence}`,
      messageId,
      session.sessionId,
      fx.clock.value + sequence,
      fx.clock.value + sequence,
      JSON.stringify({ type: 'text', text: `newer part ${sequence}` }),
      sequence,
    );
  }
  db.close();

  const status = fx.client.sessionStatus(session.sessionId);
  assert.equal(status.available, true);
  assert.equal(status.toolRunning, true);
});

test('session status uses the latest state of a tool call across the full session', (t) => {
  const fx = makeFixture(t);
  const session = fx.session('deep-completed-tool');
  const { messageId } = fx.message(session.sessionId, 'assistant', 'placeholder');
  fx.client.closeSession();
  const db = new DatabaseSync(fx.sessionDbPath);
  db.prepare(`UPDATE part SET data = ?, sequence = 1 WHERE message_id = ?`)
    .run(JSON.stringify({ type: 'tool', callID: 'same-call', tool: 'long-job', state: { status: 'running' } }), messageId);
  const insert = db.prepare(`INSERT INTO part (
    id, message_id, session_id, time_created, time_updated, data, sequence
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (let sequence = 2; sequence <= 42; sequence += 1) {
    insert.run(
      `completed-padding-${sequence}`,
      messageId,
      session.sessionId,
      fx.clock.value + sequence,
      fx.clock.value + sequence,
      JSON.stringify({ type: 'text', text: `newer part ${sequence}` }),
      sequence,
    );
  }
  insert.run(
    'same-call-completed',
    messageId,
    session.sessionId,
    fx.clock.value + 43,
    fx.clock.value + 43,
    JSON.stringify({ type: 'tool', callID: 'same-call', tool: 'long-job', state: { status: 'completed' } }),
    43,
  );
  db.close();

  const status = fx.client.sessionStatus(session.sessionId);
  assert.equal(status.available, true);
  assert.equal(status.toolRunning, false);
});

test('atomic unclaimed revocation refuses claimed work and never deletes its run', (t) => {
  const fx = makeFixture(t);
  const first = deterministicAutomationId('revoke-a', 1);
  const fields = { automationId: first, title: 'A', prompt: 'continue', workspace: fx.root, targetTaskId: 'sess-1', modelRef: 'plan/model' };
  fx.client.insertOrAdoptAutomation(fields);
  assert.equal(fx.client.revokeUnclaimedAutomation(first).revoked, true);

  const second = deterministicAutomationId('revoke-b', 1);
  fx.client.insertOrAdoptAutomation({ ...fields, automationId: second });
  const db = new DatabaseSync(fx.indexDbPath);
  db.prepare(`UPDATE automations SET running=1, claimed_at=?, dispatch_status='claimed' WHERE automation_id=?`).run(fx.clock.value, second);
  db.prepare(`INSERT INTO automation_runs (run_id, automation_id, workspace_key, dispatch_status, outcome, session_id, created_at, updated_at) VALUES ('claimed-run', ?, ?, 'claimed', 'running', NULL, ?, ?)`).run(second, fx.root, fx.clock.value, fx.clock.value);
  db.close();
  const result = fx.client.revokeUnclaimedAutomation(second);
  assert.equal(result.revoked, false);
  assert.equal(result.phase, 'claimed');
  const verify = new DatabaseSync(fx.indexDbPath, { readOnly: true });
  assert.equal(verify.prepare(`SELECT count(*) AS count FROM automations WHERE automation_id=?`).get(second).count, 1);
  assert.equal(verify.prepare(`SELECT count(*) AS count FROM automation_runs WHERE automation_id=?`).get(second).count, 1);
  verify.close();
});

test('atomic unclaimed revocation refuses a linked client task without a run row', (t) => {
  const fx = makeFixture(t);
  const session = fx.session('mapped-revoke');
  const id = deterministicAutomationId('mapped-revoke', 1);
  fx.client.insertOrAdoptAutomation({
    automationId: id,
    title: 'A',
    prompt: 'continue',
    workspace: fx.root,
    targetTaskId: null,
    modelRef: 'plan/model',
  });
  fx.client.closeIndex();
  const db = new DatabaseSync(fx.indexDbPath);
  db.prepare(`UPDATE tasks SET cron_automation_id = ?, task_status = 'running' WHERE task_id = ?`)
    .run(id, session.sessionId);
  db.close();

  const result = fx.client.revokeUnclaimedAutomation(id);
  assert.equal(result.revoked, false);
  assert.equal(result.phase, 'claimed');
  assert.equal(result.mappedTask.task_id, session.sessionId);
  const verify = new DatabaseSync(fx.indexDbPath, { readOnly: true });
  assert.equal(verify.prepare(`SELECT count(*) AS count FROM automations WHERE automation_id = ?`).get(id).count, 1);
  assert.equal(verify.prepare(`SELECT task_status FROM tasks WHERE task_id = ?`).get(session.sessionId).task_status, 'running');
  verify.close();
});

test('terminal runs without run.session_id resolve through the linked task row', (t) => {
  const fx = makeFixture(t);
  const session = fx.session('mapped-session');
  const id = deterministicAutomationId('mapped', 1);
  fx.client.insertOrAdoptAutomation({ automationId: id, title: 'A', prompt: 'continue', workspace: fx.root, targetTaskId: null, modelRef: 'plan/model' });
  const db = new DatabaseSync(fx.indexDbPath);
  db.prepare(`UPDATE tasks SET cron_automation_id=?, task_status='completed' WHERE task_id=?`).run(id, session.sessionId);
  db.prepare(`INSERT INTO automation_runs (run_id, automation_id, workspace_key, dispatch_status, outcome, session_id, created_at, updated_at) VALUES ('mapped-run', ?, ?, 'claimed', 'succeeded', NULL, ?, ?)`).run(id, fx.root, fx.clock.value, fx.clock.value);
  db.close();
  fx.client.closeIndex();
  const status = fx.client.queryAutomation(id);
  assert.equal(status.run.outcome, 'succeeded');
  assert.equal(status.run.session_id, null);
  assert.equal(status.sessionId, session.sessionId);
  assert.equal(status.mappedTask.task_status, 'completed');
});

test('a linked client task is conservative claimed evidence even when automation flags look idle', (t) => {
  const fx = makeFixture(t);
  const session = fx.session('mapped-with-error');
  const id = deterministicAutomationId('mapped-with-error', 1);
  fx.client.insertOrAdoptAutomation({
    automationId: id,
    title: 'A',
    prompt: 'continue',
    workspace: fx.root,
    targetTaskId: null,
    modelRef: 'plan/model',
  });
  fx.client.closeIndex();
  const db = new DatabaseSync(fx.indexDbPath);
  db.prepare(`UPDATE automations
    SET last_error = 'dispatch failed', running = 0, claimed_at = NULL, dispatch_status = 'idle'
    WHERE automation_id = ?`).run(id);
  db.prepare(`UPDATE tasks SET cron_automation_id = ?, task_status = 'running' WHERE task_id = ?`)
    .run(id, session.sessionId);
  db.close();

  const status = fx.client.queryAutomation(id);
  assert.equal(status.dispatchFailed, true);
  assert.equal(status.possiblyClaimed, true);
  assert.equal(status.sessionId, session.sessionId);
  assert.equal(status.mappedTask.task_status, 'running');
});

test('terminal dispatch failures are distinct from retryable failures and conflicting task mappings', (t) => {
  const fx = makeFixture(t);
  const fields = {
    title: 'A',
    prompt: 'continue',
    workspace: fx.root,
    targetTaskId: null,
    modelRef: 'plan/model',
  };
  const retryId = deterministicAutomationId('dispatch-retry', 1);
  const failedId = deterministicAutomationId('dispatch-terminal', 1);
  const skippedId = deterministicAutomationId('dispatch-skipped', 1);
  fx.client.insertOrAdoptAutomation({ ...fields, automationId: retryId });
  fx.client.insertOrAdoptAutomation({ ...fields, automationId: failedId });
  fx.client.insertOrAdoptAutomation({ ...fields, automationId: skippedId });
  fx.client.closeIndex();

  const db = new DatabaseSync(fx.indexDbPath);
  db.prepare(`UPDATE automations
    SET lifecycle_status = 'active', enabled = 1, running = 0, claimed_at = NULL,
        dispatch_status = 'idle', retry_at = ?, last_error = 'temporary dispatch error'
    WHERE automation_id = ?`).run(fx.clock.value + 1000, retryId);
  db.prepare(`UPDATE automations
    SET lifecycle_status = 'failed', enabled = 0, running = 0, claimed_at = NULL,
        dispatch_status = 'idle', retry_at = NULL, last_error = 'permanent dispatch error'
    WHERE automation_id = ?`).run(failedId);
  db.prepare(`UPDATE automations
    SET lifecycle_status = 'completed', enabled = 0, running = 0, claimed_at = NULL,
        dispatch_status = 'idle', retry_at = NULL, last_error = 'missed one-shot window'
    WHERE automation_id = ?`).run(skippedId);
  const insertRun = db.prepare(`INSERT INTO automation_runs (
    run_id, automation_id, workspace_key, dispatch_status, outcome, session_id, error, created_at, updated_at
  ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)`);
  insertRun.run('retry-run', retryId, fx.root, 'failed_to_dispatch', 'temporary dispatch error', fx.clock.value, fx.clock.value);
  insertRun.run('failed-run', failedId, fx.root, 'failed_to_dispatch', 'permanent dispatch error', fx.clock.value, fx.clock.value);
  insertRun.run('skipped-run', skippedId, fx.root, 'skipped', 'missed one-shot window', fx.clock.value, fx.clock.value);
  db.close();

  assert.equal(fx.client.queryAutomation(retryId).terminalDispatchFailure, false);
  assert.equal(fx.client.queryAutomation(failedId).terminalDispatchFailure, true);
  assert.equal(fx.client.queryAutomation(skippedId).terminalDispatchFailure, true);

  const mapped = fx.session('terminal-conflict');
  fx.client.closeIndex();
  const conflicting = new DatabaseSync(fx.indexDbPath);
  conflicting.prepare(`UPDATE tasks SET cron_automation_id = ?, task_status = 'running' WHERE task_id = ?`)
    .run(failedId, mapped.sessionId);
  conflicting.close();
  const conflictedStatus = fx.client.queryAutomation(failedId);
  assert.equal(conflictedStatus.terminalDispatchFailure, false);
  assert.equal(conflictedStatus.possiblyClaimed, true);
  assert.equal(conflictedStatus.nonCompletedMappingCount, 1);
});

test('client SQLite connections wait briefly for concurrent writers', (t) => {
  const fx = makeFixture(t);
  assert.equal(fx.client.openIndex().prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.equal(fx.client.openSession().prepare('PRAGMA busy_timeout').get().timeout, 5000);
});

test('cleanup reports a busy database instead of throwing past runtime recovery', (t) => {
  const fx = makeFixture(t);
  const id = deterministicAutomationId('cleanup-busy', 1);
  fx.client.insertOrAdoptAutomation({
    automationId: id,
    title: 'A',
    prompt: 'continue',
    workspace: fx.root,
    targetTaskId: 'sess-1',
    modelRef: 'plan/model',
  });
  fx.client.openIndex().exec('PRAGMA busy_timeout = 20');
  const blocker = new DatabaseSync(fx.indexDbPath);
  blocker.exec('BEGIN IMMEDIATE');
  t.after(() => {
    try { blocker.exec('ROLLBACK'); } catch {}
    blocker.close();
  });

  assert.equal(fx.client.cleanupAutomation(id), false);
});
