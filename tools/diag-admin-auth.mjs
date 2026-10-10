/**
 * 核对面板口令是不是真的生效了。
 * 三条线：不带 / 带对 / 带错，分别打 `/admin/api/state` 和 `/admin`。
 */
import { readFileSync } from 'node:fs';

const B = process.env.O2A_BASE || 'http://127.0.0.1:7864';
const cfg = JSON.parse(readFileSync('config.json', 'utf8'));
const T = cfg.admin?.token || '';

console.log(`  口令: ${T ? `${T.slice(0, 4)}…${T.slice(-4)}（${T.length} 位）` : '（空）'}\n`);

const hit = async (p, tok, apiKey) => {
  const h = {};
  if (tok !== null) h['x-admin-token'] = tok;
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  const r = await fetch(B + p, { headers: h });
  return r.status;
};

const KEY = process.env.O2A_KEY || 'sk-officeace';
const rows = [
  // [路径, 面板口令, API Key, 期望状态码, 说明]
  ['/admin/api/state', null, null, 401, '面板接口不带口令必须拦'],
  ['/admin/api/state', T, null, 200, '带对口令放行'],
  ['/admin/api/state', 'wrong-token', null, 401, '错口令也要拦'],
  // 面板 HTML 那条线：口令既可以在请求头里，也可以直接写在 URL 上。
  // 后者是**人第一次打开面板唯一能用的方式**（浏览器地址栏没法加自定义头），
  // 所以它必须能用 —— 以前服务端只比对请求头，按提示走反而进不去。
  ['/admin', null, null, 401, '面板 HTML 也不该裸奔'],
  ['/admin', T, null, 200, '带对口令能打开面板（头）'],
  ['/admin', 'wrong-token', null, 401, '错口令打不开'],
  ['/admin?token=__T__', null, null, 200, '口令写在 URL 上也能打开（浏览器只能这么传）'],
  ['/admin?token=wrong', null, null, 401, 'URL 上写错口令照样拦'],
  // OpenAI 那条线是**另一套**凭据：API Key，不是面板口令。
  // 两者互不相通 —— 面板口令拿去打 /v1 没用，API Key 拿去打 /admin 也没用。
  ['/v1/models', null, null, 401, 'OpenAI 接口不带 API Key 要拦'],
  ['/v1/models', T, null, 401, '光有面板口令不够（两套凭据不通）'],
  ['/v1/models', null, KEY, 200, '带 API Key 才放行'],
];
let bad = 0;
for (const [p0, tok, ak, expect, why] of rows) {
  const p = p0.replace('__T__', encodeURIComponent(T));
  const st = await hit(p, tok, ak);
  const tag = tok === null ? '无面板口令' : tok === T ? '对面板口令' : '错面板口令';
  const tag2 = ak ? '+APIKey' : '';
  const mark = st === expect ? '✓' : '✗';
  if (st !== expect) bad += 1;
  console.log(`  ${mark} ${p.padEnd(18)} ${(tag + tag2).padEnd(14)} → ${st}  (期望 ${expect})  ${why}`);
}
console.log(`\n  ${bad === 0 ? '✓ 全部符合预期' : `✗ ${bad} 项不符`}\n`);
/*
 * 不要用 `process.exit()` 收尾 —— 上面打过 fetch，undici 的 keep-alive socket
 * 此刻可能还在收尾，强退会撞上 libuv 断言
 *   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
 * （Windows 上退出码变成 -1073740791 = 0xC0000409，CRT abort）。
 * 结果是「全部符合预期」却报了个崩溃码，而且时好时坏。
 */
process.exitCode = bad ? 1 : 0;
