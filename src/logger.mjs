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
const listeners = new Set();
let logFile = '';
let fileReady = false;

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
      // 超过 8MB 就滚动一次，只保留一份历史
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 8 * 1024 * 1024) {
        fs.renameSync(logFile, `${logFile}.1`);
      }
      fileReady = true;
    } catch {
      fileReady = false;
    }
  }
}

export function onLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
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
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      /* ignore listener errors */
    }
  }
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
