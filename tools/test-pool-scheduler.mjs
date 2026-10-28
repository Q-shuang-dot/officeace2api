/**
 * 号池调度器测试
 *
 * 覆盖四件容易悄悄坏掉、但不会报错的事：
 *   ① 无样本时仍然公平轮询（不能因为打分永远选第一个）；
 *   ② 会话黏性：同一会话 TTL 内回同一个号（决定 prefix cache 能不能命中）；
 *   ③ 在途软上限：一个号满了就换下一个，而不是继续往上叠；
 *   ④ EWMA 首包延迟 + Retry-After 冷却。
 *
 * 跑：node tools/test-pool-scheduler.mjs
 */

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

function makePool(n = 3, opts = {}) {
  const pool = new CredentialPool({
    maxInFlightPerCredential: 2,
    sessionTtlSeconds: 1800,
    latencyWeightMs: 800,
    ...opts,
  });
  for (let i = 0; i < n; i += 1) {
    pool.add({
      baseUrl: `https://cred-${i}.example/v1`,
      headers: { Authorization: `Bearer token-${i}` },
      source: 'test',
      userId: `user-${i}`,
      accountId: `acct-${i}`,
    });
  }
  return pool;
}

console.log('【1】无延迟样本时按游标公平轮询');
{
  const pool = makePool(3);
  const picked = [];
  for (let i = 0; i < 3; i += 1) {
    const e = pool.pick('model-x');
    picked.push(e.key);
    pool.release(e);
  }
  check('三轮选中三个不同的号', new Set(picked).size, 3);
}

console.log('\n【2】会话黏性：同一会话跨请求回同一个号');
{
  const pool = makePool(3);
  const first = pool.pick('model-x', { sessionKey: 'conversation-1', trackInFlight: true });
  pool.release(first);
  const second = pool.pick('model-x', { sessionKey: 'conversation-1', trackInFlight: true });
  check('第二次仍是同一个 key', second.key, first.key);
  pool.release(second);
}

console.log('\n【3】在途软上限：一个号满了就换下一个');
{
  const pool = makePool(2, { maxInFlightPerCredential: 1 });
  const a = pool.pick('model-x', { sessionKey: 's1', trackInFlight: true });
  const b = pool.pick('model-x', { sessionKey: 's2', trackInFlight: true });
  check('两个会话落在不同号上', a.key === b.key, false);
  pool.release(a);
  pool.release(b);
}

console.log('\n【4】EWMA 首包延迟：快号优先');
{
  const pool = makePool(2);
  const [fast, slow] = pool.entries;
  pool.release(fast, 1000);
  pool.release(fast, 2000); // 0.7*1000 + 0.3*2000 = 1300
  pool.release(slow, 5000);
  check('EWMA 计算', fast.ewmaTtfbMs, 1300);
  const picked = pool.pick('model-x');
  check('选中更快的号', picked.key, fast.key);
}

console.log('\n【5】Retry-After 会拉长冷却，但有上限');
{
  const pool = makePool(1);
  const e = pool.entries[0];
  pool.markRateLimited(e, null, '429', 120_000);
  const left = e.cooldownUntil - Date.now();
  check('冷却至少 110 秒', left > 110_000, true);
  check('冷却不超过 10 分钟', left <= 600_000, true);
}

console.log('\n【6】每个模型独立的 EWMA，慢模型不污染快模型');
{
  const pool = makePool(2);
  const [fast, slow] = pool.entries;
  pool.release(fast, 1000, 'model-a');
  pool.release(slow, 5000, 'model-a');
  // 让 fast 在 model-b 上看起来慢、slow 看起来快
  pool.release(fast, 5000, 'model-b');
  pool.release(slow, 1000, 'model-b');
  const picked = pool.pick('model-a');
  check('model-a 仍选快号', picked.key, fast.key);
  check('list 暴露 modelTtfb', pool.list()[0].modelTtfb['model-a'].ms > 0, true);
}

console.log('\n【7】全满时短队列：等释放后成功');
{
  const pool = makePool(1, { maxInFlightPerCredential: 1, queueTimeoutMs: 1000 });
  const first = await pool.acquire('model-x', { sessionKey: 'q1', trackInFlight: true });
  const started = Date.now();
  const pending = pool.acquire('model-x', { sessionKey: 'q2', trackInFlight: true });
  setTimeout(() => pool.release(first), 120);
  const second = await pending;
  check('等到释放后拿到号', !!second, true);
  check('等待时间 >= 100ms', Date.now() - started >= 100, true);
  check('队列计数已记录', pool.stats().queueAdmitted, 1);
  pool.release(second);
}

console.log('\n【8】队列超时后退回软上限，不把请求 503');
{
  const pool = makePool(1, { maxInFlightPerCredential: 1, queueTimeoutMs: 100 });
  const first = await pool.acquire('model-x', { sessionKey: 'q3', trackInFlight: true });
  const started = Date.now();
  const second = await pool.acquire('model-x', { sessionKey: 'q4', trackInFlight: true });
  check('超时仍拿到号', !!second, true);
  check('超时不再等满 10 秒', Date.now() - started < 1000, true);
  check('超时计数已记录', pool.stats().queueTimeouts, 1);
  pool.release(first);
  pool.release(second);
}

console.log('\n【9】会话黏性命中/未命中计数');
{
  const pool = makePool(2);
  const a = pool.pick('model-x', { sessionKey: 's1', trackInFlight: true });
  pool.release(a);
  const b = pool.pick('model-x', { sessionKey: 's1', trackInFlight: true });
  pool.release(b);
  const c = pool.pick('model-x', { sessionKey: 's2', trackInFlight: true });
  pool.release(c);
  check('命中 1 次', pool.stats().affinityHits, 1);
  // s1 第一次建立绑定算一次未命中，s2 第一次也算一次 → 2 次
  check('未命中 2 次', pool.stats().affinityMisses, 2);
}

console.log('\n【10】list() 暴露在途和首包，供面板显示');
{
  const pool = makePool(1);
  const e = pool.pick('model-x', { trackInFlight: true });
  check('在途为 1', pool.list()[0].inFlight, 1);
  pool.release(e, 1234);
  check('首包写入面板字段', pool.list()[0].ewmaTtfbMs, 1234);
  check('已释放', pool.list()[0].inFlight, 0);
}

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail ? 1 : 0);
