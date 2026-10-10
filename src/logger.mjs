import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

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
  const entry = {
    ts: new Date().toISOString(),
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
  const line = `[${entry.ts.slice(11, 19)}] ${level.toUpperCase().padEnd(5)} ${scope.padEnd(9)} ${msg}${tail}`;
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
