import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 给人看的时间一律用**本机时区**（面板、logs/server.log、控制台都走这里）。
 *
 * 以前是直接切一个 UTC ISO 的第 11~19 位，于是日志比本机时间慢 8 小时
 * （实测：本机 13:44 的日志写着 05:44）—— 对时间的时候极容易误判成「这是凌晨
 * 那一条」，排查反而更绕。
 *
 * `entry.ts` 不动，它仍然是 UTC ISO：那是给程序和数据口径用的**绝对时刻**
 * （面板拿它排序、做去重都靠它）。这里只改「给人看的那一列」。
 */
export function localClock(d = new Date()) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 本机时区标签（如 `UTC+08:00`）。启动时打一行，省得再猜日志是哪个区的。 */
export function localZone(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return `UTC${off >= 0 ? '+' : '-'}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

let currentLevel = LEVELS.info;
const recent = [];
let recentLimit = 300;
let logFile = '';
let fileReady = false;

/** 单个日志文件的上限，超过就滚动。留 3 份历史，一共约 32MB 封顶。 */
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const KEEP_GENERATIONS = 3;

/**
 * @param {{level?:string, keepRecent?:number, file?:string}} options
 * `file` 指定后，日志同时落盘（这样用计划任务直接跑 node 时也能留痕，
 * 不依赖命令行重定向）。
 */
export function configureLogger({ level = 'info', keepRecent = 300, file = '' } = {}) {
  currentLevel = LEVELS[level] ?? LEVELS.info;
  recentLimit = keepRecent;
  if (file) {
    logFile = file;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      rotateLog();
      fileReady = true;
    } catch {
      fileReady = false;
    }
  }
}

/**
 * 超过 MAX_LOG_BYTES 就把 server.log 滚成 .1、.1 滚成 .2、.2 滚成 .3（最老的丢掉）。
 *
 * 原来只留一份（`.1` 直接被覆盖）。实测吃过这个亏：想对「今天服务重启前后」的日志，
 * 而那次重启刚好跨过一次滚动，于是想要的那半天正好被覆盖掉 —— 排查时最需要的那段
 * 恰恰是最先被丢的。三份够用，总量也就 32MB 封顶。
 *
 * 滚动失败只当没滚（不能让写日志这件事把服务弄挂）。
 */
function rotateLog() {
  if (!logFile) return 0;
  if (!fs.existsSync(logFile) || fs.statSync(logFile).size <= MAX_LOG_BYTES) return 0;
  let rotated = 0;
  for (let n = KEEP_GENERATIONS; n >= 1; n -= 1) {
    const src = n === 1 ? logFile : `${logFile}.${n - 1}`;
    const dst = `${logFile}.${n}`;
    if (!fs.existsSync(src)) continue;
    try {
      fs.rmSync(dst, { force: true });
      fs.renameSync(src, dst);
      rotated += 1;
    } catch {
      /* 滚不动就算了，别影响写日志 */
    }
  }
  return rotated;
}

export function getRecentLogs() {
  return [...recent];
}

export function clearRecentLogs() {
  const n = recent.length;
  recent.length = 0;
  return n;
}

function emit(level, scope, msg, extra) {
  const at = new Date();
  const entry = {
    ts: at.toISOString(),
    level,
    scope,
    msg,
    ...(extra && Object.keys(extra).length ? { extra } : {}),
  };
  recent.push(entry);
  if (recent.length > recentLimit) recent.splice(0, recent.length - recentLimit);
  if ((LEVELS[level] ?? 9) > currentLevel) return;
  const tail = extra && Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
  const line = `[${localClock(at)}] ${level.toUpperCase().padEnd(5)} ${scope.padEnd(9)} ${msg}${tail}`;
  if (fileReady) {
    try {
      fs.appendFileSync(logFile, `${line}\n`);
    } catch {
      /* 落盘失败不影响服务 */
    }
  }
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export function createLogger(scope) {
  return {
    error: (msg, extra) => emit('error', scope, msg, extra),
    warn: (msg, extra) => emit('warn', scope, msg, extra),
    info: (msg, extra) => emit('info', scope, msg, extra),
    debug: (msg, extra) => emit('debug', scope, msg, extra),
  };
}
