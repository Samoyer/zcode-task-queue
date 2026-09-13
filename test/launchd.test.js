'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { render } = require('../launchd/render');

test('launchd renderer emits a private, valid, fully resolved plist', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztq-launchd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'agents', 'queue.plist');
  const testHome = path.join(root, 'home & user');
  const env = {
    ...process.env,
    ZTQ_HOME_DIR: testHome,
    ZTQ_NODE_BIN: process.execPath,
    ZTQ_DATA_DIR: path.join(root, 'data & state'),
    ZTQ_PID_FILE: path.join(root, 'run', 'pid.json'),
    ZTQ_READY_FILE: path.join(root, 'run', 'ready.json'),
    ZTQ_LOG_FILE: path.join(root, 'log', 'server.log'),
    ZTQ_LAUNCHD_STDOUT: path.join(root, 'fresh stdout', 'queue.stdout.log'),
    ZTQ_LAUNCHD_STDERR: path.join(root, 'fresh stderr', 'queue.stderr.log'),
    ZTQ_API_TOKEN_FILE: path.join(root, 'auth & token', 'api-token'),
    ZTQ_CLIENT_INDEX_DB: path.join(root, 'client', 'index.sqlite'),
    ZTQ_CLIENT_SESSION_DB: path.join(root, 'client', 'session.sqlite'),
    ZTQ_TEST_MODE: '1',
    ZTQ_SHELL_SHUTDOWN_GRACE_MS: '3210',
    ZTQ_SHELL_KILL_WAIT_MS: '876',
    ZTQ_HOST: '127.0.0.1',
    ZTQ_PORT: '0',
    ZTQ_LAUNCHD_LABEL: 'com.zcode-task-queue.test',
  };
  const result = render({ output, env });
  const body = fs.readFileSync(output, 'utf8');
  assert.equal(result.label, env.ZTQ_LAUNCHD_LABEL);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.doesNotMatch(body, /__ZTQ_|\/REPLACE\/WITH/);
  assert.match(body, /com\.zcode-task-queue\.test/);
  assert.match(body, /<key>ZTQ_HOME_DIR<\/key>\s*<string>.*home &amp; user<\/string>/);
  assert.match(body, /data &amp; state/);
  assert.match(body, /ZTQ_CLIENT_INDEX_DB/);
  assert.match(body, /<key>ZTQ_API_TOKEN_FILE<\/key>\s*<string>.*auth &amp; token.*api-token<\/string>/);
  assert.match(body, /<key>ZTQ_SHELL_SHUTDOWN_GRACE_MS<\/key>\s*<string>3210<\/string>/);
  assert.match(body, /<key>ZTQ_SHELL_KILL_WAIT_MS<\/key>\s*<string>876<\/string>/);
  assert.match(body, /<key>StandardOutPath<\/key>\s*<string>.*fresh stdout.*queue\.stdout\.log<\/string>/);
  assert.match(body, /<key>StandardErrorPath<\/key>\s*<string>.*fresh stderr.*queue\.stderr\.log<\/string>/);
  for (const logFile of [env.ZTQ_LAUNCHD_STDOUT, env.ZTQ_LAUNCHD_STDERR]) {
    assert.equal(fs.existsSync(path.dirname(logFile)), true);
    assert.equal(fs.statSync(path.dirname(logFile)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(logFile).isFile(), true);
    assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
  }
  if (process.platform === 'darwin') {
    const lint = spawnSync('/usr/bin/plutil', ['-lint', output], { encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stderr || lint.stdout);
  }
});

test('launchd renderer refuses a symlink as a pre-created stdio target', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztq-launchd-stdio-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const victim = path.join(root, 'victim.log');
  const stderrFile = path.join(root, 'stderr.log');
  fs.writeFileSync(victim, 'preserve');
  fs.symlinkSync(victim, stderrFile);
  assert.throws(() => render({
    output: path.join(root, 'agents', 'queue.plist'),
    env: {
      ...process.env,
      ZTQ_NODE_BIN: process.execPath,
      ZTQ_HOME_DIR: path.join(root, 'home'),
      ZTQ_DATA_DIR: path.join(root, 'data'),
      ZTQ_PID_FILE: path.join(root, 'run', 'pid.json'),
      ZTQ_READY_FILE: path.join(root, 'run', 'ready.json'),
      ZTQ_LOG_FILE: path.join(root, 'log', 'server.log'),
      ZTQ_API_TOKEN_FILE: path.join(root, 'auth', 'token'),
      ZTQ_LAUNCHD_STDERR: stderrFile,
      ZTQ_HOST: '127.0.0.1',
      ZTQ_PORT: '0',
    },
  }), /非符号链接普通文件/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'preserve');
});

test('launchd renderer rejects non-loopback listeners', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztq-launchd-reject-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => render({
    output: path.join(root, 'bad.plist'),
    env: { ...process.env, ZTQ_HOST: '0.0.0.0' },
  }), /回环/);
});

test('launchd renderer protects its template and rejects unsafe timer values', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztq-launchd-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => render({
    output: path.resolve(__dirname, '..', 'launchd', 'com.zcode-task-queue.plist'),
    env: process.env,
  }), /不能覆盖/);
  assert.throws(() => render({
    output: path.join(root, 'bad-timer.plist'),
    env: { ...process.env, ZTQ_POLL_MS: '0' },
  }), /ZTQ_POLL_MS/);
});

test('launchd renderer rejects output and runtime files that alias queue state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztq-launchd-collision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const baseEnv = {
    ...process.env,
    ZTQ_NODE_BIN: process.execPath,
    ZTQ_HOME_DIR: path.join(root, 'home'),
    ZTQ_DATA_DIR: dataDir,
    ZTQ_PID_FILE: path.join(root, 'run', 'pid.json'),
    ZTQ_READY_FILE: path.join(root, 'run', 'ready.json'),
    ZTQ_LOG_FILE: path.join(root, 'log', 'server.log'),
    ZTQ_API_TOKEN_FILE: path.join(root, 'auth', 'token'),
    ZTQ_HOST: '127.0.0.1',
    ZTQ_PORT: '0',
  };
  const stateFile = path.join(dataDir, 'state.json');
  assert.throws(() => render({
    output: path.join(root, 'agents', 'queue.plist'),
    env: { ...baseEnv, ZTQ_READY_FILE: stateFile },
  }), /路径冲突/);
  assert.equal(fs.existsSync(stateFile), false);

  assert.throws(() => render({
    output: stateFile,
    env: baseEnv,
  }), /路径冲突/);
  assert.equal(fs.existsSync(stateFile), false);
});
