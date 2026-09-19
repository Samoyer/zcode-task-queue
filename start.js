#!/usr/bin/env node
/**
 * ZCode Task Queue - 跨平台启动器
 * 支持 macOS 和 Windows
 * 
 * 用法:
 *   node start.js start        - 启动服务
 *   node start.js stop         - 停止服务
 *   node start.js restart      - 重启服务
 *   node start.js status       - 查看状态
 *   node start.js preflight    - 运行预检
 */

'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ==================== 配置 ====================
const CONFIG = {
  defaultPort: 8787,
  defaultHost: '127.0.0.1',
  startupTimeoutMs: 10000,
  checkIntervalMs: 100,
  maxRetries: 100,
};

// ==================== 工具函数 ====================

/**
 * 检测当前操作系统
 */
function getPlatform() {
  return process.platform;
}

/**
 * 获取 Node.js 可执行文件路径
 */
function getNodePath() {
  if (process.env.ZTQ_NODE_BIN) {
    return process.env.ZTQ_NODE_BIN;
  }
  
  // Windows 下可能需要使用 where/node 命令
  if (getPlatform() === 'win32') {
    try {
      return execSync('where node').toString().trim().split('\n')[0];
    } catch (e) {
      console.error('✗ 找不到 Node.js，请先安装 Node.js >= 22.13.0');
      process.exit(1);
    }
  }
  
  // Unix-like 系统
  try {
    return execSync('command -v node').toString().trim();
  } catch (e) {
    console.error('✗ 找不到 Node.js，请先安装 Node.js >= 22.13.0');
    process.exit(1);
  }
}

/**
 * 检查 Node.js 版本
 */
function checkNodeVersion(nodePath) {
  try {
    const version = execSync(`${nodePath} -p process.versions.node`).toString().trim();
    const [major] = version.split('.').map(Number);
    
    if (major < 22) {
      console.error(`✗ 需要 Node.js >= 22.13.0，当前版本：${version}`);
      process.exit(1);
    }
    
    console.log(`✓ Node.js 版本检查通过：${version}`);
  } catch (error) {
    console.error(`✗ 无法检查 Node.js 版本：${error.message}`);
    process.exit(1);
  }
}

/**
 * 打印彩色输出 (Windows 10+ 支持 ANSI)
 */
function color(text, code) {
  if (getPlatform() === 'win32') {
    // Windows CMD/PowerShell 支持颜色
    return `\x1b[${code}m${text}\x1b[0m`;
  }
  return `\x1b[${code}m${text}\x1b[0m`;
}

const COLORS = {
  success: 32,    // 绿色
  error: 31,      // 红色
  warning: 33,    // 黄色
  info: 36,       // 青色
  reset: 0
};

function log(message, colorCode) {
  if (colorCode) {
    console.log(color(message, colorCode));
  } else {
    console.log(message);
  }
}

function success(message) { log(message, COLORS.success); }
function error(message) { log(message, COLORS.error); }
function warning(message) { log(message, COLORS.warning); }
function info(message) { log(message, COLORS.info); }

/**
 * 读取 JSON 文件
 */
function readJsonFile(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return null;
  }
}

/**
 * 检查端口是否被占用
 */
async function isPortInUse(port) {
  return new Promise((resolve) => {
    if (getPlatform() === 'win32') {
      // Windows: 使用 netstat
      try {
        const output = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
        resolve(output.length > 0);
      } catch (e) {
        resolve(false);
      }
    } else {
      // Unix-like: 使用 lsof 或 ss
      try {
        execSync(`lsof -i :${port} -sTCP:LISTEN`, { stdio: 'ignore' });
        resolve(true);
      } catch (e) {
        try {
          execSync(`ss -tlnp | grep :${port}`, { stdio: 'ignore' });
          resolve(true);
        } catch (e2) {
          resolve(false);
        }
      }
    }
  });
}

// ==================== 核心功能 ====================

/**
 * 显示帮助信息
 */
function showHelp() {
  console.log(`
ZCode Task Queue - 跨平台启动器

用法:
  node start.js <command> [options]

命令:
  start        - 启动服务
  stop         - 停止服务
  restart      - 重启服务
  status       - 查看服务状态
  preflight    - 运行预检检查
  
选项:
  --port <num>     - 指定端口 (默认：8787)
  --host <addr>    - 指定主机地址 (默认：127.0.0.1)
  --data-dir <path>- 指定数据目录
  
示例:
  node start.js start
  node start.js stop
  node start.js status --port 9090
`);
}

/**
 * 运行预检检查
 */
async function runPreflight(options) {
  info('正在运行预检检查...\n');
  
  const nodePath = getNodePath();
  checkNodeVersion(nodePath);
  
  const rootDir = process.cwd();
  const serverJs = path.join(rootDir, 'server.js');
  const dataDir = options.dataDir || path.join(rootDir, 'data');
  
  // 检查服务器文件
  if (!fs.existsSync(serverJs)) {
    error(`✗ 找不到服务器文件：${serverJs}`);
    process.exit(1);
  }
  success(`✓ 服务器文件存在：${serverJs}`);
  
  // 检查数据目录
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      success(`✓ 已创建数据目录：${dataDir}`);
    } else {
      success(`✓ 数据目录存在：${dataDir}`);
    }
  } catch (error) {
    error(`✗ 无法访问数据目录：${error.message}`);
    process.exit(1);
  }
  
  // 检查端口可用性
  const port = options.port || CONFIG.defaultPort;
  const inUse = await isPortInUse(port);
  if (inUse) {
    error(`✗ 端口 ${port} 已被占用`);
    process.exit(1);
  }
  success(`✓ 端口 ${port} 可用`);
  
  // 检查 Node.js 模块
  try {
    require.resolve('node:sqlite');
    success('✓ node:sqlite 模块可用');
  } catch (error) {
    error('✗ node:sqlite 模块不可用');
    process.exit(1);
  }
  
  success('\n✓ 所有预检检查通过!');
}

/**
 * 启动服务
 */
async function startService(options) {
  const port = options.port || CONFIG.defaultPort;
  const host = options.host || CONFIG.defaultHost;
  const rootDir = process.cwd();
  const dataDir = options.dataDir || path.join(rootDir, 'data');
  const pidFile = path.join(dataDir, 'server.pid.json');
  const readyFile = path.join(dataDir, 'ready.json');
  const logFile = path.join(dataDir, 'server.log');
  
  info(`正在启动 ZCode 任务队列服务...`);
  info(`端口：${host}:${port}`);
  info(`数据目录：${dataDir}`);
  
  // 检查是否已运行
  if (fs.existsSync(pidFile)) {
    const pidData = readJsonFile(pidFile);
    if (pidData && pidData.pid) {
      warning(`⚠ 服务似乎已在运行 (PID: ${pidData.pid})`);
      return;
    }
  }
  
  // 检查端口
  const inUse = await isPortInUse(port);
  if (inUse) {
    error(`✗ 端口 ${port} 已被占用`);
    process.exit(1);
  }
  
  // 启动服务器进程
  const nodePath = getNodePath();
  const args = [rootDir];
  
  const env = {
    ...process.env,
    ZTQ_HOST: host,
    ZTQ_PORT: String(port),
    ZTQ_DATA_DIR: dataDir,
    ZTQ_PID_FILE: pidFile,
    ZTQ_READY_FILE: readyFile,
    ZTQ_LOG_FILE: logFile,
    ZTQ_MIRROR_LOG_STDOUT: '0', // 避免重复输出
  };
  
  info('启动服务器进程...\n');
  
  const child = spawn(nodePath, [path.join(rootDir, 'server.js')], {
    cwd: rootDir,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  
  child.on('spawn', () => {
    info(`✓ 服务器进程已启动 (PID: ${child.pid})`);
  });
  
  child.on('error', (error) => {
    error(`✗ 启动失败：${error.message}`);
    process.exit(1);
  });
  
  // 等待服务就绪
  info('等待服务就绪...\n');
  
  for (let i = 0; i < CONFIG.maxRetries; i++) {
    await sleep(CONFIG.checkIntervalMs);
    
    // 检查 PID 文件
    if (!fs.existsSync(pidFile)) continue;
    
    const pidData = readJsonFile(pidFile);
    if (!pidData || !pidData.pid) continue;
    
    // 检查健康状态
    try {
      const http = require('http');
      const url = `http://${host}:${port}/api/health`;
      
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const health = JSON.parse(data);
              if (health.ok) {
                resolve();
              } else {
                reject(new Error('Health check failed'));
              }
            } catch (e) {
              reject(e);
            }
          });
        });
        
        req.on('error', reject);
        req.setTimeout(2000, () => {
          req.destroy();
          reject(new Error('Timeout'));
        });
      });
      
      success(`\n✓ 服务已启动并运行!\n`);
      info(`URL: http://${host}:${port}`);
      info(`API Token: ${pidData.startToken || '[未找到]'}`);
      
      // 尝试打开浏览器
      if (getPlatform() === 'win32') {
        try {
          execSync(`start http://${host}:${port}`, { stdio: 'ignore' });
          info('已尝试打开浏览器\n');
        } catch (e) {
          info(`请手动访问：http://${host}:${port}\n`);
        }
      } else {
        try {
          execSync(`open http://${host}:${port}`, { stdio: 'ignore' });
          info('已尝试打开浏览器\n');
        } catch (e) {
          info(`请手动访问：http://${host}:${port}\n`);
        }
      }
      
      return;
    } catch (error) {
      // 继续重试
    }
  }
  
  error('\n✗ 服务启动超时');
  error('请查看日志文件：' + logFile);
  process.exit(1);
}

/**
 * 停止服务
 */
async function stopService() {
  const rootDir = process.cwd();
  const dataDir = path.join(rootDir, 'data');
  const pidFile = path.join(dataDir, 'server.pid.json');
  
  info('正在停止 ZCode 任务队列服务...\n');
  
  if (!fs.existsSync(pidFile)) {
    warning('服务未运行 (PID 文件不存在)');
    return;
  }
  
  const pidData = readJsonFile(pidFile);
  if (!pidData || !pidData.pid) {
    warning('无法从 PID 文件读取进程 ID');
    return;
  }
  
  const pid = pidData.pid;
  info(`目标进程：PID ${pid}`);
  
  // 发送 SIGTERM
  try {
    if (getPlatform() === 'win32') {
      // Windows: 使用 taskkill
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'inherit' });
    } else {
      // Unix-like: 使用 kill
      process.kill(-pid, 'SIGTERM'); // 发送信号到进程组
      
      // 等待进程退出
      for (let i = 0; i < 50; i++) {
        await sleep(100);
        try {
          process.kill(pid, 0); // 检查进程是否存在
        } catch (e) {
          break; // 进程已退出
        }
      }
      
      // 如果仍未退出，强制终止
      try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGKILL');
        for (let i = 0; i < 20; i++) {
          await sleep(100);
          try {
            process.kill(pid, 0);
          } catch (e) {
            break;
          }
        }
      } catch (e) {
        // 忽略错误
      }
    }
  } catch (error) {
    if (error.code === 'ESRCH') {
      warning('进程不存在，可能已经退出');
      return;
    }
    throw error;
  }
  
  // 清理文件
  const readyFile = path.join(dataDir, 'ready.json');
  try {
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    if (fs.existsSync(readyFile)) fs.unlinkSync(readyFile);
  } catch (e) {
    // 忽略清理错误
  }
  
  success('\n✓ 服务已停止');
}

/**
 * 查看服务状态
 */
async function checkStatus() {
  const rootDir = process.cwd();
  const dataDir = path.join(rootDir, 'data');
  const pidFile = path.join(dataDir, 'server.pid.json');
  const port = parseInt(process.env.ZTQ_PORT) || CONFIG.defaultPort;
  const host = process.env.ZTQ_HOST || CONFIG.defaultHost;
  
  info('ZCode 任务队列服务状态:\n');
  
  if (!fs.existsSync(pidFile)) {
    warning('✗ 服务未运行 (PID 文件不存在)\n');
    return;
  }
  
  const pidData = readJsonFile(pidFile);
  if (!pidData || !pidData.pid) {
    warning('✗ 无法读取 PID 文件\n');
    return;
  }
  
  const pid = pidData.pid;
  info(`PID: ${pid}`);
  info(`启动时间：${pidData.processStartedAt || '未知'}`);
  info(`监听地址：${pidData.host || host}:${pidData.port || port}`);
  
  // 检查进程是否存在
  try {
    process.kill(pid, 0);
    info('进程状态：运行中 ✓');
  } catch (e) {
    warning('进程状态：未响应 ✗\n');
    return;
  }
  
  // 检查 HTTP 健康状态
  try {
    const http = require('http');
    const url = `http://${host}:${port}/api/health`;
    
    await new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const health = JSON.parse(data);
            if (health.ok) {
              success('HTTP 健康检查：通过 ✓');
              info(`\n访问地址：http://${host}:${port}`);
              if (pidData.startToken) {
                info(`API Token: ${pidData.startToken}`);
              }
            } else {
              warning('HTTP 健康检查：失败 ✗');
            }
          } catch (e) {
            warning('HTTP 健康检查：无法解析响应 ✗');
          }
          resolve();
        });
      });
      
      req.on('error', reject);
      req.setTimeout(2000, () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
    });
  } catch (error) {
    warning(`HTTP 健康检查：失败 (${error.message}) ✗\n`);
  }
}

/**
 * 重启服务
 */
async function restartService(options) {
  await stopService();
  await sleep(1000); // 等待 1 秒
  await startService(options);
}

/**
 * 延迟函数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== 主程序 ====================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  if (!command || command === '-h' || command === '--help') {
    showHelp();
    return;
  }
  
  // 解析选项
  const options = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      options.port = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--host' && args[i + 1]) {
      options.host = args[i + 1];
      i++;
    } else if (args[i] === '--data-dir' && args[i + 1]) {
      options.dataDir = args[i + 1];
      i++;
    }
  }
  
  switch (command) {
    case 'start':
      await startService(options);
      break;
    case 'stop':
      await stopService();
      break;
    case 'restart':
      await restartService(options);
      break;
    case 'status':
      await checkStatus();
      break;
    case 'preflight':
      await runPreflight(options);
      break;
    default:
      error(`✗ 未知命令：${command}`);
      showHelp();
      process.exit(1);
  }
}

main().catch(error => {
  error(`✗ 发生错误：${error.message}`);
  process.exit(1);
});
