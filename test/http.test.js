'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createService, defaultProcessController, parseProcessTable, readProcessTable, stopClient } = require('../server');
const { createIndexDb, createSessionDb } = require('./helpers/fixture');
const TEST_TOKEN = 'test_token_'.padEnd(64, 'x');

async function serviceFixture(t, serviceOptions = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztq-http-'));
  const dataDir = path.join(tempRoot, 'data');
  const indexDbPath = path.join(tempRoot, 'zcode', 'v2', 'tasks-index.sqlite');
  const sessionDbPath = path.join(tempRoot, 'zcode', 'cli', 'db', 'db.sqlite');
  createIndexDb(indexDbPath);
  createSessionDb(sessionDbPath);
  const env = {
    ...process.env,
    HOME: tempRoot,
    ZTQ_TEST_MODE: '1',
    ZTQ_CLIENT_REFRESH_MS: '60000',
    ZTQ_GUARD_INTERVAL_MS: '60000',
  };
  const service = createService({
    root: path.resolve(__dirname, '..'),
    dataDir,
    indexDbPath,
    sessionDbPath,
    clientConfigPath: path.join(tempRoot, 'missing-config.json'),
    pidFile: path.join(tempRoot, 'run', 'pid.json'),
    readyFile: path.join(tempRoot, 'run', 'ready.json'),
    logFile: path.join(tempRoot, 'log', 'server.log'),
    homeDir: tempRoot,
    host: '127.0.0.1',
    port: 0,
    testMode: true,
    apiToken: TEST_TOKEN,
    env,
    logger: () => {},
    ...serviceOptions,
  });
  await service.start();
  t.after(async () => {
    await service.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return { service, base: `http://127.0.0.1:${service.port}`, tempRoot };
}

async function jsonRequest(base, route, { method = 'GET', body, headers = {} } = {}) {
  const authorizedHeaders = { Authorization: `Bearer ${TEST_TOKEN}`, ...headers };
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? authorizedHeaders : { 'Content-Type': 'application/json', ...authorizedHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  return { response, value };
}

function chunkedJsonRequest(port, chunks, key) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/tasks',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
        'X-ZTQ-Local': '1',
        'Idempotency-Key': key,
      },
    }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, value: JSON.parse(body) }));
    });
    request.on('error', reject);
    const writeNext = (index) => {
      if (index >= chunks.length) { request.end(); return; }
      request.write(chunks[index]);
      setTimeout(() => writeNext(index + 1), 20);
    };
    writeNext(0);
  });
}

function fakeProcessController(entries) {
  const live = new Map(entries.map((entry) => [entry.pid, {
    uid: typeof process.getuid === 'function' ? process.getuid() : 501,
    startedAt: `start-${entry.pid}`,
    executable: '',
    ...entry,
  }]));
  const signals = [];
  return {
    live,
    signals,
    list: () => [...live.values()].map(({ executable, startedAt, ...entry }) => entry),
    executableMap: () => new Map([...live.values()].map((entry) => [entry.pid, entry.executable])),
    executable: (pid) => live.get(pid) && live.get(pid).executable || '',
    identity: (pid) => {
      const entry = live.get(pid);
      return entry ? { ppid: entry.ppid, uid: entry.uid, startedAt: entry.startedAt } : null;
    },
    signal: (pid, signal) => {
      signals.push({ pid, signal });
      live.delete(pid);
    },
    wait: async () => {},
  };
}

test('process table parser preserves parent and executable-name fields without matching by arguments', () => {
  const output = [
    ' 101 1 501 ZCode',
    ' 102 101 501 zcode-host-local-1',
    ' 103 1 502 /opt/local/bin/zcode-cli',
    ' 104 1 501 ZCode Helper (Renderer)',
  ].join('\n');
  assert.deepEqual(parseProcessTable(output), [
    { pid: 101, ppid: 1, uid: 501, command: 'ZCode' },
    { pid: 102, ppid: 101, uid: 501, command: 'zcode-host-local-1' },
    { pid: 103, ppid: 1, uid: 502, command: '/opt/local/bin/zcode-cli' },
    { pid: 104, ppid: 1, uid: 501, command: 'ZCode Helper (Renderer)' },
  ]);
});

test('strict process inventory rejects failed, empty, partial, and self-missing ps snapshots', async () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const self = ` ${process.pid} 1 ${uid} node`;
  assert.deepEqual(readProcessTable(() => `${self}\n 591 1 -2 /usr/sbin/distnoted\n`, process.pid), [
    { pid: process.pid, ppid: 1, uid, command: 'node' },
    { pid: 591, ppid: 1, uid: -2, command: '/usr/sbin/distnoted' },
  ]);

  const badReaders = [
    () => { throw new Error('ps failed'); },
    () => '',
    () => 'not a process row\n',
    () => `${self}\nnot a process row\n`,
    () => ` 999999 1 ${uid} node\n`,
  ];
  for (const read of badReaders) {
    const result = await stopClient({ processController: defaultProcessController(read, process.pid) });
    assert.equal(result.stopped, false);
    assert.equal(result.count, 0);
    assert.equal(result.code, 'ZCODE_PROCESS_INVENTORY_UNAVAILABLE');
  }

  const completeEmptyOfZcode = await stopClient({
    processController: defaultProcessController(() => `${self}\n`, process.pid),
  });
  assert.deepEqual(completeEmptyOfZcode, { stopped: true, count: 0, ownershipVerified: true });
});

test('a transient per-process ps failure after TERM cannot be mistaken for verified exit', async () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const rootPid = 9876;
  const rootExecutable = '/Applications/ZCode.app/Contents/MacOS/ZCode';
  const self = ` ${process.pid} 1 ${uid} node`;
  let listReads = 0;
  let identityReads = 0;
  const signals = [];
  const execFile = (file, args) => {
    if (file === '/bin/ps' && args[0] === '-axo') {
      listReads += 1;
      return listReads === 1
        ? `${self}\n ${rootPid} 1 ${uid} ZCode\n`
        : `${self}\n`;
    }
    if (file === '/bin/ps' && args[0] === '-o') {
      identityReads += 1;
      if (identityReads <= 2) return `1 ${uid} Sat Sep 13 09:00:00 2026`;
      throw new Error('transient identity ps failure');
    }
    if (file === '/usr/sbin/lsof' && args.includes('-Fpn')) {
      return `p${rootPid}\nn${rootExecutable}\n`;
    }
    if (file === '/usr/sbin/lsof' && args.includes('-Fn')) {
      return `p${rootPid}\nn${rootExecutable}\n`;
    }
    throw new Error(`unexpected probe ${file}`);
  };
  const processController = defaultProcessController(execFile, process.pid, {
    signal: (pid, signal) => signals.push({ pid, signal }),
    wait: async () => {},
  });

  const result = await stopClient({ processController });
  assert.deepEqual(signals, [{ pid: rootPid, signal: 'SIGTERM' }]);
  assert.equal(result.stopped, false);
  assert.equal(result.ownershipVerified, false);
  assert.equal(result.requiresAttention, true);
  assert.ok(result.orphaned >= 1);
});

test('client stop rechecks the recorded parent before sending a signal', async () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const executable = '/Applications/ZCode.app/Contents/MacOS/ZCode';
  let identityReads = 0;
  const signals = [];
  const controller = {
    list: () => [{ pid: 208, ppid: 1, uid, command: 'ZCode' }],
    executableMap: () => new Map([[208, executable]]),
    executable: () => executable,
    identity: () => ({ ppid: ++identityReads === 1 ? 1 : 999, uid, startedAt: 'same-second' }),
    signal: (pid, signal) => signals.push({ pid, signal }),
    wait: async () => {},
  };

  const result = await stopClient({ processController: controller });
  assert.deepEqual(signals, []);
  assert.equal(result.stopped, false);
  assert.equal(result.ownershipVerified, false);
});

test('client stop signals only a verified ZCode.app root and its recorded descendants', async () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const controller = fakeProcessController([
    { pid: 101, ppid: 1, uid, command: 'ZCode', executable: '/Applications/ZCode.app/Contents/MacOS/ZCode' },
    { pid: 102, ppid: 101, uid, command: 'ZCode Helper', executable: '/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper' },
    { pid: 103, ppid: 102, uid, command: 'zcode-cli', executable: '/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper' },
    { pid: 201, ppid: 1, uid, command: 'zcode-cli', executable: '/opt/local/bin/zcode-cli' },
  ]);

  const first = await stopClient({ processController: controller });
  assert.equal(first.stopped, true);
  assert.equal(first.count, 3);
  assert.deepEqual(controller.signals, [
    { pid: 101, signal: 'SIGTERM' },
    { pid: 102, signal: 'SIGTERM' },
    { pid: 103, signal: 'SIGTERM' },
  ]);
  assert.equal(controller.live.has(201), true, 'independent CLI must remain alive');

  controller.signals.length = 0;
  const repeated = await stopClient({ processController: controller });
  assert.deepEqual(repeated, { stopped: true, count: 0, ownershipVerified: true });
  assert.deepEqual(controller.signals, []);
});

test('client stop rechecks every executable before signalling same-second PID identities', async () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const rootExecutable = '/Applications/ZCode.app/Contents/MacOS/ZCode';
  const childExecutable = '/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper';
  const entries = [
    { pid: 211, ppid: 1, uid, command: 'ZCode' },
    { pid: 212, ppid: 211, uid, command: 'ZCode Helper' },
  ];
  const signals = [];
  const controller = {
    list: () => entries,
    executableMap: () => new Map([[211, rootExecutable], [212, childExecutable]]),
    // PID 211 was reused by another executable within the same `lstart`
    // second; PID 212 can no longer be inspected. Neither is safe to signal.
    executable: (pid) => pid === 211 ? '/usr/bin/safe-unrelated-process' : '',
    identity: (pid) => {
      const entry = entries.find((item) => item.pid === pid);
      return entry ? { ppid: entry.ppid, uid, startedAt: 'same-second' } : null;
    },
    signal: (pid, signal) => { signals.push({ pid, signal }); },
    wait: async () => {},
  };

  const result = await stopClient({ processController: controller });
  assert.deepEqual(signals, []);
  assert.equal(result.stopped, false);
  assert.equal(result.ownershipVerified, false);
  assert.equal(result.requiresAttention, true);
  assert.ok(result.orphaned >= 1);
});

test('a target skipped at the TERM gate can never become a later SIGKILL target', async () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const executable = '/Applications/ZCode.app/Contents/MacOS/ZCode';
  let executableReads = 0;
  const signals = [];
  const controller = {
    list: () => [{ pid: 216, ppid: 1, uid, command: 'ZCode' }],
    executableMap: () => new Map([[216, executable]]),
    executable: () => ++executableReads === 1 ? '' : executable,
    identity: () => ({ ppid: 1, uid, startedAt: 'stable-start' }),
    signal: (pid, signal) => { signals.push({ pid, signal }); },
    wait: async () => {},
  };

  const result = await stopClient({ processController: controller });
  assert.deepEqual(signals, []);
  assert.equal(result.stopped, false);
  assert.equal(result.ownershipVerified, false);
  assert.equal(result.requiresAttention, true);
});

test('a descendant missing its discovery-time executable is not signalled and forces attention', async () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const controller = fakeProcessController([
    { pid: 221, ppid: 1, uid, command: 'ZCode', executable: '/Applications/ZCode.app/Contents/MacOS/ZCode' },
    { pid: 222, ppid: 221, uid, command: 'ZCode Helper', executable: '' },
  ]);

  const result = await stopClient({ processController: controller });
  assert.equal(controller.signals.some((item) => item.pid === 222), false);
  assert.equal(controller.live.has(222), true);
  assert.equal(result.stopped, false);
  assert.equal(result.ownershipVerified, false);
  assert.equal(result.requiresAttention, true);
});

test('a stale parent snapshot cannot adopt a PID replacement during discovery', async () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const rootExecutable = '/Applications/ZCode.app/Contents/MacOS/ZCode';
  const replacementExecutable = '/usr/bin/safe-unrelated-process';
  const live = new Map([
    [231, { pid: 231, ppid: 1, uid, command: 'ZCode', startedAt: 'root-start', executable: rootExecutable }],
    [232, { pid: 232, ppid: 999, uid, command: 'safe', startedAt: 'replacement-start', executable: replacementExecutable }],
  ]);
  const signals = [];
  const controller = {
    // PID 232 was a child in the ps snapshot, but was replaced before identity
    // and executable probes. Its current parent no longer matches that row.
    list: () => [
      { pid: 231, ppid: 1, uid, command: 'ZCode' },
      { pid: 232, ppid: 231, uid, command: 'ZCode Helper' },
    ],
    executableMap: () => new Map([...live.values()].map((entry) => [entry.pid, entry.executable])),
    executable: (pid) => live.get(pid) && live.get(pid).executable || '',
    identity: (pid) => {
      const entry = live.get(pid);
      return entry ? { ppid: entry.ppid, uid: entry.uid, startedAt: entry.startedAt } : null;
    },
    signal: (pid, signal) => { signals.push({ pid, signal }); live.delete(pid); },
    wait: async () => {},
  };

  const result = await stopClient({ processController: controller });
  assert.equal(signals.some((item) => item.pid === 232), false);
  assert.equal(live.has(232), true);
  assert.equal(result.stopped, false);
  assert.equal(result.ownershipVerified, false);
  assert.equal(result.requiresAttention, true);
});

test('an orphaned ZCode.app helper enters attention without receiving a signal', async () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const controller = fakeProcessController([
    {
      pid: 301,
      ppid: 1,
      uid,
      command: '/Applications/ZC',
      executable: '/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper',
    },
    {
      pid: 302,
      ppid: 1,
      uid,
      command: '/Applications/ZC',
      executable: '/Applications/ZCode.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler',
    },
  ]);
  const result = await stopClient({ processController: controller });
  assert.equal(result.stopped, false);
  assert.equal(result.requiresAttention, true);
  assert.equal(result.orphaned, 1, 'crashpad must be ignored as a non-executing residue');
  assert.equal(result.code, 'ZCODE_PROCESS_OWNERSHIP_UNPROVEN');
  assert.equal(controller.live.has(301), true);
  assert.deepEqual(controller.signals, []);
});

test('standalone CLI, crashpad, and Computer Use processes are neither signalled nor blocking', async () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const controller = fakeProcessController([
    { pid: 401, ppid: 1, uid, command: 'zcode-cli', executable: '/opt/local/bin/zcode-cli' },
    {
      pid: 402,
      ppid: 1,
      uid,
      command: '/Applications/ZC',
      executable: '/Applications/ZCode.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler',
    },
    {
      pid: 403,
      ppid: 1,
      uid,
      command: 'ZCode Computer Use',
      executable: '/Users/test/.zcode/computer-use/ZCode Computer Use.app/Contents/MacOS/ZCode Computer Use',
    },
  ]);
  const result = await stopClient({ processController: controller });
  assert.deepEqual(result, { stopped: true, count: 0, ownershipVerified: true });
  assert.equal(controller.live.size, 3);
  assert.deepEqual(controller.signals, []);
});

test('an unavailable process inventory fails safe without attempting a signal', async () => {
  let signals = 0;
  const result = await stopClient({
    processController: {
      list() { throw new Error('ps unavailable'); },
      signal() { signals += 1; },
    },
  });
  assert.equal(result.stopped, false);
  assert.equal(result.requiresAttention, true);
  assert.equal(result.code, 'ZCODE_PROCESS_INVENTORY_UNAVAILABLE');
  assert.equal(signals, 0);
});

test('HTTP surface is loopback-only, revisioned, protected, and idempotent', async (t) => {
  const { service, base } = await serviceFixture(t);
  const health = await jsonRequest(base, '/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.value.ok, true);
  assert.equal(health.value.port, service.port);
  assert.equal(health.value.root, path.resolve(__dirname, '..'));
  assert.match(health.value.processStartedAt, /\S/);
  assert.equal(health.value.authRequired, true);
  assert.equal(Object.hasOwn(health.value, 'apiToken'), false);

  const unauthorized = await fetch(`${base}/api/state?view=summary`);
  assert.equal(unauthorized.status, 401);

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /unsafe-inline/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(await page.text(), /data-testid="app-root"/);
  const head = await fetch(`${base}/`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.ok(Number(head.headers.get('content-length')) > 0);
  assert.equal(await head.text(), '');

  const wrongMethod = await fetch(`${base}/`, { method: 'POST' });
  assert.equal(wrongMethod.status, 405);

  const badHost = await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port: service.port, path: '/api/health', headers: { Host: 'attacker.example' },
    }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    request.end();
  });
  assert.equal(badHost, 421);

  const missingHeader = await jsonRequest(base, '/api/queue', { method: 'POST', body: { action: 'pause' } });
  assert.equal(missingHeader.response.status, 403);
  const badOrigin = await jsonRequest(base, '/api/queue', {
    method: 'POST',
    body: { action: 'pause' },
    headers: { 'X-ZTQ-Local': '1', Origin: 'https://evil.example' },
  });
  assert.equal(badOrigin.response.status, 403);
  const missingTaskId = await jsonRequest(base, '/api/queue', {
    method: 'POST',
    body: { action: 'stopCurrent' },
    headers: { 'X-ZTQ-Local': '1' },
  });
  assert.equal(missingTaskId.response.status, 400);

  const invalidDryRun = await jsonRequest(base, '/api/guard', {
    method: 'POST', body: { action: 'stopClient', dryRun: 'false' }, headers: { 'X-ZTQ-Local': '1' },
  });
  assert.equal(invalidDryRun.response.status, 400);
  const dryRun = await jsonRequest(base, '/api/guard', {
    method: 'POST', body: { action: 'stopClient', dryRun: true }, headers: { 'X-ZTQ-Local': '1' },
  });
  assert.equal(dryRun.response.status, 200);
  assert.equal(dryRun.value.dryRun, true);
  const enable = await jsonRequest(base, '/api/guard', {
    method: 'POST', body: { action: 'enableClient' }, headers: { 'X-ZTQ-Local': '1' },
  });
  assert.equal(enable.response.status, 200);
  assert.equal(enable.value.ok, true);

  const before = (await jsonRequest(base, '/api/state?view=summary')).value;
  const headers = { 'X-ZTQ-Local': '1', 'Idempotency-Key': 'http-pause-key' };
  const paused = await jsonRequest(base, '/api/queue', { method: 'POST', body: { action: 'pause' }, headers });
  assert.equal(paused.response.status, 200);
  assert.equal(paused.value.paused, true);
  const replay = await jsonRequest(base, '/api/queue', { method: 'POST', body: { action: 'pause' }, headers });
  assert.equal(replay.value.replayed, true);
  const afterPause = (await jsonRequest(base, '/api/state?view=summary')).value;
  assert.ok(afterPause.revision > before.revision);

  const taskBody = { type: 'shell', name: '<img src=x onerror=alert(1)>', prompt: 'printf safe', timeoutMin: 0 };
  const taskHeaders = { 'X-ZTQ-Local': '1', 'Idempotency-Key': 'http-create-key' };
  const created = await jsonRequest(base, '/api/tasks', { method: 'POST', body: taskBody, headers: taskHeaders });
  assert.equal(created.response.status, 200);
  const createdAgain = await jsonRequest(base, '/api/tasks', { method: 'POST', body: taskBody, headers: taskHeaders });
  assert.equal(createdAgain.value.replayed, true);
  assert.deepEqual(createdAgain.value.ids, created.value.ids);
  const replayOnly = await jsonRequest(base, '/api/tasks', {
    method: 'POST',
    body: taskBody,
    headers: { ...taskHeaders, 'Idempotency-Replay-Only': '1' },
  });
  assert.equal(replayOnly.response.status, 200);
  assert.equal(replayOnly.value.replayed, true);
  const beforeUnknownReplay = (await jsonRequest(base, '/api/state?view=summary')).value.counts.pending;
  const unknownReplay = await jsonRequest(base, '/api/tasks', {
    method: 'POST',
    body: taskBody,
    headers: {
      'X-ZTQ-Local': '1',
      'Idempotency-Key': 'missing-http-replay-key',
      'Idempotency-Replay-Only': '1',
    },
  });
  assert.equal(unknownReplay.response.status, 409);
  assert.equal(unknownReplay.value.code, 'IDEMPOTENCY_REPLAY_UNKNOWN');
  assert.equal((await jsonRequest(base, '/api/state?view=summary')).value.counts.pending, beforeUnknownReplay);
  const missingReplayKey = await jsonRequest(base, '/api/tasks', {
    method: 'POST', body: taskBody, headers: { 'X-ZTQ-Local': '1', 'Idempotency-Replay-Only': '1' },
  });
  assert.equal(missingReplayKey.response.status, 400);
  assert.equal(missingReplayKey.value.code, 'IDEMPOTENCY_KEY_REQUIRED');
  const malformedReplayHeader = await jsonRequest(base, '/api/tasks', {
    method: 'POST', body: taskBody, headers: { ...taskHeaders, 'Idempotency-Replay-Only': 'true' },
  });
  assert.equal(malformedReplayHeader.response.status, 400);
  const conflict = await jsonRequest(base, '/api/tasks', {
    method: 'POST',
    body: { ...taskBody, prompt: 'different' },
    headers: taskHeaders,
  });
  assert.equal(conflict.response.status, 409);
  const oversizedTimeout = await jsonRequest(base, '/api/tasks', {
    method: 'POST',
    body: { type: 'shell', prompt: 'true', timeoutMin: 10081 },
    headers: { 'X-ZTQ-Local': '1', 'Idempotency-Key': 'http-timeout-bound' },
  });
  assert.equal(oversizedTimeout.response.status, 400);

  const invalidHiddenSession = await jsonRequest(base, '/api/client-tasks/hide', {
    method: 'POST',
    body: { sessionId: { unexpected: true } },
    headers: { 'X-ZTQ-Local': '1', 'Idempotency-Key': 'http-hide-bound' },
  });
  assert.equal(invalidHiddenSession.response.status, 400);

  const summary = (await jsonRequest(base, '/api/state?view=summary')).value;
  const summaryTask = summary.tasks.find((task) => task.id === created.value.ids[0]);
  assert.equal(summaryTask.name, taskBody.name);
  assert.equal(Object.hasOwn(summaryTask, 'prompt'), false);
  assert.equal(Object.hasOwn(summaryTask, 'logs'), false);
  const detail = (await jsonRequest(base, `/api/tasks/${created.value.ids[0]}`)).value;
  assert.equal(detail.prompt, taskBody.prompt);
  assert.ok(Array.isArray(detail.logs));

  const configHeaders = { 'X-ZTQ-Local': '1', 'Idempotency-Key': 'http-config-key' };
  const config = await jsonRequest(base, '/api/config', { method: 'POST', body: { intervalSec: 9 }, headers: configHeaders });
  assert.equal(config.value.settings.intervalSec, 9);
  const configReplay = await jsonRequest(base, '/api/config', { method: 'POST', body: { intervalSec: 9 }, headers: configHeaders });
  assert.equal(configReplay.value.replayed, true);
  const finalState = (await jsonRequest(base, '/api/state?view=summary')).value;
  assert.ok(finalState.revision >= summary.revision);
  assert.equal(finalState.instanceId, before.instanceId);
});

test('SSE sends an initial revisioned summary and closes cleanly', async (t) => {
  const { service } = await serviceFixture(t);
  const payload = await new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port: service.port,
      path: '/api/events',
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${TEST_TOKEN}` },
    }, (response) => {
      assert.equal(response.statusCode, 200);
      assert.match(response.headers['content-type'], /text\/event-stream/);
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
        if (body.includes('\n\n')) {
          request.destroy();
          resolve(body);
        }
      });
    });
    request.on('error', (error) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    request.setTimeout(3000, () => {
      request.destroy();
      reject(new Error('SSE initial event timeout'));
    });
  });
  assert.match(payload, /^event: state\ndata: /);
  const dataLine = payload.split('\n').find((line) => line.startsWith('data: '));
  const state = JSON.parse(dataLine.slice(6));
  assert.equal(typeof state.revision, 'number');
  assert.equal(typeof state.instanceId, 'string');
  assert.ok(Array.isArray(state.tasks));
});

test('manual client stop persists the queue pause before awaiting client shutdown', async (t) => {
  let signalStarted;
  let releaseStop;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const gate = new Promise((resolve) => { releaseStop = resolve; });
  const { service, base } = await serviceFixture(t, {
    stopClient: async () => {
      signalStarted();
      await gate;
      return { stopped: true, count: 1, ownershipVerified: true };
    },
  });
  const request = jsonRequest(base, '/api/guard', {
    method: 'POST', body: { action: 'stopClient' },
    headers: { 'X-ZTQ-Local': '1', 'Idempotency-Key': 'manual-stop-pause-first' },
  });
  await started;
  assert.equal(service.runtime.queue.paused, true);
  assert.equal(service.runtime.queue.pauseReason.kind, 'manual');
  releaseStop();
  const result = await request;
  assert.equal(result.response.status, 200);
  assert.equal(result.value.queuePaused, true);
});

test('non-replayable client guard actions reject replay-only requests before side effects', async (t) => {
  let stopCalls = 0;
  const { service, base } = await serviceFixture(t, {
    stopClient: async () => { stopCalls += 1; return { stopped: true, count: 1, ownershipVerified: true }; },
  });
  const result = await jsonRequest(base, '/api/guard', {
    method: 'POST',
    body: { action: 'stopClient' },
    headers: {
      'X-ZTQ-Local': '1',
      'Idempotency-Key': 'guard-replay-must-not-run',
      'Idempotency-Replay-Only': '1',
    },
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.value.code, 'NON_REPLAYABLE_OPERATION');
  assert.equal(stopCalls, 0);
  assert.equal(service.runtime.queue.paused, false);
});

test('a data directory is exclusively owned for the full service lifetime', async (t) => {
  const { service, tempRoot } = await serviceFixture(t);
  const common = {
    root: path.resolve(__dirname, '..'),
    dataDir: path.join(tempRoot, 'data'),
    indexDbPath: path.join(tempRoot, 'zcode', 'v2', 'tasks-index.sqlite'),
    sessionDbPath: path.join(tempRoot, 'zcode', 'cli', 'db', 'db.sqlite'),
    clientConfigPath: path.join(tempRoot, 'missing-config.json'),
    pidFile: path.join(tempRoot, 'run', 'second-pid.json'),
    readyFile: path.join(tempRoot, 'run', 'second-ready.json'),
    logFile: path.join(tempRoot, 'log', 'second.log'),
    homeDir: tempRoot,
    host: '127.0.0.1', port: 0, testMode: true, apiToken: TEST_TOKEN,
    env: { ...process.env, ZTQ_TEST_MODE: '1' }, logger: () => {},
  };
  assert.throws(() => createService(common), /同一数据目录/);
  assert.equal((await fetch(`http://127.0.0.1:${service.port}/api/health`)).status, 200);
});

test('oversized request bodies return 413 without crashing the service', async (t) => {
  const { base } = await serviceFixture(t);
  const response = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ZTQ-Local': '1', Authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify({ type: 'shell', prompt: 'x'.repeat(5 * 1024 * 1024 + 1) }),
  });
  assert.equal(response.status, 413);
  const value = await response.json();
  assert.equal(value.code, 'BODY_TOO_LARGE');
  assert.equal((await fetch(`${base}/api/health`)).status, 200);

  // Limit is bytes, not JavaScript character count. This payload is less than
  // five million characters but greater than five MiB in UTF-8.
  const unicode = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ZTQ-Local': '1', Authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify({ type: 'shell', prompt: '汉'.repeat(1800000) }),
  });
  assert.equal(unicode.status, 413);
});

test('HTTP JSON decoding preserves split UTF-8 and rejects malformed bytes', async (t) => {
  const { service, base } = await serviceFixture(t);
  const body = Buffer.from(JSON.stringify({ type: 'shell', name: 'utf8', prompt: '汉', timeoutMin: 0 }));
  const character = Buffer.from('汉');
  const offset = body.indexOf(character);
  assert.ok(offset > 0);
  const split = await chunkedJsonRequest(
    service.port,
    [body.subarray(0, offset + 1), body.subarray(offset + 1)],
    'split-utf8-body',
  );
  assert.equal(split.status, 200);
  const detail = await jsonRequest(base, `/api/tasks/${split.value.ids[0]}`);
  assert.equal(detail.value.prompt, '汉');

  const prefix = Buffer.from('{"type":"shell","prompt":"');
  const suffix = Buffer.from('"}');
  const malformed = await chunkedJsonRequest(
    service.port,
    [prefix, Buffer.from([0xff]), suffix],
    'malformed-utf8-body',
  );
  assert.equal(malformed.status, 400);
  assert.equal(malformed.value.code, 'INVALID_UTF8');
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test('service rejects dangerous writable-path aliases before creating queue state', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztq-path-layout-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const makeOptions = (name, overrides = {}) => {
    const root = path.join(tempRoot, name);
    const dataDir = path.join(root, 'data');
    return {
      root: path.resolve(__dirname, '..'),
      dataDir,
      indexDbPath: path.join(root, 'client', 'index.sqlite'),
      sessionDbPath: path.join(root, 'client', 'session.sqlite'),
      clientConfigPath: path.join(root, 'client', 'config.json'),
      pidFile: path.join(root, 'run', 'pid.json'),
      readyFile: path.join(root, 'run', 'ready.json'),
      logFile: path.join(root, 'log', 'server.log'),
      apiTokenFile: path.join(root, 'auth', 'token'),
      homeDir: path.join(root, 'home'),
      host: '127.0.0.1', port: 0, testMode: true, apiToken: TEST_TOKEN,
      env: { ...process.env, ZTQ_TEST_MODE: '1' }, logger: () => {},
      ...overrides,
    };
  };

  const protectedLayout = makeOptions('protected');
  const protectedFiles = [
    path.join(protectedLayout.dataDir, 'state.json'),
    path.join(protectedLayout.dataDir, 'state.json.bak'),
    path.join(protectedLayout.dataDir, '.state-v2-initialized'),
    path.join(protectedLayout.dataDir, 'tasks.json'),
    path.join(protectedLayout.dataDir, 'settings.json'),
    path.join(protectedLayout.dataDir, 'tasks.json.legacy.bak'),
    path.join(protectedLayout.dataDir, 'settings.json.legacy.bak'),
    path.join(protectedLayout.dataDir, 'server.instance.lock'),
    protectedLayout.pidFile,
    protectedLayout.logFile,
    `${protectedLayout.logFile}.1`,
    protectedLayout.apiTokenFile,
    `${protectedLayout.pidFile}.lifecycle.lock`,
    protectedLayout.indexDbPath,
    `${protectedLayout.indexDbPath}-wal`,
    `${protectedLayout.indexDbPath}-shm`,
    protectedLayout.sessionDbPath,
    `${protectedLayout.sessionDbPath}-wal`,
    `${protectedLayout.sessionDbPath}-shm`,
  ];
  for (const protectedFile of protectedFiles) {
    assert.throws(
      () => createService({ ...protectedLayout, readyFile: protectedFile }),
      /路径冲突/,
      protectedFile,
    );
  }
  assert.equal(fs.existsSync(path.join(protectedLayout.dataDir, 'state.json')), false);

  const alias = makeOptions('symlink');
  const realControl = path.join(tempRoot, 'symlink', 'real-control');
  const aliasControl = path.join(tempRoot, 'symlink', 'alias-control');
  fs.mkdirSync(realControl, { recursive: true });
  fs.symlinkSync(realControl, aliasControl, 'dir');
  alias.pidFile = path.join(realControl, 'identity.json');
  alias.readyFile = path.join(aliasControl, 'identity.json');
  assert.throws(() => createService(alias), /\u8def\u5f84\u51b2\u7a81/);

  const hardlink = makeOptions('hardlink');
  fs.mkdirSync(path.dirname(hardlink.pidFile), { recursive: true });
  fs.writeFileSync(hardlink.pidFile, 'placeholder');
  fs.linkSync(hardlink.pidFile, hardlink.readyFile);
  assert.throws(() => createService(hardlink), /\u8def\u5f84\u51b2\u7a81/);

  const nested = makeOptions('nested');
  nested.pidFile = path.join(tempRoot, 'nested', 'control');
  nested.logFile = path.join(nested.pidFile, 'server.log');
  assert.throws(() => createService(nested), /\u8def\u5f84\u51b2\u7a81/);

});

test('malformed URL encoding receives 400 and the service stays healthy', async (t) => {
  const { service, base } = await serviceFixture(t);
  const status = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: service.port, path: '/%E0%A4%A' }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(status, 400);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test('a post-listen runtime initialization failure removes runtime files and can be retried', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztq-start-failure-'));
  const indexDbPath = path.join(tempRoot, 'zcode', 'v2', 'tasks-index.sqlite');
  const sessionDbPath = path.join(tempRoot, 'zcode', 'cli', 'db', 'db.sqlite');
  const pidFile = path.join(tempRoot, 'run', 'pid.json');
  const readyFile = path.join(tempRoot, 'run', 'ready.json');
  createIndexDb(indexDbPath);
  createSessionDb(sessionDbPath);
  const service = createService({
    root: path.resolve(__dirname, '..'),
    dataDir: path.join(tempRoot, 'data'),
    indexDbPath,
    sessionDbPath,
    clientConfigPath: path.join(tempRoot, 'missing-config.json'),
    pidFile,
    readyFile,
    logFile: path.join(tempRoot, 'log', 'server.log'),
    homeDir: tempRoot,
    host: '127.0.0.1',
    port: 0,
    testMode: true,
    apiToken: TEST_TOKEN,
    env: { ...process.env, ZTQ_TEST_MODE: '1', ZTQ_CLIENT_REFRESH_MS: '60000', ZTQ_GUARD_INTERVAL_MS: '60000' },
    logger: () => {},
  });
  t.after(async () => {
    await service.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  const realStart = service.runtime.start.bind(service.runtime);
  service.runtime.start = () => { throw new Error('simulated runtime startup failure'); };
  await assert.rejects(service.start(), /simulated runtime startup failure/);
  assert.equal(service.server, null);
  assert.equal(service.port, null);
  assert.equal(fs.existsSync(pidFile), false);
  assert.equal(fs.existsSync(readyFile), false);

  service.runtime.start = realStart;
  await service.start();
  assert.ok(service.port > 0);
  assert.equal((await fetch(`http://127.0.0.1:${service.port}/api/health`)).status, 200);
});

test('invalid timer environment is rejected before a listener or runtime file is created', () => {
  assert.throws(() => createService({
    root: path.resolve(__dirname, '..'),
    env: { ...process.env, ZTQ_POLL_MS: 'not-a-number' },
    logger: () => {},
  }), /ZTQ_POLL_MS/);
});

test('failed scheduled stop remains due and retries until a verified success', async (t) => {
  const fixedNow = new Date(2026, 8, 13, 9, 0, 0, 0).getTime();
  let calls = 0;
  let succeeds = false;
  const { service } = await serviceFixture(t, {
    now: () => fixedNow,
    stopClient: async () => {
      calls += 1;
      return succeeds ? { stopped: true, count: 1, ownershipVerified: true } : { stopped: false, count: 1, error: 'still running' };
    },
  });
  service.runtime.settings.autoStopEnabled = true;
  service.runtime.settings.autoStopTime = '08:55';
  service.runtime.settings.autoEnableEnabled = false;
  service.runtime.queue.guardState.stopLastAt = 0;
  service.runtime.queue.guardState.lastAppliedAt = 0;
  service.runtime.queue.paused = true;
  service.runtime.queue.pausedBySystem = false;
  service.runtime.queue.pauseReason = { kind: 'manual', message: 'keep this pause', since: fixedNow - 5000 };
  service.runtime.commit();

  await service.guardTick();
  assert.equal(calls, 1);
  assert.equal(service.runtime.queue.guardState.stopLastAt, 0);
  assert.equal(service.runtime.queue.guardState.lastAppliedAt, 0);
  assert.match(service.runtime.queue.guardState.lastError.message, /still running/);
  assert.equal(service.runtime.queue.paused, true);
  assert.equal(service.runtime.queue.pauseReason.kind, 'manual');
  assert.equal(service.runtime.hasGuardStopOwnershipPending(), true);

  await service.guardTick();
  assert.equal(calls, 2);
  succeeds = true;
  await service.guardTick();
  assert.equal(calls, 3);
  assert.equal(service.runtime.queue.guardState.stopLastAt, new Date(2026, 8, 13, 8, 55).getTime());
  assert.equal(service.runtime.queue.guardState.lastError, null);
  assert.equal(service.runtime.hasGuardStopOwnershipPending(), false);
  assert.equal(service.runtime.queue.pauseReason.kind, 'manual');
});

test('unowned GUI remnants enter persistent guard attention until a safe recheck passes', async (t) => {
  const fixedNow = new Date(2026, 8, 13, 9, 0, 0, 0).getTime();
  let calls = 0;
  let remnantsRemain = true;
  const { service } = await serviceFixture(t, {
    now: () => fixedNow,
    stopClient: async () => {
      calls += 1;
      return remnantsRemain
        ? { stopped: false, count: 0, orphaned: 1, requiresAttention: true, error: 'ownership unproven' }
        : { dryRun: true, ownershipVerified: true };
    },
  });
  service.runtime.settings.autoStopEnabled = true;
  service.runtime.settings.autoStopTime = '08:55';
  service.runtime.settings.autoEnableEnabled = false;
  service.runtime.queue.guardState.stopLastAt = 0;
  service.runtime.queue.guardState.lastAppliedAt = 0;
  service.runtime.commit();

  await service.guardTick();
  assert.equal(calls, 1);
  assert.equal(service.runtime.queue.paused, true);
  assert.equal(service.runtime.queue.pauseReason.kind, 'attention');
  assert.equal(service.runtime.queue.pauseReason.source, 'guard-stop-ownership');
  assert.equal(service.runtime.queue.guardState.stopLastAt, 0);
  service.runtime.syncAttentionPause();
  assert.equal(service.runtime.queue.pauseReason.source, 'guard-stop-ownership', 'task reconciliation must not clear guard attention');

  remnantsRemain = false;
  await service.guardTick();
  assert.equal(calls, 2);
  assert.equal(service.runtime.queue.pauseReason.kind, 'auto-stop');
  assert.equal(service.runtime.queue.guardState.stopLastAt, new Date(2026, 8, 13, 8, 55).getTime());
  assert.equal(service.runtime.queue.guardState.lastError, null);
});

test('a successful pending-stop recheck never regresses guard watermarks', async (t) => {
  const fixedNow = new Date(2026, 8, 13, 9, 0, 0, 0).getTime();
  const watermark = fixedNow + 60 * 1000;
  let calls = 0;
  const { service } = await serviceFixture(t, {
    now: () => fixedNow,
    stopClient: async () => {
      calls += 1;
      return { stopped: true, count: 0, ownershipVerified: true };
    },
  });
  service.runtime.queue.guardState.stopLastAt = watermark;
  service.runtime.queue.guardState.enableLastAt = watermark;
  service.runtime.queue.guardState.lastAppliedAt = watermark;

  for (const eventTime of [null, fixedNow - 5000]) {
    service.runtime.setGuardStopOwnershipPending({
      source: 'scheduled',
      eventTime,
      message: 'recovered pending stop',
      guardPauseApplied: true,
      basePause: { kind: 'auto-stop', message: 'scheduled stop', since: fixedNow - 10000 },
    });
    assert.equal(service.runtime.guardStopOwnershipPending().eventTime, eventTime);
    await service.guardTick();
    assert.equal(service.runtime.hasGuardStopOwnershipPending(), false);
    assert.equal(service.runtime.queue.guardState.stopLastAt, watermark);
    assert.equal(service.runtime.queue.guardState.enableLastAt, watermark);
    assert.equal(service.runtime.queue.guardState.lastAppliedAt, watermark);
  }
  assert.equal(calls, 2);
});

test('manual stop verification failure latches across resume, enable, and explicit dry-run until a verified recheck', async (t) => {
  let verified = false;
  let stopCalls = 0;
  let enableCalls = 0;
  const { service, base } = await serviceFixture(t, {
    testMode: false,
    stopClient: async ({ dryRun }) => {
      stopCalls += 1;
      if (dryRun) return { dryRun: true, ownershipVerified: true, pids: [] };
      return verified
        ? { stopped: true, count: 0, ownershipVerified: true }
        : { stopped: false, count: 0, ownershipVerified: false, error: 'inventory incomplete' };
    },
    enableClient: () => { enableCalls += 1; return { ok: true }; },
  });

  const failed = await jsonRequest(base, '/api/guard', {
    method: 'POST',
    body: { action: 'stopClient' },
    headers: { 'X-ZTQ-Local': '1', 'Idempotency-Key': 'manual-stop-latch' },
  });
  assert.equal(failed.response.status, 500);
  assert.equal(failed.value.code, 'CLIENT_STOP_UNVERIFIED');
  const pendingSince = service.runtime.guardStopOwnershipPending().since;
  assert.equal(service.runtime.guardStopOwnershipPending().source, 'manual-api');
  assert.equal(service.runtime.queue.pauseReason.kind, 'manual');

  const resume = await jsonRequest(base, '/api/queue', {
    method: 'POST',
    body: { action: 'resume' },
    headers: { 'X-ZTQ-Local': '1', 'Idempotency-Key': 'resume-under-stop-latch' },
  });
  assert.equal(resume.response.status, 409);
  assert.equal(resume.value.code, 'GUARD_STOP_UNVERIFIED');

  const enable = await jsonRequest(base, '/api/guard', {
    method: 'POST',
    body: { action: 'enableClient' },
    headers: { 'X-ZTQ-Local': '1' },
  });
  assert.equal(enable.response.status, 409);
  assert.equal(enable.value.code, 'GUARD_STOP_UNVERIFIED');
  assert.equal(enableCalls, 0);

  const dryRun = await jsonRequest(base, '/api/guard', {
    method: 'POST',
    body: { action: 'stopClient', dryRun: true },
    headers: { 'X-ZTQ-Local': '1' },
  });
  assert.equal(dryRun.response.status, 200);
  assert.equal(dryRun.value.dryRun, true);
  assert.equal(service.runtime.hasGuardStopOwnershipPending(), true);
  assert.equal(service.runtime.guardStopOwnershipPending().since, pendingSince);

  verified = true;
  await service.guardTick();
  assert.equal(stopCalls, 3);
  assert.equal(service.runtime.hasGuardStopOwnershipPending(), false);
  assert.equal(service.runtime.queue.guardState.lastError, null);
  assert.equal(service.runtime.queue.paused, true);
  assert.equal(service.runtime.queue.pauseReason.kind, 'manual');
});

test('manual client stop remains as a base pause after overlaid task attention is acknowledged', async (t) => {
  const { service, base } = await serviceFixture(t, {
    stopClient: async () => ({ stopped: true, count: 0, ownershipVerified: true }),
  });
  service.runtime.queue.paused = true;
  const taskId = service.runtime.createTasks({ type: 'shell', name: 'manual stop attention', prompt: 'true' }, 'manual-stop-attention').ids[0];
  const task = service.runtime.findTask(taskId);
  service.runtime.markAttentionWithoutCommit(task, 'needs-review', 'review before resume', {}, false);
  service.runtime.commit();

  const stopped = await jsonRequest(base, '/api/guard', {
    method: 'POST',
    body: { action: 'stopClient' },
    headers: { 'X-ZTQ-Local': '1', 'Idempotency-Key': 'manual-stop-over-attention' },
  });
  assert.equal(stopped.response.status, 200);
  assert.equal(service.runtime.hasGuardStopOwnershipPending(), false);
  assert.equal(service.runtime.queue.pauseReason.kind, 'attention');
  assert.equal(service.runtime.queue.pauseReason.taskId, taskId);
  assert.equal(service.runtime.guardStopBasePause().kind, 'manual');

  service.runtime.taskAction(taskId, 'acknowledge', 'ack-manual-stop-attention');
  assert.equal(service.runtime.queue.paused, true);
  assert.equal(service.runtime.queue.pausedBySystem, false);
  assert.equal(service.runtime.queue.pauseReason.kind, 'manual');
});

test('scheduled stop latch coexists with task attention and acknowledgement cannot clear it', async (t) => {
  const fixedNow = new Date(2026, 8, 13, 9, 0, 0, 0).getTime();
  let verified = false;
  const { service } = await serviceFixture(t, {
    now: () => fixedNow,
    stopClient: async () => verified
      ? { stopped: true, count: 0, ownershipVerified: true }
      : { stopped: false, count: 0, ownershipVerified: false, error: 'ownership unknown' },
  });
  service.runtime.queue.paused = true;
  service.runtime.queue.pausedBySystem = false;
  service.runtime.queue.pauseReason = null;
  const firstId = service.runtime.createTasks({ type: 'shell', name: 'attention one', prompt: 'true' }, 'guard-attn-one').ids[0];
  const secondId = service.runtime.createTasks({ type: 'shell', name: 'attention two', prompt: 'true' }, 'guard-attn-two').ids[0];
  const pendingId = service.runtime.createTasks({ type: 'shell', name: 'must stay pending', prompt: 'true' }, 'guard-attn-pending').ids[0];
  const first = service.runtime.findTask(firstId);
  const second = service.runtime.findTask(secondId);
  service.runtime.markAttentionWithoutCommit(first, 'first-uncertain', 'first needs review', {}, false);
  service.runtime.markAttentionWithoutCommit(second, 'second-uncertain', 'second needs review', {}, false);
  service.runtime.settings.autoStopEnabled = true;
  service.runtime.settings.autoStopTime = '08:55';
  service.runtime.settings.autoEnableEnabled = false;
  service.runtime.queue.guardState.stopLastAt = 0;
  service.runtime.queue.guardState.lastAppliedAt = 0;
  service.runtime.commit();

  await service.guardTick();
  assert.equal(service.runtime.hasGuardStopOwnershipPending(), true);
  assert.equal(service.runtime.queue.pauseReason.kind, 'attention');
  const selectedId = service.runtime.queue.pauseReason.taskId;
  const remainingId = selectedId === firstId ? secondId : firstId;
  const remaining = service.runtime.findTask(remainingId);
  assert.ok([firstId, secondId].includes(selectedId));
  assert.equal(service.runtime.queue.guardState.stopOwnershipPending.guardPauseApplied, false);

  service.runtime.taskAction(selectedId, 'acknowledge', 'guard-ack-one');
  assert.equal(service.runtime.hasGuardStopOwnershipPending(), true);
  assert.equal(service.runtime.queue.pauseReason.taskId, remainingId);
  assert.equal(remaining.status, 'attention');

  verified = true;
  await service.guardTick();
  assert.equal(service.runtime.hasGuardStopOwnershipPending(), false);
  assert.equal(service.runtime.queue.pauseReason.kind, 'attention');
  assert.equal(service.runtime.queue.pauseReason.taskId, remainingId);
  assert.equal(service.runtime.queue.paused, true);
  assert.equal(service.runtime.guardStopBasePause().kind, 'auto-stop');
  assert.equal(service.runtime.queue.guardState.stopLastAt, new Date(2026, 8, 13, 8, 55).getTime());

  service.runtime.taskAction(remainingId, 'acknowledge', 'guard-ack-remaining');
  assert.equal(service.runtime.queue.paused, true);
  assert.equal(service.runtime.queue.pausedBySystem, true);
  assert.equal(service.runtime.queue.pauseReason.kind, 'auto-stop');
  assert.equal(service.runtime.findTask(pendingId).status, 'pending');
  assert.equal(service.runtime.nextTimer, null);
});

test('failed scheduled enable remains due and does not resume until launch succeeds', async (t) => {
  const fixedNow = new Date(2026, 8, 13, 23, 5, 0, 0).getTime();
  let calls = 0;
  let succeeds = false;
  const { service } = await serviceFixture(t, {
    now: () => fixedNow,
    enableClient: () => {
      calls += 1;
      return succeeds ? { ok: true } : { ok: false, error: 'open failed' };
    },
  });
  service.runtime.settings.autoStopEnabled = false;
  service.runtime.settings.autoEnableEnabled = true;
  service.runtime.settings.autoEnableTime = '23:00';
  service.runtime.queue.paused = true;
  service.runtime.queue.pausedBySystem = true;
  service.runtime.queue.pauseReason = { kind: 'auto-stop', message: 'test', since: fixedNow - 1000 };
  service.runtime.queue.guardState.enableLastAt = 0;
  service.runtime.queue.guardState.lastAppliedAt = 0;
  service.runtime.commit();

  await service.guardTick();
  assert.equal(calls, 1);
  assert.equal(service.runtime.queue.guardState.enableLastAt, 0);
  assert.equal(service.runtime.queue.guardState.enableResumeAt, 0);
  assert.match(service.runtime.queue.guardState.lastError.message, /open failed/);
  await service.guardTick();
  assert.equal(calls, 2);

  succeeds = true;
  await service.guardTick();
  assert.equal(calls, 3);
  assert.equal(service.runtime.queue.guardState.enableLastAt, new Date(2026, 8, 13, 23, 0).getTime());
  assert.equal(service.runtime.queue.guardState.lastError, null);
  assert.ok(service.runtime.queue.guardState.enableResumeAt > fixedNow);
  assert.equal(service.runtime.queue.paused, true);
});

test('scheduled enable consumes an auto-stop base hidden by task attention but leaves manual bases intact', async (t) => {
  let currentNow = new Date(2026, 8, 13, 23, 5, 0, 0).getTime();
  const { service } = await serviceFixture(t, {
    now: () => currentNow,
    enableResumeMs: 10,
    enableClient: () => ({ ok: true }),
  });
  service.runtime.queue.paused = true;
  const attentionId = service.runtime.createTasks({ type: 'shell', name: 'enable attention', prompt: 'true' }, 'enable-attention').ids[0];
  const pendingId = service.runtime.createTasks({ type: 'shell', name: 'after attention', prompt: 'true' }, 'enable-pending').ids[0];
  const attention = service.runtime.findTask(attentionId);
  service.runtime.markAttentionWithoutCommit(attention, 'enable-review', 'review still required', {}, false);
  service.runtime.setGuardStopBasePause({ kind: 'auto-stop', message: 'scheduled stop', since: currentNow - 10000 }, { commit: false });
  service.runtime.settings.autoStopEnabled = false;
  service.runtime.settings.autoEnableEnabled = true;
  service.runtime.settings.autoEnableTime = '23:00';
  service.runtime.queue.guardState.enableLastAt = 0;
  service.runtime.queue.guardState.lastAppliedAt = 0;
  service.runtime.commit();

  await service.guardTick();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(service.runtime.queue.pauseReason.kind, 'attention');
  assert.equal(service.runtime.guardStopBasePause(), null);
  service.runtime.taskAction(attentionId, 'acknowledge', 'ack-after-enable');
  assert.equal(service.runtime.queue.paused, false);
  assert.ok(service.runtime.nextTimer, 'clearing the final attention should kick the pending task');
  assert.equal(service.runtime.findTask(pendingId).status, 'pending');

  // A manual base is user-owned and must never be consumed by auto-enable.
  service.runtime.clearRuntimeTimers();
  service.runtime.queue.paused = true;
  service.runtime.queue.pausedBySystem = false;
  service.runtime.queue.pauseReason = { kind: 'manual', message: 'manual', since: currentNow };
  service.runtime.setGuardStopBasePause(service.runtime.queue.pauseReason, { commit: false });
  currentNow += 24 * 60 * 60 * 1000;
  service.runtime.queue.guardState.enableLastAt = 0;
  service.runtime.queue.guardState.lastAppliedAt = 0;
  service.runtime.commit();
  await service.guardTick();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(service.runtime.guardStopBasePause().kind, 'manual');
  assert.equal(service.runtime.queue.pauseReason.kind, 'manual');
  assert.equal(service.runtime.queue.paused, true);
});

test('auto-enable cannot erase a stopOnFail pause created while auto-stop is the base pause', async (t) => {
  const fixedNow = new Date(2026, 8, 13, 23, 5, 0, 0).getTime();
  const { service } = await serviceFixture(t, {
    now: () => fixedNow,
    enableResumeMs: 10,
    enableClient: () => ({ ok: true }),
  });
  service.runtime.queue.paused = true;
  const failedId = service.runtime.createTasks({ type: 'shell', name: 'will fail', prompt: 'false' }, 'stop-on-fail-active').ids[0];
  const pendingId = service.runtime.createTasks({ type: 'shell', name: 'must remain pending', prompt: 'true' }, 'stop-on-fail-pending').ids[0];
  const failed = service.runtime.findTask(failedId);
  failed.status = 'running';
  failed.phase = 'running';
  failed.execution = { startedAt: fixedNow - 1000 };
  service.runtime.current = {
    taskId: failedId,
    kind: 'client',
    pollHandle: null,
    timeoutHandle: null,
    nextAttemptHandle: null,
  };
  service.runtime.queue.paused = false;
  service.runtime.queue.pausedBySystem = false;
  service.runtime.queue.pauseReason = null;
  service.runtime.settings.stopOnFail = true;
  assert.equal(service.runtime.setSystemPause('auto-stop', 'scheduled stop'), true);
  service.runtime.finishTask(failed, 'failed', 1, 'simulated failure');
  assert.equal(service.runtime.queue.pauseReason.kind, 'failure');
  assert.equal(service.runtime.guardStopBasePause().kind, 'failure');

  service.runtime.settings.autoStopEnabled = false;
  service.runtime.settings.autoEnableEnabled = true;
  service.runtime.settings.autoEnableTime = '23:00';
  service.runtime.queue.guardState.enableLastAt = 0;
  service.runtime.queue.guardState.lastAppliedAt = 0;
  service.runtime.commit();
  await service.guardTick();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(service.runtime.guardStopBasePause().kind, 'failure');
  assert.equal(service.runtime.queue.paused, true);
  assert.equal(service.runtime.queue.pauseReason.kind, 'failure');
  assert.equal(service.runtime.findTask(pendingId).status, 'pending');
  assert.equal(service.runtime.nextTimer, null);
});

test('a pending post-enable resume survives a service restart', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztq-enable-resume-'));
  const dataDir = path.join(tempRoot, 'data');
  const indexDbPath = path.join(tempRoot, 'zcode', 'v2', 'tasks-index.sqlite');
  const sessionDbPath = path.join(tempRoot, 'zcode', 'cli', 'db', 'db.sqlite');
  createIndexDb(indexDbPath);
  createSessionDb(sessionDbPath);
  const env = {
    ...process.env,
    ZTQ_TEST_MODE: '1',
    ZTQ_CLIENT_REFRESH_MS: '60000',
    ZTQ_GUARD_INTERVAL_MS: '60000',
    ZTQ_ENABLE_RESUME_MS: '400',
  };
  const options = {
    root: path.resolve(__dirname, '..'), dataDir, indexDbPath, sessionDbPath,
    clientConfigPath: path.join(tempRoot, 'missing-config.json'),
    pidFile: path.join(tempRoot, 'run', 'pid.json'),
    readyFile: path.join(tempRoot, 'run', 'ready.json'),
    logFile: path.join(tempRoot, 'log', 'server.log'),
    homeDir: tempRoot, host: '127.0.0.1', port: 0, testMode: true, env, logger: () => {},
    apiToken: TEST_TOKEN,
  };
  let service = createService(options);
  t.after(async () => {
    await service.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  await service.start();
  const due = new Date(Date.now() - 60 * 1000);
  const dueClock = `${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`;
  service.runtime.settings.autoEnableEnabled = true;
  service.runtime.settings.autoEnableTime = dueClock;
  service.runtime.queue.paused = true;
  service.runtime.queue.pausedBySystem = true;
  service.runtime.queue.pauseReason = { kind: 'auto-stop', message: 'test', since: Date.now() - 1000 };
  service.runtime.queue.guardState.enableLastAt = 0;
  service.runtime.queue.guardState.lastAppliedAt = 0;
  service.runtime.commit();
  await service.guardTick();
  const resumeAt = service.runtime.queue.guardState.enableResumeAt;
  assert.ok(resumeAt > Date.now());
  await service.stop();

  service = createService(options);
  await service.start();
  assert.equal(service.runtime.queue.paused, true);
  assert.equal(service.runtime.queue.guardState.enableResumeAt, resumeAt);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(service.runtime.queue.paused, false);
  assert.equal(service.runtime.queue.guardState.enableResumeAt, 0);
});
