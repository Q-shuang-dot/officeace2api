/**
 * 用量按天聚合 / 失败原因分类的回归测试。
 *
 * 面板「近 7 天」和「失败原因」直接读这两块数据；口径错了不会报错，
 * 只会让图看起来正常但数字对不上，所以单独测一下。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageStore, usageDayKey, classifyUsageError } from '../src/stats.mjs';

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o2a-usage-daily-'));
const file = path.join(dir, 'usage.json');
const store = new UsageStore({ file, flushMs: 60_000 });

store.record({
  model: 'm1',
  ok: true,
  latencyMs: 100,
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
});
store.record({
  model: 'm1',
  ok: false,
  latencyMs: 50,
  error: '429 Too Many Requests',
});
store.record({
  model: 'm1',
  ok: false,
  latencyMs: 30,
  error: 'fetch failed: ECONNRESET',
});

const day = usageDayKey();
const snap = store.snapshot();
check('当日请求数', snap.daily[day].requests, 3);
check('当日成功数', snap.daily[day].ok, 1);
check('当日失败数', snap.daily[day].failed, 2);
check('当日 tokens', snap.daily[day].total_tokens, 12);
check('429 归类', snap.errors['限流 429'], 1);
check('网络错误归类', snap.errors['网络错误'], 1);
check('超时归类函数', classifyUsageError('request ETIMEDOUT'), '超时');
check('模型权限归类', classifyUsageError('ModelArts.81004'), '模型无权限');
check('参数错误归类', classifyUsageError('81001 bad request'), '请求参数');
check('未知错误归类', classifyUsageError('some weird thing'), '其他');

// 落盘再读，确认旧文件没有 daily/errors 时也不会丢
store.flush();
const reloaded = new UsageStore({ file, flushMs: 60_000 });
const snap2 = reloaded.snapshot();
check('重载后当天请求数', snap2.daily[day].requests, 3);
check('重载后失败分类', snap2.errors['限流 429'], 1);

store.timer?.unref?.();
reloaded.timer?.unref?.();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
