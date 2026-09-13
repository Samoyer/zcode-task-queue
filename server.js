#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn, spawnSync } = require('child_process');
const { ClientDatabase } = require('./lib/client-db');
const { executionWindowOpen, latestDueGuardEvent } = require('./lib/core');
const { QueueRuntime, RuntimeError } = require('./lib/queue-runtime');
const { StateStore } = require('./lib/state-store');

const PLANS = Object.freeze({
  'builtin:bigmodel-start-plan': { label: '体验套餐', fallbackModels: ['GLM-5.3-Flash'] },
  'builtin:bigmodel-coding-plan': { label: '个人套餐', fallbackModels: ['GLM-5.3', 'GLM-5.3-Flash'] },
});

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const MAX_TIMER_MS = 7 * 24 * 60 * 60 * 1000;
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
});
const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

function assertNodeSupport(version = process.versions.node) {
  const [major, minor, patchVersion] = String(version).split('.').map(Number);
  const supported = major > 22 || major === 22 && (minor > 13 || minor === 13 && patchVersion >= 0);
  if (!supported) throw new Error(`需要 Node 22.13.0 或更高版本，当前为 ${version}`);
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE probe(value INTEGER)');
    db.close();
  } catch (error) {
    throw new Error(`当前 Node 无法直接使用 node:sqlite：${error.message}`);
  }
}

function rotateLog(file, maxBytes = 5 * 1024 * 1024, copies = 3) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < maxBytes) return;
    for (let i = copies; i >= 1; i -= 1) {
      const source = i === 1 ? file : `${file}.${i - 1}`;
      const target = `${file}.${i}`;
      if (!fs.existsSync(source)) continue;
      try { fs.rmSync(target, { force: true }); } catch {}
      fs.renameSync(source, target);
    }
  } catch {}
}

function createLogger(logFile, { mirrorStdout = true } = {}) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  rotateLog(logFile);
  try { fs.closeSync(fs.openSync(logFile, 'a', 0o600)); fs.chmodSync(logFile, 0o600); } catch {}
  return (...values) => {
    const line = `${new Date().toLocaleString('zh-CN', { hour12: false })} ${values.map((value) => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')}\n`;
    try { fs.appendFileSync(logFile, line, { mode: 0o600 }); } catch {}
    if (mirrorStdout) process.stdout.write(line);
  };
}

function redactDiagnostic(value, tokenFile) {
  let output = String(value == null ? '' : value);
  try {
    const stat = fs.statSync(tokenFile);
    if (stat.isFile() && stat.size <= 4096) {
      const token = fs.readFileSync(tokenFile, 'utf8').trim();
      if (token) output = output.split(token).join('[REDACTED]');
    }
  } catch {}
  return output
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .replace(/([?#&]token=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/((?:apiToken|token)\s*[:=]\s*["']?)[A-Za-z0-9_-]{16,}/gi, '$1[REDACTED]')
    .replace(/\b[a-f0-9]{64}\b/g, '[REDACTED]');
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

function assertPortAvailable(port) {
  if (!port || process.platform !== 'darwin' || !fs.existsSync('/usr/sbin/lsof')) return;
  const probe = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  if (probe.status === 0 && String(probe.stdout || '').trim()) {
    throw new Error(`端口 ${port} 已有监听进程；拒绝在加载或迁移队列状态前启动`);
  }
}

function acquireInstanceLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let result;
  try {
    result = spawnSync('/usr/bin/shlock', ['-f', file, '-p', String(process.pid)], { encoding: 'utf8' });
  } catch (error) {
    throw new Error(`无法取得服务单实例锁: ${error.message}`);
  }
  if (!result || result.status !== 0) {
    let owner = '';
    try { owner = fs.readFileSync(file, 'utf8').trim(); } catch {}
    throw new Error(`另一个队列服务正在使用同一数据目录${owner ? ` (PID ${owner})` : ''}`);
  }
  try { fs.chmodSync(file, 0o600); } catch {}
}

function releaseInstanceLock(file) {
  try {
    if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.rmSync(file, { force: true });
  } catch {}
}

function readOrCreateApiToken(file, provided) {
  if (provided !== undefined) {
    const token = String(provided);
    if (!/^[A-Za-z0-9_-]{32,200}$/.test(token)) throw new Error('测试 API 令牌格式无效');
    return token;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch {}
  const readExisting = () => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`API 令牌路径必须是普通文件: ${file}`);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`API 令牌文件不属于当前用户: ${file}`);
    const token = fs.readFileSync(file, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error(`API 令牌文件内容无效: ${file}`);
    try { fs.chmodSync(file, 0o600); } catch {}
    return token;
  };
  if (fs.existsSync(file)) return readExisting();
  const token = crypto.randomBytes(32).toString('hex');
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, `${token}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    // Install the fully written token without replacing a token concurrently
    // created by another queue instance using a different data directory.
    try {
      fs.linkSync(tmp, file);
      fs.chmodSync(file, 0o600);
      return token;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return readExisting();
    }
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

function processStartIdentity(pid = process.pid) {
  try {
    return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 5 * 1024 * 1024) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new RuntimeError('请求体超过 5 MiB', 413, 'BODY_TOO_LARGE'));
        return;
      }
      let data;
      try {
        data = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
      } catch {
        reject(new RuntimeError('请求体不是有效的 UTF-8', 400, 'INVALID_UTF8'));
        return;
      }
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new RuntimeError('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function canonicalPathInfo(file, label) {
  const resolved = path.resolve(file);
  let cursor = resolved;
  const suffix = [];
  for (;;) {
    try {
      const lstat = fs.lstatSync(cursor);
      const realpath = fs.realpathSync.native || fs.realpathSync;
      let canonical;
      try { canonical = realpath(cursor); }
      catch (error) { throw new Error(`${label}无法解析符号链接: ${resolved}: ${error.message}`); }
      const stat = fs.statSync(cursor);
      if (suffix.length && !stat.isDirectory()) {
        throw new Error(`${label}的父路径不是目录: ${cursor}`);
      }
      canonical = path.join(canonical, ...suffix);
      return {
        resolved,
        canonical,
        comparison: process.platform === 'darwin' ? canonical.normalize('NFC').toLowerCase() : canonical,
        stat: suffix.length ? null : stat,
        isSymbolicLink: suffix.length === 0 && lstat.isSymbolicLink(),
      };
    } catch (error) {
      if (!error || !['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`${label}路径无法解析: ${resolved}`);
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function pathIsAncestor(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateWritablePathLayout({
  dataDir,
  pidFile,
  readyFile,
  logFile,
  apiTokenFile,
  instanceLockFile,
  indexDbPath,
  sessionDbPath,
  additionalFiles = [],
}) {
  const resolvedDataDir = path.resolve(dataDir);
  const stateFile = path.join(resolvedDataDir, 'state.json');
  const entries = [
    ['主状态文件', stateFile],
    ['状态备份', `${stateFile}.bak`],
    ['状态初始化标记', path.join(resolvedDataDir, '.state-v2-initialized')],
    ['旧任务文件', path.join(resolvedDataDir, 'tasks.json')],
    ['旧设置文件', path.join(resolvedDataDir, 'settings.json')],
    ['旧任务备份', path.join(resolvedDataDir, 'tasks.json.legacy.bak')],
    ['旧设置备份', path.join(resolvedDataDir, 'settings.json.legacy.bak')],
    ['服务实例锁', instanceLockFile || path.join(resolvedDataDir, 'server.instance.lock')],
    ['PID 文件', pidFile],
    ['ready 文件', readyFile],
    ['服务日志', logFile],
    ['日志轮换 1', `${logFile}.1`],
    ['日志轮换 2', `${logFile}.2`],
    ['日志轮换 3', `${logFile}.3`],
    ['API 令牌', apiTokenFile],
    ['启停生命周期锁', `${pidFile}.lifecycle.lock`],
  ];
  for (const [label, database] of [['客户端索引库', indexDbPath], ['客户端会话库', sessionDbPath]]) {
    if (!database) continue;
    entries.push([label, database]);
    entries.push([`${label} WAL`, `${database}-wal`]);
    entries.push([`${label} SHM`, `${database}-shm`]);
    entries.push([`${label} journal`, `${database}-journal`]);
  }
  for (const entry of additionalFiles) {
    if (!entry || !entry.path) continue;
    entries.push([entry.label || '附加文件', entry.path]);
  }

  const directory = canonicalPathInfo(resolvedDataDir, '数据目录');
  if (directory.stat && !directory.stat.isDirectory()) throw new Error(`数据目录不是目录: ${directory.resolved}`);
  const files = entries.map(([label, file]) => ({ label, ...canonicalPathInfo(file, label) }));
  for (const file of files) {
    if (file.stat && !file.stat.isFile()) throw new Error(`${file.label}必须是普通文件: ${file.resolved}`);
    if (file.comparison === directory.comparison || pathIsAncestor(file.comparison, directory.comparison)) {
      throw new Error(`路径冲突: ${file.label} (${file.resolved}) 不能是数据目录或其祖先`);
    }
  }
  for (let left = 0; left < files.length; left += 1) {
    for (let right = left + 1; right < files.length; right += 1) {
      const a = files[left];
      const b = files[right];
      const sameInode = a.stat && b.stat && a.stat.dev === b.stat.dev && a.stat.ino === b.stat.ino;
      const samePath = a.comparison === b.comparison;
      const nested = pathIsAncestor(a.comparison, b.comparison) || pathIsAncestor(b.comparison, a.comparison);
      if (sameInode || samePath || nested) {
        throw new Error(`路径冲突: ${a.label} (${a.resolved}) 与 ${b.label} (${b.resolved}) 不能安全共存`);
      }
    }
  }
  return { dataDir: directory.canonical, files };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function durationSetting(env, key, optionValue, fallback, { min = 0, max = MAX_TIMER_MS } = {}) {
  const raw = env[key] !== undefined && env[key] !== '' ? env[key]
    : optionValue !== undefined ? optionValue : fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} 必须是 ${min}–${max} 之间的整数毫秒`);
  }
  return value;
}

function runtimeTimings(env = process.env, options = {}) {
  return {
    dispatchWaitMs: durationSetting(env, 'ZTQ_DISPATCH_WAIT_MS', options.dispatchWaitMs, 5 * 60 * 1000),
    dbErrorGraceMs: durationSetting(env, 'ZTQ_DB_ERROR_GRACE_MS', options.dbErrorGraceMs, 60 * 1000),
    resultGraceMs: durationSetting(env, 'ZTQ_RESULT_GRACE_MS', options.resultGraceMs, 5 * 1000),
    pollMs: durationSetting(env, 'ZTQ_POLL_MS', options.pollMs, 2000, { min: 10 }),
    clientRefreshMs: durationSetting(env, 'ZTQ_CLIENT_REFRESH_MS', options.clientRefreshMs, 3000, { min: 10 }),
    guardIntervalMs: durationSetting(env, 'ZTQ_GUARD_INTERVAL_MS', options.guardIntervalMs, 15000, { min: 10 }),
    enableResumeMs: durationSetting(env, 'ZTQ_ENABLE_RESUME_MS', options.enableResumeMs, 60 * 1000),
    shellShutdownGraceMs: durationSetting(env, 'ZTQ_SHELL_SHUTDOWN_GRACE_MS', options.shellShutdownGraceMs, 2000, { max: 10000 }),
    shellKillWaitMs: durationSetting(env, 'ZTQ_SHELL_KILL_WAIT_MS', options.shellKillWaitMs, 1000, { max: 10000 }),
    startupDelayMs: durationSetting(env, 'ZTQ_STARTUP_DELAY_MS', options.startupDelayMs, 0, { max: 60000 }),
  };
}

function parseProcessTable(output) {
  return String(output || '').split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(.*?)\s*$/.exec(line);
    return match ? {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      uid: Number(match[3]),
      command: match[4],
    } : null;
  }).filter((entry) => entry && entry.command);
}

function readProcessTable(execFile = execFileSync, expectedPid = process.pid) {
  let output;
  try {
    output = execFile('/bin/ps', ['-axo', 'pid=,ppid=,uid=,comm='], { encoding: 'utf8' });
  } catch (error) {
    throw new Error(`ps 进程表读取失败: ${error.message}`);
  }
  const lines = String(output || '').split('\n').filter((line) => line.trim());
  const entries = parseProcessTable(output);
  if (!lines.length) throw new Error('ps 进程表为空');
  if (entries.length !== lines.length) throw new Error('ps 进程表包含无法解析的记录');
  const seen = new Set();
  for (const entry of entries) {
    if (entry.pid <= 0 || entry.ppid < 0 || !Number.isSafeInteger(entry.uid) || seen.has(entry.pid)) {
      throw new Error('ps 进程表包含无效或重复的 PID 记录');
    }
    seen.add(entry.pid);
  }
  if (expectedPid != null && !seen.has(Number(expectedPid))) {
    throw new Error(`ps 进程表不完整：缺少调用进程 PID ${expectedPid}`);
  }
  return entries;
}

function processExecutablePath(pid, execFile = execFileSync) {
  try {
    const output = execFile('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], { encoding: 'utf8' });
    const first = output.split('\n').find((line) => line.startsWith('n'));
    return first ? first.slice(1) : '';
  } catch {
    return '';
  }
}

function processExecutableMap(execFile = execFileSync) {
  const result = new Map();
  try {
    const output = execFile('/usr/sbin/lsof', ['-d', 'txt', '-Fpn'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    let pid = null;
    for (const line of output.split('\n')) {
      if (line.startsWith('p') && /^p\d+$/.test(line)) {
        pid = Number(line.slice(1));
      } else if (pid && line.startsWith('n') && !result.has(pid)) {
        result.set(pid, line.slice(1));
      }
    }
  } catch {}
  return result;
}

function processIdentity(pid, execFile = execFileSync) {
  let value;
  try {
    value = String(execFile('/bin/ps', ['-o', 'ppid=,uid=,lstart=', '-p', String(pid)], { encoding: 'utf8' }) || '').trim();
  } catch (error) {
    const stdout = error && error.stdout != null ? String(error.stdout).trim() : '';
    const stderr = error && error.stderr != null ? String(error.stderr).trim() : '';
    // macOS ps exits 1 with no output when the requested PID no longer
    // exists. Every other failure is an unreadable identity, not proof that
    // the process exited.
    if (Number(error && error.status) === 1 && !stdout && !stderr) return null;
    throw new Error(`ps 进程身份读取失败: ${error && error.message || error}`);
  }
  if (!value) throw new Error('ps 进程身份为空');
  const match = /^(\d+)\s+(-?\d+)\s+(.+)$/.exec(value);
  if (!match) throw new Error('ps 进程身份包含无法解析的记录');
  const identity = { ppid: Number(match[1]), uid: Number(match[2]), startedAt: match[3].trim() };
  if (identity.ppid < 0 || !Number.isSafeInteger(identity.uid) || !identity.startedAt) {
    throw new Error('ps 进程身份包含无效字段');
  }
  return identity;
}

function defaultProcessController(execFile = execFileSync, expectedPid = process.pid, overrides = {}) {
  return {
    list() {
      return readProcessTable(execFile, expectedPid);
    },
    executableMap() { return processExecutableMap(execFile); },
    executable(pid) { return processExecutablePath(pid, execFile); },
    identity(pid) { return processIdentity(pid, execFile); },
    signal(pid, signal) { (overrides.signal || process.kill)(pid, signal); },
    wait: overrides.wait || sleep,
  };
}

function zcodeBundleKind(executable) {
  const normalized = String(executable || '').replaceAll('\\', '/');
  if (/\/ZCode\.app\/Contents\/MacOS\/ZCode$/.test(normalized)) return 'root';
  if (/\/ZCode\.app\/Contents\//.test(normalized)) return 'helper';
  return null;
}

function ignorableZcodeBundleProcess(executable) {
  return /\/chrome_crashpad_handler$/.test(String(executable || '').replaceAll('\\', '/'));
}

function possibleZcodeProcess(entry) {
  return /(?:^|\/)(?:ZCode(?: Helper(?: \([^)]*\))?)?|zcode-(?:cli|host-local(?:-\d+)?|node-repl(?:-mcp)?)|chrome_crashpad_handler)$/.test(entry.command)
    || entry.command.includes('/ZCode.app/Contents/')
    || /^\/Applications\/ZC(?:ode)?/.test(entry.command);
}

function discoverOwnedZcodeTree(controller = defaultProcessController(), ownPid = process.pid) {
  // macOS may truncate `ps comm`, so it is only an inventory/parent source.
  // Ownership starts exclusively at an executable path inside the real
  // ZCode.app bundle; arguments and helper basenames never establish a root.
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const table = controller.list().filter((entry) => entry.pid !== ownPid && (uid == null || entry.uid === uid));
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const executableByPid = new Map();
  let executableSnapshot = null;
  try { executableSnapshot = typeof controller.executableMap === 'function' ? controller.executableMap() : null; } catch {}
  for (const entry of table) {
    const snapshotted = executableSnapshot && executableSnapshot.get(entry.pid);
    if (!snapshotted && !possibleZcodeProcess(entry)) continue;
    executableByPid.set(entry.pid, snapshotted || controller.executable(entry.pid));
  }
  const roots = table.filter((entry) => zcodeBundleKind(executableByPid.get(entry.pid)) === 'root');
  const ownedIds = new Set();
  const depthByPid = new Map();
  const visit = (pid, depth) => {
    if (ownedIds.has(pid)) return;
    if (depth > 0 && ignorableZcodeBundleProcess(executableByPid.get(pid))) return;
    ownedIds.add(pid);
    depthByPid.set(pid, depth);
    for (const child of table) if (child.ppid === pid) visit(child.pid, depth + 1);
  };
  for (const root of roots) visit(root.pid, 0);

  const ownedCandidates = [...ownedIds].map((pid) => {
    const entry = byPid.get(pid);
    const identity = controller.identity(pid);
    const parentVerified = Boolean(identity && identity.ppid === entry.ppid);
    return { entry, identity, parentVerified, depth: depthByPid.get(pid), executable: executableByPid.get(pid) || '' };
  });
  // A stable start identity alone is insufficient on macOS because `ps lstart`
  // has only one-second precision. Only processes with both a start identity
  // and a discovery-time executable path are eligible for signals.
  const owned = ownedCandidates.filter((item) => item.parentVerified && item.executable).map((item) => ({
    ...item.entry, ...item.identity, depth: item.depth, executable: item.executable,
  }));
  const unverifiableOwned = ownedCandidates.filter((item) => !item.parentVerified || !item.executable).map((item) => ({
    ...item.entry,
    ...(item.identity || {}),
    depth: item.depth,
    executable: item.executable || '',
  }));
  const ownedSet = new Set(owned.map((entry) => entry.pid));
  const orphanHelpers = table.filter((entry) => !ownedSet.has(entry.pid)
    && zcodeBundleKind(executableByPid.get(entry.pid)) === 'helper'
    && !ignorableZcodeBundleProcess(executableByPid.get(entry.pid)));
  const unverifiableRoots = table.filter((entry) => !executableByPid.get(entry.pid)
    && (path.basename(entry.command) === 'ZCode'
      || /^ZCode Helper(?: \([^)]*\))?$/.test(path.basename(entry.command))
      || /^\/Applications\/ZC(?:ode)?/.test(entry.command)));
  return { roots, owned, orphanHelpers, unverifiableRoots, unverifiableOwned };
}

function processIdentityState(controller, entry) {
  let current;
  try { current = controller.identity(entry.pid); }
  catch { return 'unverifiable'; }
  if (!current) return 'gone';
  if (current.ppid !== entry.ppid || current.uid !== entry.uid || current.startedAt !== entry.startedAt) return 'changed';
  if (!entry.executable) return 'unverifiable';
  let executable;
  try { executable = controller.executable(entry.pid); }
  catch { return 'unverifiable'; }
  if (!executable) return 'unverifiable';
  return executable === entry.executable ? 'match' : 'changed';
}

function ambiguousZcodeProcessCount(discovery) {
  return new Set([
    ...discovery.orphanHelpers,
    ...discovery.unverifiableRoots,
    ...discovery.unverifiableOwned,
  ].map((entry) => entry.pid)).size;
}

async function stopClient({
  dryRun = false,
  testMode = false,
  logger = () => {},
  processController = defaultProcessController(),
} = {}) {
  let discovery;
  try {
    discovery = discoverOwnedZcodeTree(processController);
  } catch (error) {
    const message = `无法读取进程表以证明 ZCode.app 所有权；未发送任何信号：${error.message}`;
    logger(message);
    return {
      stopped: false,
      count: 0,
      ownershipVerified: false,
      requiresAttention: true,
      code: 'ZCODE_PROCESS_INVENTORY_UNAVAILABLE',
      error: message,
    };
  }
  const ambiguousCount = ambiguousZcodeProcessCount(discovery);
  if (dryRun || testMode) {
    return {
      dryRun: true,
      pids: discovery.owned.map((entry) => entry.pid),
      orphaned: ambiguousCount,
      ownershipVerified: ambiguousCount === 0,
    };
  }
  if (!discovery.owned.length) {
    if (!ambiguousCount) return { stopped: true, count: 0, ownershipVerified: true };
    const error = `检测到 ${ambiguousCount} 个无法归属于 ZCode.app 主进程的残留进程；未发送任何信号，请人工确认`;
    logger(error);
    return {
      stopped: false,
      count: 0,
      orphaned: ambiguousCount,
      ownershipVerified: false,
      requiresAttention: true,
      code: 'ZCODE_PROCESS_OWNERSHIP_UNPROVEN',
      error,
    };
  }

  const targets = [...discovery.owned].sort((a, b) => a.depth - b.depth);
  const unresolvedAtSignal = new Set();
  const stateAtSignal = (entry) => {
    const state = processIdentityState(processController, entry);
    // Any non-terminal mismatch during this invocation needs a fresh complete
    // inventory before success can be claimed. This includes a same-second PID
    // replacement, a reparented descendant, and a transient probe failure.
    if (state !== 'match' && state !== 'gone') unresolvedAtSignal.add(entry.pid);
    return state;
  };
  const termSignalled = [];
  for (const entry of targets) {
    if (stateAtSignal(entry) !== 'match') continue;
    try {
      processController.signal(entry.pid, 'SIGTERM');
      termSignalled.push(entry);
    } catch {}
  }
  for (let i = 0; i < 20 && termSignalled.some((entry) => stateAtSignal(entry) === 'match'); i += 1) {
    await processController.wait(1000);
  }
  // Never escalate a process that did not first receive TERM in this invocation.
  // In particular, a temporarily unreadable executable must not become a new
  // SIGKILL target merely because a later lsof call happens to succeed.
  const survivors = termSignalled.filter((entry) => stateAtSignal(entry) === 'match').sort((a, b) => b.depth - a.depth);
  for (const entry of survivors) {
    if (stateAtSignal(entry) !== 'match') continue;
    try { processController.signal(entry.pid, 'SIGKILL'); } catch {}
  }
  if (survivors.length) await processController.wait(1000);

  const remainingOwned = targets.filter((entry) => stateAtSignal(entry) === 'match');
  let after;
  try {
    after = discoverOwnedZcodeTree(processController);
  } catch (inventoryError) {
    const error = `已向验证过的 ZCode.app 进程树发送停止信号，但无法完成退出复核：${inventoryError.message}`;
    logger(error);
    return {
      stopped: false,
      count: targets.length,
      ownershipVerified: false,
      requiresAttention: true,
      code: 'ZCODE_PROCESS_INVENTORY_UNAVAILABLE',
      error,
    };
  }
  const remainingAmbiguous = ambiguousZcodeProcessCount(after);
  const remainingVerified = after.owned.length;
  const unresolvedCount = new Set([
    ...discovery.orphanHelpers,
    ...discovery.unverifiableRoots,
    ...discovery.unverifiableOwned,
  ].map((entry) => entry.pid).concat([...unresolvedAtSignal])).size;
  const stopped = remainingOwned.length === 0 && remainingVerified === 0
    && remainingAmbiguous === 0 && unresolvedCount === 0;
  const error = stopped ? null : remainingOwned.length || remainingVerified
    ? `${Math.max(remainingOwned.length, remainingVerified)} 个已验证的 ZCode.app 进程未能停止`
    : `检测到 ${Math.max(remainingAmbiguous, unresolvedCount)} 个无法证明归属或无法复核可执行文件的 ZCode.app 进程；未向它们发送信号`;
  logger(stopped ? `已停止 ZCode.app 及其已验证进程树 (${targets.length} 个进程)` : error);
  return {
    stopped,
    count: targets.length,
    orphaned: Math.max(remainingAmbiguous, unresolvedCount),
    ownershipVerified: stopped,
    requiresAttention: !stopped,
    code: stopped ? undefined : 'ZCODE_PROCESS_OWNERSHIP_UNPROVEN',
    error: error || undefined,
  };
}

function enableClient({ testMode = false, logger = () => {} } = {}) {
  if (testMode) return { ok: true, dryRun: true };
  try {
    execFileSync('/usr/bin/open', ['-a', 'ZCode'], { timeout: 10000, stdio: 'ignore' });
    logger('已拉起 ZCode 客户端');
    return { ok: true };
  } catch (error) {
    const message = String(error.message || error).slice(0, 300);
    logger(`拉起 ZCode 客户端失败: ${message}`);
    return { ok: false, error: message };
  }
}

function createService(options = {}) {
  assertNodeSupport();
  const env = options.env || process.env;
  const root = path.resolve(options.root || __dirname);
  const publicDir = path.join(root, 'public');
  const dataDir = path.resolve(options.dataDir || env.ZTQ_DATA_DIR || path.join(root, 'data'));
  const host = options.host || env.ZTQ_HOST || '127.0.0.1';
  const requestedPort = Number(options.port !== undefined ? options.port : env.ZTQ_PORT || 8787);
  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`拒绝监听非本机地址 ${host}；只允许 127.0.0.1、::1 或 localhost`);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('ZTQ_PORT 必须是 0–65535 的整数');
  const pidFile = path.resolve(options.pidFile || env.ZTQ_PID_FILE || path.join(dataDir, 'server.pid.json'));
  const readyFile = path.resolve(options.readyFile || env.ZTQ_READY_FILE || path.join(dataDir, 'ready.json'));
  const logFile = path.resolve(options.logFile || env.ZTQ_LOG_FILE || path.join(dataDir, 'server.log'));
  const testMode = options.testMode !== undefined ? options.testMode : env.ZTQ_TEST_MODE === '1';
  const stopClientImpl = options.stopClient || stopClient;
  const enableClientImpl = options.enableClient || enableClient;
  const timings = runtimeTimings(env, options);
  assertPortAvailable(requestedPort);
  const now = options.now || (() => Date.now());
  const instanceId = crypto.randomUUID();
  const startToken = crypto.randomBytes(16).toString('hex');
  const startedAt = now();
  const processStartedAt = processStartIdentity();
  const homeDir = path.resolve(options.homeDir || env.ZTQ_HOME_DIR || env.HOME || os.homedir());
  const instanceLockFile = path.resolve(options.instanceLockFile || path.join(dataDir, 'server.instance.lock'));
  const apiTokenFile = path.resolve(options.apiTokenFile || env.ZTQ_API_TOKEN_FILE || path.join(homeDir, '.zcode-task-queue', 'api-token'));
  const client = options.client || new ClientDatabase({
    root,
    homeDir,
    indexDbPath: options.indexDbPath !== undefined ? options.indexDbPath : env.ZTQ_CLIENT_INDEX_DB,
    sessionDbPath: options.sessionDbPath !== undefined ? options.sessionDbPath : env.ZTQ_CLIENT_SESSION_DB,
    clientConfigPath: options.clientConfigPath !== undefined ? options.clientConfigPath : env.ZTQ_CLIENT_CONFIG,
    logger: () => {},
    now,
  });
  try {
    validateWritablePathLayout({
      dataDir, pidFile, readyFile, logFile, apiTokenFile, instanceLockFile,
      indexDbPath: client.paths && client.paths.indexDb,
      sessionDbPath: client.paths && client.paths.sessionDb,
    });
  } catch (error) {
    if (!options.client) client.close();
    throw error;
  }
  const logger = options.logger || createLogger(logFile, { mirrorStdout: env.ZTQ_MIRROR_LOG_STDOUT !== '0' });
  if (!options.client) client.logger = logger;
  acquireInstanceLock(instanceLockFile);
  let instanceLockHeld = true;
  let apiToken;
  try { apiToken = readOrCreateApiToken(apiTokenFile, options.apiToken); }
  catch (error) {
    if (!options.client) client.close();
    releaseInstanceLock(instanceLockFile); instanceLockHeld = false; throw error;
  }

  let store;
  let runtime;
  let broadcast = () => {};
  try {
    store = options.store || new StateStore({ dataDir, logger });
    runtime = options.runtime || new QueueRuntime({
      root, store, client, plans: PLANS, logger, now,
      onChange: () => broadcast(),
      focusWorkspace: (workspace) => {
        if (testMode) return;
        const child = spawn('/usr/bin/open', [`zcode://workspace/open?path=${encodeURIComponent(workspace)}`], { detached: true, stdio: 'ignore' });
        child.unref();
      },
      dispatchWaitMs: timings.dispatchWaitMs,
      dbErrorGraceMs: timings.dbErrorGraceMs,
      resultGraceMs: timings.resultGraceMs,
      pollMs: timings.pollMs,
      shellShutdownGraceMs: timings.shellShutdownGraceMs,
      shellKillWaitMs: timings.shellKillWaitMs,
    });
  } catch (error) {
    if (client) client.close();
    releaseInstanceLock(instanceLockFile); instanceLockHeld = false;
    throw error;
  }
  let planModels = client.readPlanModels(PLANS);
  let clientState = client.readClientTasks(runtime.settings.hiddenSessions);
  let server = null;
  let actualPort = null;
  let refreshTimer = null;
  let guardTimer = null;
  let heartbeatTimer = null;
  let enableResumeTimer = null;
  let guardRunning = false;
  let shuttingDown = false;
  const sseClients = new Set();
  let broadcastTimer = null;
  let eventRevision = runtime.revision;

  function dropSsePeer(peer, { end = true } = {}) {
    if (!peer || peer.closed) return;
    peer.closed = true;
    peer.pendingState = null;
    sseClients.delete(peer);
    if (end) try { peer.res.end(); } catch {}
  }

  function writeSsePeer(peer, payload) {
    if (peer.closed) return;
    if (peer.res.writableLength > 1024 * 1024) return dropSsePeer(peer);
    try {
      if (!peer.res.write(payload)) {
        peer.blocked = true;
        peer.res.once('drain', () => {
          if (peer.closed) return;
          peer.blocked = false;
          flushSsePeer(peer);
        });
      }
    } catch { dropSsePeer(peer); }
  }

  function flushSsePeer(peer) {
    if (peer.closed || peer.blocked || !peer.pendingState) return;
    const payload = peer.pendingState;
    peer.pendingState = null;
    writeSsePeer(peer, payload);
  }

  function sendSseState(peer, payload) {
    if (peer.closed) return;
    peer.pendingState = payload;
    if (peer.res.writableLength > 1024 * 1024) return dropSsePeer(peer);
    flushSsePeer(peer);
  }

  function sendSseHeartbeat(peer) {
    if (peer.closed || peer.blocked || peer.pendingState) return;
    writeSsePeer(peer, ': heartbeat\n\n');
  }

  function securityHeaders(extra = {}) { return { ...SECURITY_HEADERS, ...extra }; }
  function sendJson(res, code, value, extra = {}) {
    res.writeHead(code, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }));
    res.end(JSON.stringify(value));
  }
  function mergedState(summary) {
    eventRevision = Math.max(eventRevision, runtime.revision);
    const health = client.health();
    const state = runtime.publicState({
      summary,
      clientState: {
        plans: PLANS,
        planModels,
        clientTasks: clientState.visible,
        hiddenClientTasks: clientState.hidden,
        clientTasksError: clientState.error,
        clientPathsFound: health.indexDbFound && health.sessionDbFound,
      },
    });
    state.instanceId = instanceId;
    state.revision = eventRevision;
    return state;
  }

  broadcast = () => {
    if (broadcastTimer) clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(() => {
      try {
        eventRevision = Math.max(eventRevision + 1, runtime.revision);
        const payload = `event: state\ndata: ${JSON.stringify(mergedState(true))}\n\n`;
        for (const peer of sseClients) sendSseState(peer, payload);
      } catch (error) {
        logger(`广播状态失败: ${error.stack || error.message}`);
      }
    }, 100);
  };

  function refreshClientState() {
    const before = JSON.stringify(clientState);
    const modelsBefore = JSON.stringify(planModels);
    clientState = client.readClientTasks(runtime.settings.hiddenSessions);
    planModels = client.readPlanModels(PLANS);
    if (JSON.stringify(clientState) !== before || JSON.stringify(planModels) !== modelsBefore) broadcast();
  }

  async function scheduledStop() {
    // The queue guard must receive a verified result. A detached legacy script
    // can exit without stopping ZCode (for example outside its own date/time
    // window), so it is intentionally not treated as completion evidence.
    return stopClientImpl({ testMode, logger });
  }

  function verifiedStopSucceeded(result) {
    return Boolean(result && result.ownershipVerified === true && (
      result.stopped === true || (testMode && result.dryRun === true)
    ));
  }

  function stopFailureMessage(result, fallback = '仍检测到无法确认归属的 ZCode.app 进程') {
    return result && result.error || fallback;
  }

  function resolveStopOwnershipPending() {
    const pending = runtime.guardStopOwnershipPending();
    if (!pending) return;
    runtime.clearGuardStopOwnershipPending({ commit: false });
    runtime.syncAttentionPause();
    if (pending.source === 'scheduled' && pending.eventTime != null
      && Number.isFinite(Number(pending.eventTime))) {
      runtime.recordGuardEvent({ type: 'stop', time: Number(pending.eventTime) });
    } else {
      runtime.queue.guardState.lastError = null;
      runtime.commit();
    }
  }

  function finishScheduledEnable() {
    if (!runtime.storage.healthy) {
      logger('自动恢复队列待处理，但状态存储当前不可写');
      return;
    }
    const guardState = runtime.queue.guardState;
    if (runtime.hasGuardStopOwnershipPending()) {
      const hadPendingResume = Number(guardState.enableResumeAt || 0) > 0;
      guardState.enableResumeAt = 0;
      runtime.enforceGuardStopOwnershipPause();
      if (hadPendingResume) runtime.commit();
      return;
    }
    const shouldResume = runtime.queue.pausedBySystem
      && runtime.queue.pauseReason && runtime.queue.pauseReason.kind === 'auto-stop';
    const hadPendingResume = Number(guardState.enableResumeAt || 0) > 0;
    const clearedAutoStopBase = runtime.clearGuardStopBasePause('auto-stop', { commit: false });
    guardState.enableResumeAt = 0;
    if (shouldResume) {
      runtime.queue.paused = false;
      runtime.queue.pausedBySystem = false;
      runtime.queue.pauseReason = null;
    }
    if (shouldResume || hadPendingResume || clearedAutoStopBase) runtime.commit();
    if (shouldResume) runtime.kick();
  }

  function scheduleEnableResume(resumeAt) {
    if (enableResumeTimer) clearTimeout(enableResumeTimer);
    const delay = Math.max(0, Number(resumeAt) - now());
    enableResumeTimer = setTimeout(() => {
      enableResumeTimer = null;
      try { finishScheduledEnable(); }
      catch (error) { logger(`自动恢复队列失败: ${error.stack || error.message}`); }
    }, Math.min(delay, MAX_TIMER_MS));
  }

  function restoreEnableResume() {
    if (runtime.hasGuardStopOwnershipPending()) return;
    const resumeAt = Number(runtime.queue.guardState.enableResumeAt || 0);
    if (resumeAt > 0) scheduleEnableResume(resumeAt);
  }

  async function retryStopOwnershipPending() {
    const pending = runtime.guardStopOwnershipPending();
    if (!pending) return false;
    const event = { type: 'stop', time: Number(pending.eventTime) || now() };
    let result;
    let failure = null;
    try {
      result = await scheduledStop();
      if (!verifiedStopSucceeded(result)) failure = stopFailureMessage(result);
    } catch (error) {
      failure = error.message || String(error);
    }
    if (shuttingDown) return true;
    if (failure) {
      const message = `自动停止 ZCode 仍需人工确认：${failure}`;
      runtime.setGuardStopOwnershipPending({ message }, { commit: false });
      runtime.recordGuardFailure(event, message);
      return true;
    }
    resolveStopOwnershipPending();
    logger('已确认 ZCode.app 及其残留进程退出，解除自动停止人工确认状态');
    return true;
  }

  async function guardTick() {
    if (shuttingDown || !runtime.storage.healthy || guardRunning) return;
    guardRunning = true;
    try {
      if (await retryStopOwnershipPending()) return;
      const event = latestDueGuardEvent(runtime.settings, runtime.queue.guardState, new Date(now()));
      if (event) {
        let failure = null;
        if (event.type === 'stop') {
          if (enableResumeTimer) clearTimeout(enableResumeTimer);
          enableResumeTimer = null;
          runtime.queue.guardState.enableResumeAt = 0;
          const guardPauseApplied = runtime.setSystemPause('auto-stop', '每日自动停止客户端');
          const basePause = runtime.guardStopBasePause() || {
            kind: 'auto-stop',
            message: '每日自动停止客户端',
            since: now(),
          };
          runtime.setGuardStopOwnershipPending({
            source: 'scheduled',
            eventTime: event.time,
            message: '正在验证 ZCode.app 及其进程树已完全停止',
            guardPauseApplied,
            basePause,
          });
          try {
            const result = await scheduledStop();
            if (!verifiedStopSucceeded(result)) failure = stopFailureMessage(result, '未能验证 ZCode.app 已完全停止');
          } catch (error) {
            failure = error.message || String(error);
          }
          if (shuttingDown) return;
          if (failure) {
            const message = `自动停止 ZCode 失败：${failure}`;
            logger(message);
            runtime.setGuardStopOwnershipPending({ message }, { commit: false });
            runtime.recordGuardFailure(event, message);
          } else {
            resolveStopOwnershipPending();
          }
          return;
        } else {
          try {
            const result = enableClientImpl({ testMode, logger });
            if (result && result.ok) {
              runtime.queue.guardState.enableResumeAt = now() + timings.enableResumeMs;
              scheduleEnableResume(runtime.queue.guardState.enableResumeAt);
            } else {
              failure = result && result.error || '未能打开 ZCode';
            }
          } catch (error) {
            failure = error.message || String(error);
          }
        }
        if (failure) {
          const message = `${event.type === 'stop' ? '自动停止' : '自动启用'} ZCode 失败：${failure}`;
          logger(message);
          runtime.recordGuardFailure(event, message);
        } else {
          runtime.recordGuardEvent(event);
        }
      }
      const windowOpen = executionWindowOpen(runtime.settings, new Date(now()));
      if (windowOpen !== runtime.queue.guardState.lastWindowOpen) {
        runtime.queue.guardState.lastWindowOpen = windowOpen;
        runtime.commit();
      }
      if (windowOpen) runtime.kick();
    } finally {
      guardRunning = false;
    }
  }

  function idempotencyKey(req) {
    const value = req.headers['idempotency-key'];
    if (value == null) return null;
    const key = String(value).trim();
    if (!key || key.length > 200) throw new RuntimeError('Idempotency-Key 必须是 1–200 个字符');
    return key;
  }
  function idempotencyContext(req) {
    const key = idempotencyKey(req);
    const header = req.headers['idempotency-replay-only'];
    if (header != null && header !== '1') {
      throw new RuntimeError('Idempotency-Replay-Only 只接受值 1');
    }
    const replayOnly = header === '1';
    if (replayOnly && !key) {
      throw new RuntimeError('安全重放必须携带 Idempotency-Key', 400, 'IDEMPOTENCY_KEY_REQUIRED');
    }
    return { key, replayOnly };
  }
  function allowedOrigin(origin) {
    if (!origin) return true;
    try {
      const url = new URL(origin);
      const hostname = url.hostname === '[::1]' ? '::1' : url.hostname;
      return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(hostname);
    } catch { return false; }
  }

  function allowedRequestHost(value) {
    if (!value || !actualPort) return false;
    try {
      const parsed = new URL(`http://${value}`);
      const hostname = parsed.hostname === '[::1]' ? '::1' : parsed.hostname.toLowerCase();
      const port = parsed.port ? Number(parsed.port) : 80;
      return LOOPBACK_HOSTS.has(hostname) && port === actualPort;
    } catch { return false; }
  }

  function tokenMatches(candidate) {
    if (typeof candidate !== 'string') return false;
    const left = Buffer.from(candidate);
    const right = Buffer.from(apiToken);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }

  function authorizedRequest(req, pathname, url) {
    const header = String(req.headers.authorization || '');
    if (header.startsWith('Bearer ') && tokenMatches(header.slice(7))) return true;
    return pathname === '/api/events' && tokenMatches(url.searchParams.get('token'));
  }

  async function handleApi(req, res, pathname, url) {
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, runtime.storage.healthy ? 200 : 503, {
        ok: runtime.storage.healthy, instanceId, startToken, processStartedAt, pid: process.pid,
        uid: typeof process.getuid === 'function' ? process.getuid() : null,
        root, host, port: actualPort,
        node: { executable: process.execPath, version: process.versions.node },
        storage: runtime.storage, client: client.health(), revision: runtime.revision, startedAt,
        authRequired: true,
      });
    }
    if (!authorizedRequest(req, pathname, url)) {
      return sendJson(res, 401, { error: '缺少或无效的本机 API 令牌', code: 'AUTH_REQUIRED' }, { 'WWW-Authenticate': 'Bearer' });
    }
    if (req.method === 'POST') {
      if (req.headers['x-ztq-local'] !== '1') return sendJson(res, 403, { error: '本机 API 防护：POST 请求缺少 X-ZTQ-Local 头' });
      if (!allowedOrigin(req.headers.origin)) return sendJson(res, 403, { error: '本机 API 防护：拒绝跨站来源' });
      if (!runtime.storage.healthy) return sendJson(res, 503, { error: runtime.storage.error || '存储不可用', code: 'STORAGE_UNAVAILABLE' });
    }
    if (pathname === '/api/state' && req.method === 'GET') return sendJson(res, 200, mergedState(url.searchParams.get('view') === 'summary'));
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, securityHeaders({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' }));
      const peer = { res, blocked: false, closed: false, pendingState: null };
      sseClients.add(peer);
      sendSseState(peer, `event: state\ndata: ${JSON.stringify(mergedState(true))}\n\n`);
      req.on('close', () => dropSsePeer(peer, { end: false }));
      return;
    }
    if (pathname === '/api/tasks' && req.method === 'GET') return sendJson(res, 200, runtime.listTasks({ status: url.searchParams.get('status') || 'history', cursor: url.searchParams.get('cursor'), limit: url.searchParams.get('limit') }));
    if (pathname === '/api/tasks/log' && req.method === 'GET') {
      const detail = runtime.taskDetail(url.searchParams.get('id'));
      return sendJson(res, 200, { id: detail.id, logs: detail.logs || [] });
    }
    const detailMatch = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
    if (detailMatch && req.method === 'GET') return sendJson(res, 200, runtime.taskDetail(detailMatch[1]));
    if (pathname === '/api/tasks' && req.method === 'POST') {
      const body = await readBody(req);
      const context = idempotencyContext(req);
      return sendJson(res, 200, runtime.createTasks(body, context.key, context));
    }
    const actionMatch = /^\/api\/tasks\/([^/]+)\/action$/.exec(pathname);
    if (actionMatch && req.method === 'POST') {
      const body = await readBody(req);
      const context = idempotencyContext(req);
      return sendJson(res, 200, runtime.taskAction(actionMatch[1], body.action, context.key, context));
    }
    if (pathname === '/api/queue' && req.method === 'POST') {
      const body = await readBody(req);
      const context = idempotencyContext(req);
      return sendJson(res, 200, runtime.queueAction(body, context.key, context));
    }
    if (pathname === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const context = idempotencyContext(req);
      return sendJson(res, 200, runtime.updateConfig(body, context.key, context));
    }
    if (pathname === '/api/client-tasks/continue' && req.method === 'POST') {
      const body = await readBody(req);
      const context = idempotencyContext(req);
      const info = [...clientState.visible, ...clientState.hidden].find((task) => task.sessionId === body.sessionId);
      if (!info && !context.replayOnly) throw new RuntimeError('会话不在最近列表里', 404, 'NOT_FOUND');
      return sendJson(res, 200, runtime.createContinuation(info || { sessionId: body.sessionId }, context.key, context));
    }
    if (pathname === '/api/client-tasks/import' && req.method === 'POST') {
      const body = await readBody(req);
      const context = idempotencyContext(req);
      const info = [...clientState.visible, ...clientState.hidden].find((task) => task.sessionId === body.sessionId);
      if (!info && !context.replayOnly) throw new RuntimeError('会话不在最近列表里', 404, 'NOT_FOUND');
      return sendJson(res, 200, runtime.importSession(
        info || { sessionId: body.sessionId },
        context.replayOnly ? null : client.sessionPrompt(body.sessionId),
        context.key,
        context,
      ));
    }
    if (pathname === '/api/client-tasks/hide' && req.method === 'POST') {
      const body = await readBody(req);
      const context = idempotencyContext(req);
      const result = runtime.hideSession(body.sessionId, context.key, context); refreshClientState(); return sendJson(res, 200, result);
    }
    if (pathname === '/api/client-tasks/unhide' && req.method === 'POST') {
      const body = await readBody(req);
      const context = idempotencyContext(req);
      const result = runtime.unhideSession(body.sessionId, context.key, context); refreshClientState(); return sendJson(res, 200, result);
    }
    if (pathname === '/api/guard' && req.method === 'POST') {
      if (req.headers['idempotency-replay-only'] != null) {
        throw new RuntimeError('客户端停止/启用操作不支持安全重放', 400, 'NON_REPLAYABLE_OPERATION');
      }
      const body = await readBody(req);
      if (body.action === 'stopClient') {
        if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') throw new RuntimeError('dryRun 必须是布尔值');
        const key = idempotencyKey(req);
        if (body.dryRun) {
          const result = await stopClientImpl({ dryRun: true, testMode, logger });
          return sendJson(res, 200, { ...result, queuePaused: runtime.queue.paused });
        }
        runtime.queueAction({ action: 'pause' }, key);
        const pending = runtime.setGuardStopOwnershipPending({
          source: 'manual-api',
          eventTime: now(),
          message: '正在验证 ZCode.app 及其进程树已完全停止',
          guardPauseApplied: false,
          basePause: {
            kind: 'manual',
            message: '用户手动暂停',
            since: now(),
          },
        });
        let result;
        let failure = null;
        try {
          result = await stopClientImpl({ dryRun: false, testMode, logger });
          if (!verifiedStopSucceeded(result)) failure = stopFailureMessage(result, '未能验证 ZCode.app 已完全停止');
        } catch (error) {
          failure = error.message || String(error);
        }
        if (failure) {
          const message = `手动停止 ZCode 失败：${failure}`;
          runtime.setGuardStopOwnershipPending({ message }, { commit: false });
          runtime.recordGuardFailure({ type: 'stop', time: Number(pending.eventTime) || now() }, message);
          throw new RuntimeError('ZCode 客户端停止状态无法验证，队列已安全锁定', 500, 'CLIENT_STOP_UNVERIFIED');
        }
        resolveStopOwnershipPending();
        return sendJson(res, 200, { ...result, queuePaused: runtime.queue.paused });
      }
      if (body.action === 'enableClient') {
        if (runtime.hasGuardStopOwnershipPending()) {
          throw new RuntimeError('ZCode.app 停止状态尚未验证，不能重新打开客户端', 409, 'GUARD_STOP_UNVERIFIED');
        }
        const result = enableClientImpl({ testMode, logger });
        if (!result.ok) throw new RuntimeError(result.error || '无法打开 ZCode 客户端', 502, 'CLIENT_ENABLE_FAILED');
        return sendJson(res, 200, result);
      }
      throw new RuntimeError('未知操作');
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  function handleStatic(req, res, pathname) {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const full = path.resolve(publicDir, relative);
    if (full !== publicDir && !full.startsWith(`${publicDir}${path.sep}`)) { res.writeHead(403, securityHeaders()); res.end(); return; }
    try {
      const data = fs.readFileSync(full);
      res.writeHead(200, securityHeaders({
        'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-cache',
      }));
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
      res.end('404');
    }
  }

  async function requestHandler(req, res) {
    try {
      if (!allowedRequestHost(req.headers.host)) return sendJson(res, 421, { error: '拒绝非本机 Host', code: 'INVALID_HOST' });
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { return sendJson(res, 400, { error: 'URL 无效' }); }
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { return sendJson(res, 400, { error: 'URL 编码无效' }); }
      if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, url);
      if (!['GET', 'HEAD'].includes(req.method)) return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
      return handleStatic(req, res, pathname);
    } catch (error) {
      const code = error instanceof RuntimeError ? error.statusCode : 500;
      if (code >= 500) logger(`请求失败: ${error.stack || error.message}`);
      if (!res.headersSent) sendJson(res, code, { error: error.message || '内部错误', code: error.code || 'INTERNAL_ERROR' });
      else try { res.end(); } catch {}
    }
  }

  function readyPayload() {
    return {
      pid: process.pid, uid: typeof process.getuid === 'function' ? process.getuid() : null,
      root, node: process.execPath, nodeVersion: process.versions.node, host, port: actualPort,
      instanceId, startToken, startedAt, processStartedAt,
    };
  }
  async function start() {
    if (server) return readyPayload();
    let runtimeStarted = false;
    try {
      if (timings.startupDelayMs) await sleep(timings.startupDelayMs);
      server = http.createServer(requestHandler);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(requestedPort, host, resolve); });
      actualPort = server.address().port;
      writeJsonAtomic(pidFile, readyPayload());
      writeJsonAtomic(readyFile, readyPayload());
      runtimeStarted = true;
      runtime.start();
      restoreEnableResume();
      refreshTimer = setInterval(() => {
        try { refreshClientState(); }
        catch (error) { logger(`刷新客户端状态失败: ${error.stack || error.message}`); }
      }, timings.clientRefreshMs);
      guardTimer = setInterval(() => guardTick().catch((error) => logger(`守护检查失败: ${error.message}`)), timings.guardIntervalMs);
      heartbeatTimer = setInterval(() => { for (const peer of sseClients) sendSseHeartbeat(peer); }, 20000);
      if (!testMode) setTimeout(() => guardTick().catch((error) => logger(`初始守护检查失败: ${error.message}`)), 0);
      logger(`ZCode 任务队列已启动: http://${host === '::1' ? '[::1]' : host}:${actualPort}`);
      logger(`数据目录: ${dataDir}`);
      logger(`客户端任务索引库: ${client.paths.indexDb || '未找到'}`);
      logger(`客户端会话库: ${client.paths.sessionDb || '未找到'}`);
      logger(`任务数: ${runtime.tasks.length}，等待中: ${runtime.pendingTasks().length}，队列状态: ${runtime.queue.paused ? '暂停' : '运行'}`);
      return readyPayload();
    } catch (error) {
      for (const timer of [refreshTimer, guardTimer, heartbeatTimer, broadcastTimer, enableResumeTimer]) if (timer) clearTimeout(timer);
      refreshTimer = guardTimer = heartbeatTimer = broadcastTimer = enableResumeTimer = null;
      for (const peer of [...sseClients]) dropSsePeer(peer);
      sseClients.clear();
      if (runtimeStarted) try { await runtime.shutdown(); } catch {}
      client.close();
      if (server && server.listening) {
        try { await new Promise((resolve) => server.close(resolve)); } catch {}
      }
      server = null;
      actualPort = null;
      removeOwnedRuntimeFile(pidFile);
      removeOwnedRuntimeFile(readyFile);
      throw error;
    }
  }
  function removeOwnedRuntimeFile(file) {
    try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); if (value.pid === process.pid && value.startToken === startToken) fs.rmSync(file, { force: true }); } catch {}
  }
  async function stop() {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      for (const timer of [refreshTimer, guardTimer, heartbeatTimer, broadcastTimer, enableResumeTimer]) if (timer) clearTimeout(timer);
      for (const peer of [...sseClients]) dropSsePeer(peer);
      sseClients.clear();
      try { await runtime.shutdown(); } catch (error) { logger(`退出前保存失败: ${error.message}`); }
      client.close();
      if (server) await new Promise((resolve) => server.close(resolve));
      server = null;
      actualPort = null;
      removeOwnedRuntimeFile(pidFile);
      removeOwnedRuntimeFile(readyFile);
      logger('ZCode 任务队列已停止');
    } finally {
      if (instanceLockHeld) { releaseInstanceLock(instanceLockFile); instanceLockHeld = false; }
    }
  }
  return {
    start, stop, requestHandler, refreshClientState, guardTick,
    get server() { return server; }, get runtime() { return runtime; }, get client() { return client; }, get port() { return actualPort; },
    paths: { root, dataDir, pidFile, readyFile, logFile, instanceLockFile, apiTokenFile },
  };
}

async function main() {
  const service = createService();
  await service.start();
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    try { await service.stop(); process.exitCode = 0; }
    catch (error) { console.error(`${signal} 退出失败:`, error); process.exitCode = 1; }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) main().catch((error) => {
  const homeDir = path.resolve(process.env.ZTQ_HOME_DIR || process.env.HOME || os.homedir());
  const tokenFile = path.resolve(process.env.ZTQ_API_TOKEN_FILE || path.join(homeDir, '.zcode-task-queue', 'api-token'));
  console.error(redactDiagnostic(error.stack || error.message, tokenFile));
  process.exitCode = 1;
});

module.exports = {
  PLANS,
  SECURITY_HEADERS,
  assertNodeSupport,
  createService,
  defaultProcessController,
  discoverOwnedZcodeTree,
  parseProcessTable,
  processStartIdentity,
  readProcessTable,
  redactDiagnostic,
  runtimeTimings,
  stopClient,
  validateWritablePathLayout,
};
