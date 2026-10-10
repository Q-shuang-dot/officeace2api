/**
 * 一次性核对：超大请求体现在回给客户端的到底是什么。
 *
 * 起因：塞 ~5.5MB 的对话历史会撞到上游 `ModelArts.81113`
 * （Invalid request body, exceeds the maximum size）。它带的是 HTTP 429，
 * 所以以前被当成"限流" —— 反代原样重试 3 遍、客户端看到 429 也以为只是忙。
 * 修完之后应该是：413 + code=request_too_large + 只打一次上游。
 */
const BASE = process.env.O2A_BASE || 'http://127.0.0.1:7864';
const KEY = process.env.O2A_KEY || 'sk-officeace';
const MODEL = 'deepseek-v4.1-flash';

const filler = '这是一段用于把请求撑爆的填充文本。'.repeat(40);
const messages = [];
for (let i = 0; i < 7500; i += 1) {
  messages.push({ role: 'user', content: `【块 ${i}】${filler}` });
  messages.push({ role: 'assistant', content: '收到。' });
}
const bytes = Buffer.byteLength(JSON.stringify({ model: MODEL, messages }), 'utf8');
console.log(`  body 约 ${(bytes / 1024 / 1024).toFixed(2)} MB / ${messages.length} 条消息`);

const t0 = Date.now();
const r = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: MODEL, max_tokens: 32, messages: [...messages, { role: 'user', content: '回一个字。' }] }),
  signal: AbortSignal.timeout(300000),
});
const txt = await r.text();
const ms = Date.now() - t0;

console.log(`\n  HTTP ${r.status}   ${ms}ms`);
let j = null;
try { j = JSON.parse(txt); } catch { /* 不是 JSON */ }
if (j) {
  console.log(`  error.code    = ${JSON.stringify(j.error?.code)}`);
  console.log(`  error.type    = ${JSON.stringify(j.error?.type)}`);
  console.log(`  error.message = ${String(j.error?.message || '').slice(0, 200)}`);
  console.log(`  attempts 次数 = ${(j.attempts || []).length}`);
} else {
  console.log(`  原始应答前 300 字：${txt.slice(0, 300)}`);
}

const expect = r.status === 413 && j?.error?.code === 'request_too_large' && (j.attempts || []).length <= 1;
console.log(`\n  ${expect ? '✓ 符合预期' : '✗ 和预期不符'}：413 + request_too_large + 不重试`);
process.exit(expect ? 0 : 1);
