/**
 * 上游到底认不认 max_tokens？
 *
 * 现象：客户端给 max_tokens=1，反代按"追加推理预算"发的是 1+1024=1025，
 * 结果正文长度 24 个字符 —— 远超 1 个 token 该有的长度。
 * 也可能是客户端**没给** max_tokens（我上一个脚本是给的），
 * 也可能是上游压根不理会这个小值。
 *
 * 直连上游，绕开反代的所有改写，看它的真实脾气。
 */
import { readFileSync } from 'node:fs';

const oauth = JSON.parse(readFileSync(new URL('../data/oauth-accounts.json', import.meta.url), 'utf8'));
const first = Object.values(oauth).find((r) => r.authorization && r.baseUrl);
const UP = first.baseUrl;
const AUTH = first.authorization;
const M = 'deepseek-v4.1-flash';

async function raw(body, tag) {
  const r = await fetch(`${UP}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: AUTH },
    body: JSON.stringify({ model: M, messages: [{ role: 'user', content: '说一句二十个字的问候' }], ...body }),
  });
  const j = await r.json();
  const c = String(j.choices?.[0]?.message?.content || '');
  const u = j.usage || {};
  console.log(
    `  ${tag.padEnd(26)} HTTP ${r.status}  正文 ${String(c.length).padStart(3)} 字符  ` +
    `completion=${u.completion_tokens ?? '-'}  推理=${u.completion_tokens_details?.reasoning_tokens ?? '-'}  finish=${j.choices?.[0]?.finish_reason ?? '-'}`,
  );
  return c;
}

console.log(`\n  直连上游 ${UP}\n`);
console.log('  ── max_tokens 各值 ──');
for (const mt of [1, 2, 5, 16, 64, 1024, 1025, 2048]) {
  await raw({ max_tokens: mt, stream: false }, `max_tokens=${mt}`);
}

console.log('\n  ── 不给 max_tokens（上游用自己默认）──');
await raw({ stream: false }, '（不给）');

console.log('\n  ── 反代实际会发出的那两个值 ──');
await raw({ max_tokens: 1025, stream: false }, '1025 (=1+1024)');
await raw({ max_tokens: 1088, stream: false }, '1088 (=64+1024)');
