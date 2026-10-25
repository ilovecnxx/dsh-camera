// 隔离 DSH 实例管理：只操作自己的 DSH_HOME=/tmp/dsh-cam-home 与端口，绝不碰 3080。
//
// 用法：
//   import { prepareProfile, startInstance } from './lib/dsh-instance.mjs';
//   await prepareProfile();
//   const inst = await startInstance();
//   // ... inst.url / inst.token
//   await inst.stop();
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const WORKSPACE_ROOT = path.resolve(REPO_ROOT, '..');

export const DEFAULTS = {
  home: process.env.DSH_CAMERA_TEST_HOME || '/tmp/dsh-cam-home',
  profile: 'cam',
  port: Number(process.env.DSH_CAMERA_TEST_PORT || 3099),
  chromePort: null, // Chrome 用 --remote-debugging-port=0 动态端口
  dshBin: process.env.DSH_BIN || 'dsh',
  logFile: '/tmp/cam-instance.log',
  chromeLogFile: '/tmp/cam-chrome.log',
  chromeProfile: '/tmp/cam-chrome-profile',
  startTimeoutMs: 120000,
};

const PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@local/dsh-camera',
];

export function isPortListening(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * 精确找出属于本测试 DSH_HOME 的 dsh 进程（扫 /proc/[pid]/environ + cmdline）。
 * 只返回 DSH_HOME 精确匹配且命令行含 `--profile <profile>` 的 PID —— 绝不误伤 3080。
 */
export function findInstancePids({ home = DEFAULTS.home, profile = DEFAULTS.profile } = {}) {
  const wantedEnv = Buffer.from(`DSH_HOME=${home}\0`);
  const pids = [];
  let entries = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return pids;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let environ;
    let cmdline;
    try {
      environ = fs.readFileSync(`/proc/${pid}/environ`);
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (!environ.includes(wantedEnv)) continue;
    // cmdline 用 \0 分隔；匹配 --profile <profile>
    const argv = cmdline.split('\0').filter(Boolean);
    const idx = argv.indexOf('--profile');
    const hasProfile = idx >= 0 && argv[idx + 1] === profile;
    if (!hasProfile) continue;
    pids.push(pid);
  }
  return pids;
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/**
 * 初始化隔离 profile：$DSH_HOME/profiles/<profile>/package.json 的 dsh.profile.bundles
 * + `dsh plugin --profile <profile> add link:<repo>`。
 * 幂等：已装好则跳过 pnpm（快）。
 */
export async function prepareProfile({
  home = DEFAULTS.home,
  profile = DEFAULTS.profile,
  repo = REPO_ROOT,
  log = console.log,
  force = false,
} = {}) {
  const profileDir = path.join(home, 'profiles', profile);
  fs.mkdirSync(profileDir, { recursive: true });
  const pkgFile = path.join(profileDir, 'package.json');
  const desired = {
    name: `dsh-profile-${profile}`,
    private: true,
    dsh: { profile: { bundles: PROFILE_BUNDLES } },
  };
  const existing = readJsonIfExists(pkgFile);
  if (!existing) {
    writeJson(pkgFile, desired);
    log(`[dsh-instance] wrote ${pkgFile}`);
  } else {
    // 确保 bundles 列表齐全（保留用户/测试手动追加的字段）
    const bundles = existing?.dsh?.profile?.bundles;
    const merged = Array.isArray(bundles) ? [...bundles] : [];
    let changed = !Array.isArray(bundles);
    for (const b of PROFILE_BUNDLES) {
      if (!merged.includes(b)) {
        merged.push(b);
        changed = true;
      }
    }
    if (changed) {
      existing.dsh = { ...(existing.dsh || {}), profile: { ...(existing.dsh?.profile || {}), bundles: merged } };
      writeJson(pkgFile, existing);
      log(`[dsh-instance] updated bundles in ${pkgFile}`);
    }
  }

  const linkTarget = fs.realpathSync(path.resolve(repo));
  const pkg = readJsonIfExists(pkgFile) ?? {};
  const dep = pkg?.dependencies?.['dsh-camera'];
  const nodeModulesLink = path.join(profileDir, 'node_modules', '@local', 'dsh-camera');
  const linkExists = fs.existsSync(nodeModulesLink);
  const depMatches = typeof dep === 'string' && dep.startsWith('link:') && fs.realpathSync(path.resolve(profileDir, dep.slice('link:'.length))) === linkTarget;
  if (!force && linkExists && depMatches) {
    log(`[dsh-instance] plugin link already installed: ${nodeModulesLink} -> ${linkTarget}`);
    return { profileDir, pkgFile, installed: true };
  }

  log(`[dsh-instance] adding plugin link: ${linkTarget}`);
  const res = spawnSync(DEFAULTS.dshBin, ['plugin', '--profile', profile, 'add', `link:${linkTarget}`], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    timeout: 180000,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  log(out.trim());
  if (res.status !== 0) {
    throw new Error(`dsh plugin add failed (status ${res.status}):\n${out}`);
  }
  return { profileDir, pkgFile, installed: true };
}

/** 从日志提取带 token 的 GUI URL。 */
export function extractTokenUrl(logText) {
  const match = /dsh web:\s+(https?:\/\/\S+)/.exec(logText);
  if (!match) return null;
  const raw = match[1].trim();
  try {
    const url = new URL(raw);
    const token = url.searchParams.get('token');
    return { url: raw, token, origin: url.origin, port: Number(url.port) };
  } catch {
    return null;
  }
}

/**
 * 启动隔离实例，等待带 token 的 URL 出现且 HTTP 可达。
 * @returns {{ pid:number, url:string, token:string, origin:string, port:number,
 *             home:string, profile:string, logFile:string, proc:import('node:child_process').ChildProcess,
 *             stop:() => Promise<void>, readLog:() => string }}
 */
export async function startInstance({
  home = DEFAULTS.home,
  profile = DEFAULTS.profile,
  port = DEFAULTS.port,
  logFile = DEFAULTS.logFile,
  startTimeoutMs = DEFAULTS.startTimeoutMs,
  log = console.log,
  extraEnv = {},
} = {}) {
  if (await isPortListening(port)) {
    const guard = findInstancePids({ home, profile });
    const pids = guard.length ? guard : [];
    throw new Error(
      `port ${port} already in use (test-home pids: ${pids.join(',') || 'none'}). ` +
        `Refusing to kill anything automatically; run scripts/stop-instance.mjs first if it is a stale test instance.`,
    );
  }
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, '');
  const fd = fs.openSync(logFile, 'a');
  const proc = spawn(DEFAULTS.dshBin, ['--profile', profile, '--no-open', '--port', String(port)], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, DSH_HOME: home, ...extraEnv },
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  const readLog = () => {
    try {
      return fs.readFileSync(logFile, 'utf8');
    } catch {
      return '';
    }
  };
  let exited = null;
  proc.once('exit', (code, signal) => {
    exited = { code, signal };
  });
  proc.once('error', (err) => {
    exited = { error: err };
  });

  const startedAt = Date.now();
  let tokenUrl = null;
  while (Date.now() - startedAt < startTimeoutMs) {
    if (exited) {
      throw new Error(`dsh instance exited before ready (${JSON.stringify(exited)}). log:\n${readLog().slice(-6000)}`);
    }
    tokenUrl = extractTokenUrl(readLog());
    if (tokenUrl) {
      // 等端口真正可用
      if (await isPortListening(tokenUrl.port || port)) break;
    }
    await delay(200);
  }
  if (!tokenUrl) {
    throw new Error(`did not find "dsh web: http://...?token=" in log within ${startTimeoutMs}ms:\n${readLog().slice(-6000)}`);
  }
  if (!(await isPortListening(tokenUrl.port || port))) {
    throw new Error(`dsh instance printed URL but port ${tokenUrl.port || port} is not listening`);
  }

  const stop = async () => stopInstance({ pid: proc.pid, home, profile, port: tokenUrl.port || port, proc, log });
  log(`[dsh-instance] ready pid=${proc.pid} url=${tokenUrl.url} (${Date.now() - startedAt}ms)`);
  return { pid: proc.pid, ...tokenUrl, home, profile, logFile, proc, stop, readLog };
}

/**
 * 停止实例：先精确 kill 测试 home 的 dsh 进程（含进程组），再等端口释放。
 * 绝不使用宽泛 pkill/pgrep -f dsh。
 */
export async function stopInstance({
  pid = null,
  home = DEFAULTS.home,
  profile = DEFAULTS.profile,
  port = DEFAULTS.port,
  proc = null,
  log = console.log,
  timeoutMs = 15000,
} = {}) {
  const pids = new Set(findInstancePids({ home, profile }));
  if (pid) pids.add(pid);
  if (!pids.size) {
    log('[dsh-instance] no test instance processes found');
    return { stopped: [], portFree: !(await isPortListening(port)) };
  }
  log(`[dsh-instance] stopping pids: ${[...pids].join(', ')} (DSH_HOME=${home})`);
  for (const target of pids) {
    try {
      process.kill(-target, 'SIGTERM');
    } catch {
      try {
        process.kill(target, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
  }
  if (proc) await Promise.race([waitChildExit(proc, timeoutMs), delay(timeoutMs)]);
  // 等待端口释放
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await isPortListening(port))) break;
    const remaining = findInstancePids({ home, profile });
    if (!remaining.length) {
      // 进程都退了，端口可能还在 TIME_WAIT，稍等
      if (!(await isPortListening(port))) break;
    } else {
      for (const target of remaining) {
        try {
          process.kill(target, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
    await delay(200);
  }
  const portFree = !(await isPortListening(port));
  if (!portFree) log(`[dsh-instance] WARNING: port ${port} still listening after stop`);
  return { stopped: [...pids], portFree };
}

function waitChildExit(proc, timeoutMs) {
  if (!proc || proc.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** 回收可能残留的测试 Chrome（只按 user-data-dir 精确匹配）。 */
export function findTestChromePids({ chromeProfile = DEFAULTS.chromeProfile } = {}) {
  const wanted = Buffer.from(`--user-data-dir=${chromeProfile}\0`);
  const pids = [];
  let entries = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return pids;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let cmdline;
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`);
    } catch {
      continue;
    }
    if (cmdline.includes(wanted)) pids.push(pid);
  }
  return pids;
}

export function stopStrayTestChrome({ chromeProfile = DEFAULTS.chromeProfile, log = console.log } = {}) {
  const pids = findTestChromePids({ chromeProfile });
  if (!pids.length) return { stopped: [] };
  log(`[dsh-instance] stopping stray test chrome pids: ${pids.join(', ')}`);
  for (const target of pids) {
    try {
      process.kill(target, 'SIGTERM');
    } catch {
      /* ignore */
    }
  }
  return { stopped: pids };
}
