/**
 * 排障：deep4.1 的「推理吃满预算、正文为空」到底还能不能撞到。
 *
 * 背景：上游把 `max_tokens` 当成**总预算**（推理 + 正文），而且**不**按它截正文。
 * 所以只要某次推理特别贪，token 会在推理阶段就用光，正文变空、finish_reason=length。
 *
 * 代理的对策是「把 `max_tokens` 加上一段 allowance」（`minMaxTokens`，默认 1024）。
 * 但 allowance 是**固定值**，而推理需求是**随机的**（实测同一天同参数从 17 到 3158
 * 字符都有）。所以问题是：默认的 1024 够不够？
 *
 * 这个脚本就是去撞那个窗口：用小 `max_tokens` 反复打，把每次的
 * reasoning / content / finish_reason 都摊开，看有没有
 * 「正文为空 + finish_reason=length + reasoning>0」的组合。
 *
 * 撞到了说明 allowance 还得加；没撞到也不能就放心 —— 概率不是零，
 * 下面会把观测到的推理量分布一起报出来，好判断 1024 这个数离危险区有多远。
 *
 * 用法：node tools/diag-empty-window.mjs [每个档位打几次] [模型]
 */
import { writeFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:7864';
const KEY = 'sk-officeace';
const ROUNDS = Number(process.argv[2]) || 12;
const MODEL = process.argv[3] || 'deepseek-v4.1-flash';

const BUDGETS = [16, 64, 256];
const PROMPTS = [
  '用一句话说明你是什么模型',
  '仔细数一下 1 到 20 的质数有哪些，然后回答',
  '比较一下 TCP 和 UDP 的区别，要仔细',
  '写一个函数判断字符串是不是回文',
  '为什么天空是蓝色的？仔细想想',
];

async function once(budget, prompt) {
  const t0 = Date.now();
  let r;
  try {
    r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, max_tokens: budget, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    return { err: err.message, ms: Date.now() - t0 };
  }
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch { /* 上游可能回非 JSON */ }
  const ch = j?.choices?.[0];
  const msg = ch?.message || {};
  return {
    ms: Date.now() - t0,
    status: r.status,
    contentLen: (msg.content || '').length,
    reasonLen: (msg.reasoning_content || '').length,
    finish: ch?.finish_reason || j?.error?.code || '-',
    completion: j?.usage?.completion_tokens ?? null,
    reasoningTokens: j?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    err: j?.error?.message,
  };
}

console.log(`\n══ deep4.1 空正文窗口搜索 ══`);
console.log(`  模型 ${MODEL}   每个预算档打 ${ROUNDS} 次\n`);

const rows = [];
const empty = [];
for (const b of BUDGETS) {
  process.stdout.write(`  max_tokens=${String(b).padStart(4)}  `);
  for (let i = 0; i < ROUNDS; i++) {
    const r = await once(b, PROMPTS[i % PROMPTS.length]);
    rows.push({ budget: b, ...r });
    if (r.err) process.stdout.write('E');
    else if (r.status !== 200) process.stdout.write('X');
    else if (!r.contentLen && r.finish === 'length' && r.reasonLen > 0) { process.stdout.write('☠'); empty.push({ budget: b, ...r }); }
    else if (!r.contentLen) process.stdout.write('○');
    else process.stdout.write('.');
  }
  const mine = rows.filter((x) => x.budget === b && !x.err && x.status === 200);
  const rl = mine.map((x) => x.reasonLen).sort((a, c) => a - c);
  const cl = mine.map((x) => x.contentLen);
  console.log(
    `  正文空 ${cl.filter((x) => !x).length}/${mine.length}` +
    `   推理字符 min=${rl[0] ?? '-'} 中位=${rl.length ? rl[Math.floor(rl.length / 2)] : '-'} max=${rl.at(-1) ?? '-'}` +
    `   正文中位=${cl.length ? cl.slice().sort((a, c) => a - c)[Math.floor(cl.length / 2)] : '-'}`,
  );
}

const ok = rows.filter((r) => !r.err && r.status === 200);
const totalEmpty = ok.filter((r) => !r.contentLen).length;
const danger = ok.filter((r) => !r.contentLen && r.finish === 'length' && r.reasonLen > 0);
const reasonChars = ok.map((r) => r.reasonLen).sort((a, c) => a - c);

console.log(`\n  ── 汇总 ──`);
console.log(`  打了 ${rows.length} 次，HTTP 200 ${ok.length} 次`);
console.log(`  正文为空 ${totalEmpty} 次；其中"推理吃光预算"型（finish=length 且有推理）${danger.length} 次`);
console.log(`  推理字符数分布：min=${reasonChars[0] ?? '-'}  p50=${reasonChars.length ? reasonChars[Math.floor(reasonChars.length * 0.5)] : '-'}  p90=${reasonChars.length ? reasonChars[Math.floor(reasonChars.length * 0.9)] : '-'}  max=${reasonChars.at(-1) ?? '-'}`);
const maxR = reasonChars.at(-1) ?? 0;
console.log('');
if (danger.length) {
  console.log(`  ⚠️ 撞到了 ${danger.length} 次「推理吃光预算、正文为空」。`);
  console.log(`     观测到的最大推理是 ${maxR} 字符（约 ${Math.ceil(maxR / 1.6)} token），`);
  console.log(`     说明还有比 emptyRetryFloorTokens 更贪的请求。`);
  console.log(`     先看这一发的推理 token 数有没有顶到重试预算 —— 顶到了就是"预算还是小"，`);
  console.log(`     没顶到就是别的原因（比如上游直接把那一发截了）。`);
} else {
  console.log(`  ✓ 这一轮没撞到空正文。`);
  console.log(`     注意概率不是零：观测到的最大推理是 ${maxR} 字符（约 ${Math.ceil(maxR / 1.6)} token）。`);
  console.log(`     推理开销是随机的，而且尾部很肥（实测见过 18904 字符 ≈ 11800 token），`);
  console.log(`     所以"零空正文"是做不到的，能做到的是把它压到很低、并且失败那一发能看出来。`);
}

writeFileSync('data/diag-empty-window.json', JSON.stringify({ at: new Date().toISOString(), model: MODEL, rounds: ROUNDS, rows, danger }, null, 2));
console.log(`\n  明细已写入 data/diag-empty-window.json\n`);
process.exit(danger.length ? 1 : 0);
