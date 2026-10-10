/**
 * 同一个预算连打多次，看「正文为空」的概率。
 *
 * probe-deep41-budget.mjs 测的是"能不能出正文"，每个组合只打一次 ——
 * 结果 512 那行刚好 5/5，看着像 512 就够了。但同一张表里 P1 在 1024 预算下
 * 烧掉 867 个推理 token，说明**推理开销的方差很大**，单次采样不足以下结论。
 *
 * 这个脚本每个预算连打 N 次，直接给"空正文率"。
 */
import { readFileSync } from 'node:fs';

const oauth = JSON.parse(readFileSync(new URL('../data/oauth-accounts.json', import.meta.url), 'utf8'));
const first = Object.values(oauth).find((r) => r.authorization && r.baseUrl);
const UP = first.baseUrl;
const AUTH = first.authorization;
const M = 'deepseek-v4.1-flash';

const N = Number(process.argv[2]) || 6;
// 两个问题对比着测：
//   P_short 短回答 —— 看"推理吃掉整个预算"的概率
//   P_long  长回答 —— 看"推理 + 正文"总共要多少，确认下限别反而卡住长回答
const PROMPTS = [
  { tag: 'P短 一句话问候', text: '说一句二十个字的问候' },
  { tag: 'P长 写段代码', text: '写一个 Python 冒泡排序，带注释' },
];

async function ask(mt, text) {
  const r = await fetch(`${UP}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: AUTH },
    body: JSON.stringify({ model: M, max_tokens: mt, messages: [{ role: 'user', content: text }] }),
  });
  if (!r.ok) return { err: `HTTP ${r.status}` };
  const j = await r.json();
  return {
    len: String(j.choices?.[0]?.message?.content || '').length,
    reasoning: j.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    completion: j.usage?.completion_tokens ?? 0,
    fin: j.choices?.[0]?.finish_reason,
  };
}

console.log(`\n  每个预算 / 每个问题 连打 ${N} 次\n`);
console.log('  预算    问题          空正文   推理 token（每次）');
const emptyRate = {};
for (const mt of [1024, 1536, 2048, 3072]) {
  emptyRate[mt] = [];
  for (const p of PROMPTS) {
    const rows = [];
    for (let i = 0; i < N; i += 1) rows.push(await ask(mt, p.text));
    const empties = rows.filter((r) => !r.len).length;
    emptyRate[mt].push(empties);
    const rts = rows.map((r) => (r.err ? r.err : r.reasoning));
    const mark = empties === 0 ? '✓' : empties === rows.length ? '✗' : '!';
    console.log(`  ${mark} ${String(mt).padEnd(6)} ${p.tag.padEnd(14)} ${String(empties).padStart(2)}/${N}    ${rts.join(' / ')}`);
  }
}
console.log('\n  ── 汇总：两个问题加起来 2N 次里空了多少 ──');
for (const mt of Object.keys(emptyRate)) {
  const total = emptyRate[mt].reduce((a, b) => a + b, 0);
  console.log(`    ${String(mt).padEnd(6)} 空 ${total}/${N * 2}   ${total === 0 ? '✓' : ''}`);
}
console.log('\n  选下限的目标：2N 次里 0 次空正文（并留一点余量，别卡临界值）\n');
