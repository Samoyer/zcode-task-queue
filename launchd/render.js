#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runtimeTimings, validateWritablePathLayout } = require('../server');

function fail(message) {
  process.stderr.write(`错误：${message}\n`);
  process.exitCode = 2;
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function absolute(value, name) {
  if (!path.isAbsolute(value)) throw new Error(`${name} 必须是绝对路径`);
  return path.resolve(value);
}

function preparePrivateLog(file, name) {
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = fs.statSync(parent);
  if (!parentStat.isDirectory()) throw new Error(`${name} 父路径不是目录: ${parent}`);
  if (fs.existsSync(file)) {
    const existing = fs.lstatSync(file);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error(`${name} 必须是非符号链接普通文件: ${file}`);
    if (typeof process.getuid === 'function' && existing.uid !== process.getuid()) throw new Error(`${name} 不属于当前用户: ${file}`);
  }
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | noFollow, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${name} 必须是普通文件: ${file}`);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${name} 不属于当前用户: ${file}`);
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
}

function render({ output, env = process.env } = {}) {
  const root = path.resolve(__dirname, '..');
  const target = absolute(output, '输出路径');
  const templateFile = path.join(__dirname, 'com.zcode-task-queue.plist');
  if (target === templateFile) throw new Error('输出路径不能覆盖 launchd 模板');
  const node = absolute(env.ZTQ_NODE_BIN || process.execPath, 'ZTQ_NODE_BIN');
  const home = absolute(env.HOME || os.homedir(), 'HOME');
  const homeDir = absolute(env.ZTQ_HOME_DIR || home, 'ZTQ_HOME_DIR');
  const dataDir = absolute(env.ZTQ_DATA_DIR || path.join(root, 'data'), 'ZTQ_DATA_DIR');
  const pidFile = absolute(env.ZTQ_PID_FILE || path.join(dataDir, 'server.pid.json'), 'ZTQ_PID_FILE');
  const readyFile = absolute(env.ZTQ_READY_FILE || path.join(dataDir, 'ready.json'), 'ZTQ_READY_FILE');
  const logFile = absolute(env.ZTQ_LOG_FILE || path.join(dataDir, 'server.log'), 'ZTQ_LOG_FILE');
  const stdoutFile = absolute(env.ZTQ_LAUNCHD_STDOUT || '/dev/null', 'ZTQ_LAUNCHD_STDOUT');
  const stderrFile = absolute(env.ZTQ_LAUNCHD_STDERR || path.join(dataDir, 'launchd.stderr.log'), 'ZTQ_LAUNCHD_STDERR');
  const apiTokenFile = absolute(env.ZTQ_API_TOKEN_FILE || path.join(homeDir, '.zcode-task-queue', 'api-token'), 'ZTQ_API_TOKEN_FILE');
  const host = env.ZTQ_HOST || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('ZTQ_HOST 只允许本机回环地址');
  const port = Number(env.ZTQ_PORT || 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('ZTQ_PORT 必须是 0–65535 的整数');
  const label = env.ZTQ_LAUNCHD_LABEL || 'com.zcode-task-queue';
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error('ZTQ_LAUNCHD_LABEL 只能包含字母、数字、点、下划线和连字符');
  if (!fs.existsSync(node)) throw new Error(`Node 不存在: ${node}`);
  if (!fs.existsSync(path.join(root, 'server.js'))) throw new Error(`server.js 不存在: ${root}`);
  const probe = spawnSync(node, ['-e', `
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (!(major > 22 || major === 22 && minor >= 13)) process.exit(2);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE probe(x)'); db.close();
  `], { encoding: 'utf8', timeout: 10000 });
  if (probe.status !== 0) throw new Error(`Node 不满足 >=22.13.0 且可直接使用 node:sqlite 的要求: ${node}`);
  runtimeTimings(env);
  validateWritablePathLayout({
    dataDir,
    pidFile,
    readyFile,
    logFile,
    apiTokenFile,
    indexDbPath: env.ZTQ_CLIENT_INDEX_DB,
    sessionDbPath: env.ZTQ_CLIENT_SESSION_DB,
    additionalFiles: [
      { label: 'launchd 输出文件', path: target },
      { label: 'launchd stderr 文件', path: stderrFile },
      ...(stdoutFile === '/dev/null' ? [] : [{ label: 'launchd stdout 文件', path: stdoutFile }]),
    ],
  });

  const optionalKeys = [
    'ZTQ_API_TOKEN_FILE', 'ZTQ_CLIENT_INDEX_DB', 'ZTQ_CLIENT_SESSION_DB', 'ZTQ_CLIENT_CONFIG',
    'ZTQ_TEST_MODE', 'ZTQ_CLIENT_REFRESH_MS', 'ZTQ_GUARD_INTERVAL_MS',
    'ZTQ_DISPATCH_WAIT_MS', 'ZTQ_DB_ERROR_GRACE_MS', 'ZTQ_RESULT_GRACE_MS',
    'ZTQ_POLL_MS', 'ZTQ_ENABLE_RESUME_MS', 'ZTQ_SHELL_SHUTDOWN_GRACE_MS',
    'ZTQ_SHELL_KILL_WAIT_MS', 'ZTQ_STARTUP_DELAY_MS',
  ];
  const extra = optionalKeys.filter((key) => env[key] !== undefined && env[key] !== '').map((key) => {
    const value = key.includes('_DB') || key.endsWith('_FILE') || key === 'ZTQ_CLIENT_CONFIG' ? absolute(env[key], key) : String(env[key]);
    return `    <key>${key}</key>\n    <string>${xml(value)}</string>`;
  }).join('\n');

  const replacements = {
    __ZTQ_LABEL__: label,
    __ZTQ_NODE__: node,
    __ZTQ_SERVER__: path.join(root, 'server.js'),
    __ZTQ_ROOT__: root,
    __ZTQ_HOME__: home,
    __ZTQ_HOME_DIR__: homeDir,
    __ZTQ_HOST__: host,
    __ZTQ_PORT__: String(port),
    __ZTQ_DATA_DIR__: dataDir,
    __ZTQ_PID_FILE__: pidFile,
    __ZTQ_READY_FILE__: readyFile,
    __ZTQ_LOG_FILE__: logFile,
    __ZTQ_STDOUT_FILE__: stdoutFile,
    __ZTQ_STDERR_FILE__: stderrFile,
  };
  let template = fs.readFileSync(templateFile, 'utf8');
  for (const [token, value] of Object.entries(replacements)) template = template.replaceAll(token, xml(value));
  template = template.replace('    <!-- __ZTQ_EXTRA_ENV__ -->', extra);
  if (/__ZTQ_[A-Z_]+__/.test(template)) throw new Error('模板中仍有未替换的占位符');

  if (stdoutFile !== '/dev/null') preparePrivateLog(stdoutFile, 'launchd stdout 文件');
  preparePrivateLog(stderrFile, 'launchd stderr 文件');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, template, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, target);
    fs.chmodSync(target, 0o600);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
  return { output: target, label, root, node, homeDir, dataDir, pidFile, readyFile, logFile, stdoutFile, stderrFile, host, port };
}

if (require.main === module) {
  const output = process.argv[2];
  if (!output || process.argv.length !== 3) {
    fail('用法: node launchd/render.js /绝对路径/com.zcode-task-queue.plist');
  } else {
    try {
      const result = render({ output });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      fail(error.message);
    }
  }
}

module.exports = { render };
