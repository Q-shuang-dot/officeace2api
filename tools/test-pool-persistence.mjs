/**
 * 号池运行态持久化 + 连续失败熔断测试
 *
 * 覆盖：
 *   ① 5xx / 传输层的连续失败会触发熔断，单次失败不会；
 *   ② 熔断等级递增时冷却时间翻倍；
 *   ③ 429 连续发生时指数退避，但有上限；
 *   ④ 冷却、会话黏性、连败状态能跨进程恢复；
 *   ⑤ 状态文件不包含 Authorization / 原始会话 key；
 *   ⑥ 损坏的状态文件不会把服务带崩。
 *
 * 跑：node tools/test-pool-persistence.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialPool } from '../src/pool.mjs';

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function makePool(stateFile = '', opts = {}) {
  const pool = new CredentialPool({
    maxInFlightPerCredential: 1,
    sessionTtlSeconds: 1800,
    latencyWeightMs: 800,
    stateFile,
    ...opts,
  });
  for (let i = 0; i < 2; i += 1) {
    pool.add({
      baseUrl: `https://persist-${i}.example/v1`,
      headers: { Authorization: `Bearer token-${i}` },
      source: 'test',
      userId: `user-${i}`,
      accountId: `acct-${i}`,
    });
  }
  return pool;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o2a-pool-state-'));

console.log('【1】单次失败不熔断，连续失败才熔断');
{
  const pool = makePool('', { breakerThreshold: 2, breakerCooldownMs: 1000, breakerMaxMs: 4000 });
  const e = pool.entries[0];
  pool.markFailed(e, '502 first');
  check('第一次不冷却', e.cooldownUntil, 0);
  pool.markFailed(e, '502 second');
  check('第二次触发冷却', e.cooldownUntil > Date.now(), true);
  check('熔断等级为 1', e.breakerLevel, 1);
  check('面板能读到熔断剩余时间', pool.list()[0].breakerMsLeft > 0, true);
}

console.log('\n【2】熔断等级递增，冷却时间翻倍');
{
  const pool = makePool('', { breakerThreshold: 2, breakerCooldownMs: 1000, breakerMaxMs: 4000 });
  const e = pool.entries[0];
  pool.markFailed(e, 'a');
  pool.markFailed(e, 'b');
  const first = e.cooldownUntil - Date.now();
  pool.markFailed(e, 'c');
  pool.markFailed(e, 'd');
  const second = e.cooldownUntil - Date.now();
  check('第一次约 1 秒', first <= 1100, true);
  check('第二次约 2 秒', second > first, true);
  check('等级升到 2', e.breakerLevel, 2);
}

console.log('\n【3】连续 429 指数退避，且不超过配置上限');
{
  const pool = makePool('', {
    cooldownOnRateLimitMs: 100,
    cooldownOnRateLimitMaxMs: 500,
  });
  const e = pool.entries[0];
  pool.markRateLimited(e, null, '429 first');
  const first = e.cooldownUntil - Date.now();
  pool.markRateLimited(e, null, '429 second');
  const second = e.cooldownUntil - Date.now();
  check('第一次约 100ms', first <= 200, true);
  check('第二次更长', second > first, true);
  check('不超过 500ms', second <= 600, true);
  check('429 连击计数为 2', e.softRateStreak, 2);
}

console.log('\n【4】冷却和会话黏性跨实例恢复');
{
  const stateFile = path.join(tmpDir, 'pool-state.json');
  const p1 = makePool(stateFile, { breakerThreshold: 10 });
  const [a, b] = p1.entries;
  p1.markRateLimited(a, null, '429');
  const chosen = p1.pick('model-x', { sessionKey: 'conversation-1', trackInFlight: true });
  check('冷却中的号没被选中', chosen.key, b.key);
  p1.release(chosen);
  check('状态已落盘', p1.flushState(), true);

  const raw = fs.readFileSync(stateFile, 'utf8');
  check('状态文件不含 Authorization', raw.includes('token-0') || raw.includes('token-1'), false);
  check('状态文件不含原始会话 key', raw.includes('conversation-1'), false);

  const p2 = makePool(stateFile, { breakerThreshold: 10 });
  check('冷却跨实例恢复', p2.entries[0].cooldownUntil > Date.now(), true);
  const hit = p2.pick('model-x', { sessionKey: 'conversation-1', trackInFlight: true });
  check('会话绑定跨实例恢复', hit.key, chosen.key);
  check('恢复后算一次黏性命中', p2.stats().affinityHits, 1);
  p2.release(hit);
}

console.log('\n【5】损坏的状态文件按空状态启动');
{
  const bad = path.join(tmpDir, 'bad-state.json');
  fs.writeFileSync(bad, '{ this is not json', 'utf8');
  let thrown = '';
  try {
    const pool = makePool(bad);
    check('仍能加入凭据', pool.size, 2);
  } catch (err) {
    thrown = String(err?.message || err);
  }
  check('不抛异常', thrown, '');
}

console.log('\n【6】过期状态不会被恢复');
{
  const oldFile = path.join(tmpDir, 'old-state.json');
  fs.writeFileSync(oldFile, JSON.stringify({
    version: 1,
    savedAt: '2020-01-01T00:00:00.000Z',
    entries: { x: { cooldownUntil: Date.now() + 60_000 } },
    sessions: {},
  }), 'utf8');
  const pool = makePool(oldFile);
  check('旧状态不产生冷却', pool.entries[0].cooldownUntil, 0);
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail ? 1 : 0);
