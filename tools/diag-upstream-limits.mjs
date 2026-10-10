/**
 * 摸清上游两条**不同的**上限，别把它们混成一条。
 *
 * 实测踩到的第一条（`ModelArts.81113`，HTTP 429）原文是：
 *   Invalid request body, exceeds the maximum size , messages max size is: 5000.
 * 注意最后那句 —— **是 `messages` 的条数上限，5000 条**，跟 token 没关系。
 * 我第一次撞它时以为是"上下文太长"，其实那是 15000 条消息（7500 块 ×2）
 * 撑出来的，换成 3000 条长消息就撞不到了。
 *
 * 所以这里有两条独立的线：
 *   ① **条数**：`messages.length` ≤ 5000 → 超了回 81113
 *   ② **窗口**：prompt token 数超了模型的 context window → 回另一套错
 *
 * 这个脚本把两条都摸出来。`max_tokens: 1` 让每发只花约 1 token，成本可以忽略。
 */
const BASE = process.env.O2A_BASE || 'http://127.0.0.1:7864';
const KEY = process.env.O2A_KEY || 'sk-officeace';
const MODEL = process.env.O2A_MODEL || 'deepseek-v4.1-flash';
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` };

const call = async (messages, extra = {}) => {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ model: MODEL, max_tokens: 1, messages, ...extra }),
      signal: AbortSignal.timeout(600000),
    });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch { /* 非 JSON */ }
    return {
      status: r.status,
      ms: Date.now() - t0,
      code: j?.error?.code || null,
      type: j?.error?.type || null,
      msg: String(j?.error?.message || '').slice(0, 200),
      promptTokens: j?.usage?.prompt_tokens ?? null,
      attempts: (j?.attempts || []).length,
    };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, code: null, msg: `${e.name}: ${e.message}` };
  }
};

/* ── ① 条数上限：5000 条 ─────────────────────────────────────────── */

console.log('\n【①】messages 条数上限（上游说 5000）');
console.log('     用小消息（每条几个字）单独测条数，和 token 无关');

const countCase = (n) => {
  const msgs = [];
  const half = Math.floor(n / 2);
  for (let i = 0; i < half; i += 1) {
    msgs.push({ role: 'user', content: `a${i}` });
    msgs.push({ role: 'assistant', content: 'b' });
  }
  while (msgs.length < n) msgs.push({ role: 'user', content: 'x' });
  return msgs.slice(0, n);
};

let lo = null; // 已知能过的最大条数
let hi = null; // 已知被拒的最小条数
// 注意：被拒之后反代回的是 `413 / request_too_large`（我们改过的），
// 上游原来的 `ModelArts.81113` 只留在 message 里。所以这里两种都算"被拒"。
for (const n of [4990, 5000, 5001, 5100]) {
  const r = await call(countCase(n));
  const rejected = r.status === 413 || r.code === 'ModelArts.81113' || /81113/.test(r.msg);
  console.log(`     messages=${String(n).padStart(5)}  HTTP ${r.status}  ${rejected ? '被拒' : r.status === 200 ? '通过' : '?'}  ${r.ms}ms`);
  if (rejected) { if (hi === null || n < hi) hi = n; }
  else if (r.status === 200) { if (lo === null || n > lo) lo = n; }
  else console.log(`         （既不是 200 也不是被拒，message: ${r.msg.slice(0, 120)}）`);
}

console.log('');
if (lo !== null && hi !== null && hi - lo === 1) {
  console.log(`  → 条数上限正好是 ${lo}：${lo} 条过、${hi} 条被拒。`);
  console.log(`     和上游自报的 "messages max size is: 5000" 完全对得上。`);
} else if (lo !== null && hi !== null) {
  console.log(`  → 条数上限落在 ${lo}（过）和 ${hi}（拒）之间`);
} else if (hi !== null) {
  console.log(`  → 至少 ${hi} 条会被拒`);
} else {
  console.log('  → 这一档没撞到条数上限');
}

/* ── ② 窗口上限：用"条数少但每条很长"撑 token ───────────────────── */

console.log('\n【②】上下文窗口上限（每条很长、但总条数远小于 5000）');
console.log('     ⚠️ 这一项会往上游发很大的 prompt，每发可能真花掉一笔额度');

// 每条约 4000 汉字 ≈ 6000 token
const bigFiller = '海水的平均盐度约为千分之三十五，这一数值在不同海域会有差异。'.repeat(120);

const windowCase = (nBlocks) => {
  const msgs = [];
  for (let i = 0; i < nBlocks; i += 1) {
    msgs.push({ role: 'user', content: `【${i}】${bigFiller}` });
    msgs.push({ role: 'assistant', content: '收到。' });
  }
  msgs.push({ role: 'user', content: '回一个字。' });
  return msgs;
};

/*
 * 一开始我用「字符数 × 0.75」估 token，估出来 60 块 ≈ 162k，
 * 实测只有 123k —— 因为那段填充文本重复度极高，压缩率比自然文本好得多。
 * 所以下面**只信上游回报的 `prompt_tokens`**，估算值仅作粗参考。
 *
 * 已知 123k 能过，段位就往上加。
 */
for (const blocks of [60, 120, 200, 320]) {
  const msgs = windowCase(blocks);
  const approxTokens = Math.round(msgs.reduce((n, m) => n + m.content.length, 0) * 0.75);
  const r = await call(msgs);
  const tag = r.status === 200
    ? `200  实测 prompt_tokens=${r.promptTokens}`
    : `${r.status}  ${r.code || '-'}${/81113/.test(r.msg) ? '(81113)' : ''}`;
  console.log(`     ${String(blocks).padStart(3)} 块（粗估 ${String(approxTokens).padStart(7)} token，messages=${msgs.length} 条）→ ${tag}   ${r.ms}ms`);
  if (r.status !== 200) console.log(`         message: ${r.msg.slice(0, 200)}`);
  if (/81113/.test(r.msg)) {
    console.log('         ↑ 仍然撞的是 **条数/字节**那条线，还没到 token 窗口');
  }
  if (r.status === 413 && /81113/.test(r.msg) && msgs.length <= 5000) {
    console.log('         注意：条数没超 5000 却回 81113 → 说明还有一条**请求体字节数**上限，');
    console.log('              或者上游把 `max size` 用在了别的地方。');
  }
}

console.log('\n  （跑完这个脚本只是摸边界，改不了任何配置。参数没调对就加大 blocks 再跑。）\n');
