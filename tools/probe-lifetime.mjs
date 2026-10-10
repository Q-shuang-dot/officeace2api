/**
 * 临时 AK/SK 的真实寿命到底多长？
 *
 * 时间口径（踩过坑，写清楚）：
 *   - 日志里的 `[HH:MM:SS]` 是**本机本地时间**（北京，UTC+8），且**不带日期**；
 *   - state 里 `credential.expiresAt` / `refreshExpiresAt` 是 **UTC ISO 串**，
 *     `refreshedAt` 是**本地时间轴**的毫秒时间戳。
 *
 * 所以判断寿命只能以 `refreshedAt` 为准（它跟 `expiresAt` 同属一套绝对时间），
 * 日志时刻只用来做交叉印证。直接把「本地小时数」跟「UTC 小时数」相减，
 * 会凭空多出/少掉 8 小时，算出「10 小时」「-16 小时」这种离谱值。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateFile = path.join(ROOT, 'data', 'refresh-state.json');

/** UTC 毫秒 → 本地（北京）显示 */
const fmtLocal = (ms) => {
  const offMin = -new Date(ms).getTimezoneOffset();
  const d = new Date(ms + offMin * 60000);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}`;
};
const fmtLocalShort = (ms) => fmtLocal(ms).slice(5);

/** 把「日志里的本地时分秒」补成绝对时间戳：借一个参考时间戳的日期 */
const logTimeToAbs = (refMs, hh, mm, ss) => {
  const ref = new Date(refMs);
  const guess = new Date(ref);
  guess.setHours(Number(hh), Number(mm), Number(ss), 0);
  // 日志时刻比参考时间晚太多 → 那是前一天的行
  if (guess.getTime() > refMs + 10 * 60 * 1000) guess.setHours(guess.getHours() - 24);
  return guess.getTime();
};

const doc = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const now = Date.now();

console.log('  ── 逐次续期的真实寿命（以 refreshedAt / expiresAt 为准）──');
console.log('  本次签发时间(本地)      到期时间(本地)        真实寿命');
for (const [k, v] of Object.entries(doc)) {
  const issuedMs = Number(v?.refreshedAt) || 0;
  const expMs = Date.parse(v?.credential?.expiresAt || '');
  if (!issuedMs || !Number.isFinite(expMs)) continue;
  const leftH = (expMs - now) / 3600000;
  console.log(`  ${fmtLocal(issuedMs)}   ${fmtLocal(expMs)}   ${((expMs - issuedMs) / 3600000).toFixed(2).padStart(6)} 小时`);

  const claims = v.idTokenClaims || {};
  console.log(`  账号 ${String(k).slice(0, 16)}…  用户 ${v.userName || claims.userName || '-'}  续期次数 ${v.count}`);

  const lifeH = (expMs - issuedMs) / 3600000;
  const leadMin = lifeH * 0.25 * 60;
  console.log(`\n  当前这份还剩 ${leftH.toFixed(2)} 小时（${(leftH * 60).toFixed(0)} 分钟）`);
  console.log(`  本轮寿命 ${lifeH.toFixed(2)} 小时  →  提前量 25% = ${leadMin.toFixed(0)} 分钟`);
  const until = leftH * 60 - leadMin;
  console.log(
    until > 0
      ? `  →  约 ${until.toFixed(0)} 分钟之后触发下一次自动续期`
      : `  →  已进入提前续期窗口，下一次巡检（≤15 分钟）就会换`,
  );

  // 交叉印证：日志里那条签发记录的时刻
  const logFile = path.join(ROOT, 'logs', 'server.log');
  if (fs.existsSync(logFile)) {
    const hit = fs
      .readFileSync(logFile, 'utf8')
      .split(/\r?\n/)
      .reverse()
      .find((l) => l.includes('续期成功') && l.includes(v.credential?.accessKeyId || '@@'));
    const m = hit && hit.match(/^\[(\d\d):(\d\d):(\d\d)\]/);
    if (m) {
      const abs = logTimeToAbs(issuedMs, m[1], m[2], m[3]);
      console.log(`  日志印证：那条「续期成功」写于 ${m[1]}:${m[2]}:${m[3]}` +
        `（换算 ${fmtLocal(abs)}，与签发时间差 ${((abs - issuedMs) / 1000).toFixed(0)} 秒 —— 应当接近 0）`);
    }
  }
  console.log('');
}
