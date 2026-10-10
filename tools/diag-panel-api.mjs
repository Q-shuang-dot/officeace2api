/**
 * 用**面板自己那段真实的 api() 代码**做端到端验证。
 *
 * ## 为什么不能"我自己重写一遍请求"
 *
 * 前面 `diag-panel-body.mjs` / `diag-panel-alias.mjs` 都是我在脚本里手写 fetch，
 * 那样只能证明"服务端行为如何"，**证明不了面板修好了没有** ——
 * 因为要验的恰恰是 `admin.html` 里那个 `api()` 的翻译逻辑。
 *
 * 所以这里把 `api()` **整段从 admin.html 里抠出来**，用 `new Function` 装成真函数
 * （喂真的 fetch、真的 H()/J()），然后调它 —— 等价于浏览器里点那个按钮。
 *
 * 顺带把"改之前"的行为也复现一遍作对照，证明这个测试真的测得住
 * （不然"修好了"可能只是因为测试本身没测到）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.O2A_BASE || 'http://127.0.0.1:7864';
const cfg = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const ADMIN = String(cfg.admin?.token || '');
const KEY = (cfg.apiKeys || [])[0] || '';

const html = readFileSync(path.join(ROOT, 'src', 'admin.html'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (m, d) => { pass += 1; console.log(`  ✓ ${m}${d ? `  ${d}` : ''}`); };
const bad = (m, e) => { fail += 1; console.log(`  ✗ ${m}  ${e}`); };
const note = (m) => console.log(`  · ${m}`);

/* ── 把 api() 从 admin.html 里抠出来 ─────────────────────────────── */

/** 从 `async function api(path, opts) {` 起，按大括号配平截到函数结束 */
function extractApi(srcText) {
  // 优先找带 async 的；找不到再找普通 function
  for (const head of [/async function api\s*\(/, /function api\s*\(/]) {
    const m = head.exec(srcText);
    if (!m) continue;
    const start = m.index;
    const braceOpen = srcText.indexOf('{', start + m[0].length - 1);
    let depth = 0;
    for (let i = braceOpen; i < srcText.length; i += 1) {
      const c = srcText[i];
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) return srcText.slice(start, i + 1);
      }
    }
  }
  return null;
}

const apiSrc = extractApi(html);
if (!apiSrc) {
  bad('没能从 admin.html 里抠出 api()', '面板改过结构？需要人工确认');
  process.exit(1);
}
note(`抠出 api()：${apiSrc.split('\n').length} 行，${apiSrc.length} 字符`);

/*
 * 复现"改之前"那版：把新的两行逻辑换回老的。
 * 用来做对照 —— 如果对照也"通过"，说明测试没测到东西。
 */
const oldApiSrc = apiSrc
  .replace(
    /let hasBody = o\.body !== undefined;\s*\n\s*if \(o\.json !== undefined && o\.json !== true\) \{\s*\n\s*o\.body = JSON\.stringify\(o\.json\);\s*\n\s*hasBody = true;\s*\n\s*\}\s*\n\s*delete o\.json;\s*\n\s*o\.headers = Object\.assign\(\{\}, H\(\), hasBody \? J : \{\}, o\.headers \|\| \{\}\);/,
    'const hasJson = o.json !== undefined;\n  if (hasJson) { o.body = JSON.stringify(o.json); delete o.json; }\n  o.headers = Object.assign({}, H(), hasJson ? J : {}, o.headers || {});',
  );
const hasOldVersion = oldApiSrc !== apiSrc;
note(`对照版（老逻辑）提取${hasOldVersion ? '成功' : '失败 —— 对照将跳过'}`);

const H = () => ({ 'x-admin-token': ADMIN });
const J = { 'Content-Type': 'application/json' };

/*
 * `api()` 发的是**相对路径**（`/admin/api/xxx`）。
 * 浏览器会自动按当前页面 origin 补全，Node 的 fetch 不会 —— 直接抛
 * `Failed to parse URL from /admin/api/models`。
 * 所以给它包一层，把相对路径补成 `${B}...`，其余原样透传。
 * 这一步只是补环境差异，不改变 api() 本身的逻辑。
 */
const fetchForPanel = (input, init) => {
  if (typeof input === 'string' && input.startsWith('/')) return fetch(B + input, init);
  return fetch(input, init);
};

const makeApi = (src) => new Function('fetch', 'H', 'J', `${src}\nreturn api;`)(fetchForPanel, H, J);

const apiNew = makeApi(apiSrc);
const apiOld = hasOldVersion ? makeApi(oldApiSrc) : null;

/* ── 准备：找一个可逆的写入点（模型别名）────────────────────────── */

const state = async () => (await (await fetch(`${B}/admin/api/state`, { headers: H() })).json());
const s0 = await state();
const ids = (s0.models || []).map((m) => m.id);
const target = ids.find((x) => /glm-5\.2/.test(x)) || ids[0];
const BASE_CFG = {
  alias: { ...(s0.config?.models?.alias || {}) },
  hidden: s0.config?.models?.hidden || [],
  extra: s0.config?.models?.extra || [],
};
const MARK = 'zz-api-probe';

console.log(`\n  实验对象：把别名 \`${MARK}\` 指向 \`${target}\``);

/* ── A. 新版 api()（面板现在的代码）──────────────────────────────── */

console.log('\n【A】新版 api()：{ json: {对象} } —— 应该能存进去');
await apiNew('/admin/api/models', { method: 'POST', json: { ...BASE_CFG, alias: { ...BASE_CFG.alias, [MARK]: target } } });
const afterNew = (await state()).config?.models?.alias?.[MARK];
if (afterNew === target) ok('存进去了', `alias["${MARK}"] = ${JSON.stringify(afterNew)}`);
else bad('没存进去', `读到 ${JSON.stringify(afterNew)}，期望 ${JSON.stringify(target)}`);

/* ── B. 新版 api() 的第二种写法（{json:true, body} 也不该再被吃掉）── */

console.log('\n【B】新版 api()：{ json: true, body: <字符串> } —— 这条老写法也必须能通');
await apiNew('/admin/api/models', {
  method: 'POST',
  json: true,
  body: JSON.stringify({ ...BASE_CFG, alias: { ...BASE_CFG.alias, [MARK]: 'zz-second' } }),
});
const afterSecond = (await state()).config?.models?.alias?.[MARK];
if (afterSecond === 'zz-second') ok('也存进去了（两种写法都支持）', `alias["${MARK}"] = ${JSON.stringify(afterSecond)}`);
else bad('这种写法还是被吃掉', `读到 ${JSON.stringify(afterSecond)}，期望 "zz-second"`);

/* ── C. 对照：老版 api() 必须复现"静默丢失"───────────────────────── */

console.log('\n【对照】老版 api()（改之前的代码）—— 应该复现"界面成功、实际没存"');
if (!apiOld) {
  note('对照版提取失败，跳过（但上面的 A/B 已经证明修好了）');
} else {
  // 先把标记清掉，制造一个"本来没有这个别名"的干净状态
  await apiNew('/admin/api/models', { method: 'POST', json: { ...BASE_CFG } });
  const cleanCheck = (await state()).config?.models?.alias?.[MARK];
  note(`清场后 alias["${MARK}"] = ${JSON.stringify(cleanCheck)}（应为 undefined）`);

  const r = await apiOld('/admin/api/models', {
    method: 'POST',
    json: true,
    body: JSON.stringify({ ...BASE_CFG, alias: { ...BASE_CFG.alias, [MARK]: 'zz-old-should-fail' } }),
  }).catch((e) => ({ error: e.message }));
  const afterOld = (await state()).config?.models?.alias?.[MARK];
  note(`老版调用返回：${JSON.stringify(r).slice(0, 80)}`);
  if (afterOld === undefined) {
    ok('对照复现成功：老版发出的是 body="true"，字段没到服务端 → **静默没保存**');
    note('这条对照证明上面的 A/B 是真的测到了东西，而不是碰巧通过');
  } else {
    bad('对照没复现（老版居然也存进去了）', `alias["${MARK}"] = ${JSON.stringify(afterOld)}`);
    note('要重新想一遍：可能我的老版替换没生效');
  }
}

/* ── D. 别的形态也别打坏 ─────────────────────────────────────────── */

console.log('\n【D】其它 opts 形态不该被这次修改弄坏');
// 不带 body 的 GET —— /admin/api/state 返回的是 {health, config, pool, models, ...} 一大堆键
const g = await apiNew('/admin/api/state');
if (g && typeof g === 'object' && Array.isArray(g.models)) ok('GET 无 body 正常', `拿到 ${Object.keys(g).length} 个顶层键`);
else bad('GET 无 body 出问题', JSON.stringify(g).slice(0, 80));
// json: {}（空对象）→ 应发 "{}"
const e = await apiNew('/admin/api/refresh', { method: 'POST', json: {} });
if (e && (e.upstream !== undefined || e.ok !== undefined)) ok('POST json:{} 正常', JSON.stringify(e).slice(0, 70));
else bad('POST json:{} 出问题', JSON.stringify(e).slice(0, 100));
// 显式给 headers 时不该被覆盖（口令头必须还在，否则这个请求会 401）
const c = await apiNew('/admin/api/state', { headers: { 'x-custom': '1' } });
if (c && Array.isArray(c.models)) ok('显式 headers 与口令头能合并（口令没被顶掉，请求没变 401）');
else bad('合并 headers 出问题', JSON.stringify(c).slice(0, 80));

/* ── 还原 ────────────────────────────────────────────────────────── */

console.log('\n【还原】');
await apiNew('/admin/api/models', { method: 'POST', json: { ...BASE_CFG } });
const finalAlias = (await state()).config?.models?.alias || {};
const clean = finalAlias[MARK] === undefined
  && JSON.stringify(Object.keys(finalAlias).sort()) === JSON.stringify(Object.keys(BASE_CFG.alias).sort());
if (clean) ok('模型配置已还原成实验前的样子', `alias 共 ${Object.keys(finalAlias).length} 项`);
else bad('没还原干净', JSON.stringify(finalAlias));

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══\n`);
process.exit(fail ? 1 : 0);
