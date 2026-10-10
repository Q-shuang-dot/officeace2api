/**
 * 诊断：为什么把 max_tokens 抬到 1024 之后，还是有「空正文」？
 *
 * 假设 A：抬升没生效（客户端给的还是 64 被透传了）
 * 假设 B：抬升生效了，但模型这一次把 1024 个 token 全烧在推理上
 * 假设 C："空正文"是我的判定写错了（比如命中了错误帧）
 *
 * 做法：把每次响应的 usage 和 finish_reason 全打出来，一眼就能分辨。
 */
const BASE = 'http://127.0.0.1:7864';
const KEY = 'sk-officeace';
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const M = 'deepseek-v4.1-flash';
const PROMPT = '说一句二十个字的问候';

async function one(maxTokens) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ model: M, max_tokens: maxTokens, messages: [{ role: 'user', content: PROMPT }] }),
  });
  const j = await r.json();
  const c = j.choices?.[0];
  return {
    http: r.status,
    contentLen: String(c?.message?.content || '').length,
    reasoningLen: String(c?.message?.reasoning_content || '').length,
    finish: c?.finish_reason,
    nChoices: (j.choices || []).length,
    completionTokens: j.usage?.completion_tokens,
    reasoningTokens: j.usage?.completion_tokens_details?.reasoning_tokens,
    totalTokens: j.usage?.total_tokens,
    err: j.error ? JSON.stringify(j.error).slice(0, 120) : '',
  };
}

console.log(`\n  每次请求的完整 usage（客户端一律给 max_tokens=64，看反代抬到多少）\n`);
console.log('  #   HTTP  content  reasoning  finish    completion  reasoning_tok  total');
for (let i = 1; i <= 8; i += 1) {
  const r = await one(64);
  console.log(
    `  ${String(i).padEnd(3)} ${String(r.http).padEnd(5)} ${String(r.contentLen).padStart(7)} ${String(r.reasoningLen).padStart(10)}  ${String(r.finish).padEnd(8)} ${String(r.completionTokens).padStart(10)} ${String(r.reasoningTokens).padStart(13)} ${String(r.totalTokens).padStart(6)}`,
  );
  if (r.err) console.log(`       错误：${r.err}`);
}

console.log(`\n  ── 判读 ──`);
console.log('  completion_tokens 稳定 ≫ 64  → 抬升生效了（假设 A 排除）');
console.log('  content=0 且 reasoning_tokens = completion_tokens → 假设 B：模型这次把预算全烧在推理上');
console.log('  content=0 但 reasoning_tokens ≪ completion_tokens → 有别的字段被吃掉，要继续查');
