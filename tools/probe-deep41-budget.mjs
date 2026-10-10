/**
 * 量一下：deepseek-v4.1-flash 的 max_tokens 给多少才**稳定**出正文。
 *
 * 为什么直连上游测：反代现在会把过小的 max_tokens 抬到下限（见 upstream.mjs），
 * 走反代就测不出"客户端给 64 会怎样"了。直连才能看到模型的真实脾气。
 *
 * 结论用来定 `config.models.minMaxTokens` 那个下限该设多少。
 */
import { readFileSync } from 'node:fs';

const oauth = JSON.parse(readFileSync(new URL('../data/oauth-accounts.json', import.meta.url), 'utf8'));
const first = Object.values(oauth).find((r) => r.authorization && r.baseUrl);
const UP = first.baseUrl;
const AUTH = first.authorization;

const M = 'deepseek-v4.1-flash';
const PROMPTS = [
  { tag: 'P1 一句话问候', text: '说一句二十个字的问候' },
  { tag: 'P2 算术', text: '1+1=？只回数字' },
  { tag: 'P3 自我介绍', text: '用三句话介绍一下你自己' },
  { tag: 'P4 写代码', text: '写一个 Python 冒泡排序' },
  { tag: 'P5 逻辑题', text: '一个水池三个进水口(2,3,5升/分)一个出水口(4升/分)，多久装满100升？只回数字' },
];

async function ask(text, mt) {
  const r = await fetch(`${UP}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: AUTH },
    body: JSON.stringify({ model: M, max_tokens: mt, messages: [{ role: 'user', content: text }] }),
  });
  if (!r.ok) return { err: `HTTP ${r.status}` };
  const j = await r.json();
  const c = String(j.choices?.[0]?.message?.content || '');
  return { len: c.length, reasoning: j.usage?.completion_tokens_details?.reasoning_tokens ?? 0, fin: j.choices?.[0]?.finish_reason };
}

const LEVELS = [128, 256, 384, 512, 768, 1024, 1536];
console.log(`\n  直连上游：${UP}`);
console.log('  ✓n = 有正文且推理用了 n 个 token；✗ = 正文为空\n');
console.log('  ' + '预算'.padEnd(8) + PROMPTS.map((p) => p.tag.padEnd(10)).join(''));
const table = {};
for (const mt of LEVELS) {
  const row = [];
  table[mt] = [];
  for (const p of PROMPTS) {
    const r = await ask(p.text, mt);
    if (r.err) { row.push(r.err.padEnd(10)); table[mt].push(0); continue; }
    const cell = r.len ? `✓${r.reasoning}` : '✗';
    row.push(cell.padEnd(10));
    table[mt].push(r.len ? 1 : 0);
  }
  console.log('  ' + String(mt).padEnd(8) + row.join(''));
}

console.log('\n  ── 每个预算的通过率 ──');
let suggested = 0;
for (const mt of LEVELS) {
  const hit = table[mt].filter(Boolean).length;
  const pct = Math.round((hit / PROMPTS.length) * 100);
  console.log(`    ${String(mt).padEnd(6)} ${hit}/${PROMPTS.length}  (${pct}%)`);
  if (pct === 100 && !suggested) suggested = mt;
}
console.log(
  suggested
    ? `\n  → 全是正文字的最小预算是 ${suggested}，建议把 minMaxTokens 定在 ${suggested} 以上（本脚本用的是单轮短问题，真实多轮对话只会更费）`
    : '\n  → 即使 1536 也没能全部出正文 —— 这个模型对短问也会长篇推理，建议下限定 2048',
);
