/**
 * 诊断：流式回复正文为空时，那条告警该不该打出来？
 *
 * 现象：verify 脚本那次流式确实出现了「正文0字符 推理1568字符」，
 * 但 logs\server.log 里没有对应的 WARN。
 *
 * 可能：
 *   A) 那次不是 finish_reason=length（模型自己停了，只是没说话）
 *   B) 我的判定条件写错了（字段名 / 取值）
 *   C) 告警打了但被日志轮转切掉了
 */
const BASE = 'http://127.0.0.1:7864';
const KEY = 'sk-officeace';
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function streamOnce(maxTokens) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, max_tokens: maxTokens, messages: [{ role: 'user', content: '说一句二十个字的问候' }] }),
  });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let reasoning = '';
  let fin = null;
  let lastUsage = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const p = s.slice(5).trim();
      if (p === '[DONE]') continue;
      try {
        const j = JSON.parse(p);
        const d = j.choices?.[0]?.delta || {};
        if (typeof d.content === 'string') text += d.content;
        if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
        if (j.choices?.[0]?.finish_reason) fin = j.choices[0].finish_reason;
        if (j.usage) lastUsage = j.usage;
      } catch { /* 跳过 */ }
    }
  }
  return { text, reasoning, fin, usage: lastUsage };
}

console.log('\n  流式 8 次，把 finish_reason 完整打出来：\n');
console.log('  #   正文  推理    finish_reason   reasoning_tokens  completion_tokens');
let hit = 0;
for (let i = 1; i <= 8; i += 1) {
  const r = await streamOnce(64);
  const rt = r.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const ct = r.usage?.completion_tokens ?? 0;
  console.log(
    `  ${String(i).padEnd(3)} ${String(r.text.length).padStart(4)} ${String(r.reasoning.length).padStart(6)}  ${String(r.fin).padEnd(14)} ${String(rt).padStart(16)} ${String(ct).padStart(17)}`,
  );
  if (!r.text.length && r.fin === 'length' && rt > 0) hit += 1;
}
console.log(`\n  符合「正文空 + finish=length + 有推理 token」的：${hit}/8`);
console.log('  这几条应该各自在 server.log 里留一条 WARN 正文为空\n');
