#!/usr/bin/env node
/**
 * 模型注册表：大小写归一 + 去重。
 *
 * 起因是一个真踩到的坑（本轮实测）：
 *
 *     POST /v1/chat/completions  {"model":"kimi-k2.6"}   → 200 正常出结果
 *     POST /v1/chat/completions  {"model":"KIMI-K2.6"}   → 404 没有这个模型
 *
 * 同一个模型，只因为大小写就一个能用一个报错 —— 而上游网关本身对大小写不敏感
 * （`Kimi-K2.6` 和 `kimi-k2.6` 两种拼法探测都返回 200）。原因是 `resolve()` 只做
 * 精确匹配，`KIMI-K2.6` 原样透传，然后被 `checkModel()` 判成「没有这个模型」。
 * 报的还是最容易让人怀疑上游的那句话。
 *
 * 这里钉住四件事：
 *   1. 清单里同一个模型的两个拼法只留一条（上游真的会这么给）
 *   2. `resolve()` 把任意大小写变体归一到清单里的拼法；**未知名字原样返回**
 *      （不能凭空造模型 —— 那是 checkModel 判 404 的依据）
 *   3. 别名也按大小写不敏感；hide 也按大小写不敏感
 *   4. 归一之后冷却/拒绝标记不会再因为拼法不同而各记一份
 *
 *   node tools/test-models.mjs
 */

import { ModelRegistry } from '../src/models.mjs';

let pass = 0;
const fails = [];
function ok(name) {
  pass += 1;
  console.log(`  ✓ ${name}`);
}
function bad(name, extra) {
  fails.push(name);
  console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`);
}

console.log('模型注册表：大小写');

/** 复刻 server.mjs 里 checkModel() 的判据：不在清单里就 404 */
const wouldPassCheck = (registry, requested) => registry.ids().includes(registry.resolve(requested));

const build = (over = {}) => {
  const reg = new ModelRegistry({ alias: {}, hidden: [], extra: [], ...over });
  reg.setUpstream([
    { id: 'Kimi-K2.6', owned_by: 'moonshot' },
    { id: 'kimi-k2.6', owned_by: 'moonshot' }, // 上游真的会两种拼法都给
    { id: 'glm-5.2', owned_by: 'zhipu' },
    { id: 'deepseek-v3.2', owned_by: 'deepseek' },
  ]);
  reg.setDiscovered([{ id: 'glm-5.3-test', baseUrl: 'https://127.0.0.1:1', account: 'acc' }]);
  return reg;
};

/* ---------------------------------------------------- 1. 大小写去重 */
{
  const reg = build();
  const ids = reg.ids();
  const lower = ids.map((x) => x.toLowerCase());
  const dupes = lower.filter((x, i) => lower.indexOf(x) !== i);
  if (ids.length === 4 && dupes.length === 0) ok(`清单大小写去重（4 条：${ids.join(', ')}）`);
  else bad('清单大小写去重', JSON.stringify(ids));

  const listed = reg.toOpenAiList().map((m) => m.id);
  if (listed.length === ids.length) ok('/v1/models 里也只剩一条（客户端选择器不会出现两个同名项）');
  else bad('/v1/models 还有重复', JSON.stringify(listed));
}

/* ---------------------------------------------------- 2. 归一成清单里的拼法 */
{
  const reg = build();
  const canonical = reg.resolve('kimi-k2.6');
  const cases = ['Kimi-K2.6', 'kimi-k2.6', 'KIMI-K2.6', 'Kimi-k2.6', 'kImI-K2.6'];
  const wrong = cases.filter((c) => reg.resolve(c) !== canonical);
  if (canonical && wrong.length === 0) ok(`五种大小写变体都归一到 ${canonical}`);
  else bad('大小写归一', JSON.stringify([canonical, wrong]));

  // 同一条：两处不同拼法必须落到同一个键，否则冷却/拒绝标记各记一份、互相不生效
  if (reg.resolve('KIMI-K2.6') === reg.resolve('kimi-k2.6')) ok('两种拼法落到同一个记账键（冷却不会因为拼法而漏）');
  else bad('两种拼法记账键不一致', '冷却、拒绝标记会各记一份');

  // 这就是 checkModel 的不变量 —— 以前 `KIMI-K2.6` 正是挂在这里（404 没有这个模型）
  const allIds = reg.ids();
  const variants = allIds.flatMap((id) => [id, id.toUpperCase(), id.toLowerCase()]);
  const rejected = variants.filter((v) => !wouldPassCheck(reg, v));
  if (rejected.length === 0) {
    ok(`清单里每个模型的任意大小写都能通过模型校验（测了 ${variants.length} 个写法）`);
  } else {
    bad('有大小写变体过不了模型校验（就是 404 那个坑）', JSON.stringify(rejected.slice(0, 6)));
  }

  const glm = reg.ids().find((x) => x === 'glm-5.2');
  if (wouldPassCheck(reg, 'GLM-5.2') && wouldPassCheck(reg, 'Glm-5.2')) ok('普通模型（glm-5.2）的大写也放行，不是只对 Kimi 特殊处理');
  else bad('glm-5.2 大写没放行', glm);
}

/* ---------------------------------------------------- 3. 未知名字不许被造出来 */
{
  const reg = build();
  const ghost = '完全不存在的模型';
  if (reg.resolve(ghost) === ghost && !reg.ids().includes(reg.resolve(ghost)) && !wouldPassCheck(reg, ghost)) {
    ok('未知名字原样返回，而且过不了模型校验（仍然 404 —— 这条不能松）');
  } else {
    bad('未知名字的处理', JSON.stringify([reg.resolve(ghost), wouldPassCheck(reg, ghost)]));
  }
  if (reg.resolve('') === null && reg.resolve(null) === null) ok('空名字返回 null（交给默认模型那条路）');
  else bad('空名字', JSON.stringify([reg.resolve(''), reg.resolve(null)]));
}

/* ---------------------------------------------------- 4. 别名与隐藏 */
{
  const reg = build({ alias: { 'gpt-4o': 'glm-5.2', 'Kimi-Thinking': 'Kimi-K2.6' } });
  const cases = [
    ['gpt-4o', 'glm-5.2'],
    ['GPT-4O', 'glm-5.2'],
    ['Kimi-Thinking', 'Kimi-K2.6'],
    ['kimi-thinking', 'Kimi-K2.6'],
  ];
  const wrong = cases.filter(([inp, want]) => reg.resolve(inp) !== want);
  if (wrong.length === 0) ok('别名精确和大小写不敏感两种写法都认');
  else bad('别名大小写', JSON.stringify(wrong));

  if (reg.ids().includes('gpt-4o') && reg.ids().includes('Kimi-Thinking')) ok('别名本身也出现在清单里（客户端能选）');
  else bad('别名没进清单', JSON.stringify(reg.ids()));
}

{
  // hidden 写一个小写，也要把清单里的 CamelCase 藏掉
  const reg = build({ hidden: ['kimi-k2.6'] });
  if (!reg.ids().some((x) => x.toLowerCase() === 'kimi-k2.6')) ok('hide 按大小写不敏感生效（写小写也能藏掉 Kimi-K2.6）');
  else bad('hide 没生效', JSON.stringify(reg.ids()));
  if (!wouldPassCheck(reg, 'KIMI-K2.6')) ok('藏掉的模型即使换个大小写请求也照样拒绝（不能绕过去）');
  else bad('藏掉的模型被绕过了', '换个大小写就能用');
}

/* ---------------------------------------------------- 5. 默认模型与 has() */
{
  const reg = build();
  if (reg.defaultModel() === 'glm-5.2') ok('默认模型仍优先 glm-5.2');
  else bad('默认模型', reg.defaultModel());
  if (reg.has('GLM-5.2') && !reg.has('glm-9.9')) ok('has() 也大小写不敏感，未知名字返回 false');
  else bad('has() 行为', JSON.stringify([reg.has('GLM-5.2'), reg.has('glm-9.9')]));
}

console.log('\n' + '='.repeat(56));
console.log(`结果：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log(`  - ${f}`);
}
process.exit(fails.length ? 1 : 0);