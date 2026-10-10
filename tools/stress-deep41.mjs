/**
 * 大批量压力测试：long-context / 多轮会话 / 高并发 / 稳定性
 *
 * 目标模型：`deepseek-v4.1-flash`（推理模型，最容易被预算和上下文撑坏的那种）。
 *
 * 这份脚本回答四个问题：
 *
 *   ① **会话会不会断** —— 几十轮的连续对话，中途有没有哪一轮报错、
 *      或者上下文丢了（前面对过的话后面不记得）。
 *   ② **上下文扛不扛得住** —— 长历史（上万 token）+ 埋在不同深度的"暗号"，
 *      问它能不能把暗号全找出来。这一段同时验证：反代有没有偷偷截断 messages。
 *   ③ **并发撑不撑得住** —— 一次几十发同时打，看状态码分布、有没有串号
 *      （并发下最容易出的问题是"答的不是问的那句"）、有没有连接被拒。
 *   ④ **长时间跑会不会退化** —— 连着打几百发，看延迟和错误率有没有随时间爬升。
 *
 * ⚠️ 这个脚本是**只读**的：只发请求 + 读统计，不改配置、不改号池。
 *    唯一副作用是消耗额度（每发都会真花积分）。默认规模故意压得比较小，
 *    要压满用命令行参数抬（见下）。
 *
 * 用法：
 *   node tools/stress-deep41.mjs                      # 默认规模，约 3~5 分钟
 *   node tools/stress-deep41.mjs --turns=40           # 长会话轮数
 *   node tools/stress-deep41.mjs --concurrent=40      # 并发数
 *   node tools/stress-deep41.mjs --burst=120          # 连续打多少发
 *   node tools/stress-deep41.mjs --context=12000      # 长上下文目标 token
 *   node tools/stress-deep41.mjs --all                # 全上，跑满（会花不少额度）
 */
import { adminHeaders } from './adminToken.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.O2A_BASE || 'http://127.0.0.1:7864';
const KEY = process.env.O2A_KEY || 'sk-officeace';
const MODEL = process.env.O2A_MODEL || 'deepseek-v4.1-flash';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);
const ALL = has('all');

const TURNS = arg('turns', ALL ? 50 : 24);
const CONCURRENT = arg('concurrent', ALL ? 48 : 24);
const BURST = arg('burst', ALL ? 150 : 60);
const CONTEXT_TOKENS = arg('context', ALL ? 14000 : 9000);

const H = adminHeaders({ 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` });

/* ────────────────────────────── 小工具 ────────────────────────────── */

let pass = 0;
let fail = 0;
const ok = (m, d) => { pass++; console.log(`  ✓ ${m}${d ? `  ${d}` : ''}`); };
const bad = (m, d) => { fail++; console.log(`  ✗ ${m}${d ? `  ${d}` : ''}`); };
const note = (m) => console.log(`  · ${m}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 这一轮上游实际计费的 token 合计（prompt + completion，含推理） */
let billedTokens = 0;
const addBilled = (usage) => {
  if (usage) billedTokens += (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
};

async function chat(payload, { timeoutMs = 300000 } = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ model: MODEL, ...payload }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* 可能不是 JSON */ }
    const msg = j?.choices?.[0]?.message || {};
    if (j?.usage) addBilled(j.usage);
    return {
      status: r.status,
      ms: Date.now() - t0,
      content: msg.content || '',
      reasoning: msg.reasoning_content || '',
      finish: j?.choices?.[0]?.finish_reason || null,
      usage: j?.usage || null,
      toolCalls: msg.tool_calls || null,
      err: j?.error?.message || (r.ok ? null : text.slice(0, 200)),
      raw: text,
    };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, content: '', err: `${e.name}: ${e.message}` };
  }
}

/** 流式：把 delta 拼起来，返回和 chat() 同形状的结果 */
async function chatStream(payload, { timeoutMs = 300000 } = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ model: MODEL, stream: true, ...payload }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      const t = await r.text();
      return { status: r.status, ms: Date.now() - t0, content: '', frames: 0, err: t.slice(0, 200) };
    }    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let content = '';
    let reasoning = '';
    let frames = 0;
    let badFrames = 0;
    let sawDone = false;
    let usage = null;
    let finish = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { sawDone = true; continue; }
        frames += 1;
        let o;
        try { o = JSON.parse(data); } catch { badFrames += 1; continue; }
        const d = o?.choices?.[0]?.delta || {};
        if (d.content) content += d.content;
        if (d.reasoning_content) reasoning += d.reasoning_content;
        if (o?.choices?.[0]?.finish_reason) finish = o.choices[0].finish_reason;
        if (o?.usage) usage = o.usage;
      }
    }
    if (usage) addBilled(usage);
    return { status: r.status, ms: Date.now() - t0, content, reasoning, frames, badFrames, sawDone, usage, finish, err: null };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, content: '', frames: 0, err: `${e.name}: ${e.message}` };
  }
}

const short = (s, n = 40) => (String(s || '').replace(/\s+/g, ' ').trim().slice(0, n) || '(空)');
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/* ────────────────────────── ① 长会话：会不会断 ────────────────────────── */

async function testLongConversation() {
  console.log(`\n【1】长会话：连打 ${TURNS} 轮，看会不会断 / 上下文会不会丢`);
  console.log('    （埋暗号：第 1 轮的随机词 + 每轮编号，最后一起问）');

  const secret = `ZX${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const history = [];
  const failures = [];
  const latencies = [];
  let firstLostAt = null;

  for (let turn = 1; turn <= TURNS; turn += 1) {
    // 每轮塞一个"只有这一轮说了才可能被记住"的信息
    const word = `词${turn}-${secret}`;
    history.push({ role: 'user', content: `${word}。请只回答"收到${turn}"。` });
    const r = await chat({ max_tokens: 64, messages: history });
    latencies.push(r.ms);

    if (r.status !== 200 || !r.content) {
      failures.push({ turn, status: r.status, err: r.err, finish: r.finish });
      // 连续失败 3 轮就停，别浪费额度
      if (failures.length >= 3) {
        note(`第 ${turn} 轮连续失败，提前停`);
        break;
      }
      history.push({ role: 'assistant', content: r.content || '' });
      continue;
    }
    history.push({ role: 'assistant', content: r.content });
    if (turn % 8 === 0 || turn === TURNS) {
      process.stdout.write(`    第 ${turn}/${TURNS} 轮  ${r.ms}ms  「${short(r.content, 18)}」\n`);
    }
    // 抽查：第 1 轮的暗号还记不记得（每 10 轮问一次，别每轮都问，太费）
    if (turn % 10 === 0) {
      const probe = await chat({
        max_tokens: 128,
        messages: [...history, { role: 'user', content: `第一轮我给你的那个暗号是什么？只回答暗号本身，不要别的话。` }],
      });
      const remembered = probe.content.includes(secret);
      if (!remembered && firstLostAt === null) firstLostAt = turn;
      note(`第 ${turn} 轮时抽查第 1 轮暗号：${remembered ? '记得 ✓' : `忘了 ✗（说成「${short(probe.content, 30)}」）`}`);
    }
  }

  const good = latencies.length - failures.length;
  if (failures.length === 0) ok(`${TURNS} 轮连续对话没有一轮失败，会话没断`, `中位延迟 ${median(latencies)}ms`);
  else bad(`有 ${failures.length}/${TURNS} 轮失败（会话断了）`, JSON.stringify(failures.slice(0, 3)));
  if (good === TURNS) ok('每一轮都拿到了非空正文');
  else bad(`只有 ${good}/${TURNS} 轮拿到正文`);
  if (firstLostAt === null) ok(`${TURNS} 轮之后仍然记得第 1 轮的暗号`, secret);
  else bad(`上下文在第 ${firstLostAt} 轮时把第 1 轮的暗号丢了`);

  // 历史长度：最后一发的 messages 有多少
  const finalChars = history.reduce((n, m) => n + m.content.length, 0);
  note(`最多时历史 ${history.length} 条消息 / 约 ${finalChars} 字符`);
  return { failures, latencies, secret, historyLen: history.length, finalChars };
}

/* ──────────────────── ② 长上下文：埋暗号能不能全找出来 ──────────────────── */

async function testLongContext() {
  console.log(`\n【2】长上下文：塞进约 ${CONTEXT_TOKENS} token 的历史，埋 5 个暗号`);

  // 用无害的填充文本把上下文撑大。每块约 400 汉字 ≈ 600 token
  const block = (i) => `【资料${i}】这是一段用于占位的普通文本，内容与问题无关。` +
    '海洋覆盖了地球表面约百分之七十一的面积，平均深度约三千七百米，' +
    '其中最深处的马里亚纳海沟超过一万一千米，比珠穆朗玛峰的高度还要多出两千米以上。' +
    '海洋在气候调节中起着关键作用，它吸收了大量的二氧化碳与热量，' +
    '洋流把赤道的热量带向两极，从而让低纬度不至于过热、高纬度不至于过冷。' +
    `（本段编号 ${i}，重复填充用，不含任何答案。）`;

  const anchors = [
    '暗号甲：紫色犀牛',
    '暗号乙：凌晨四点十七分',
    '暗号丙：第七号抽屉',
    '暗号丁：北纬三十九度',
    '暗号戊：一个叫老陈的人',
  ];
  // 埋在不同深度：开头、偏前、正中、偏后、最末
  const depths = [0.0, 0.22, 0.5, 0.78, 1.0];

  const messages = [];
  let filled = 0;
  let anchorIdx = 0;
  const totalCharsNeeded = CONTEXT_TOKENS * 1.5; // 汉字≈1 token 的粗估，留点余量
  let chars = 0;
  let blockNo = 0;

  messages.push({ role: 'system', content: '你会收到一大段资料，之后要回答关于资料的问题。资料里埋着若干"暗号"，请务必逐字记住。' });
  while (chars < totalCharsNeeded || anchorIdx < anchors.length) {
    blockNo += 1;
    const frac = chars / Math.max(1, totalCharsNeeded);
    let text = block(blockNo);
    // 到达某个深度就把暗号插在这一块的前面
    while (anchorIdx < anchors.length && frac >= depths[anchorIdx]) {
      text = `${anchors[anchorIdx]}。${text}`;
      anchorIdx += 1;
    }
    messages.push({ role: 'user', content: text });
    chars += text.length;
    if (blockNo > 400) break; // 防呆，别把自己卡死
    if (chars >= totalCharsNeeded && anchorIdx >= anchors.length) break;
  }
  // 收尾：确保剩下的暗号都插进去
  while (anchorIdx < anchors.length) {
    messages.push({ role: 'user', content: `${anchors[anchorIdx]}。这是补充资料。` });
    anchorIdx += 1;
  }
  filled = messages.length;

  const question = {
    role: 'user',
    content: '上面资料里一共埋了 5 个暗号。请把这 5 个暗号的原话逐字列出来，每行一个，不要解释、不要编号之外的任何字。',
  };

  console.log(`    拼了 ${filled} 条消息 / 约 ${chars} 字符`);
  const r = await chat({ max_tokens: 1024, messages: [...messages, question] });

  if (r.status !== 200) {
    bad('长上下文请求失败了', `HTTP ${r.status} ${r.err}`);
    return null;
  }
  ok('长上下文请求通了', `HTTP 200  ${r.ms}ms  prompt_tokens=${r.usage?.prompt_tokens}`);
  const pt = r.usage?.prompt_tokens || 0;
  if (pt > CONTEXT_TOKENS * 0.5) ok(`上游确实收到了大 prompt（没有被反代截断）`, `prompt_tokens=${pt}`);
  else bad('prompt_tokens 远小于预期，怀疑 messages 被截断了', `prompt_tokens=${pt}`);

  // 不能直接找整串「暗号甲：紫色犀牛」—— 实测模型会自己加换行、去掉编号，
  // 变成「紫色犀牛\n凌晨四点十七分\n…」。5 个全答对了，却因为少了「暗号甲：」
  // 前缀被判成 0/5（第一版就是这个误报）。断言要盯**信息有没有丢**，
  // 不能盯模型的排版习惯。
  const keyPart = (a) => a.split('：')[1] || a;
  const found = anchors.filter((a) => r.content.includes(keyPart(a)));
  const missed = anchors.filter((a) => !r.content.includes(keyPart(a)));
  if (found.length === anchors.length) ok('5 个暗号全找回来了（不同深度都没丢）');
  else bad(`只找回来 ${found.length}/5 个`, `没找到：${missed.join(' / ')}`);
  note(`回答前 160 字：${short(r.content, 160)}`);

  // 反向对照：问一个资料里**没有**的东西，它不该瞎编
  const neg = await chat({
    max_tokens: 256,
    messages: [...messages, { role: 'user', content: '资料里有没有提到"蓝色鲸鱼"这个暗号？有就回答有，没有就回答没有。只回答两个字。' }],
  });
  if (/没有/.test(neg.content)) ok('反向对照：资料里没有的暗号它没瞎编', short(neg.content, 20));
  else note(`反向对照回答「${short(neg.content, 40)}」（不算错，模型可能没按格式答）`);

  return { promptTokens: pt, found: found.length, anchors: anchors.length, chars };
}

/* ──────────────────────── ③ 并发：串不串号 ──────────────────────── */

async function testConcurrency() {
  console.log(`\n【3】并发：一次打 ${CONCURRENT} 发（一半流式），看有没有串号 / 被拒`);

  // 每发都带一个**唯一**的编号，让它回显 —— 串号的话回显就对不上
  const jobs = Array.from({ length: CONCURRENT }, (_, i) => ({
    i,
    id: `JOB${String(i).padStart(3, '0')}`,
    stream: i % 2 === 1,
  }));

  const t0 = Date.now();
  const results = await Promise.all(jobs.map((j) => {
    const body = {
      max_tokens: 64,
      messages: [{ role: 'user', content: `请只回复这串编号本身，不要任何别的字符：${j.id}` }],
    };
    return j.stream ? chatStream(body) : chat(body);
  }));
  const wall = Date.now() - t0;

  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  console.log(`    墙钟 ${wall}ms   状态码分布 ${JSON.stringify(byStatus)}`);

  const okAll = results.filter((r) => r.status === 200);
  if (okAll.length === CONCURRENT) ok(`并发 ${CONCURRENT} 发全部 200`, `${wall}ms`);
  else bad(`有 ${CONCURRENT - okAll.length} 发不是 200`, JSON.stringify(byStatus));
  if (byStatus[0]) bad(`有 ${byStatus[0]} 发连接层就失败了（ECONNRESET/超时）`);

  // 串号检查：第 i 发的回答里必须出现 JOBi，且**不能**出现别的 JOBxxx
  let crossed = 0;
  let empty = 0;
  for (let i = 0; i < results.length; i += 1) {
    const c = results[i].content || '';
    if (!c) { empty += 1; continue; }
    const others = jobs.filter((j) => j.i !== i && c.includes(j.id));
    if (others.length) crossed += 1;
  }
  if (crossed === 0) ok('没有串号（每条回答都只含自己的编号）');
  else bad(`有 ${crossed} 发串号了`, '并发下拿到了别人的回答');
  if (empty === 0) ok('每一发都拿到了非空正文');
  else note(`有 ${empty} 发正文为空（推理吃光预算，属已知情况；重试救不回来就是这种）`);

  const lat = results.filter((r) => r.status === 200).map((r) => r.ms);
  note(`单发耗时 中位 ${median(lat)}ms / 最快 ${Math.min(...lat)}ms / 最慢 ${Math.max(...lat)}ms`);

  // 流式那半：帧是否合法、有没有 [DONE]
  const streaming = results.filter((_, i) => jobs[i].stream && results[i].status === 200);
  const noDone = streaming.filter((r) => !r.sawDone);
  const badFrames = streaming.reduce((n, r) => n + (r.badFrames || 0), 0);
  if (noDone.length === 0) ok(`并发的流式全部收到 [DONE]`, `${streaming.length} 发`);
  else bad(`有 ${noDone.length} 发流式没收到 [DONE]`);
  if (badFrames === 0) ok('并发的流式没有一帧是坏 JSON');
  else bad(`有 ${badFrames} 帧不是合法 JSON`);

  return { byStatus, wall, crossed, empty, okAll: okAll.length };
}

/* ─────────────── ④ 混合大流量：跑一波看会不会退化 ─────────────── */

async function testBurst() {
  console.log(`\n【4】连续 ${BURST} 发（每批 ${Math.min(12, CONCURRENT)} 并发），看错误率和延迟会不会随时间爬升`);

  const BATCH = Math.min(12, CONCURRENT);
  const batches = Math.ceil(BURST / BATCH);
  const all = [];
  const errors = [];

  for (let b = 0; b < batches; b += 1) {
    const n = Math.min(BATCH, BURST - b * BATCH);
    const rs = await Promise.all(Array.from({ length: n }, (_, k) => {
      const idx = b * BATCH + k;
      const stream = idx % 3 === 0;
      const body = {
        max_tokens: 48,
        messages: [{ role: 'user', content: `只回复数字：${idx}` }],
      };
      return (stream ? chatStream(body) : chat(body)).then((r) => ({ idx, stream, ...r }));
    }));
    for (const r of rs) {
      all.push(r);
      if (r.status !== 200) errors.push({ idx: r.idx, status: r.status, err: r.err });
    }
    const done = Math.min((b + 1) * BATCH, BURST);
    const recent = rs.map((r) => r.ms);
    const sofar = all.filter((r) => r.status === 200).map((r) => r.ms);
    process.stdout.write(`    ${String(done).padStart(4)}/${BURST} 发  本批中位 ${String(median(recent)).padStart(6)}ms  累计中位 ${String(median(sofar)).padStart(6)}ms  错 ${errors.length}\n`);
  }

  const good = all.filter((r) => r.status === 200);
  if (errors.length === 0) ok(`${BURST} 发全部成功，没有一次连接失败`, `${good.length} 发 200`);
  else bad(`有 ${errors.length}/${BURST} 发失败`, JSON.stringify(errors.slice(0, 4)));

  // 退化检测：前半段和后半段的中位延迟比一比
  const half = Math.floor(good.length / 2);
  const early = median(good.slice(0, half).map((r) => r.ms));
  const late = median(good.slice(half).map((r) => r.ms));
  const ratio = early ? Math.round((late / early) * 100) / 100 : 0;
  if (ratio < 2) ok('没有明显退化（后半段和前半段延迟相当）', `前半 ${early}ms → 后半 ${late}ms（${ratio}x）`);
  else bad('延迟随时间明显爬升，可能有资源泄漏', `前半 ${early}ms → 后半 ${late}ms（${ratio}x）`);

  const rate = pct(good.length, all.length);
  if (rate >= 99) ok(`成功率 ${rate}%`);
  else bad(`成功率只有 ${rate}%`);

  const empties = good.filter((r) => !r.content).length;
  note(`其中正文为空 ${empties} 发（${pct(empties, good.length)}%）—— 推理吃光预算，见 diag-empty-window.mjs`);

  return { total: all.length, good: good.length, errors, early, late, ratio, empties };
}

/* ─────────────── ⑤ 同一会话读统计，看账目对不对得上 ─────────────── */

async function checkAccounting(before) {
  console.log('\n【5】账目核对：额度有没有被正确扣掉、号池有没有被打坏');
  const r = await fetch(`${BASE}/admin/api/state`, { headers: adminHeaders({ Authorization: `Bearer ${KEY}` }) });
  const s = await r.json();
  const t = s.usage?.totals || {};

  /*
   * ⚠️ `usage.totals` **不能**用来验证"本次跑了多少发"。
   *
   * 它是服务自己累加的、而且 `POST /admin/api/usage/reset` 一按就清零 ——
   * `tools/test-admin.mjs` 里就有一条断言会真按一下（打的是活的 service）。
   * 第一版拿它做前后差值，于是实测跑出 `新增成功 -39`（总 13，比开跑前的 52 还少）
   * 这种看着像数据错乱、其实是"测试把统计清了"的假故障。
   *
   * 真正靠谱的量是**云端额度**：它由华为那边算，本地清不掉。
   * 但它有 300 秒缓存（`credits.ttlSeconds`），所以必须**强制刷新**一下再读，
   * 否则读到的还是开跑前那个旧值 —— 第一版就踩了这个，
   * 打印出"额度被扣掉了 0 积分"，看着像"跑了 125 发没花钱"。
   */
  const readCredits = async (refresh) => {
    if (refresh) {
      await fetch(`${BASE}/admin/api/credits/refresh`, {
        method: 'POST',
        headers: { ...H },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(120000),
      }).catch(() => {});
      // 云端要一轮才回，刷完稍等一下再读，别读到刷新前的缓存
      await sleep(2500);
    }
    const hz = await (await fetch(`${BASE}/healthz`)).json();
    return Number(hz.creditsRemaining);
  };
  const creditNow = await readCredits(true);
  const spent = before.creditsRemaining - creditNow;
  /*
   * ⚠️ 这一项**只报数，不做断言** —— 云端那个计数器的粒度比这个脚本细不了。
   *
   * 踩过两次：
   *   · 一次读到 `0`（前后都在 300 秒缓存窗口内，云端还没结算）→
   *     打印"跑了 125 发没花钱"，看着像漏计费；
   *   · 另一次算出 `14325 token/积分`，而上一次同样的活是 `7254` —— 差一倍，
   *     因为前后两次读到的快照对应的是**不同时刻**的云端状态。
   *
   * 所以这里改成：把数字如实报出来，并且把"这一轮实际发了多少 token"一起给到，
   * 让人自己判断合不合理。真正能当断言的只有"号池没被打坏"和"服务还活着"。
   */
  if (!Number.isFinite(creditNow)) {
    note('拿不到云端额度，跳过这项');
  } else {
    const billed = before.billedTokens;
    note(`额度 ${before.creditsRemaining} → ${creditNow}（差 ${Math.round(spent * 100) / 100} 积分）`);
    note(`这一轮上游合计计费约 ${billed} token`);
    if (spent > 0) {
      note(`粗算 ${Math.round(billed / spent)} token/积分 —— 云端计数器有 300 秒缓存，`);
      note(`前后两次读的快照不是同一时刻，这个比率只能当量级参考（实测同规模的活算出来 7k~14k 都出现过）。`);
    } else {
      note('额度这次没动 —— 云端多半还没结算到，不是"没花钱"。');
    }
  }

  // usage 只当参考：能大于开跑前的值就说明新请求记进去了；比开跑前小就是被重置过
  if ((t.requests || 0) >= (before.requests || 0)) {
    ok(`服务统计没有倒退`, `requests=${t.requests}（开跑前 ${before.requests}）`);
  } else {
    note(`服务统计被重置过（${before.requests} → ${t.requests}）—— 多半是别的测试按了「重置用量」，不算故障`);
  }

  const pool = s.pool || [];
  if (pool.length === 2) ok('两个号都还在池里，没有号被打掉');
  else bad(`号池变成 ${pool.length} 个`, JSON.stringify(pool.map((e) => e.index)));
  const cooled = pool.filter((e) => (e.cooldownMsLeft || 0) > 0);
  if (cooled.length === 0) ok('没有号处于冷却');
  else bad(`有 ${cooled.length} 个号在冷却`, JSON.stringify(cooled.map((e) => ({ i: e.index, left: e.cooldownMsLeft }))));
  note(pool.map((e) => `#${e.index} ok=${e.ok} fail=${e.fail}`).join('   '));

  const hz = await (await fetch(`${BASE}/healthz`)).json();
  if (hz.status === 'ok') ok('/healthz 还是 ok');
  else bad(`/healthz 变成 ${hz.status}`);
  return { spent, requests: t.requests, pool };
}

/* ──────────── ⑥ 换号对话：跨凭据的多轮还记不记得上文 ──────────── */

async function testCredentialSwitch() {
  console.log('\n【6】换号接着聊：号池会轮换凭据，多轮对话跨号之后还记不记得上文');

  /*
   * 号池默认是轮换挑选的，所以一段多轮对话的每一轮**可能落在不同的号**上。
   * 这本身没问题（反代是无状态的，上下文由客户端每轮整份带过来），
   * 但值得验一次：万一哪个实现把状态挂在凭据上，跨号就会失忆。
   *
   * 怎么知道这轮用了哪个号：`/admin/api/state` 的 `pool[].ok` 每成功一次加一。
   * 前后各读一次，哪个号涨了就是它。上一轮涨的和这一轮涨的不一样 → 真的换号了。
   */
  const poolOk = async () => {
    const s = await (await fetch(`${BASE}/admin/api/state`, { headers: adminHeaders({ Authorization: `Bearer ${KEY}` }) })).json();
    return (s.pool || []).map((e) => e.ok || 0);
  };

  const secret = `SW${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const history = [];
  const used = [];
  let switched = 0;
  let prevCred = null;

  const T = Math.max(12, Math.min(TURNS, 30));
  for (let turn = 1; turn <= T; turn += 1) {
    const before = await poolOk();
    history.push({
      role: 'user',
      content: turn === 1
        ? `暗号是 ${secret}。（第 ${turn} 轮）请只回答"轮${turn}"。`
        : `（第 ${turn} 轮）请只回答"轮${turn}"。`,
    });
    const r = await chat({ max_tokens: 48, messages: history });
    const after = await poolOk();
    // 哪个号的 ok 涨了 = 这一轮用的哪个号
    const cred = after.findIndex((v, i) => v > (before[i] || 0));
    if (cred >= 0) {
      used.push(cred);
      if (prevCred !== null && cred !== prevCred) switched += 1;
      prevCred = cred;
    }
    if (r.status !== 200 || !r.content) {
      bad(`第 ${turn} 轮失败了`, `HTTP ${r.status} ${r.err}`);
      history.push({ role: 'assistant', content: '' });
      continue;
    }
    history.push({ role: 'assistant', content: r.content });
  }

  const distinct = [...new Set(used)];
  note(`这 ${T} 轮用过 ${distinct.length} 个号：${used.map((c) => `#${c}`).join(' ')}`);
  if (switched > 0) ok(`确实在号之间轮换了 ${switched} 次（不是一直用同一个）`, `用过 ${distinct.join(' / ')}`);
  else note('这一轮没发生换号（号池可能一直在挑同一个），跨号那半条没测到');

  // 换着号聊完之后，第 1 轮的暗号还在不在
  const probe = await chat({
    max_tokens: 128,
    messages: [...history, { role: 'user', content: '最开头我给你的那个暗号是什么？只回答暗号本身。' }],
  });
  if (probe.content.includes(secret)) ok(`跨 ${switched} 次换号之后，第 1 轮的暗号还记得`, secret);
  else bad('跨号之后上面的话丢了', `说成「${short(probe.content, 40)}」`);

  return { turns: T, distinct: distinct.length, used, switched, remembered: probe.content.includes(secret) };
}

/* ──────────── ⑦ 长对话中途还能记住最近几轮 ──────────── */

async function testRecencyUnderLongContext() {
  console.log('\n【7】长对话里"最近的还记不记得"（长了之后最容易丢的是近处）');

  // 造一段长历史：开头一个远期暗号，末尾几个近期暗号
  const longAgo = `远${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const recent = [`近1-${Math.random().toString(36).slice(2, 6)}`, `近2-${Math.random().toString(36).slice(2, 6)}`, `近3-${Math.random().toString(36).slice(2, 6)}`];
  const history = [{ role: 'user', content: `很久以前我说过暗号 ${longAgo}，请记住。` }, { role: 'assistant', content: '记住了。' }];
  // 中间塞大量无关内容
  for (let i = 0; i < 40; i += 1) {
    history.push({ role: 'user', content: `无关内容第 ${i} 段。` + '海水的平均盐度约为千分之三十五，这一数值在不同海域会有差异。'.repeat(3) });
    history.push({ role: 'assistant', content: `收到第 ${i} 段。` });
  }
  for (const r of recent) history.push({ role: 'user', content: `刚才我说过暗号 ${r}。` });
  history.push({ role: 'assistant', content: '好的。' });

  const q = await chat({
    max_tokens: 256,
    messages: [...history, { role: 'user', content: `我刚才连续说了三个"近"开头的暗号，分别是哪三个？只列出来，每行一个。` }],
  });
  if (q.status !== 200) { bad('长历史里问近处失败了', `HTTP ${q.status}`); return null; }
  const foundRecent = recent.filter((r) => q.content.includes(r));
  if (foundRecent.length === recent.length) ok(`最近说的 ${recent.length} 个暗号，隔了 80 条消息还记得`, foundRecent.join(' / '));
  else bad(`近处丢了 ${recent.length - foundRecent.length} 个`, `只记得 ${foundRecent.join(' / ') || '（一个都没有）'}`);
  const foundOld = q.content.includes(longAgo);
  note(`远端那个（更早说的）${foundOld ? '也还记得' : '已经想不起来了'} —— 长上下文里远端先丢是正常现象，不算故障`);

  return { recentFound: foundRecent.length, recentTotal: recent.length, oldFound: foundOld, historyLen: history.length };
}

/* ──────────── ⑧ 混着打：所有能用模型一起上 ──────────── */

async function testAllModels() {
  console.log('\n【8】混着打：/v1/models 列出的每个模型都打一发，看有没有漏的');

  const list = await (await fetch(`${BASE}/v1/models`, { headers: adminHeaders({ Authorization: `Bearer ${KEY}` }) })).json();
  const ids = (list.data || []).map((m) => m.id);
  if (!ids.length) { bad('/v1/models 一个模型都没有'); return null; }
  // 别名（`alias_of`）要在下面单独放行 —— 见对回显的说明
  const aliasOf = {};
  for (const m of list.data || []) if (m.alias_of) aliasOf[m.id] = m.alias_of;
  note(`/v1/models 列了 ${ids.length} 个：${ids.join(' ')}`);
  if (Object.keys(aliasOf).length) {
    note(`其中 ${Object.keys(aliasOf).length} 个是别名：${Object.entries(aliasOf).map(([a, b]) => `${a}→${b}`).join('  ')}`);
  }

  const t0 = Date.now();
  const rs = await Promise.all(ids.map((id) => fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ model: id, max_tokens: 48, messages: [{ role: 'user', content: '只回答：好' }] }),
    signal: AbortSignal.timeout(300000),
  }).then(async (r) => {
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch { /* 非 JSON */ }
    if (j?.usage) addBilled(j.usage);
    return { id, status: r.status, content: j?.choices?.[0]?.message?.content || '', code: j?.error?.code, model: j?.model };
  }).catch((e) => ({ id, status: 0, content: '', err: e.message }))));
  const wall = Date.now() - t0;

  const failed = rs.filter((r) => r.status !== 200);
  const emptyContent = rs.filter((r) => r.status === 200 && !r.content);
  if (failed.length === 0) ok(`${ids.length} 个模型全部 200`, `${wall}ms`);
  else bad(`有 ${failed.length} 个模型打不通`, failed.map((f) => `${f.id}→${f.status}${f.code ? `(${f.code})` : ''}`).join(', '));

  /*
   * 回显名字对不上 ≠ 路由串台，得先分清楚是**谁**改的、该不该改。
   *
   * `models.mjs` 的 `resolve()` 只在命中 `models.alias` 时替换名字，否则原样返回，
   * 所以反代不篡改 `model`。对不上的一共三类，**全是正常的**：
   *
   *   ① **别名**：`/v1/models` 里带 `alias_of` 的那些。问 `gpt-4o` 回 `glm-5.2`
   *      是**设计如此** —— 别名存在的意义就是"借另一个模型的名字"。
   *      （别名后来又在面板里被加回来了，所以这一节要跟着它变。）
   *   ② **上游归一大小写**：Kimi-K2.6 → kimi-k2.6
   *   ③ **上游归一到基座**：deepseek-v4.1-flash-0930 → deepseek-v4.1-flash
   *
   * ②③ 跟别处踩过的「上游回 81009 说名字不认」是同一件事的两面：
   * **名字的最终解释权在上游**，它爱怎么归一就怎么归一。
   *
   * 所以断言只盯**真的串台**：回显既不是请求的那个、也不是别名指向的那个、
   * 也不是它的"近亲"（忽略大小写 / 去掉日期后缀之后相同），才算故障。
   */
  const family = (s) => String(s || '').toLowerCase().replace(/[-_.]/g, '').replace(/\d{4,}$/, '');
  const expectedEcho = (id) => [id, aliasOf[id]].filter(Boolean);
  const isSameFamily = (a, b) => family(a) === family(b);
  const acceptable = (r) => expectedEcho(r.id).some((e) => r.model === e || isSameFamily(r.model, e));

  const wrongEcho = rs.filter((r) => r.status === 200 && r.model && r.model !== r.id && !acceptable(r));
  const aliasEcho = rs.filter((r) => r.status === 200 && aliasOf[r.id] && r.model === aliasOf[r.id]);
  const normalized = rs.filter((r) => r.status === 200 && r.model && r.model !== r.id && !aliasOf[r.id] && isSameFamily(r.model, r.id));

  if (wrongEcho.length === 0) ok('没有路由串台（回显对不上都能解释：别名 / 上游归一）');
  else bad(`有 ${wrongEcho.length} 个模型回显的名字对不上，像是串台了`, wrongEcho.map((w) => `${w.id}→${w.model}（期望 ${expectedEcho(w.id).join(' 或 ')}）`).join(', '));
  if (aliasEcho.length) {
    ok(`别名正常转发（${aliasEcho.length} 个别名都回显了它的目标模型）`, aliasEcho.map((w) => `${w.id}→${w.model}`).join('  '));
  }
  if (normalized.length) {
    note(`上游把 ${normalized.length} 个名字归一了（反代原样发出，是上游改的）：${normalized.map((w) => `${w.id}→${w.model}`).join('  ')}`);
  }
  if (emptyContent.length === 0) ok('每个模型都给了非空正文');
  else note(`有 ${emptyContent.length} 个正文为空：${emptyContent.map((e) => e.id).join(', ')}（推理吃光预算，重试也没救回来）`);

  return { total: ids.length, failed: failed.length, emptyContent: emptyContent.length, wall };
}

/* ──────────── ⑨ 撞上游的硬上限：超限了是什么表现 ──────────── */

async function testContextCeiling() {
  console.log('\n【9】顶到上游的硬上限：超限了上游怎么回、反代会不会把它变成 500');

  /*
   * 真实客户端开着长对话早晚会撞到上限。这一节要确认三件事：
   *   ① 撞墙时反代**如实转发**上游的错，客户端要能认出"是请求本身太大"；
   *   ② **别把这笔账记到号上**（以前踩过好几次"把模型的错当成账号的错"）；
   *   ③ 别重试 —— body 不变，重试只会把整个 body 再传一遍。
   *
   * ⚠️ 先说清楚到底是哪条上限，我第一版就搞错了：
   *
   *   上游 `ModelArts.81113` 的原文是
   *     "Invalid request body, exceeds the maximum size , messages max size is: 5000."
   *   最后那句才是关键 —— **`messages` 的条数上限，5000 条**，跟 token 没关系。
   *   我第一次撞它时塞的是 7500 块 ×2 = **15000 条消息**，误当成"上下文太长"。
   *   实测（见 `tools/diag-upstream-limits.mjs`）：
   *     · 条数：4990 过、**5000 过、5001 拒** —— 正好 5000
   *     · token：**655,713** 个 prompt token 照样 200。
   *       所以这一节**不测 token 窗口**（那个天花板高到我在这台机器上撞不到），
   *       只测那条真正会撞到的 **5000 条消息** 的线。
   */
  const ONE = '这是一段用于堆消息条数的填充文本。';
  const messages = [];
  while (messages.length < 5001) {
    messages.push({ role: 'user', content: `${ONE}${messages.length}` });
    messages.push({ role: 'assistant', content: '收到。' });
  }
  messages.length = 5001;

  const poolCool = async () => {
    const s = await (await fetch(`${BASE}/admin/api/state`, { headers: adminHeaders({ Authorization: `Bearer ${KEY}` }) })).json();
    return (s.pool || []).map((e) => e.cooldownMsLeft || 0);
  };
  const coolBefore = await poolCool();

  console.log(`    发 ${messages.length} 条消息（上限 5000，故意多一条）`);
  const t0 = Date.now();
  const r = await chat({ max_tokens: 32, messages }, { timeoutMs: 300000 });
  const ms = Date.now() - t0;

  const coolAfter = await poolCool();
  if (r.status === 200) {
    ok('这么多条上游还收下了', `prompt_tokens=${r.usage?.prompt_tokens}`);
    note('说明这一档还没超 —— 上游那条线可能挪了，回头看 diag-upstream-limits.mjs');
  } else {
    note(`上游拒了：HTTP ${r.status}  ${ms}ms`);
    if (r.status === 413) ok('超限时回的是 413（客户端能一眼看出"是请求太大"）', `HTTP ${r.status}`);
    else if (r.status === 429) bad('超限被回成了 429 —— 客户端会以为"只是忙"，于是继续重试这个必然失败的请求');
    else if (r.status === 500) bad('超限被包装成了 500', '客户端会以为服务挂了');
    else note(`状态码 ${r.status}`);

    const bodyIsJson = /^\{/.test(String(r.raw || '').trim());
    if (bodyIsJson) ok('错误体还是 JSON（不是 HTML / 纯文本）');
    else bad('错误体不是 JSON', String(r.raw).slice(0, 120));

    if (r.err && /81113|exceeds the maximum size|request_too_large|历史太大/.test(String(r.err))) {
      ok('错误信息里带着"请求太大"的线索');
    } else {
      note(`错误信息：${String(r.err || '').slice(0, 120)}`);
    }

    // 关键：不重试。`attempts` 数组有几条就是打了几次上游
    const attempts = r.raw && /"attempts"\s*:\s*\[/.test(r.raw) ? '（响应里带 attempts 字段）' : '';
    if (ms < 5000) ok('几乎是立刻回的，没有退避重试', `${ms}ms ${attempts}`);
    else note(`耗时 ${ms}ms —— 偏长，可能重试过 ${attempts}`);
  }

  // 不管上游怎么拒，都不能把这笔账算到号头上
  const cooledNow = coolAfter.filter((v) => v > 0).length;
  const cooledWas = coolBefore.filter((v) => v > 0).length;
  if (cooledNow <= cooledWas) ok('没有因为"请求太大"冷却任何号', `冷却中的号 ${cooledWas} → ${cooledNow}`);
  else bad('把请求太大当成了账号故障，号被冷却了', JSON.stringify(coolAfter));

  // 超限之后服务还得能正常干活（别把服务带崩了）
  const after = await chat({ max_tokens: 24, messages: [{ role: 'user', content: '只回答：好' }] });
  if (after.status === 200 && after.content) ok('超限之后紧接着还能正常对话（服务没被带坏）', `「${short(after.content, 12)}」`);
  else bad('超限之后服务就不正常了', `HTTP ${after.status} ${after.err || ''}`);

  return { messageCount: messages.length, status: r.status, ms, cooled: cooledNow, recovered: after.status === 200 };
}

/* ──────────── ⑩ 多个独立会话同时聊 ──────────── */

async function testParallelSessions() {
  console.log('\n【10】多个独立会话同时聊（真实场景：一边几个窗口都在对话）');

  /*
   * 第 3 节测的是"各发各的、互不相干"。这一节不一样：**每一条都是多轮**，
   * 而且各自的上下文完全不同 —— 这是"串上下文"最容易露馅的场景，
   * 因为串了之后本轮的回答就会带上别的会话的暗号。
   */
  const N = Math.min(6, Math.max(3, Math.floor(CONCURRENT / 8)));
  const ROUNDS = 4;

  const sessions = Array.from({ length: N }, (_, i) => ({
    i,
    secret: `SE${i}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    history: [],
  }));
  // 第一轮各自报暗号
  for (const s of sessions) {
    s.history.push({ role: 'user', content: `我们这个会话的暗号是 ${s.secret}。请只回答"好${s.i}"。` });
  }

  const t0 = Date.now();
  let badRounds = 0;
  for (let round = 1; round <= ROUNDS; round += 1) {
    const rs = await Promise.all(sessions.map((s) => chat({
      max_tokens: 64,
      messages: [...s.history, { role: 'user', content: `（第 ${round} 轮）请只回答"${s.i}轮${round}"。` }],
    })));
    for (let k = 0; k < sessions.length; k += 1) {
      const s = sessions[k];
      const r = rs[k];
      if (r.status !== 200 || !r.content) { badRounds += 1; continue; }
      s.history.push({ role: 'user', content: `（第 ${round} 轮）请只回答"${s.i}轮${round}"。` });
      s.history.push({ role: 'assistant', content: r.content });
    }
  }
  const wall = Date.now() - t0;

  // 同时问所有会话：自己的暗号是哪个
  const probes = await Promise.all(sessions.map((s) => chat({
    max_tokens: 96,
    messages: [...s.history, { role: 'user', content: '本会话一开始的暗号是什么？只回答暗号本身。' }],
  })));

  let correct = 0;
  let leaked = 0;
  for (let k = 0; k < sessions.length; k += 1) {
    const s = sessions[k];
    const c = probes[k].content || '';
    if (c.includes(s.secret)) correct += 1;
    // 串上下文的话，会答出**别的会话**的暗号
    const others = sessions.filter((o) => o.i !== s.i && c.includes(o.secret));
    if (others.length) leaked += 1;
  }

  if (badRounds === 0) ok(`${N} 个会话 × ${ROUNDS} 轮全部成功`, `${wall}ms`);
  else bad(`有 ${badRounds} 轮失败`);
  if (correct === N) ok(`${N} 个会话都答对了自己的暗号`);
  else bad(`只有 ${correct}/${N} 个答对自己的暗号`);
  if (leaked === 0) ok('没有串上下文（谁都没答出别人的暗号）');
  else bad(`有 ${leaked} 个会话串了上下文`, '拿到了别的会话的暗号');

  return { sessions: N, rounds: ROUNDS, wall, correct, leaked, badRounds };
}

/* ──────────────────────────────── 主流程 ──────────────────────────────── */

console.log(`\n════════ 大批量压力测试 ════════`);
console.log(`  目标 ${BASE}   模型 ${MODEL}`);
console.log(`  规模：${TURNS} 轮会话 / 上下文 ${CONTEXT_TOKENS} token / 并发 ${CONCURRENT} / 连打 ${BURST}`);
console.log(`  （改规模：--turns= --context= --concurrent= --burst= --all）`);

const hz0 = await (await fetch(`${BASE}/healthz`)).json();
console.log(`  开跑前：status=${hz0.status} 凭据=${hz0.credentials} 号=${hz0.accountsUsable}/${hz0.accounts} 额度=${hz0.creditsRemaining ?? '-'}`);

const st0 = await (await fetch(`${BASE}/admin/api/state`, { headers: adminHeaders({ Authorization: `Bearer ${KEY}` }) })).json();
const before = {
  requests: st0.usage?.totals?.requests || 0,
  ok: st0.usage?.totals?.ok || 0,
  // 额度是唯一不会被本地重置的量，用它来验"账目对得上"
  creditsRemaining: hz0.creditsRemaining,
  // 下面会在跑完之后连同 billedTokens 一起填进去
  billedTokens: 0,
};

const out = { at: new Date().toISOString(), model: MODEL, scale: { TURNS, CONTEXT_TOKENS, CONCURRENT, BURST } };
const t00 = Date.now();

out.conversation = await testLongConversation();
out.context = await testLongContext();
out.concurrency = await testConcurrency();
out.burst = await testBurst();
out.credentialSwitch = await testCredentialSwitch();
out.recency = await testRecencyUnderLongContext();
out.allModels = await testAllModels();
out.parallelSessions = await testParallelSessions();
// 这一节故意放最后：它会往上游推一个超大 prompt，撞不撞得到墙都不影响前面的结论
out.contextCeiling = await testContextCeiling();
before.billedTokens = billedTokens;
out.billedTokens = billedTokens;
out.accounting = await checkAccounting(before);
out.wallMs = Date.now() - t00;

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
console.log(`  总耗时 ${Math.round(out.wallMs / 1000)} 秒\n`);

mkdirSync('data', { recursive: true });
writeFileSync('data/stress-deep41.json', JSON.stringify(out, null, 2));
console.log('  明细已写入 data/stress-deep41.json\n');
process.exit(fail ? 1 : 0);
