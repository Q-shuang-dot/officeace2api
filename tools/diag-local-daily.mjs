/**
 * 本机自用的日常体验体检。
 *
 * 场景不是"别人 clone"，而是**你自己这台机器、天天用**：
 * 开服务 → 打开面板 → 切七个菜单 → 用测试台发消息。
 * 要确认加了口令之后这一串不会在哪一步卡住。
 *
 * ────────────────────────────────────────────────────────────────
 * 这个脚本我重写过三遍，前两版全是"假路径"造成的误报，值得记下来：
 *
 *   ① 我手写了 `/admin/api/usage`、`/admin/api/models`、`/admin/api/settings`、
 *      `/admin/api/logs` 去探 —— 4 个报 401，差点当成"面板缺 Authorization 头"去改代码。
 *      其实这几个路径**根本不存在**（面板的数据全从 `/admin/api/state` 一次拉全）。
 *   ② 从 server.mjs 抠出 42 条真实路由，但全用 **GET** 探 ——
 *      那些是 POST-only 路由，GET 不命中，照样一片 401。
 *   ③ 最后才明白：**未命中 /admin/api/* 的请求会落到兜底的 API Key 检查**，
 *      于是"路径不存在"和"被鉴权拦住"都回 401，长得一模一样。
 *
 * 破法：加一条**已知不存在**的路径作对照。有了基线，才分得清这两种 401。
 * 下面【0】就是那条对照，别删。
 * ────────────────────────────────────────────────────────────────
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminHeaders, resolveAdminToken, describeAdminToken } from './adminToken.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.O2A_BASE || 'http://127.0.0.1:7864';

let pass = 0;
let fail = 0;
const ok = (m, d) => { pass += 1; console.log(`  ✓ ${m}${d ? `  ${d}` : ''}`); };
const bad = (m, d) => { fail += 1; console.log(`  ✗ ${m}${d ? `  ${d}` : ''}`); };
const note = (m) => console.log(`  · ${m}`);

const cfg = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const KEY = (cfg.apiKeys || [])[0] || '';
const H = adminHeaders();

console.log(`\n  面板口令: ${describeAdminToken()}`);
console.log(`  API Key : ${KEY || '（未配置）'}`);

/* ── 0. 对照组：一个绝不可能存在的路径 ───────────────────────────── */

console.log('\n【0】对照组：故意打一个不存在的路径');
const ghost = await fetch(`${B}/admin/api/zz-no-such-route`, {
  method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}',
});
if (ghost.status === 404) {
  ok('不存在的路径回 404 —— 好，这样"401 = 被拦住"就是可信的判据');
} else if (ghost.status === 401) {
  note(`不存在的路径回 401（${(await ghost.text()).slice(0, 60)}）`);
  note('⚠️ 所以下面看到 401 时，必须再确认路径与 method 都对，才敢说"被鉴权拦了"');
  note('（未命中 /admin/api/* 的请求会落到兜底 API Key 检查，401 是它的默认回答）');
} else {
  bad('不存在的路径回了个奇怪的码', `HTTP ${ghost.status}`);
}

/* ── 1. 七个菜单真实依赖的接口 ───────────────────────────────────── */

console.log('\n【1】七个菜单各自依赖的接口（按面板前端的真实请求打）');
/*
 * 路径全部来自 `src/admin.html` 里 `api("admin/api/...")` 的实际调用。
 * 注意 method 必须是**对的** —— 面板里 `/admin/api/models`、`/admin/api/config`
 * 都是 POST-only，用 GET 探会得到一个误导性的 401。
 */
const st = await (await fetch(`${B}/admin/api/state`, { headers: H })).json();
const accId = (st.accounts || [])[0]?.id || '';

const MENUS = [
  ['账号池', 'GET', '/admin/api/state', undefined, '面板主数据（七个菜单全靠它）'],
  ['账号池', 'GET', '/admin/api/accounts', undefined, '账号列表'],
  ['账号池', 'GET', '/admin/api/accounts/ignored', undefined, '忽略名单'],
  ['账号池', 'GET', '/admin/api/auth/app', undefined, '第三方登录入口（⚠️ GET-only）'],
  ['用量', 'GET', '/admin/api/state', undefined, '用量在 state.usage 里（没有单独接口）'],
  ['积分构成', 'GET', '/admin/api/credits', undefined, '积分总览'],
  ['积分构成', 'GET', '/admin/api/credits/claims', undefined, '签到记录'],
  ['模型与档位', 'GET', '/admin/api/model-rates', undefined, '模型档位'],
  ['接入信息', 'GET', '/admin/api/state', undefined, '接入信息在 state.config 里'],
  ['运行日志', 'GET', '/admin/api/state', undefined, '日志在 state.logs 里'],
  ['配置', 'GET', '/admin/api/state', undefined, '配置在 state.config 里'],
];

for (const [menu, method, p, body, why] of MENUS) {
  const opts = { method, headers: H };
  if (body !== undefined) {
    opts.headers = { ...H, 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(B + p, opts);
  const text = await r.text();
  let shape = '';
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j)) shape = `数组 ${j.length} 项`;
    else if (j && typeof j === 'object') shape = `对象 ${Object.keys(j).length} 键`;
  } catch { shape = `${text.length} 字节`; }
  if (r.status === 200) ok(`[${menu}] ${method} ${p}`, `200  ${shape}  ${why}`);
  else bad(`[${menu}] ${method} ${p}`, `HTTP ${r.status}  ${text.slice(0, 90)}`);
}

/* ── 2. 面板调的路径 vs 服务端真实路由 ───────────────────────────── */

console.log('\n【2】面板调用的接口，服务端是不是都真的存在');
const html = readFileSync(path.join(ROOT, 'src', 'admin.html'), 'utf8');
const server = readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');

const called = new Set();
for (const m of html.matchAll(/api\(\s*"(admin\/api\/[A-Za-z0-9_\-/]+)/g)) called.add(m[1]);
if (called.size === 0) note('没抠出 admin/api 字面量，面板可能换了拼法');
const missing = [];
for (const p of [...called].sort()) {
  // 路径参数（如 /credits/detail?id=…）抠出来的没带 query，正好直接比对
  const needle = `/${p}`;
  if (server.includes(`'${needle}'`) || server.includes(`\`${needle}`) || server.includes(`'${needle}/`)) {
    ok(`面板调 ${p}，服务端有`);
  } else {
    missing.push(p);
  }
}
for (const p of missing) bad(`面板调 ${p}，服务端里找不到`, '它在浏览器里只会表现为"这块空白"');

/* ── 3. 面板 HTML 本身 ──────────────────────────────────────────── */

console.log('\n【3】面板 HTML');
const T = resolveAdminToken();
const viaQuery = await fetch(`${B}/admin?token=${encodeURIComponent(T)}`);
const htmlText = await viaQuery.text();
if (viaQuery.status === 200 && htmlText.length > 10000) ok('带口令能取到完整面板', `${(htmlText.length / 1024).toFixed(1)} KB`);
else bad('面板取不到', `HTTP ${viaQuery.status} ${htmlText.length} 字节`);
for (const menu of ['账号池', '用量', '积分构成', '模型与档位', '接入信息', '运行日志', '配置']) {
  if (htmlText.includes(menu)) ok(`面板里有「${menu}」菜单`);
  else bad(`面板里找不到「${menu}」菜单`);
}
if (/new URLSearchParams\(location\.search\)\.get\(["']token["']\)/.test(htmlText)) {
  ok('面板会从 URL 的 ?token= 里读口令（open-panel.cmd 拼的地址才有用）');
} else {
  bad('面板不再从 URL 读口令了', 'open-panel.cmd 拼的地址会失效');
}

/* ── 4. 测试台那条路（走 API Key，不是面板口令）──────────────────── */

console.log('\n【4】面板「测试台」那条路（走 API Key）');
const lm = await fetch(`${B}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } });
const lmBody = await lm.json().catch(() => null);
if (lm.status === 200) ok('测试台能列模型', `${lmBody?.data?.length} 个`);
else bad('测试台列不了模型', `HTTP ${lm.status}`);
if (htmlText.includes('firstKey')) ok('面板是从配置里取第一个 API Key（不是写死的）');
else note('面板取 key 的写法变了，需要人工确认');

/* ── 5. 退回「本机自用不校验」的路 ──────────────────────────────── */

console.log('\n【5】如果哪天想退回「本机自用不校验」');
if (T) {
  note('把 config.json 的 admin.token 改成 "" 再重启，面板就不校验了');
  note('这是"只在本机"配置下的合理选择 —— 但一旦监听地址改成 0.0.0.0 就危险');
} else {
  ok('当前就是空口令配置，面板不校验');
}

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══\n`);
process.exit(fail ? 1 : 0);
