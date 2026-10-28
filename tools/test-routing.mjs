#!/usr/bin/env node
/** 路由纯函数：会话黏性 key / Retry-After 解析。 */

import { retryAfterMsOf, sessionAffinityKey } from '../src/routing.mjs';

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  if (Object.is(actual, expected)) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

console.log('【1】显式会话 ID 优先');
{
  const req = { headers: { 'x-session-id': 'abc' } };
  check('带 header 的 key', sessionAffinityKey({ messages: [] }, 'm', req), 'm|id:abc');
}

console.log('\n【2】首条 user 稳定，system 变化不影响');
{
  const a = { messages: [{ role: 'system', content: 'date 1' }, { role: 'user', content: 'hello' }] };
  const b = { messages: [{ role: 'system', content: 'date 2' }, { role: 'user', content: 'hello' }] };
  check('同一 user 同 key', sessionAffinityKey(a, 'm'), sessionAffinityKey(b, 'm'));
  const c = { messages: [{ role: 'user', content: 'other' }] };
  check('不同 user 不同 key', sessionAffinityKey(a, 'm') === sessionAffinityKey(c, 'm'), false);
}

console.log('\n【3】Retry-After 秒数 / 日期 / 上限');
{
  const h = (v) => ({ get: () => v });
  check('秒数', retryAfterMsOf(h('3')), 3000);
  check('空值', retryAfterMsOf(h('')), 0);
  const future = new Date(Date.now() + 5000).toUTCString();
  const ms = retryAfterMsOf(h(future));
  check('HTTP 日期在 4-6 秒之间', ms >= 4000 && ms <= 6000, true);
  check('超长值封顶 10 分钟', retryAfterMsOf(h('999999')), 600000);
}

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail ? 1 : 0);
