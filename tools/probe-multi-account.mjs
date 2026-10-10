/**
 * 多账号最终体检：一眼看完"两个号到底能不能用、有没有互相拖累"。
 *
 * 和 probe-second-account.mjs 的分工：
 *   - probe-second-account.mjs  看**单个号的凭据从哪来**（控制面原始响应）
 *   - 这个                       看**整体健康**（轮询公不公平、冷却有没有串、签到账对不对）
 */
import { adminHeaders } from './adminToken.mjs';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:7864';
const KEY = 'sk-officeace';
const H = adminHeaders({ Authorization: `Bearer ${KEY}` });

const get = async (p) => (await fetch(BASE + p, { headers: H })).json();
const chat = async (model) => {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'x' }], max_tokens: 2 }),
  });
  return r.status;
};

console.log('══ 1. 账号池 ══');
const acc = await get('/admin/api/accounts');
for (const a of acc.accounts) {
  console.log(`   ${a.short}  ${String(a.label).padEnd(22)} 健康=${a.health.state}/${a.health.label}  凭据=${a.credentials.length}  来源=${(a.sources || []).join('+')}`);
}
console.log(`   合计：${acc.status.total} 个号 / ${acc.status.enabled} 启用 / ${acc.status.healthy} 健康 / ${acc.status.credentials} 条凭据`);

console.log('\n══ 2. 连接池（能不能被调度去转发）══');
const st = await get('/admin/api/state');
for (const e of st.pool || []) {
  console.log(`   #${e.index}  ${String(e.userId).slice(0, 8)}..  ok=${e.ok} fail=${e.fail} rateLimited=${e.rateLimited}  整条冷却=${e.cooldownMsLeft}ms  拒绝过的模型=${(e.rejectedModels || []).length} 个`);
}

console.log('\n══ 3. 轮询公平性（连打 6 发，两个号都应该有份）══');
for (let i = 0; i < 6; i += 1) await chat('deepseek-v4-flash-0731');
const st2 = await get('/admin/api/state');
console.log('   ' + (st2.pool || []).map((e) => `#${e.index} 本轮 ok=${e.ok}`).join('   '));

console.log('\n══ 4. 健康度会不会说真话 ══');
const hz = await get('/healthz');
console.log(`   status=${hz.status}  credentials=${hz.credentials}  accounts=${hz.accounts}  accountsUsable=${hz.accountsUsable}`);
console.log(`   额度：${hz.creditsRemainingEnabled}（启用且读到额度的号）  creditsAccounts=${hz.creditsAccounts}`);
console.log(`   目录里但用不了：${(hz.modelsUnavailable || []).length} 个  ${JSON.stringify(hz.modelsUnavailable || [])}`);

console.log('\n══ 5. 签到账目 ══');
const cr = await get('/admin/api/credits');
const s = cr.summary;
console.log(`   接口调通=${s.claimedToday}  真领到分=${s.claimedWithGain}  claimTotal=${s.claimTotal}`);
console.log(`   lastError="${s.lastError}"${s.lastErrorAccount ? `（来自 ${String(s.lastErrorAccount).slice(0, 8)}..）` : ''}`);
console.log(`   每号各自的错误：${JSON.stringify(s.lastErrorByAccount || {})}`);

console.log('\n══ 6. 盘上有没有幽灵键 ══');
try {
  const meta = JSON.parse(readFileSync(new URL('../data/accounts.json', import.meta.url), 'utf8'));
  const keys = [...Object.keys(meta.labels || {}), ...(meta.disabled || []), ...(meta.ignored || [])];
  const ghosts = keys.filter((k) => !/^[0-9a-f]{32}:[0-9a-f]{32}$/.test(k));
  console.log(`   labels/disabled/ignored 共 ${keys.length} 个键，形态不对的 ${ghosts.length} 个${ghosts.length ? '：' + JSON.stringify(ghosts) : ' ✓'}`);
} catch (err) {
  console.log(`   读不到 accounts.json：${err.message}`);
}
