/**
 * 深挖 deepseek-v4.1-flash 这条反代的两个可疑点：
 *
 *  ① 非流式返回 content=""（答案是不是跑到 reasoning_content 里去了？）
 *  ② 流式 tool_calls 分片拼出来不是合法 JSON（是上游没给 index，还是反代丢了？）
 *
 * 做法：同一个请求**同时**打上游网关和本服务，逐帧对比，看差异到底出在谁身上。
 */
const BASE = process.env.O2A_BASE || 'http://127.0.0.1:7864';
const KEY = process.env.O2A_KEY || 'sk-officeace';
const MODEL = 'deepseek-v4.1-flash';

/* ---- 从本服务拿一条上游凭据，好做直连对照 ---- */
const st = await (await fetch(`${BASE}/admin/api/state`, { headers: { Authorization: `Bearer ${KEY}` } })).json();
const cred = st.pool?.[0];
if (!cred) {
  console.log('  拿不到上游凭据，无法做直连对照');
  process.exit(1);
}
// state 里只给了 authPreview，真 key 得从 config / 凭据文件里拿
const { readFileSync } = await import('node:fs');
const oauth = JSON.parse(readFileSync(new URL('../data/oauth-accounts.json', import.meta.url), 'utf8'));
const first = Object.values(oauth).find((r) => r.authorization && r.baseUrl);
const UP = first.baseUrl;
const AUTH = first.authorization;
console.log(`  上游：${UP}`);
console.log(`  凭据：${AUTH.slice(0, 14)}…（${first.id?.slice(0, 8)}…）\n`);

const body = (stream) => ({
  model: MODEL,
  stream,
  max_tokens: 200,
  messages: [{ role: 'user', content: '记住这个数字：7391。然后只回这个数字。' }],
});

/* ══════════════ ① 非流式：content 到底在哪 ══════════════ */
console.log('══ ① 非流式 content 是不是空的 ══');
{
  // 直连上游
  const r1 = await fetch(`${UP}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: AUTH }, body: JSON.stringify(body(false)),
  });
  const raw1 = await r1.text();
  console.log(`  [上游直连] HTTP ${r1.status}`);
  console.log(`  [上游原始] ${raw1.slice(0, 700)}`);
}
{
  // 走本服务
  const r2 = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body(false)),
  });
  const j = await r2.json();
  console.log(`\n  [走本服务] HTTP ${r2.status}`);
  const m = j.choices?.[0]?.message || {};
  console.log(`    content          = ${JSON.stringify(m.content)}`);
  console.log(`    reasoning_content= ${JSON.stringify(String(m.reasoning_content || '').slice(0, 80))}`);
  console.log(`    finish_reason    = ${j.choices?.[0]?.finish_reason}`);
  console.log(`    usage            = ${JSON.stringify(j.usage)}`);
  if (m.content !== undefined) console.log('    → 说明反代确实把上游那个字段带出来了');
}

/* ══════════════ ② 流式 tool_calls 的 index ══════════════ */
console.log('\n\n══ ② 流式 tool_calls：上游有没有给 index ══');
const toolBody = {
  model: MODEL,
  stream: true,
  max_tokens: 200,
  messages: [{ role: 'user', content: '查一下上海和深圳的天气' }],
  tools: [{
    type: 'function',
    function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
  }],
};

async function collect(url, headers, payload, tag) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (res.status !== 200) { console.log(`  [${tag}] HTTP ${res.status} ${(await res.text()).slice(0, 200)}`); return []; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const frames = [];
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
      try { frames.push(JSON.parse(p)); } catch { /* 跳过 */ }
    }
  }
  return frames;
}

const upFrames = await collect(`${UP}/chat/completions`, { 'Content-Type': 'application/json', Authorization: AUTH }, toolBody, '上游直连');
const myFrames = await collect(`${BASE}/v1/chat/completions`, { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, toolBody, '本服务');

function reportToolFrames(frames, tag) {
  console.log(`\n  [${tag}] 共 ${frames.length} 帧，带 tool_calls 的：`);
  let n = 0;
  for (const f of frames) {
    const d = f.choices?.[0]?.delta;
    if (!Array.isArray(d?.tool_calls)) continue;
    n += 1;
    for (const tc of d.tool_calls) {
      console.log(`    index=${JSON.stringify(tc.index)}  id=${JSON.stringify(tc.id)}  name=${JSON.stringify(tc.function?.name)}  args=${JSON.stringify(tc.function?.arguments)}`);
    }
  }
  if (!n) console.log('    （一帧都没有）');
  const hasIndex = frames.some((f) => (f.choices?.[0]?.delta?.tool_calls || []).some((tc) => tc.index !== undefined));
  console.log(`    → 分片里带 index 吗？ ${hasIndex ? '带了 ✓' : '没带 ⚠️'}`);
  return hasIndex;
}

const upHasIndex = reportToolFrames(upFrames, '上游直连');
const myHasIndex = reportToolFrames(myFrames, '本服务');

console.log('\n  ── 结论 ──');
if (!upHasIndex && !myHasIndex) {
  console.log('    上游自己就不给 index（模型没按 OpenAI 规范分片）。');
  console.log('    反代**不该**照抄一个虚假的 index=0 —— 那样客户端会把多个工具调用拼成一坨。');
} else if (upHasIndex && !myHasIndex) {
  console.log('    ✗ 上游给了 index，但本服务把它丢了 —— 这是反代的 bug。');
} else {
  console.log('    两边一致，问题在上游或模型行为本身。');
}
