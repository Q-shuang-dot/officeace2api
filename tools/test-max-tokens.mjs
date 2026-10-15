/**
 * 推理模型 token 预算的单元测试 —— 不碰网络，只测 buildUpstreamBody 的改写规则。
 *
 * 为什么值得单独一条测试：
 *   这段逻辑会**改动客户端发来的参数**，改动类的东西必须有测试兜着，
 *   否则很容易变成"顺手把所有模型的 max_tokens 都改了"还察觉不到。
 *
 * 用法：node tools/test-max-tokens.mjs
 */
import { buildUpstreamBody, takeBumpNote } from '../src/upstream.mjs';

let pass = 0;
let fail = 0;
const ok = (m, extra = '') => { pass += 1; console.log(`  ✓ ${m}${extra ? '  ' + extra : ''}`); };
const bad = (m, extra = '') => { fail += 1; console.log(`  ✗ ${m}${extra ? '  ' + extra : ''}`); };

function build(body, opts = {}) {
  const out = buildUpstreamBody(body, 'test-model', { alwaysStream: true, ...opts });
  const note = takeBumpNote(out);
  return { out, note };
}

console.log('\n══ max_tokens 推理预算 ══\n');

/* ---------- 1. 追加规则 ---------- */
console.log('【1】追加 1024 推理预算');
{
  const cases = [
    [16, 1040],
    [64, 1088],
    [300, 1324],
    [1024, 2048],
    [4096, 5120],
  ];
  for (const [given, want] of cases) {
    const { out, note } = build({ max_tokens: given }, { minMaxTokens: 1024 });
    if (out.max_tokens === want) ok(`max_tokens=${given} → ${want}`, note ? `note=${note.mode}` : '');
    else bad(`max_tokens=${given} 应该是 ${want}`, `实际 ${out.max_tokens}`);
  }
  const { note } = build({ max_tokens: 64 }, { minMaxTokens: 1024 });
  if (note && note.from === 64 && note.to === 1088 && note.mode === 'allowance') ok('返回了可记录的 note', JSON.stringify(note));
  else bad('note 不对', JSON.stringify(note));
}

/* ---------- 2. 小值必须原样透传 ---------- */
console.log('\n【2】小值原样透传（不能替客户端决定"其实你想要上千个 token"）');
{
  for (const tiny of [1, 2, 5, 15]) {
    const { out, note } = build({ max_tokens: tiny }, { minMaxTokens: 1024 });
    if (out.max_tokens === tiny && !note) ok(`max_tokens=${tiny} 原样透传`);
    else bad(`max_tokens=${tiny} 被改了`, `→ ${out.max_tokens} note=${JSON.stringify(note)}`);
  }
  const { out } = build({ max_tokens: 16 }, { minMaxTokens: 1024 });
  if (out.max_tokens === 1040) ok('边界值 16 走追加（不含 16 以下）', '16 → 1040');
  else bad('边界值 16 处理不对', `→ ${out.max_tokens}`);
}

/* ---------- 3. 关掉时不许动 ---------- */
console.log('\n【3】minMaxTokens=0 时一个字节都不许改');
{
  for (const given of [1, 16, 64, 4096]) {
    const { out, note } = build({ max_tokens: given }, { minMaxTokens: 0 });
    if (out.max_tokens === given && !note) ok(`max_tokens=${given} 未改动`);
    else bad(`max_tokens=${given} 被改了`, `→ ${out.max_tokens}`);
  }
  const { out } = build({ max_tokens: 64 }, { minMaxTokens: null });
  if (out.max_tokens === 64) ok('minMaxTokens=null 等价于关掉');
  else bad('minMaxTokens=null 时被改了', `→ ${out.max_tokens}`);
}

/* ---------- 4. 客户端没给就不补 ---------- */
console.log('\n【4】客户端没给 max_tokens 时不补（上游默认够用）');
{
  const { out, note } = build({ messages: [] }, { minMaxTokens: 1024 });
  if (!('max_tokens' in out) && !note) ok('没有凭空塞 max_tokens');
  else bad('凭空塞了 max_tokens', `→ ${out.max_tokens}`);
  // 非数字（客户端乱传）也不能崩
  const { out: o2 } = build({ max_tokens: 'abc' }, { minMaxTokens: 1024 });
  if (o2.max_tokens === 'abc') ok('非数字原样透传（不崩）');
  else bad('非数字被改坏了', `→ ${o2.max_tokens}`);
}

/* ---------- 5. 标记不能漏给上游 ---------- */
console.log('\n【5】内部标记绝不能发给上游');
{
  const { out, note } = build({ max_tokens: 64 }, { minMaxTokens: 1024 });
  if (note && note.to === 1088) ok('build() 里已经把 note 摘出来过（第一手拿到）', JSON.stringify(note));
  else bad('第一手没拿到 note', JSON.stringify(note));
  if (!('__o2aBumped' in out)) ok('__o2aBumped 已被摘掉');
  else bad('__o2aBumped 还在 body 里（会发给上游）', JSON.stringify(out));
  // 摘过一次之后必须再也拿不到 —— 否则同一份 body 被用两次时会重复记账
  if (takeBumpNote(out) === null) ok('摘过一次之后拿不到了（幂等 / 只消费一次）');
  else bad('还能再拿到', JSON.stringify(takeBumpNote(out)));
  // 没有标记的 body 也不能抛
  if (takeBumpNote({ max_tokens: 64 }) === null && takeBumpNote(null) === null) ok('没有标记 / 传 null 都不抛');
  else bad('takeBumpNote 对空值处理不对');
}

/* ---------- 6. 别的改写规则没被碰坏 ---------- */
console.log('\n【6】原有的改写规则照常');
{
  const { out } = build({ temperature: 9, top_p: 3, max_tokens: 64 }, { minMaxTokens: 1024 });
  if (out.temperature === 2) ok('temperature 仍被夹在 2 以内');
  else bad('temperature 没夹', String(out.temperature));
  if (out.top_p === 1) ok('top_p 仍被夹在 1 以内');
  else bad('top_p 没夹', String(out.top_p));
  if (out.stream === true) ok('alwaysStream 仍然把 stream 设成 true');
  else bad('stream 没设', String(out.stream));
  if (out.stream_options?.include_usage === true) ok('stream_options.include_usage 仍然带上');
  else bad('stream_options 没带', JSON.stringify(out.stream_options));

  const { out: o2 } = build({ max_tokens: 64, thinking: { type: 'disabled' }, enable_thinking: false }, { minMaxTokens: 1024, stripThinking: true });
  if (!('thinking' in o2) && !('enable_thinking' in o2)) ok('stripThinking 仍然剥掉 thinking 相关参数');
  else bad('stripThinking 没剥干净', JSON.stringify(o2));

  // model 必须被覆盖成路由解析后的名字
  const { out: o3 } = build({ model: 'client-said-this', max_tokens: 64 }, { minMaxTokens: 1024 });
  if (o3.model === 'test-model') ok('model 被覆盖成路由后的名字');
  else bad('model 没被覆盖', String(o3.model));
}

/*
 * 【7】exactMaxTokens：「正文为空」重试专用 —— 直接指定这一发的预算
 *
 * 这一节盯的是一个**真的会坏**的行为：重试原来原样重发同一个 max_tokens，
 * 预算不够的话第二次照样不够。实测 16/64/256 三档各 12 次、共 12/36 空正文，
 * 失败的是固定的那两个问题（见 tools/diag-empty-window.mjs）。
 */
console.log('\n【7】exactMaxTokens：重试要真的抬高预算');
{
  // 基本行为：客户端要 64，重试指名要 8917 → 就是 8917，不是 64+1024
  const { out, note } = build({ max_tokens: 64 }, { minMaxTokens: 1024, exactMaxTokens: 8917 });
  if (out.max_tokens === 8917) ok('exactMaxTokens 直接生效（不是再加一遍 allowance）', String(out.max_tokens));
  else bad('exactMaxTokens 没生效', String(out.max_tokens));
  if (note?.mode === 'retry') ok('mode 标成 retry，能看出这次是重试抬的');
  else bad('mode 不是 retry', JSON.stringify(note));
  if (note?.from === 64) ok('记录抬升前的值给日志用', JSON.stringify(note));
  else bad('from 不对', JSON.stringify(note));

  // 关掉 allowance 也不影响：重试该抬还是抬（不然重试白打）
  const { out: o2 } = build({ max_tokens: 64 }, { minMaxTokens: 0, exactMaxTokens: 4096 });
  if (o2.max_tokens === 4096) ok('minMaxTokens=0 时 exactMaxTokens 照样生效');
  else bad('allowance 关掉把重试也关掉了', String(o2.max_tokens));

  // 客户端没给 max_tokens 时也能用（重试没有"加"的基准）
  const { out: o3, note: n3 } = build({}, { minMaxTokens: 1024, exactMaxTokens: 4096 });
  if (o3.max_tokens === 4096) ok('客户端没给 max_tokens 也能抬（重试路径需要）');
  else bad('没给 max_tokens 时 exact 不生效', String(o3.max_tokens));
  if (n3?.from === null) ok('from 记成 null（上游没收到过这个字段）');
  else bad('from 应该是 null', JSON.stringify(n3));

  // ⚠️ 反向对照：客户端明确只要极小输出时，不许被重试撑大。
  //    <16 的请求本来就是"稳定要空正文"，server 那边也不该触发重试；
  //    这里再兜一道，免得哪天调用方漏判就把客户端的极小请求改了。
  for (const tiny of [1, 2, 5, 15]) {
    const { out: t } = build({ max_tokens: tiny }, { minMaxTokens: 1024, exactMaxTokens: 8917 });
    if (t.max_tokens === tiny) ok(`max_tokens=${tiny} 不被 exactMaxTokens 撑大`, String(t.max_tokens));
    else bad(`max_tokens=${tiny} 被撑大了`, `${t.max_tokens} —— 客户端要的就是极小输出`);
  }

  // 非法值不许把 max_tokens 改成垃圾
  for (const bogus of [0, -1, NaN, null, undefined, 'abc', Infinity]) {
    const { out: b } = build({ max_tokens: 64 }, { minMaxTokens: 1024, exactMaxTokens: bogus });
    if (b.max_tokens === 1088) ok(`exactMaxTokens=${String(bogus)} 被忽略，退回 allowance 规则`, String(b.max_tokens));
    else bad(`exactMaxTokens=${String(bogus)} 处理不对`, String(b.max_tokens));
  }

  // 小数要取整（上游只认整数）
  const { out: rd } = build({ max_tokens: 64 }, { minMaxTokens: 1024, exactMaxTokens: 1234.7 });
  if (rd.max_tokens === 1235) ok('小数向上取整', String(rd.max_tokens));
  else bad('小数没取整', String(rd.max_tokens));

  // 标记照旧摘干净
  if (!('__o2aBumped' in out)) ok('retry 标记也摘干净了');
  else bad('retry 标记漏在 body 里了');
}

/*
 * 【8】maxMaxTokens：夹住上游的硬上限
 *
 * 这一节盯的是一个**实测踩到过的确定性失败**：上面那套「追加推理预算」是加法，
 * 客户端给的正好是上游上限时会被顶出去 ——
 *
 *   max_tokens=393216  →  393216 + 1024 = 394240  →  400 ModelArts.81001
 *   （上游原文：`max_tokens range is [1, 393216]`）
 *
 * 请求不变、打一百遍一样被拒，客户端只会觉得"反代一直是坏的"。
 * 触发它的是一条很常见的链路：网关按 maxOutputTokens 向客户端声明能力，
 * 客户端照着那个数发。
 */
console.log('\n【8】maxMaxTokens：夹住上游硬上限');
{
  // ① 就是这个 bug：客户端给上游上限，加完预算顶出去，必须被夹回来
  const { out, note } = build({ max_tokens: 393216 }, { minMaxTokens: 1024, maxMaxTokens: 393216 });
  if (out.max_tokens === 393216) ok('393216 + 1024 = 394240 被夹回 393216（原故障用例）', String(out.max_tokens));
  else bad('没夹住上游上限', `${out.max_tokens} —— 上游会 400 ModelArts.81001`);
  if (note?.clamped === true && note.to === 393216 && note.from === 394240) ok('note 带上 clamped，日志才分得清"夹上限"和"抬下限"', JSON.stringify(note));
  else bad('clamped 标记不对', JSON.stringify(note));

  // ② 各家上限不一样，按模型配了就得各按各的夹
  const perFamily = [
    ['glm-5.3 上限 131072', 131072, 131072],
    ['qwen3-32b 上限 65536', 65536, 65536],
  ];
  for (const [label, cap, want] of perFamily) {
    const { out: o } = build({ max_tokens: 393216 }, { minMaxTokens: 1024, maxMaxTokens: cap });
    if (o.max_tokens === want) ok(`${label}：393216 被夹到 ${want}`);
    else bad(`${label} 夹错了`, String(o.max_tokens));
  }

  // ③ 夹的是**上限**，不是下限：没到上限的请求一个字节都不许动
  const { out: o3, note: n3 } = build({ max_tokens: 1000 }, { minMaxTokens: 1024, maxMaxTokens: 393216 });
  if (o3.max_tokens === 2024) ok('没到上限的照旧只加预算（1000 → 2024）', String(o3.max_tokens));
  else bad('把没到上限的请求也改了', String(o3.max_tokens));
  if (!n3?.clamped) ok('没夹就不该有 clamped 标记');
  else bad('不该标 clamped', JSON.stringify(n3));

  // ④ 边界：正好等于上限 → 不算超，不夹（不产生多余的日志）
  const { out: o4, note: n4 } = build({ max_tokens: 1024 }, { minMaxTokens: 1024, maxMaxTokens: 2048 });
  if (o4.max_tokens === 2048 && !n4?.clamped) ok('正好等于上限 2048 不动（只记账 allowance）', JSON.stringify(n4));
  else bad('边界值处理不对', `${o4.max_tokens} note=${JSON.stringify(n4)}`);
  const { out: o5 } = build({ max_tokens: 1025 }, { minMaxTokens: 1024, maxMaxTokens: 2048 });
  if (o5.max_tokens === 2048) ok('超过一个 token 就夹（1025 + 1024 = 2049 → 2048）', String(o5.max_tokens));
  else bad('超界没夹', String(o5.max_tokens));

  // ⑤ 关掉上限 = 完全不动（老行为）
  for (const off of [0, null, undefined, 'abc', NaN]) {
    const { out: o } = build({ max_tokens: 393216 }, { minMaxTokens: 1024, maxMaxTokens: off });
    if (o.max_tokens === 394240) ok(`maxMaxTokens=${String(off)} 等价于不夹`, String(o.max_tokens));
    else bad(`maxMaxTokens=${String(off)} 不该夹`, String(o.max_tokens));
  }

  // ⑥ 客户端没给 max_tokens → 上限也不许凭空造一个出来
  const { out: o6, note: n6 } = build({ messages: [] }, { minMaxTokens: 1024, maxMaxTokens: 393216 });
  if (!('max_tokens' in o6) && !n6) ok('没给就还是不补（上限也不补）');
  else bad('凭空造了 max_tokens', `${o6.max_tokens} note=${JSON.stringify(n6)}`);

  // ⑦ 极小值照旧原样透传，上限管不着它
  for (const tiny of [1, 2, 5, 15]) {
    const { out: t } = build({ max_tokens: tiny }, { minMaxTokens: 1024, maxMaxTokens: 393216 });
    if (t.max_tokens === tiny) ok(`max_tokens=${tiny} 原样透传（远在上限之下）`);
    else bad(`max_tokens=${tiny} 被改了`, String(t.max_tokens));
  }

  // ⑧ 关掉 allowance 也照样守上限（上限是上游的硬规矩，跟预算开不开无关）
  const { out: o8, note: n8 } = build({ max_tokens: 393216 }, { minMaxTokens: 0, maxMaxTokens: 131072 });
  if (o8.max_tokens === 131072) ok('minMaxTokens=0 时上限仍然生效', String(o8.max_tokens));
  else bad('allowance 关掉把上限也关了', String(o8.max_tokens));
  if (n8?.mode === 'clamp') ok('没抬过预算时 mode 记成 clamp', JSON.stringify(n8));
  else bad('mode 应该是 clamp', JSON.stringify(n8));

  // ⑨ 重试那条路（exactMaxTokens）也得守上限 —— 算出来的数一样可能超
  const { out: o9 } = build({ max_tokens: 64 }, { minMaxTokens: 1024, maxMaxTokens: 131072, exactMaxTokens: 999999 });
  if (o9.max_tokens === 131072) ok('exactMaxTokens=999999 被夹到 131072');
  else bad('重试路径漏了上限', String(o9.max_tokens));

  // ⑩ 非数字的客户端值不许被上限"救活"成数字
  const { out: o10 } = build({ max_tokens: 'abc' }, { minMaxTokens: 1024, maxMaxTokens: 393216 });
  if (o10.max_tokens === 'abc') ok('非数字原样透传（不崩、不被改）');
  else bad('非数字被改坏了', String(o10.max_tokens));

  // ⑪ 上限得是整数（上游只认整数，小数上限不该原样发出去）
  const { out: o11 } = build({ max_tokens: 393216 }, { minMaxTokens: 1024, maxMaxTokens: 131072.4 });
  if (o11.max_tokens === 131072) ok('小数上限取整', String(o11.max_tokens));
  else bad('小数上限没取整', String(o11.max_tokens));

  // ⑫ 标记照旧摘干净
  if (!('__o2aBumped' in out)) ok('夹取标记也摘干净了');
  else bad('夹取标记漏在 body 里了');
}

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══\n`);
process.exit(fail ? 1 : 0);
