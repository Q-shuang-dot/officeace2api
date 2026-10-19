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
/**
 * 全进程单调递增的日志序号。
 *
 * 存在的理由只有面板：它每 3 秒问一次「有新日志吗」，靠 `since=序号` 拿增量，
 * 就不用每次都把 300 行整包搬一遍（那曾是面板载荷的 30%）。
 * 重启归零 —— 面板那边会把 `seq` 变小当成"服务重启过"，直接重拉尾部。
 */
let seqNo = 0;
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

/**
 * @param {number} [limit] 只要最后 N 条。面板首屏用它（60 条够铺满一屏），
 *   剩下的滚动过程靠 `getLogsSince()` 增量补 —— 别一次搬 300 条。
 */
export function getRecentLogs(limit) {
  if (!limit || limit >= recent.length) return [...recent];
  return recent.slice(-limit);
}

/**
 * `seq` 之后的日志（不含等于 `seq` 的那条）。
 *
 * @param {number} since 面板已经拿到的最后一个序号；0 / 非数 → 当首次拉取
 * @param {number} [limit] 一次最多给多少条（默认 200）。积压太多时宁可截断，
 *   下一次轮询会接着要 —— 一屏日志不值得撑爆一次响应。
 * @returns {{seq:number, lines:object[], more:boolean}}
 */
export function getLogsSince(since, limit = 200) {
  const from = Number(since);
  const lastSeq = recent.length ? recent[recent.length - 1].seq : 0;
  if (!Number.isFinite(from) || from <= 0) {
    // 首次：给尾部一批，让面板有东西可显示
    return { seq: lastSeq, lines: getRecentLogs(limit), more: false };
  }
  // 服务重启过（序号变回小的了）→ 面板手里那批是上一代进程的，直接换成尾部
  if (from > lastSeq) return { seq: lastSeq, lines: getRecentLogs(limit), more: false };
  const fresh = recent.filter((e) => e.seq > from);
  const lines = fresh.length > limit ? fresh.slice(-limit) : fresh;
  return { seq: lines.length ? lines[lines.length - 1].seq : from, lines, more: fresh.length > limit };
}

/** 最后一条日志的序号；面板用来判断「要不要拉增量」。 */
export function getLogSeq() {
  return recent.length ? recent[recent.length - 1].seq : 0;
}

export function clearRecentLogs() {
  const n = recent.length;
  recent.length = 0;
  return n;
}

function emit(level, scope, msg, extra) {
  const at = new Date();
  const entry = {
    // 序号先占位：`recent` 里**所有**级别都要有序号（面板按级别过滤后再拼增量，
    // 缺号会让它以为中间丢了日志）。但落盘的文本行里不写序号 —— 那行是给人看的。
    seq: (seqNo += 1),
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
