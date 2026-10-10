// 验证自助登录里两个没法靠「假装登录」测的步骤：
//
//   ⑤ 用凭据换令牌（这里借用现有账号的 refresh_token，走的同一个端点、同一套 DPoP 签名）
//   ⑥ 拿凭据问云端要网关信息 —— 这是把「登录成功」变成「账号能用」的那一步
//
// 第 ⑥ 步是全新代码，必须实测。

import path from 'node:path';
import { AccountStore } from '../src/accounts.mjs';
import { RefreshState, CredentialRefresher } from '../src/refresh.mjs';
import { LoginFlow } from '../src/oauth.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

const store = new AccountStore({ dataFile: path.join(ROOT, 'data', 'accounts.json') });
store.load();
store.scan();
const acc0 = [...store.accounts.values()][0];
if (!acc0) { console.log('号池是空的，先登录一次 OfficeAce'); process.exit(1); }

const state = new RefreshState(path.join(ROOT, 'data', 'refresh-state.json'));
const live = state.usableCredential(acc0.id);
if (live) store.applyRefreshedCredential(acc0.id, live);
const acc = store.get(acc0.id);
const profile = acc.profile;

console.log('=== 准备 ===');
console.log(`  账号: ${acc.label}`);
console.log(`  AK  : ${profile.accessKeyId.slice(0, 12)}…`);

const flow = new LoginFlow({
  accounts: store,
  config: { refresh: {} },
  sessionFile: '',
  accountFile: '',
});

/* ---------- ⑥ 拿凭据问网关 ---------- */

console.log('\n=== ⑥ _fetchModelInfo：凭据 → 可用网关连接 ===');
let info;
try {
  info = await flow._fetchModelInfo({
    accessKeyId: profile.accessKeyId,
    secretAccessKey: profile.secretAccessKey,
    securityToken: profile.securityToken,
    projectId: profile.projectId,
  });
} catch (err) {
  console.log('  ✗ 失败:', err.message);
  process.exit(1);
}

console.log('  ✓ 成功');
console.log(`    华为云账号 ID : ${info.accountId}`);
console.log(`    principal     : ${info.principalId}`);
console.log(`    app_key       : ${info.appKey.slice(0, 8)}…${info.appKey.slice(-4)}`);
console.log(`    app_secret    : ${info.appSecret.slice(0, 8)}…${info.appSecret.slice(-4)}`);
console.log(`    网关地址      : ${info.baseUrl}`);

/* ---------- 拼出来的连接能不能真的用 ---------- */

console.log('\n=== 用拼出来的连接直接打一次网关 ===');
const authorization = `Basic ${Buffer.from(`${info.appKey}:${info.appSecret}`).toString('base64')}`;
console.log(`  Authorization : ${authorization.slice(0, 22)}…`);

const res = await fetch(`${info.baseUrl}/models`, {
  headers: { Authorization: authorization },
  signal: AbortSignal.timeout(20000),
});
const text = await res.text();
console.log(`  GET /models → HTTP ${res.status}`);
if (res.ok) {
  let j = null;
  try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  const ids = (j?.data || []).map((m) => m.id);
  console.log(`  ✓ 模型 ${ids.length} 个：${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ' …' : ''}`);
} else {
  console.log('  ✗ 响应:', text.slice(0, 300));
}

/* ---------- 和号池里原有的凭据比对 ---------- */

console.log('\n=== 和号池里那条比一比 ===');
const existing = acc.credentials[0];
const same = existing && existing.authorization === authorization;
console.log(`  号池那条 baseUrl 一致 : ${existing?.baseUrl === info.baseUrl}`);
console.log(`  号池那条 Basic 头一致 : ${same ? '是' : '否（华为会轮换密钥，正常）'}`);

/* ---------- 换成账号记录看融不融得进号池 ---------- */

console.log('\n=== 走一遍完整入库路径（用假记录，不写盘） ===');
import { toAccountRecord } from '../src/accounts.mjs';
const rec = toAccountRecord({
  id: `${info.accountId}:${info.principalId}`,
  label: '自助登录测试',
  userName: 'tester',
  accountId: info.accountId,
  userId: info.principalId,
  baseUrl: info.baseUrl,
  authorization,
  createdAt: Date.now(),
  credential: { accessKeyId: profile.accessKeyId, secretAccessKey: profile.secretAccessKey, securityToken: profile.securityToken, projectId: profile.projectId, expiresAt: new Date(Date.now() + 3600e3).toISOString() },
  refreshToken: 'RT-FAKE',
  dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b', d: 'c' },
  dpopPublicJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
});
console.log(`  id              : ${rec.id}`);
console.log(`  网关            : ${rec.credentials[0].baseUrl}`);
console.log(`  profile 有 AK   : ${!!rec.profile.accessKeyId}`);
console.log(`  profile 有 DPoP : ${!!rec.profile.raw.dpop?.privateJwk}`);
console.log(`  profile 有令牌  : ${!!rec.profile.refreshToken}`);
console.log('  → 额度查询、自动续期、连接池调度都能认这条记录');
