/**
 * 对话日志一行式格式（`formatChatLine`）的测试
 *
 * 这类"只给人看"的字符串最容易悄悄坏掉：少一个 `-`、UA 里混进一个换行、
 * 或者 `src` 带着 `::ffff:` 前缀，日志照样打得出来，只是难读了。
 * 所以这里断言到**整行字符串**，不做局部匹配。
 *
 * 跑：node tools/test-logfmt.mjs（在项目根目录）
 */

import { formatChatLine, hhmmss, shortAccount, cleanIp } from '../src/logfmt.mjs';

let pass = 0;
let fail = 0;

function eq(name, actual, expected) {
  if (Object.is(actual, expected)) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
  }
}

// 用本地时间构造，测试在哪台机器哪个时区跑都成立
const T = new Date(2026, 0, 2, 3, 4, 5).getTime();
// 每条用例都从这一刻算，所以行首时间恒定是 03:04:05
const base = { startedAt: T, model: 'm' };

console.log('【1】完整一行（字段顺序固定）');
eq(
  '一模一样',
  formatChatLine({
    seq: 909,
    startedAt: T,
    model: 'deepseek-v4.1-flash',
    stream: true,
    status: 200,
    label: 'GT-shuanghsuang',
    accountId: '148c97d7e563433f81f1100f5505b7df:1a9f0953dd3441ad9eabee938ec62435',
    ttfbMs: 1947,
    outTokens: 230,
    tps: 61.5,
    effort: '',
    totalMs: 5700,
    src: '::1',
    ua: 'deepseek-harness/0.2.0-rc.2',
    attempt: 1,
  }),
  '#909 03:04:05 deepseek-v4.1-flash | stream | 200 | GT-shuanghsuang(148c97d7) | TTFB=1.9s | tok=230 | tok/s=61.5 | effort=- | total=5.7s | src=::1 ua="deepseek-harness/0.2.0-rc.2"',
);

console.log('\n【2】缺字段一律 `-`，不写 0 / null / undefined');
eq(
  '全缺',
  formatChatLine({ ...base, stream: true, totalMs: 1200 }),
  '03:04:05 m | stream | - | - | TTFB=- | tok=- | tok/s=- | effort=- | total=1.2s | src=- ua="-"',
);

console.log('\n【3】TTFB 不足 1 秒用 ms，别写成 0.7s');
eq(
  'ttfb=671ms',
  formatChatLine({ ...base, stream: true, status: 200, ttfbMs: 671, totalMs: 1221 }),
  '03:04:05 m | stream | 200 | - | TTFB=671ms | tok=- | tok/s=- | effort=- | total=1.2s | src=- ua="-"',
);

console.log('\n【4】非流式：stream 位置写 json；null 的 TTFB/tps 必须是 `-` 而不是 0');
eq(
  'json 行',
  formatChatLine({ ...base, stream: false, status: 200, outTokens: 12, tps: null, ttfbMs: null, totalMs: 800 }),
  '03:04:05 m | json | 200 | - | TTFB=- | tok=12 | tok/s=- | effort=- | total=800ms | src=- ua="-"',
);

console.log('\n【5】只有 accountId 没有备注名 → (短id)');
eq(
  '无 label',
  formatChatLine({ ...base, stream: true, accountId: '01a1239464a67ab095dd:01a1', totalMs: 1000 }),
  '03:04:05 m | stream | - | (01a12394) | TTFB=- | tok=- | tok/s=- | effort=- | total=1.0s | src=- ua="-"',
);

console.log('\n【6】重试才出现 try=N');
eq(
  'attempt=2',
  formatChatLine({ ...base, stream: true, status: 200, attempt: 2, totalMs: 37748 }),
  '03:04:05 m | stream | 200 | - | TTFB=- | tok=- | tok/s=- | effort=- | total=37.7s | try=2 | src=- ua="-"',
);
eq(
  'attempt=1 不显示',
  formatChatLine({ ...base, stream: true, status: 200, attempt: 1, totalMs: 1000 }).includes('try='),
  false,
);

console.log('\n【7】UA 里的换行/引号/控制字符不会把一行拆成多行');
const dirty = formatChatLine({ ...base, stream: true, totalMs: 1000, ua: 'A"B\r\nC\u0007D' });
eq('不含换行', dirty.includes('\n'), false);
// 顺序：换行→空格、引号→单引号、\u0007 直接删（前后两个字符贴在一起）
eq('清成 A\'B CD', dirty.includes(`ua="A'B CD"`), true);

console.log('\n【8】UA 太长要截断');
const longUa = formatChatLine({ ...base, stream: true, totalMs: 1000, ua: 'x'.repeat(200) });
eq('封顶 64 并带省略号', /ua="x{63}…"$/.test(longUa), true);

console.log('\n【9】src 去掉 IPv4 映射前缀');
eq('::ffff:127.0.0.1', cleanIp('::ffff:127.0.0.1'), '127.0.0.1');
eq('::1 原样', cleanIp('::1'), '::1');
eq('空', cleanIp(''), '-');

console.log('\n【10】序号缺失时不打 `#`');
eq('没有 seq', formatChatLine({ ...base, stream: true, totalMs: 1000 }).startsWith('03:04:05 '), true);

console.log('\n【11】辅助函数');
eq('hhmmss 补零', hhmmss(T), '03:04:05');
eq('shortAccount 取冒号前 8 位', shortAccount('abcdef1234567:xyz'), 'abcdef12');
eq('shortAccount 空', shortAccount(''), '');

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail ? 1 : 0);
