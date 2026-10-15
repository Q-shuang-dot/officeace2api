#!/usr/bin/env node
/**
 * 日志落盘与滚动的回归测试（原先 logger 只剩静态断言，没有真跑过）。
 *
 * 为什么值得单独测：滚动是**坏了也不报错**的那一类 —— 写日志的失败被刻意吞掉
 * （不能让日志把服务弄挂），所以丢历史、只留一份、时间列回退成 UTC，全都不会有人喊。
 * 这里真写几轮超限文件，钉住三件事：
 *
 *   1. 超过上限才滚，且留 3 代（`.1` 最新、`.3` 最老，第 4 代覆盖最老的）
 *   2. 给人看的那一列是本机时间，`entry.ts` 仍然是 UTC ISO（两套口径不能混）
 *   3. `keepRecent` 真的裁内存里那份（面板日志框直接吃它）
 *
 *   node tools/test-logger.mjs
 *
 * 只在本机的临时目录里写文件，不碰 logs/ 和 data/，也不碰网络。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureLogger, createLogger, getRecentLogs, localClock, localZone, clearRecentLogs } from '../src/logger.mjs';

let pass = 0;
const fails = [];
function ok(name) {
  pass += 1;
  console.log(`  ✓ ${name}`);
}
function bad(name, extra) {
  fails.push(name);
  console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`);
}

const MB = 1024 * 1024;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o2a-log-'));
const logFile = path.join(dir, 'server.log');

/** 把文件撑到超过上限（默认 9MB > 8MB） */
function grow(file, mb = 9) {
  const chunk = `${'x'.repeat(1023 * 1024)}\n`;
  const fd = fs.openSync(file, 'a');
  for (let i = 0; i < mb; i += 1) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
}

/** 只读文件开头几十个字节（别把 9MB 全读进来） */
function head(file, n = 40) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(n);
  const got = fs.readSync(fd, buf, 0, n, 0);
  fs.closeSync(fd);
  return buf.subarray(0, got).toString('utf8');
}

console.log('日志：落盘与滚动');

/* ------------------------------------------------ 1. 三份历史，最老的被丢掉 */
{
  const marks = [];
  for (let round = 1; round <= 4; round += 1) {
    const mark = `第 ${round} 轮`;
    marks.push(mark);
    fs.writeFileSync(logFile, `${mark}\n`, 'utf8');
    grow(logFile);
    configureLogger({ file: logFile, level: 'info' });
  }

  const exists = (suffix) => fs.existsSync(`${logFile}${suffix}`);
  if (exists('.1') && exists('.2') && exists('.3') && !exists('.4')) {
    ok('滚动留 3 代历史（.1/.2/.3 在，.4 不存在）');
  } else {
    bad('滚动留 3 代历史', JSON.stringify(['.1', '.2', '.3', '.4'].map((s) => exists(s))));
  }

  // .1 应该是最新滚出去的那轮，.3 是最老的（第 1 轮已经被覆盖掉）
  const h1 = head(`${logFile}.1`);
  const h2 = head(`${logFile}.2`);
  const h3 = head(`${logFile}.3`);
  if (h1.startsWith('第 4 轮') && h2.startsWith('第 3 轮') && h3.startsWith('第 2 轮')) {
    ok('.1 最新 / .2 次之 / .3 最老（顺序没反）');
  } else {
    bad('滚动顺序', JSON.stringify([h1.split('\n')[0], h2.split('\n')[0], h3.split('\n')[0]]));
  }

  const total = [logFile, `${logFile}.1`, `${logFile}.2`, `${logFile}.3`]
    .filter((f) => fs.existsSync(f))
    .reduce((n, f) => n + fs.statSync(f).size, 0);
  if (total < 34 * MB) ok(`总量封顶（4 个文件合计 ${(total / MB).toFixed(1)}MB）`);
  else bad('总量没封顶', `${(total / MB).toFixed(1)}MB`);
}

/* ------------------------------------------------ 2. 没到上限就不滚 */
{
  const small = path.join(dir, 'small.log');
  fs.writeFileSync(small, '一小行\n', 'utf8');
  configureLogger({ file: small, level: 'info' });
  if (!fs.existsSync(`${small}.1`)) ok('没超过上限就不滚动（小文件不产生 .1）');
  else bad('小文件也被滚了', '上限判断出错');
}

/* ------------------------------------------------ 3. 时间列本机 / ts 仍 UTC */
{
  const f = path.join(dir, 'time.log');
  configureLogger({ file: f, level: 'info', keepRecent: 3 });
  clearRecentLogs();
  const log = createLogger('自测');
  log.info('时间口径检查');

  const line = fs.readFileSync(f, 'utf8').trim();
  const shown = (line.match(/^\[(\d\d:\d\d:\d\d)\]/) || [])[1];
  if (shown === localClock()) ok(`给人看的一列是本机时间（${shown}）`);
  else bad('时间列不是本机时间', `文件里 ${shown}，本机 ${localClock()}`);

  const entry = getRecentLogs().at(-1);
  if (entry && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.ts)) {
    ok('entry.ts 仍是 UTC ISO（机器读的口径没被改掉）');
  } else {
    bad('entry.ts 不是 UTC ISO', JSON.stringify(entry && entry.ts));
  }
  if (/^UTC[+-]\d\d:\d\d$/.test(localZone())) ok(`时区标签形如 ${localZone()}`);
  else bad('时区标签格式', localZone());
}

/* ------------------------------------------------ 4. keepRecent 真的裁 */
{
  const f = path.join(dir, 'recent.log');
  configureLogger({ file: f, level: 'info', keepRecent: 3 });
  clearRecentLogs();
  const log = createLogger('自测');
  for (let i = 1; i <= 6; i += 1) log.info(`第 ${i} 条`);
  const kept = getRecentLogs();
  if (kept.length === 3 && kept.at(-1).msg === '第 6 条') {
    ok('keepRecent 生效：内存里只留最近 3 条');
  } else {
    bad('keepRecent 没生效', JSON.stringify(kept.map((x) => x.msg)));
  }
}

/* ------------------------------------------------ 5. debug 按级别被挡住 */
{
  const f = path.join(dir, 'level.log');
  configureLogger({ file: f, level: 'info', keepRecent: 10 });
  clearRecentLogs();
  const log = createLogger('自测');
  log.debug('这条不该落盘');
  log.info('这条该落盘');
  const text = fs.readFileSync(f, 'utf8');
  // 但最近日志里两笔都在 —— 面板要看到 debug（这是刻意的：emit 先入 recent 再按级别闸）
  if (!text.includes('这条不该落盘') && text.includes('这条该落盘') && getRecentLogs().length === 2) {
    ok('debug 不落盘但进最近日志（面板能看到，文件里看不到）');
  } else {
    bad('级别闸行为不对', JSON.stringify([text.includes('这条不该落盘'), text.includes('这条该落盘'), getRecentLogs().length]));
  }
}

try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  /* 临时目录清不掉无所谓 */
}

console.log('\n' + '='.repeat(56));
console.log(`结果：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log(`  - ${f}`);
}
process.exit(fails.length ? 1 : 0);