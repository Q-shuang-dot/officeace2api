/**
 * 生成速度（日志里的 `tps`）计算测试
 *
 * 为什么要单独测：这个数只用来"看快慢"，算错了不会报错、只会悄悄误导人。
 * 四类坑各一条断言：
 *   ① 分子用了 total_tokens（把 10 万 token 的提示词算进"生成速度"）
 *   ② 分母从请求开始算（把选号/排队/首字等待算进去）
 *   ③ 观测窗口太短（非流式、单块吐完）还算出一个几千 tps 的毛刺
 *   ④ 拿不到 completion_tokens 时用 0 或 total 顶替
 *
 * 跑：node tools/test-tps.mjs（在项目根目录）
 */

import { calcTps } from '../src/server.mjs';

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

const T = 1_000_000; // 基准时刻，取什么值无所谓，只看差值

console.log('【1】正常流式：1000 输出 token，生成阶段 5 秒 → 200 tps');
check(
  'completion=1000 span=5000ms',
  calcTps({ prompt_tokens: 100_000, completion_tokens: 1000, total_tokens: 101_000 }, T, T + 1000, T + 6000),
  200,
);

console.log('\n【2】分子只用 completion_tokens，不掺 prompt');
// 同样的时间、同样 1000 输出，但提示词 10 万：结果必须还是 200，不是 20200
check(
  'prompt 很大也不影响',
  calcTps({ prompt_tokens: 100_000, completion_tokens: 1000, total_tokens: 101_000 }, T, T + 1000, T + 6000),
  200,
);

console.log('\n【3】分母从首字算起，不含首字前的等待');
// 请求进来后 10 秒才有第一个字，然后 2 秒生成 600 token → 300 tps（不是 600/12000=50）
check(
  'ttft=10s 时不被拉低',
  calcTps({ completion_tokens: 600 }, T, T + 10_000, T + 12_000),
  300,
);

console.log('\n【4】窗口太短 → null（不是 0，也不是毛刺）');
check('span=150ms', calcTps({ completion_tokens: 900 }, T, T + 500, T + 650), null);
check('span=0ms（首块即末块）', calcTps({ completion_tokens: 900 }, T, T + 500, T + 500), null);

console.log('\n【5】缺数据 → null');
check('usage 为 null', calcTps(null, T, T + 1000, T + 6000), null);
check('没有 completion_tokens', calcTps({ prompt_tokens: 5000, total_tokens: 6000 }, T, T + 1000, T + 6000), null);
check('completion_tokens=0', calcTps({ completion_tokens: 0 }, T, T + 1000, T + 6000), null);

console.log('\n【6】非流式（firstDataAt 没给）→ 退回 startedAt');
// 上游一次吐完、但我们仍给了 5 秒窗口：按"开始→结束"算
check('firstDataAt=0 时退回 startedAt', calcTps({ completion_tokens: 500 }, T, 0, T + 5000), 100);

console.log('\n【7】四舍五入');
check('1000 tokens / 3s = 333.3 → 333', calcTps({ completion_tokens: 1000 }, T, T, T + 3000), 333);
check('1000 tokens / 6s = 166.6 → 167', calcTps({ completion_tokens: 1000 }, T, T, T + 6000), 167);

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail ? 1 : 0);
