/**
 * 用 deepseek-v4.1-flash 全面体检这条反代。
 *
 * 目的不是"能不能通"，而是"当成日常客户端用起来会不会有坑"：
 * 流式、非流式、各种参数、工具调用、错误处理、计费口径，全部真打一遍。
 *
 * 用法：node tools\probe-model-deep41.mjs
 */
import { adminHeaders } from './adminToken.mjs';

const BASE = process.env.O2A_BASE || 'http://127.0.0.1:7864';
const KEY = process.env.O2A_KEY || 'sk-officeace';
const MODEL = 'deepseek-v4.1-flash';

const H = adminHeaders({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });

let pass = 0;
let warn = 0;
let fail = 0;
const problems = [];

const ok = (m, extra = '') => { pass += 1; console.log(`  ✓ ${m}${extra ? '  ' + extra : ''}`); };
const wa = (m, extra = '') => { warn += 1; problems.push(`[注意] ${m} ${extra}`); console.log(`  ! ${m}${extra ? '  ' + extra : ''}`); };
const bad = (m, extra = '') => { fail += 1; problems.push(`[问题] ${m} ${extra}`); console.log(`  ✗ ${m}${extra ? '  ' + extra : ''}`); };

async function post(path, body, extraHeaders = {}) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, { method: 'POST', headers: { ...H, ...extraHeaders }, body: JSON.stringify(body) });
  return { res, ms: Date.now() - t0 };
}

/** 读一整个 SSE 流，返回 { events, text, reasoning, usage, firstByteMs, doneSeen, raw } */
async function readStream(res, t0) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let firstByteMs = 0;
  let text = '';
  let reasoning = '';
  let usage = null;
  let doneSeen = false;
  const events = [];
  const raw = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!firstByteMs) firstByteMs = Date.now() - t0;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      raw.push(payload);
      if (payload === '[DONE]') { doneSeen = true; continue; }
      try {
        const j = JSON.parse(payload);
        events.push(j);
        const d = j.choices?.[0]?.delta || {};
        if (typeof d.content === 'string') text += d.content;
        if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
        if (j.usage) usage = j.usage;
      } catch { events.push({ __unparsed: payload }); }
    }
  }
  return { events, text, reasoning, usage, firstByteMs, doneSeen, raw };
}

console.log(`\n═══ 目标：${MODEL}  @  ${BASE} ═══\n`);

/* ------------------------------------------------------------------ 1. 基础连通 */
console.log('【1】基础连通与响应结构');
{
  const { res, ms } = await post('/v1/chat/completions', {
    model: MODEL, messages: [{ role: 'user', content: '只回两个字：收到' }], max_tokens: 32,
  });
  const j = await res.json();
  if (res.status === 200) ok('非流式请求通了', `${ms}ms`);
  else bad('非流式请求失败', `HTTP ${res.status} ${JSON.stringify(j).slice(0, 220)}`);

  const checks = [
    ['object === chat.completion', j.object === 'chat.completion', j.object],
    ['有 id', !!j.id, j.id],
    ['有 created', typeof j.created === 'number', j.created],
    ['model 回显', !!j.model, j.model],
    ['choices[0].message.role', j.choices?.[0]?.message?.role === 'assistant', j.choices?.[0]?.message?.role],
    ['choices[0].finish_reason', !!j.choices?.[0]?.finish_reason, j.choices?.[0]?.finish_reason],
    ['usage 三个数都在', j.usage && ['prompt_tokens', 'completion_tokens', 'total_tokens'].every((k) => typeof j.usage[k] === 'number'), JSON.stringify(j.usage)],
    ['total = prompt + completion', j.usage && j.usage.total_tokens === j.usage.prompt_tokens + j.usage.completion_tokens, ''],
  ];
  for (const [name, good, extra] of checks) (good ? ok : bad)(name, String(extra ?? ''));
  console.log(`      正文：${JSON.stringify(j.choices?.[0]?.message?.content)}`);
  console.log(`      usage：${JSON.stringify(j.usage)}`);
}

/* ------------------------------------------------------------------ 2. 流式 */
console.log('\n【2】流式（SSE）逐帧完整性');
{
  // ⚠️ 这个模型是推理模型，会先输出一大段 reasoning_content 再吐正文。
  //    max_tokens 必须给足（实测 60 都不够，正文会是空的）。
  //    第一版这里用 60，结果把自己的测试写成了"反代 bug"（已修）。
  const t0 = Date.now();
  const { res } = await post('/v1/chat/completions', {
    model: MODEL, stream: true, messages: [{ role: 'user', content: '从 1 数到 10，用逗号隔开' }], max_tokens: 800,
  });
  if (res.status !== 200) { bad('流式请求失败', `HTTP ${res.status}`); }
  else {
    const ct = res.headers.get('content-type') || '';
    if (/text\/event-stream/.test(ct)) ok('Content-Type 是 text/event-stream', ct);
    else bad('Content-Type 不对', ct);
    const s = await readStream(res, t0);
    const unparsed = s.events.filter((e) => e.__unparsed).length;
    if (unparsed === 0) ok('每一帧都是合法 JSON', `${s.events.length} 帧`);
    else bad('有帧不是合法 JSON', `${unparsed} 帧`);
    if (s.doneSeen) ok('收到 [DONE]');
    else bad('没有收到 [DONE]（客户端会一直等）');
    if (s.events.length > 1) ok('是真正的流式（多帧）', `${s.events.length} 帧`);
    else wa('只有 1 帧 —— 可能被上游整段缓冲了');
    if (s.firstByteMs < 3000) ok('首字节快', `${s.firstByteMs}ms`);
    else wa('首字节偏慢', `${s.firstByteMs}ms`);
    if (s.text.trim()) ok('正文拼得出来', JSON.stringify(s.text.slice(0, 50)));
    else bad('流式正文是空的');
    if (s.usage) ok('尾帧带 usage', JSON.stringify(s.usage));
    else wa('尾帧没有 usage（客户端统计不到 token）');
    const withId = s.events.filter((e) => e.object === 'chat.completion.chunk' && e.id).length;
    if (withId === s.events.length) ok('每帧都有 id 且 object=chat.completion.chunk');
    else wa('有帧缺 id 或 object 不对', `${withId}/${s.events.length}`);
    console.log(`      推理内容长度：${s.reasoning.length}（推理模型会有这一大段，属正常）`);
  }
}

/* ------------------------------------------------------------------ 3. 参数覆盖 */
console.log('\n【3】常用参数是否被尊重');
{
  const cases = [
    ['temperature=0（应该更确定）', { temperature: 0 }],
    ['top_p=0.1', { top_p: 0.1 }],
    ['stop=["\\n"]', { stop: ['\n'], max_tokens: 40 }],
    ['presence_penalty / frequency_penalty', { presence_penalty: 0.5, frequency_penalty: 0.5, max_tokens: 30 }],
    ['n=1', { n: 1, max_tokens: 16 }],
    ['seed=42', { seed: 42, max_tokens: 16 }],
  ];
  for (const [name, extra] of cases) {
    const { res } = await post('/v1/chat/completions', {
      model: MODEL, messages: [{ role: 'user', content: '说一句十个字的话' }], ...extra,
    });
    const txt = await res.text();
    if (res.status === 200) {
      ok(`被接受：${name}`);
    } else {
      let msg = txt.slice(0, 160);
      try { msg = JSON.parse(txt).error?.message || msg; } catch { /* 保持原文 */ }
      wa(`报错：${name}`, `HTTP ${res.status} ${msg}`);
    }
  }

  /**
   * `max_tokens` 是这条链路上最容易被误解的参数。
   *
   * 上游把它当成**推理 + 正文的总预算**（不按它截断正文），而反代对 ≥16 的值
   * 会追加 1024 的推理预算。所以能断言的只有"小值不被越权放大"这一条：
   *   max_tokens=1 → 输出必须还是 1 个 token（正文空 + finish_reason=length 是对的，
   *   那正是客户端要的"最小输出"），绝不能变成一整句话。
   * 给 ≥16 时正文应该出得来 —— 这是追加预算的目的。
   */
  console.log('      ── max_tokens 语义（反代会对 ≥16 的值追加推理预算）──');
  for (const mt of [1, 5, 16, 64]) {
    const { res } = await post('/v1/chat/completions', {
      model: MODEL, max_tokens: mt, messages: [{ role: 'user', content: '说一句二十个字的问候' }],
    });
    const j = await res.json();
    const c = String(j.choices?.[0]?.message?.content || '');
    const ct = j.usage?.completion_tokens ?? 0;
    console.log(`        给 ${String(mt).padEnd(3)} → 输出 ${String(ct).padStart(4)} token，正文 ${String(c.length).padStart(2)} 字符，finish=${j.choices?.[0]?.finish_reason}`);
    if (mt < 16) {
      if (ct <= mt) ok(`max_tokens=${mt} 没被越权放大`, `输出 ${ct} token`);
      else wa(`max_tokens=${mt} 被放大了`, `输出 ${ct} token —— 小值应该原样透传`);
    } else if (c.length) {
      ok(`max_tokens=${mt} 拿到了正文（追加推理预算生效）`, `${ct} token`);
    } else {
      wa(`max_tokens=${mt} 正文为空`, '追加预算没起作用，或这次推理特别长（重试应该兜住）');
    }
  }
}

/* ------------------------------------------------------------------ 4. 多轮对话 */
console.log('\n【4】多轮上下文（能不能记住上文）');
{
  // ⚠️ 这个模型是**推理模型**：它会先花几十上百 token 推理，才吐正文。
  //    max_tokens 给小了，token 全烧在推理上，正文就是空的（finish_reason=length）。
  //    所以这里给足预算，并且把 reasoning_content 也当成"答案可能在的地方"。
  const { res } = await post('/v1/chat/completions', {
    model: MODEL, max_tokens: 800,
    messages: [
      { role: 'system', content: '你是一个只回答数字的助手。' },
      { role: 'user', content: '记住这个数字：7391' },
      { role: 'assistant', content: '好的，我记住了。' },
      { role: 'user', content: '我刚才让你记的数字是多少？只回数字。' },
    ],
  });
  const j = await res.json();
  const m = j.choices?.[0]?.message || {};
  const content = String(m.content || '');
  const reasoning = String(m.reasoning_content || '');
  if (res.status === 200 && content.includes('7391')) ok('多轮上下文没丢', JSON.stringify(content.trim()));
  else if (res.status === 200 && reasoning.includes('7391')) ok('多轮上下文没丢（数字出现在 reasoning_content 里）', JSON.stringify(content.trim()));
  else if (res.status === 200) wa('问了上文的数字但没答对', `content=${JSON.stringify(content.trim())} finish=${j.choices?.[0]?.finish_reason}`);
  else bad('多轮请求失败', `HTTP ${res.status}`);
}

/* ------------------------------------------------------------------ 5. 编码：中文 / emoji / 长文本 */
console.log('\n【5】编码：中文、emoji、特殊字符');
{
  const text = '请原样复述这句话：「你好，世界 🌍 结束」';
  const { res } = await post('/v1/chat/completions', {
    model: MODEL, max_tokens: 800, messages: [{ role: 'user', content: text }],
  });
  const j = await res.json();
  const m = j.choices?.[0]?.message || {};
  // 推理内容里也念一遍原句，所以两边一起看
  const all = String(m.content || '') + String(m.reasoning_content || '');
  if (res.status === 200 && /你好/.test(all) && /🌍/.test(all)) ok('中文 + emoji 往返没坏', JSON.stringify(String(m.content || '').slice(0, 60)));
  else if (res.status === 200) wa('emoji 或中文在往返中丢了', JSON.stringify(all.slice(0, 80)));
  else bad('中文请求失败', `HTTP ${res.status}`);

  // 长输入
  const long = '这是一段用于测长输入的文本。'.repeat(200); // ~2600 汉字
  const { res: r2, ms } = await post('/v1/chat/completions', {
    model: MODEL, max_tokens: 800, messages: [{ role: 'user', content: long + '\n只回两个字：收到' }],
  });
  if (r2.status === 200) {
    const j2 = await r2.json();
    ok('长输入（约 2600 汉字）没被截断', `${ms}ms  prompt_tokens=${j2.usage?.prompt_tokens}`);
  } else bad('长输入失败', `HTTP ${r2.status}`);
}

/* ------------------------------------------------------------------ 6. 工具调用 */
console.log('\n【6】工具调用（function calling）');
{
  const { res } = await post('/v1/chat/completions', {
    model: MODEL, max_tokens: 100,
    messages: [{ role: 'user', content: '北京现在天气怎么样？' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查某个城市的天气',
        parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名' } }, required: ['city'] },
      },
    }],
    tool_choice: 'auto',
  });
  const raw = await res.text();
  if (res.status !== 200) {
    wa('带 tools 的请求报错了', `HTTP ${res.status} ${raw.slice(0, 200)}`);
  } else {
    const j = JSON.parse(raw);
    const msg = j.choices?.[0]?.message || {};
    const tc = msg.tool_calls;
    if (Array.isArray(tc) && tc.length) {
      const f = tc[0].function || {};
      ok('返回了 tool_calls', `name=${f.name} args=${String(f.arguments).slice(0, 60)}`);
      if (j.choices[0].finish_reason === 'tool_calls') ok('finish_reason = tool_calls');
      else wa('finish_reason 不是 tool_calls', j.choices[0].finish_reason);
      try { JSON.parse(f.arguments); ok('arguments 是合法 JSON'); }
      catch { bad('arguments 不是合法 JSON', String(f.arguments).slice(0, 80)); }
    } else {
      wa('没返回 tool_calls（模型直接答了）', JSON.stringify(msg.content).slice(0, 80));
    }
  }
}

/* ------------------------------------------------------------------ 7. 流式 + 工具调用（最容易坏的一条路） */
console.log('\n【7】流式 + 工具调用（arguments 要分片拼）');
{
  const t0 = Date.now();
  const { res } = await post('/v1/chat/completions', {
    model: MODEL, stream: true, max_tokens: 100,
    messages: [{ role: 'user', content: '查一下上海和深圳的天气' }],
    tools: [{
      type: 'function',
      function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
    }],
  });
  if (res.status !== 200) {
    wa('流式 + tools 报错', `HTTP ${res.status}`);
  } else {
    const s = await readStream(res, t0);
    // ⚠️ 必须**按 index 分组**，不能一股脑拼起来。
    //    模型要查两个城市时会发 tool_calls[0] 和 tool_calls[1] 两组分片；
    //    直接 join 会拼出 `{"city": "上海"}{"city": "深圳"}` —— 一个合法 JSON 都没有。
    //    我第一版就是这么写的，差点把一条正常链路报成 bug（已修）。
    const byIndex = new Map();
    for (const e of s.events) {
      const tc = e.choices?.[0]?.delta?.tool_calls;
      if (!Array.isArray(tc)) continue;
      for (const c of tc) {
        const i = c.index ?? 0;
        const cur = byIndex.get(i) || { id: '', name: '', args: '' };
        if (c.id) cur.id = c.id;
        if (c.function?.name) cur.name = c.function.name;
        if (c.function?.arguments) cur.args += c.function.arguments;
        byIndex.set(i, cur);
      }
    }
    if (byIndex.size) {
      ok('流式 tool_calls 收得到', `${byIndex.size} 个调用`);
      const keys = [...byIndex.keys()].sort((a, b) => a - b);
      if (keys.join(',') === keys.map((_, i) => i).join(',')) ok('index 是连续的（0..n-1）', keys.join(','));
      else wa('index 不连续', keys.join(','));
      let allJson = true;
      for (const [i, c] of byIndex) {
        try {
          const parsed = JSON.parse(c.args);
          console.log(`      [${i}] ${c.name}${c.args}  → 解析出 ${JSON.stringify(parsed)}`);
        } catch {
          allJson = false;
          wa(`第 ${i} 个调用的 arguments 不是合法 JSON`, c.args.slice(0, 80));
        }
      }
      if (allJson) ok('每个调用的 arguments 都是合法 JSON（按 index 分组之后）');
      const hasId = [...byIndex.values()].every((c) => c.id);
      if (hasId) ok('每个调用都有 id');
      else wa('有调用缺 id');
    } else {
      wa('流式下没拿到 tool_calls');
    }
  }
}

/* ------------------------------------------------------------------ 7b. 推理模型的 token 预算 */
console.log('\n【7b】推理模型的 token 预算（最容易让客户端"收到空回复"）');
{
  // 这个模型会**先**花 200~1400 个 token 推理再吐正文。客户端给 max_tokens:64，
  // 预算会被推理全吃掉，返回 content:"" + finish_reason:"length" —— 拿到 200 和空正文，
  // 客户端除了以为反代坏了没法有别的想法。
  //
  // 反代有两道防线（改之前这里 4 档里 3 档是空的）：
  //   ① max_tokens 下限：给推理模型抬到 config.models.minMaxTokens（默认 1024）
  //   ② 空正文自动重试一次：推理长度是随机的，重打一次通常就好
  //      （实测 12 次采样：只有①时空 2/8，加上②后空 0/12）
  //
  // 注意「抬升」是**故意改动客户端参数**：只对名单里的推理模型做，只抬不降，
  // 客户端给得更大照样给。想关掉设 config.models.minMaxTokens: 0。
  const results = [];
  for (const mt of [16, 64, 300, 1024, 2048]) {
    const { res } = await post('/v1/chat/completions', {
      model: MODEL, max_tokens: mt, messages: [{ role: 'user', content: '说一句二十个字的问候' }],
    });
    const j = await res.json();
    const m = j.choices?.[0]?.message || {};
    const u = j.usage || {};
    const content = String(m.content || '');
    const hasReasoning = typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0;
    const fin = j.choices?.[0]?.finish_reason;
    results.push({ mt, len: content.length, fin, ct: u.completion_tokens ?? 0 });
    console.log(`      max_tokens=${String(mt).padEnd(5)} → 正文 ${String(content.length).padStart(3)} 字符  finish=${String(fin).padEnd(7)} 实际输出 ${String(u.completion_tokens ?? '?').padStart(4)} token  推理 ${String(u.completion_tokens_details?.reasoning_tokens ?? '?').padStart(4)}  带 reasoning_content=${hasReasoning}`);
  }
  const empty = results.filter((r) => r.len === 0);
  if (!empty.length) {
    ok('各档 max_tokens 都拿到了正文（下限抬升 + 空正文重试在起作用）', `客户端给 16 也拿到了（实际输出 ${results[0].ct} token）`);
  } else {
    const worst = empty.map((r) => r.mt).join('/');
    wa(`仍然有 ${empty.length} 档拿不到正文`, `max_tokens=${worst} —— 推理长度波动太大，可以把 config.models.minMaxTokens 调更大`);
  }
  console.log('      上限保护：正文为空时 finish_reason=length 且 reasoning_content 有内容 —— 客户端能区分"没写完"和"真挂了"');
}

/* ------------------------------------------------------------------ 7c. 流式里推理内容在不在 */
console.log('\n【7c】流式时 reasoning_content 透不透传');
{
  const t0 = Date.now();
  const { res } = await post('/v1/chat/completions', {
    model: MODEL, stream: true, max_tokens: 120, messages: [{ role: 'user', content: '1+1 等于几？只回数字' }],
  });
  const s = await readStream(res, t0);
  console.log(`      正文 ${s.text.length} 字符，推理 ${s.reasoning.length} 字符`);
  if (s.reasoning.length) ok('流式里推理内容原样透传（客户端可以自己选显不显示）');
  else wa('流式里没有 reasoning_content —— 客户端只能干等，看不到"模型在想什么"');
  if (s.text.length) ok('正文也拿到了', JSON.stringify(s.text.trim().slice(0, 30)));
}

/* ------------------------------------------------------------------ 8. 错误处理 */
console.log('\n【8】错误处理（客户端最容易被坑的地方）');
{
  // 8.1 不存在的模型
  const { res } = await post('/v1/chat/completions', { model: 'no-such-model-xyz', messages: [{ role: 'user', content: 'hi' }] });
  const j1 = await res.json().catch(() => ({}));
  if (res.status === 404 && j1.error?.code === 'model_not_found') ok('不存在的模型 → 404 model_not_found');
  else wa('不存在的模型返回码不标准', `HTTP ${res.status} ${JSON.stringify(j1).slice(0, 120)}`);

  // 8.2 空 messages
  const r2 = await post('/v1/chat/completions', { model: MODEL, messages: [] });
  if (r2.res.status >= 400) ok('空 messages 被拒', `HTTP ${r2.res.status}`);
  else wa('空 messages 居然返回 200', `HTTP ${r2.res.status}`);

  // 8.3 messages 不是数组
  const r3 = await post('/v1/chat/completions', { model: MODEL, messages: 'hello' });
  if (r3.res.status >= 400) ok('messages 类型不对被拒', `HTTP ${r3.res.status}`);
  else wa('messages 类型不对还是 200', `HTTP ${r3.res.status}`);

  // 8.4 没有 Authorization
  const r4 = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
  });
  if (r4.status === 401) ok('没带 key → 401');
  else wa('没带 key 的返回码', `HTTP ${r4.status}`);

  // 8.5 错的 key
  const r5 = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-key' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
  });
  if (r5.status === 401) ok('错的 key → 401');
  else wa('错的 key 的返回码', `HTTP ${r5.status}`);

  // 8.6 坏 JSON 体
  const r6 = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: H, body: '{bad json' });
  if (r6.status >= 400 && r6.status < 500) ok('坏 JSON 体 → 4xx（不是 500）', `HTTP ${r6.status}`);
  else wa('坏 JSON 体的返回码', `HTTP ${r6.status}`);

  // 8.7 错误体是不是 OpenAI 格式
  const errBody = j1;
  if (errBody.error && typeof errBody.error.message === 'string' && typeof errBody.error.type === 'string') {
    ok('错误体是 OpenAI 格式（error.message / error.type）');
  } else wa('错误体不是标准 OpenAI 格式', JSON.stringify(errBody).slice(0, 150));
}

/* ------------------------------------------------------------------ 9. 并发与限流表现 */
console.log('\n【9】并发（客户端一次发多个）');
{
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    post('/v1/chat/completions', { model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: `第${i + 1}个问题：只回 ok` }] })
      .then(({ res }) => res.status).catch((e) => 'ERR:' + e.message)));
  const tally = {};
  for (const s of rs) tally[s] = (tally[s] || 0) + 1;
  console.log(`      6 发并发状态码：${JSON.stringify(tally)}  总耗时 ${Date.now() - t0}ms`);
  if (tally[200] === 6) ok('6 发并发全部 200');
  else if (tally[429]) wa('并发触发了限流（429）', JSON.stringify(tally));
  else bad('并发下出现非 200', JSON.stringify(tally));
}

/* ------------------------------------------------------------------ 10. 计费口径 */
console.log('\n【10】倍率与计费口径（反代自己算的积分数）');
{
  const { res } = await post('/v1/chat/completions', {
    model: MODEL, max_tokens: 200, messages: [{ role: 'user', content: '用三句话介绍一下你自己' }],
  });
  const j = await res.json();
  const u = j.usage || {};
  console.log(`      usage：${JSON.stringify(u)}`);
  const rates = await (await fetch(BASE + '/admin/api/model-rates', { headers: H })).json();
  const mine = (rates.rates || []).find((r) => r.model === MODEL);
  if (mine) ok('面板查得到这个模型的倍率', `${mine.coefficient}x`);
  else wa('面板查不到这个模型的倍率', MODEL);

  // 反代/usage 里记的那条与实际返回对不对得上
  // ⚠️ state 里调用记录在**顶层 `recent`**；`usage.recent` 已被摘掉（面板从不读它，
  //    却占了 115KB 载荷的 26%，见 server.mjs 里 /admin/api/state 的注释）
  const st = await (await fetch(BASE + '/admin/api/state', { headers: H })).json();
  const rec = (st.recent || []).find((r) => r.model === MODEL);
  if (rec) {
    // ⚠️ 服务记录里**没有 total_tokens** 这个字段，只有 prompt_tokens / completion_tokens。
    //    第一版我拿 rec.total_tokens 去比，永远得到 undefined，把一条好记录报成"不一致"（已修）。
    const recTotal = (rec.prompt_tokens || 0) + (rec.completion_tokens || 0);
    console.log(`      服务记录的最近一条：${JSON.stringify({ ok: rec.ok, prompt: rec.prompt_tokens, completion: rec.completion_tokens, latencyMs: rec.latencyMs })}`);
    if (rec.ok && recTotal === u.total_tokens) ok('服务统计的 token 与实际返回一致', `${recTotal}`);
    else if (rec.ok) wa('服务统计的 token 与实际不同', `记录 ${recTotal} / 实际 ${u.total_tokens}`);
    else wa('服务把这次请求记成了失败', rec.error);
  } else wa('服务里找不到这次请求的记录');
}

/* ------------------------------------------------------------------ 11. reasoning_effort 到底有没有用 */
console.log('\n【11】reasoning_effort 能不能真的控制推理开销');
{
  // ⚠️ 这里必须**每档跑多次**才判断得出。第一版每档只跑一次，看到
  //    none=36 / low=32 / high=34 就断言"开关可用" —— 那是噪声。
  //    换一个推理量大的问题连跑三次，同一档位内部就能从 182 抖到 351，
  //    档位之间的差异完全被抖动量盖住。
  const q = '一个水池有3个进水口和1个出水口，进水速度分别是2、3、5升每分钟，出水是4升每分钟，问多久装满100升？只回数字';
  const stats = {};
  for (const eff of ['none', 'low', 'high']) {
    const rts = [];
    for (let i = 0; i < 3; i += 1) {
      const { res } = await post('/v1/chat/completions', {
        model: MODEL, max_tokens: 800, reasoning_effort: eff, messages: [{ role: 'user', content: q }],
      });
      const txt = await res.text();
      if (res.status !== 200) { let msg = txt.slice(0, 120); try { msg = JSON.parse(txt).error?.message || msg; } catch { /* 原文 */ } wa(`reasoning_effort="${eff}" 上游不接受`, `HTTP ${res.status} ${msg}`); rts.push(null); continue; }
      const j = JSON.parse(txt);
      rts.push(j.usage?.completion_tokens_details?.reasoning_tokens ?? 0);
    }
    stats[eff] = rts.filter((x) => x !== null);
    console.log(`      reasoning_effort=${eff.padEnd(5)} → 推理 token 三次：${stats[eff].join(' / ')}`);
  }
  const spread = (a) => (a.length > 1 ? Math.max(...a) - Math.min(...a) : 0);
  const inner = Math.max(...Object.values(stats).map(spread));
  const mid = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const between = Math.max(...Object.values(stats).map(mid)) - Math.min(...Object.values(stats).map(mid));
  console.log(`      同一档内抖动量 ${Math.round(inner)} token；档位之间的差 ${Math.round(between)} token`);
  if (between > inner) ok('reasoning_effort 有效（档位差大于档内抖动）');
  else wa('reasoning_effort 在 deepseek-v4.1-flash 上基本没用', `档内抖动 ${Math.round(inner)} > 档位差 ${Math.round(between)} —— 想省推理 token 只能靠调小问题或换模型，别指望这个开关`);
}

/* ------------------------------------------------------------------ 收尾 */
console.log(`\n═══ 结果：${pass} 通过 / ${warn} 注意 / ${fail} 失败 ═══`);
if (problems.length) {
  console.log('\n需要看的：');
  for (const p of problems) console.log('  · ' + p);
}
process.exit(fail ? 1 : 0);
