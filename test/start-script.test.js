'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { createIndexDb, createSessionDb } = require('./helpers/fixture');

const repoRoot = path.resolve(__dirname, '..');
const startScript = path.join(repoRoot, 'start.sh');
const smokeScript = path.join(repoRoot, 'smoke-test.sh');

function opsFixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztq-ops-'));
  const testHome = path.join(root, 'home');
  const indexDb = path.join(root, 'zcode', 'v2', 'tasks-index.sqlite');
  const sessionDb = path.join(root, 'zcode', 'cli', 'db', 'db.sqlite');
  createIndexDb(indexDb);
  createSessionDb(sessionDb);
  const env = {
    ...process.env,
    ZTQ_HOME_DIR: testHome,
    ZTQ_DATA_DIR: path.join(root, 'data'),
    ZTQ_CLIENT_INDEX_DB: indexDb,
    ZTQ_CLIENT_SESSION_DB: sessionDb,
    ZTQ_CLIENT_CONFIG: path.join(root, 'zcode', 'v2', 'config.json'),
    ZTQ_PID_FILE: path.join(root, 'run', 'server.pid.json'),
    ZTQ_READY_FILE: path.join(root, 'run', 'ready.json'),
    ZTQ_LOG_FILE: path.join(root, 'log', 'server.log'),
    ZTQ_NODE_BIN: process.execPath,
    ZTQ_HOST: '127.0.0.1',
    ZTQ_PORT: '0',
    ZTQ_TEST_MODE: '1',
    ZTQ_CLIENT_REFRESH_MS: '60000',
    ZTQ_GUARD_INTERVAL_MS: '60000',
    ...overrides,
  };
  fs.mkdirSync(testHome, { recursive: true });
  const run = (action, extraEnv = {}) => spawnSync(startScript, [action], {
    cwd: repoRoot,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    timeout: 20000,
  });
  t.after(() => {
    run('stop');
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, env, run };
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test('start.sh handles stopped restart, duplicate start, healthy restart, and idempotent stop', (t) => {
  const fx = opsFixture(t, { ZTQ_STARTUP_DELAY_MS: '1100' });
  const preflight = fx.run('preflight');
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.match(preflight.stdout, new RegExp(`Node: ${process.execPath.replace(/[.*+?^$(){}|[\\]\\]/g, '\\$&')}`));
  assert.match(preflight.stdout, /Listen: 127\.0\.0\.1:0/);

  const coldRestart = fx.run('restart');
  assert.equal(coldRestart.status, 0, coldRestart.stderr);
  const first = JSON.parse(fs.readFileSync(fx.env.ZTQ_PID_FILE, 'utf8'));
  assert.ok(first.pid > 0);
  assert.match(first.processStartedAt, /\S/);
  assert.notEqual(first.port, 8787);

  const duplicateStart = fx.run('start');
  assert.equal(duplicateStart.status, 0, duplicateStart.stderr);
  assert.equal(JSON.parse(fs.readFileSync(fx.env.ZTQ_PID_FILE)).startToken, first.startToken);

  const healthyRestart = fx.run('restart');
  assert.equal(healthyRestart.status, 0, healthyRestart.stderr);
  const second = JSON.parse(fs.readFileSync(fx.env.ZTQ_PID_FILE, 'utf8'));
  assert.notEqual(second.startToken, first.startToken);
  assert.equal(fx.run('status').status, 0);

  assert.equal(fx.run('stop').status, 0);
  assert.equal(fs.existsSync(fx.env.ZTQ_PID_FILE), false);
  assert.equal(fx.run('status').status, 3);
  assert.equal(fx.run('stop').status, 0);
});

test('start.sh service survives launching-shell process-group teardown and keeps log routing and stop cleanup', async (t) => {
  const fx = opsFixture(t);
  const stdoutMarker = `startup-stdout-${process.pid}-${Date.now()}`;
  const stderrMarker = `startup-stderr-${process.pid}-${Date.now()}`;
  const startupHook = path.join(fx.root, 'startup-output-hook.js');
  const parentPgidFile = path.join(fx.root, 'launching-shell.pgid');
  fs.writeFileSync(startupHook, `'use strict';
if (process.env.ZTQ_MIRROR_LOG_STDOUT === '0' && process.argv[1] === ${JSON.stringify(path.join(repoRoot, 'server.js'))}) {
  process.stdout.write(${JSON.stringify(`${stdoutMarker}\n`)});
  process.stderr.write(${JSON.stringify(`${stderrMarker}\n`)});
}
`, { mode: 0o600 });

  const parent = spawnSync('/bin/bash', ['-c', `
/bin/ps -o pgid= -p $$ > ${JSON.stringify(parentPgidFile)}
${JSON.stringify(startScript)} start
rc=$?
if [ "$rc" -ne 0 ]; then exit "$rc"; fi
kill -KILL 0
`], {
    cwd: repoRoot,
    env: { ...fx.env, NODE_OPTIONS: `--require=${startupHook}` },
    encoding: 'utf8',
    timeout: 20000,
    detached: true,
  });
  assert.equal(parent.signal, 'SIGKILL', parent.stderr || parent.stdout);

  const identity = JSON.parse(fs.readFileSync(fx.env.ZTQ_PID_FILE, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.doesNotThrow(() => process.kill(identity.pid, 0), 'service died with the launching shell process group');
  const parentPgid = fs.readFileSync(parentPgidFile, 'utf8').trim();
  const servicePgid = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(identity.pid)], { encoding: 'utf8' }).trim();
  assert.equal(servicePgid, String(identity.pid));
  assert.notEqual(servicePgid, parentPgid);

  const startupLog = fs.readFileSync(`${fx.env.ZTQ_LOG_FILE}.startup`, 'utf8');
  const runtimeLog = fs.readFileSync(fx.env.ZTQ_LOG_FILE, 'utf8');
  assert.match(startupLog, new RegExp(stdoutMarker));
  assert.match(startupLog, new RegExp(stderrMarker));
  assert.match(runtimeLog, /ZCode 任务队列已启动/);
  assert.doesNotMatch(runtimeLog, new RegExp(`${stdoutMarker}|${stderrMarker}`));
  assert.equal(fx.run('status').status, 0);

  assert.equal(fx.run('stop').status, 0);
  assert.throws(() => process.kill(identity.pid, 0), (error) => error && error.code === 'ESRCH');
  assert.equal(fs.existsSync(fx.env.ZTQ_PID_FILE), false);
  assert.equal(fs.existsSync(fx.env.ZTQ_READY_FILE), false);
  assert.match(fs.readFileSync(fx.env.ZTQ_LOG_FILE, 'utf8'), /ZCode 任务队列已停止/);
});

test('start.sh never starts the server when its process group dies before handoff acknowledgement', async (t) => {
  const fx = opsFixture(t);
  const shimDir = path.join(fx.root, 'shim-bin');
  const blockedMarker = path.join(fx.root, 'identity-read-blocked');
  const serverStartedMarker = path.join(fx.root, 'server-started');
  const serverHook = path.join(fx.root, 'record-unexpected-server.js');
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, 'sed'), `#!/bin/bash
for argument in "$@"; do
  case "$argument" in
    "$ZTQ_PID_FILE".launch.*/identity)
      printf '%s\\n' "$$" > ${JSON.stringify(blockedMarker)}
      /bin/sleep 1
      ;;
  esac
done
exec /usr/bin/sed "$@"
`, { mode: 0o700 });
  fs.writeFileSync(serverHook, `'use strict';
if (process.env.ZTQ_MIRROR_LOG_STDOUT === '0' && process.argv[1] === ${JSON.stringify(path.join(repoRoot, 'server.js'))}) {
  require('fs').writeFileSync(${JSON.stringify(serverStartedMarker)}, String(process.pid));
}
`, { mode: 0o600 });

  const launcher = spawn(startScript, ['start'], {
    cwd: repoRoot,
    env: {
      ...fx.env,
      NODE_OPTIONS: `--require=${serverHook}`,
      PATH: `${shimDir}:${fx.env.PATH}`,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const launcherResult = waitForExit(launcher);
  for (let i = 0; i < 300 && !fs.existsSync(blockedMarker); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(blockedMarker), true, 'launcher never reached the pre-acknowledgement gate');

  const runDir = path.dirname(fx.env.ZTQ_PID_FILE);
  const launchPrefix = `${path.basename(fx.env.ZTQ_PID_FILE)}.launch.`;
  const launchDirs = fs.readdirSync(runDir).filter((name) => name.startsWith(launchPrefix));
  assert.equal(launchDirs.length, 1);
  const launchDir = path.join(runDir, launchDirs[0]);
  assert.equal(fs.existsSync(path.join(launchDir, 'ack')), false);
  const gatePid = Number(fs.readFileSync(path.join(launchDir, 'identity'), 'utf8').split('\n', 1)[0]);
  const launcherPgid = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(launcher.pid)], { encoding: 'utf8' }).trim();
  const gatePgid = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(gatePid)], { encoding: 'utf8' }).trim();
  assert.equal(launcherPgid, String(launcher.pid));
  assert.equal(gatePgid, String(gatePid));
  assert.notEqual(gatePgid, launcherPgid);

  process.kill(-launcher.pid, 'SIGKILL');
  const killed = await launcherResult;
  assert.equal(killed.signal, 'SIGKILL', killed.stderr || killed.stdout);
  for (let i = 0; i < 200; i += 1) {
    let gateAlive = true;
    try { process.kill(gatePid, 0); } catch (error) { if (error.code === 'ESRCH') gateAlive = false; else throw error; }
    if (!gateAlive && !fs.existsSync(launchDir)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.throws(() => process.kill(gatePid, 0), (error) => error && error.code === 'ESRCH');
  assert.equal(fs.existsSync(launchDir), false);
  assert.equal(fs.existsSync(`${fx.env.ZTQ_PID_FILE}.lifecycle.lock`), false);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(fs.existsSync(serverStartedMarker), false);
  assert.equal(fs.existsSync(fx.env.ZTQ_PID_FILE), false);
  assert.equal(fs.existsSync(fx.env.ZTQ_READY_FILE), false);
});

test('start.sh commits once acknowledgement exists even before the gate observes it', async (t) => {
  const fx = opsFixture(t, { ZTQ_TEST_GATE_STOP_BEFORE_ACK_CHECK: '1' });
  const serverStartedMarker = path.join(fx.root, 'server-started-before-ack-observation');
  const serverHook = path.join(fx.root, 'record-pre-observation-server.js');
  fs.writeFileSync(serverHook, `'use strict';
if (process.env.ZTQ_MIRROR_LOG_STDOUT === '0' && process.argv[1] === ${JSON.stringify(path.join(repoRoot, 'server.js'))}) {
  require('fs').writeFileSync(${JSON.stringify(serverStartedMarker)}, String(process.pid));
}
`, { mode: 0o600 });

  const launcher = spawn(startScript, ['start'], {
    cwd: repoRoot,
    env: { ...fx.env, NODE_OPTIONS: `--require=${serverHook}` },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const launcherResult = waitForExit(launcher);
  let gatePid = 0;
  t.after(() => {
    try { process.kill(-launcher.pid, 'SIGKILL'); } catch {}
    if (gatePid > 0) {
      try { process.kill(gatePid, 'SIGCONT'); } catch {}
    }
  });

  const runDir = path.dirname(fx.env.ZTQ_PID_FILE);
  const launchPrefix = `${path.basename(fx.env.ZTQ_PID_FILE)}.launch.`;
  let launchDir = '';
  for (let i = 0; i < 500; i += 1) {
    const candidates = fs.existsSync(runDir)
      ? fs.readdirSync(runDir).filter((name) => name.startsWith(launchPrefix))
      : [];
    const paused = candidates.find((name) => fs.existsSync(path.join(runDir, name, 'ack.pre-observe')));
    if (paused) {
      launchDir = path.join(runDir, paused);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.notEqual(launchDir, '', 'gate never paused before observing the acknowledgement');
  gatePid = Number(fs.readFileSync(path.join(launchDir, 'identity'), 'utf8').split('\n', 1)[0]);
  assert.ok(gatePid > 0);

  for (let i = 0; i < 300 && !fs.existsSync(path.join(launchDir, 'ack')); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(path.join(launchDir, 'ack')), true, 'launcher never created acknowledgement');
  assert.equal(fs.existsSync(path.join(launchDir, 'ack.observed')), false);

  process.kill(-launcher.pid, 'SIGKILL');
  const killed = await launcherResult;
  assert.equal(killed.signal, 'SIGKILL', killed.stderr || killed.stdout);
  process.kill(gatePid, 'SIGCONT');

  for (let i = 0; i < 800 && !fs.existsSync(fx.env.ZTQ_READY_FILE); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(fx.env.ZTQ_PID_FILE), true, 'committed service never wrote its PID file');
  assert.equal(fs.existsSync(fx.env.ZTQ_READY_FILE), true, 'committed service never became ready');
  assert.equal(JSON.parse(fs.readFileSync(fx.env.ZTQ_PID_FILE, 'utf8')).pid, gatePid);
  assert.equal(fs.existsSync(serverStartedMarker), true);
  assert.equal(fx.run('status').status, 0);
  assert.equal(fs.existsSync(launchDir), false);

  assert.equal(fx.run('stop').status, 0);
  assert.throws(() => process.kill(gatePid, 0), (error) => error && error.code === 'ESRCH');
  assert.equal(fs.existsSync(`${fx.env.ZTQ_PID_FILE}.lifecycle.lock`), false);
});

test('start.sh commits after the detached gate observes acknowledgement', async (t) => {
  const fx = opsFixture(t, { ZTQ_TEST_GATE_STOP_AFTER_ACK: '1' });
  const launcher = spawn(startScript, ['start'], {
    cwd: repoRoot,
    env: fx.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const launcherResult = waitForExit(launcher);
  let gatePid = 0;
  t.after(() => {
    try { process.kill(-launcher.pid, 'SIGKILL'); } catch {}
    if (gatePid > 0) {
      try { process.kill(gatePid, 'SIGCONT'); } catch {}
    }
  });

  const runDir = path.dirname(fx.env.ZTQ_PID_FILE);
  const launchPrefix = `${path.basename(fx.env.ZTQ_PID_FILE)}.launch.`;
  let launchDir = '';
  for (let i = 0; i < 500; i += 1) {
    const candidates = fs.existsSync(runDir)
      ? fs.readdirSync(runDir).filter((name) => name.startsWith(launchPrefix))
      : [];
    const observed = candidates.find((name) => fs.existsSync(path.join(runDir, name, 'ack.observed')));
    if (observed) {
      launchDir = path.join(runDir, observed);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.notEqual(launchDir, '', 'gate never observed the acknowledgement');
  assert.equal(fs.existsSync(path.join(launchDir, 'ack')), true);
  gatePid = Number(fs.readFileSync(path.join(launchDir, 'identity'), 'utf8').split('\n', 1)[0]);
  assert.ok(gatePid > 0);
  assert.doesNotThrow(() => process.kill(gatePid, 0));

  process.kill(-launcher.pid, 'SIGKILL');
  const killed = await launcherResult;
  assert.equal(killed.signal, 'SIGKILL', killed.stderr || killed.stdout);
  process.kill(gatePid, 'SIGCONT');

  for (let i = 0; i < 800 && !fs.existsSync(fx.env.ZTQ_READY_FILE); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(fx.env.ZTQ_PID_FILE), true, 'committed service never wrote its PID file');
  assert.equal(fs.existsSync(fx.env.ZTQ_READY_FILE), true, 'committed service never became ready');
  assert.equal(JSON.parse(fs.readFileSync(fx.env.ZTQ_PID_FILE, 'utf8')).pid, gatePid);
  assert.equal(fx.run('status').status, 0);
  assert.equal(fs.existsSync(launchDir), false);

  assert.equal(fx.run('stop').status, 0);
  assert.throws(() => process.kill(gatePid, 0), (error) => error && error.code === 'ESRCH');
  assert.equal(fs.existsSync(`${fx.env.ZTQ_PID_FILE}.lifecycle.lock`), false);
});

test('start.sh refuses a forged same-user PID and leaves the unrelated process alive', async (t) => {
  const fx = opsFixture(t);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  t.after(() => {
    try { unrelated.kill('SIGKILL'); } catch {}
  });
  await new Promise((resolve, reject) => {
    unrelated.once('spawn', resolve);
    unrelated.once('error', reject);
  });
  const processStartedAt = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(unrelated.pid)], { encoding: 'utf8' }).trim();
  fs.mkdirSync(path.dirname(fx.env.ZTQ_PID_FILE), { recursive: true });
  fs.writeFileSync(fx.env.ZTQ_PID_FILE, JSON.stringify({
    pid: unrelated.pid,
    uid: process.getuid(),
    root: repoRoot,
    node: process.execPath,
    processStartedAt,
    host: '127.0.0.1',
    port: 65534,
    startToken: 'forged',
  }));
  const stopped = fx.run('stop');
  assert.equal(stopped.status, 4);
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  unrelated.kill('SIGTERM');
  await new Promise((resolve) => unrelated.once('exit', resolve));
});

test('start.sh cleans stale PID files and fails cleanly on an occupied port', async (t) => {
  const fx = opsFixture(t);
  fs.mkdirSync(path.dirname(fx.env.ZTQ_PID_FILE), { recursive: true });
  fs.writeFileSync(fx.env.ZTQ_PID_FILE, JSON.stringify({ pid: 2147483647 }));
  assert.equal(fx.run('stop').status, 0);
  assert.equal(fs.existsSync(fx.env.ZTQ_PID_FILE), false);

  const blocker = net.createServer();
  t.after(() => blocker.close());
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const occupied = fx.run('start', { ZTQ_PORT: String(blocker.address().port), ZTQ_STARTUP_DELAY_MS: '0' });
  assert.equal(occupied.status, 5);
  assert.match(occupied.stderr, /端口.*监听/);
  assert.equal(fs.existsSync(fx.env.ZTQ_PID_FILE), false);
  assert.equal(fs.existsSync(fx.env.ZTQ_READY_FILE), false);
  await new Promise((resolve) => blocker.close(resolve));
});

test('start.sh terminates an unhealthy child instead of leaving an orphan', (t) => {
  const fx = opsFixture(t, { ZTQ_START_WAIT_TENTHS: '5' });
  fs.mkdirSync(fx.env.ZTQ_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(fx.env.ZTQ_DATA_DIR, 'state.json'), '{');
  fs.writeFileSync(path.join(fx.env.ZTQ_DATA_DIR, 'state.json.bak'), '{');
  const matchingProcesses = () => execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' })
    .split('\n').filter((line) => line.includes(`${repoRoot}/server.js`)).length;
  const before = matchingProcesses();
  const result = fx.run('start');
  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(fx.env.ZTQ_PID_FILE), false);
  assert.equal(fs.existsSync(fx.env.ZTQ_READY_FILE), false);
  assert.equal(matchingProcesses(), before);
});

test('start.sh kills the detached server when readiness times out', async (t) => {
  const fx = opsFixture(t, { ZTQ_START_WAIT_TENTHS: '2', ZTQ_STARTUP_DELAY_MS: '900' });
  const childPidFile = path.join(fx.root, 'timed-out-child.pid');
  const startupHook = path.join(fx.root, 'record-timed-out-child.js');
  fs.writeFileSync(startupHook, `'use strict';
if (process.env.ZTQ_MIRROR_LOG_STDOUT === '0' && process.argv[1] === ${JSON.stringify(path.join(repoRoot, 'server.js'))}) {
  require('fs').writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));
}
`, { mode: 0o600 });

  const result = fx.run('start', { NODE_OPTIONS: `--require=${startupHook}` });
  assert.equal(result.status, 1);
  const childPid = Number(fs.readFileSync(childPidFile, 'utf8').trim());
  assert.throws(() => process.kill(childPid, 0), (error) => error && error.code === 'ESRCH');
  assert.equal(fs.existsSync(fx.env.ZTQ_PID_FILE), false);
  assert.equal(fs.existsSync(fx.env.ZTQ_READY_FILE), false);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(fs.existsSync(fx.env.ZTQ_PID_FILE), false, 'timed-out server later wrote a PID file');
  assert.equal(fs.existsSync(fx.env.ZTQ_READY_FILE), false, 'timed-out server later became ready');
});

test('start.sh HUP during startup resamples a mixed exec identity and cleans the detached server', async (t) => {
  const fx = opsFixture(t, {
    ZTQ_STARTUP_DELAY_MS: '1200',
    ZTQ_TEST_MIX_STARTING_IDENTITY_ONCE: '1',
  });
  const childPidFile = path.join(fx.root, 'interrupted-child.pid');
  const mixedIdentityMarker = `${fx.env.ZTQ_PID_FILE}.test-mixed-identity`;
  const startupHook = path.join(fx.root, 'record-interrupted-child.js');
  fs.writeFileSync(startupHook, `'use strict';
if (process.env.ZTQ_MIRROR_LOG_STDOUT === '0' && process.argv[1] === ${JSON.stringify(path.join(repoRoot, 'server.js'))}) {
  require('fs').writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));
}
`, { mode: 0o600 });

  const launcher = spawn(startScript, ['start'], {
    cwd: repoRoot,
    env: { ...fx.env, NODE_OPTIONS: `--require=${startupHook}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const launcherResult = waitForExit(launcher);
  for (let i = 0; i < 200 && !fs.existsSync(childPidFile); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(childPidFile), true, 'detached server never spawned');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const childPid = Number(fs.readFileSync(childPidFile, 'utf8').trim());
  assert.doesNotThrow(() => process.kill(childPid, 0));

  launcher.kill('SIGHUP');
  const interrupted = await launcherResult;
  assert.equal(interrupted.status, 129, interrupted.stderr || interrupted.stdout);
  assert.equal(interrupted.signal, null);
  assert.equal(fs.existsSync(mixedIdentityMarker), true, 'mixed gate/Node sample hook did not run');
  assert.doesNotMatch(interrupted.stderr, /身份已变化/);
  assert.throws(() => process.kill(childPid, 0), (error) => error && error.code === 'ESRCH');
  assert.equal(fs.existsSync(`${fx.env.ZTQ_PID_FILE}.lifecycle.lock`), false);

  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(fs.existsSync(fx.env.ZTQ_PID_FILE), false, 'interrupted server later wrote a PID file');
  assert.equal(fs.existsSync(fx.env.ZTQ_READY_FILE), false, 'interrupted server later became ready');
});

test('start.sh preserves an early startup diagnostic while redacting the API token', (t) => {
  const fx = opsFixture(t, { ZTQ_START_WAIT_TENTHS: '5' });
  const token = 'cd'.repeat(32);
  const tokenFile = path.join(fx.env.ZTQ_HOME_DIR, '.zcode-task-queue', 'api-token');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const startupHook = path.join(fx.root, 'failing-startup-hook.js');
  fs.writeFileSync(startupHook, `'use strict';
if (process.env.ZTQ_MIRROR_LOG_STDOUT === '0' && process.argv[1] === ${JSON.stringify(path.join(repoRoot, 'server.js'))}) {
  const token = require('fs').readFileSync(process.env.ZTQ_API_TOKEN_FILE, 'utf8').trim();
  process.stderr.write('synthetic startup failure Authorization: Bearer ' + token + ' ?token=' + token + '\\n');
  process.exit(9);
}
`, { mode: 0o600 });

  const result = fx.run('start', { NODE_OPTIONS: `--require=${startupHook}` });
  const startupLog = `${fx.env.ZTQ_LOG_FILE}.startup`;
  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(startupLog), true);
  assert.equal(fs.statSync(startupLog).mode & 0o777, 0o600);
  const diagnostic = fs.readFileSync(startupLog, 'utf8');
  assert.match(diagnostic, /synthetic startup failure/);
  assert.match(diagnostic, /\[REDACTED\]/);
  assert.doesNotMatch(diagnostic, new RegExp(token));
  assert.doesNotMatch(result.stderr, new RegExp(token));
});

test('start.sh rejects relative state paths before starting anything', (t) => {
  const fx = opsFixture(t);
  const result = fx.run('preflight', { ZTQ_DATA_DIR: 'relative-data' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /绝对路径/);
  assert.equal(fs.existsSync(path.join(repoRoot, 'relative-data')), false);
});

test('concurrent start commands serialize without losing the owned PID file', async (t) => {
  const fx = opsFixture(t, { ZTQ_STARTUP_DELAY_MS: '600' });
  const options = { cwd: repoRoot, env: fx.env, stdio: ['ignore', 'pipe', 'pipe'] };
  const first = spawn(startScript, ['start'], options);
  const firstResultPromise = waitForExit(first);
  const lockFile = `${fx.env.ZTQ_PID_FILE}.lifecycle.lock`;
  for (let i = 0; i < 100 && !fs.existsSync(lockFile); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(lockFile), true, 'first start never acquired the lifecycle lock');
  const second = spawn(startScript, ['start'], options);
  const [firstResult, secondResult] = await Promise.all([firstResultPromise, waitForExit(second)]);
  assert.equal(firstResult.status, 0, firstResult.stderr);
  assert.equal(secondResult.status, 0, secondResult.stderr);
  const identity = JSON.parse(fs.readFileSync(fx.env.ZTQ_PID_FILE, 'utf8'));
  assert.doesNotThrow(() => process.kill(identity.pid, 0));
  assert.equal(fs.existsSync(lockFile), false);
  assert.equal(fx.run('status').status, 0);
});

test('start.sh preflight rejects a timer value that would create a busy loop', (t) => {
  const fx = opsFixture(t);
  const result = fx.run('preflight', { ZTQ_POLL_MS: '0' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ZTQ_POLL_MS/);
});

test('start.sh rejects an explicitly relative Node path and writable-path collisions', (t) => {
  const fx = opsFixture(t);
  const relativeNode = fx.run('preflight', { ZTQ_NODE_BIN: 'node' });
  assert.equal(relativeNode.status, 2);
  assert.match(relativeNode.stderr, /ZTQ_NODE_BIN.*绝对路径/);

  const stateFile = path.join(fx.env.ZTQ_DATA_DIR, 'state.json');
  const collision = fx.run('preflight', { ZTQ_PID_FILE: stateFile });
  assert.equal(collision.status, 2);
  assert.match(collision.stderr, /路径冲突/);
  assert.equal(fs.existsSync(stateFile), false);
});

test('start.sh prints the same trimmed lowercase-hex token accepted by the server', (t) => {
  const fx = opsFixture(t);
  const token = 'ab'.repeat(32);
  const tokenFile = path.join(fx.env.ZTQ_HOME_DIR, '.zcode-task-queue', 'api-token');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, ` \t${token}\n `, { mode: 0o600 });
  const started = fx.run('start');
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, new RegExp(`#token=${token}$`, 'm'));
  const status = fx.run('status');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`#token=${token}$`, 'm'));
});

test('smoke-test overrides contaminated external runtime and token settings', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztq-smoke-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const externalToken = path.join(root, 'must-not-touch', 'api-token');
  const result = spawnSync(smokeScript, ['--check-isolated-environment'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ZTQ_API_TOKEN_FILE: externalToken,
      ZTQ_NODE_BIN: 'relative-node',
      ZTQ_POLL_MS: '0',
      ZTQ_STARTUP_DELAY_MS: '999999',
      ZTQ_SHELL_KILL_WAIT_MS: '999999',
    },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const isolated = JSON.parse(result.stdout);
  assert.notEqual(isolated.ZTQ_API_TOKEN_FILE, externalToken);
  assert.match(isolated.ZTQ_API_TOKEN_FILE, /ztq-smoke\..*\/home\/\.zcode-task-queue\/api-token$/);
  assert.equal(isolated.ZTQ_NODE_BIN, process.execPath);
  assert.equal(isolated.ZTQ_POLL_MS, '2000');
  assert.equal(isolated.ZTQ_STARTUP_DELAY_MS, '0');
  assert.equal(isolated.ZTQ_SHELL_KILL_WAIT_MS, '1000');
  assert.equal(fs.existsSync(externalToken), false);
});
