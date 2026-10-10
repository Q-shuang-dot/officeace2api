/**
 * 扫一遍目录里的模型，找出**哪些是推理模型**（先推理再作答）。
 *
 * 为什么必须扫而不是猜：
 *   `deepseek-v4.1-flash` 是我一开始就发现的（名字带 4.1），所以加进了内置名单。
 *   结果 `glm-5.2` —— 名字里一点提示都没有 —— 给 max_tokens:64 时
 *   completion_tokens 直接干到 1100，多的那次 8460。它也在闷头推理。
 *   靠"名字像推理模型"去编名单，永远会漏。
 *
 * 判据：completion_tokens 明显超过请求的 max_tokens，就是被推理吃掉了。
 */
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:7864';
const KEY = 'sk-officeace';
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const PROBE_MAX_TOKENS = 64;

const models = (await (await fetch(`${BASE}/v1/models`, { headers: H })).json()).data.map((m) => m.id);
console.log(`\n  目录里 ${models.length} 个模型。每个都用 max_tokens=${PROBE_MAX_TOKENS} 问一句短话，\n  看 completion_tokens 有没有被推理撑爆。\n`);
console.log('  模型                        状态     耗时     完成tokens  推理tokens  正文  判读');
console.log('  ' + '─'.repeat(96));

const reasoning = [];
const normal = [];
const broken = [];

for (const m of models) {
  const t0 = Date.now();
  let row;
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ model: m, max_tokens: PROBE_MAX_TOKENS, messages: [{ role: 'user', content: '说一句十个字以内的话' }] }),
      signal: AbortSignal.timeout(120000),
    });
    const txt = await r.text();
    const j = JSON.parse(txt);
    if (!r.ok || j.error) {
      row = { state: `HTTP ${r.status}`, ms: Date.now() - t0, verdict: '用不了：' + String(j.error?.message || txt).slice(0, 40), kind: 'broken' };
    } else {
      const ct = j.usage?.completion_tokens ?? 0;
      const rt = j.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      const clen = String(j.choices?.[0]?.message?.content || '').length;
      // 判据：completion_tokens 超过请求上限的 2 倍 → 推理在吃预算
      const isReasoning = ct > PROBE_MAX_TOKENS * 2 || rt > 0;
      row = {
        state: 'ok',
        ms: Date.now() - t0,
        ct,
        rt,
        clen,
        kind: isReasoning ? 'reasoning' : 'normal',
        verdict: isReasoning ? `推理模型（超预算 ${(ct / PROBE_MAX_TOKENS).toFixed(0)} 倍）` : '普通模型',
      };
    }
  } catch (err) {
    row = { state: '请求异常', ms: Date.now() - t0, verdict: '超时/断连：' + String(err.message).slice(0, 30), kind: 'broken' };
  }

  if (row.kind === 'reasoning') reasoning.push(m);
  else if (row.kind === 'normal') normal.push(m);
  else broken.push({ m, why: row.verdict });

  console.log(
    '  ' + m.padEnd(28) +
    String(row.state).padEnd(9) +
    (String(row.ms) + 'ms').padEnd(9) +
    String(row.ct ?? '-').padStart(9) + '  ' +
    String(row.rt ?? '-').padStart(9) + '  ' +
    String(row.clen ?? '-').padStart(4) + '  ' +
    row.verdict,
  );
}

console.log('\n  ══ 结论 ══');
console.log(`\n  推理模型（${reasoning.length} 个）—— 必须进 reasoningModels 名单：`);
for (const m of reasoning) console.log('    ' + m);
console.log(`\n  普通模型（${normal.length} 个）：`);
console.log('    ' + (normal.join(', ') || '（无）'));
if (broken.length) {
  console.log(`\n  用不了 / 超时（${broken.length} 个）：`);
  for (const b of broken) console.log(`    ${b.m.padEnd(28)} ${b.why}`);
}

console.log('\n  ── 直接可用的配置 ──');
console.log(JSON.stringify({ models: { minMaxTokens: 1024, reasoningModels: reasoning } }, null, 2));
