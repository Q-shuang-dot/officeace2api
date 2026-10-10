/**
 * 探一探：没有网关凭据的账号（第二个号），到底卡在哪一步。
 * ① 账号在号池里的健康状态、凭据数
 * ② 积分服务能不能拿到它的临时 AK/SK（拿不到就说明 refresh_token 这条路也断了）
 * ③ `client-permission-validate` 的**原始响应**里有没有 model_app_key / model_app_secret
 *    —— 这是唯一能让它变成"可转发"的东西，而且它不在磁盘档案里，只在这次响应里
 * ④ 有了那对 key 之后，网关 Basic 认证是不是真的不过期
 */
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:7864';
const KEY = 'sk-officeace';

async function api(path) {
  const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${KEY}` } });
  return r.json();
}

/* ① 号池状态 */
const accs = await api('/admin/api/accounts');
console.log('  ── ① 号池 ──');
for (const a of accs.accounts || []) {
  console.log(`  ${a.short}  ${a.label}`);
  console.log(`     健康 ${a.health?.state}/${a.health?.label}  凭据 ${a.credentials?.length ?? 0} 来源 ${(a.sources || []).join('+')}`);
  console.log(`     有档案? ${!!a.profile}  有 refreshToken? ${!!a.profile?.refreshToken}  AK指纹 ${a.keyFingerprint || '(无)'}`);
}

/* ② 逐账号看积分能不能读到 */
const credits = await api('/admin/api/credits');
console.log('\n  ── ② 积分（每个账号一条）──');
for (const it of credits.items || []) {
  console.log(`  ${String(it.id).slice(0, 22)}…  ok=${it.ok}  error=${it.error || '(无)'}`);
  console.log(`     credentialSource=${it.credentialSource}  refreshable=${it.refreshable}  liveExp=${it.liveCredentialExpiresAt ? new Date(it.liveCredentialExpiresAt).toISOString() : 0}`);
}
console.log(`  summary.lastError = ${JSON.stringify(credits.summary?.lastError)}`);

/* ③ 直接看账号档案里到底有什么字段（脱敏） */
console.log('\n  ── ③ 账号档案字段（本地文件，脱敏）──');
try {
  const doc = JSON.parse(readFileSync(new URL('../data/oauth-accounts.json', import.meta.url), 'utf8'));
  for (const [k, v] of Object.entries(doc)) {
    console.log(`  ${String(k).slice(0, 22)}…`);
    console.log(`     字段: ${Object.keys(v).join(', ')}`);
    console.log(`     baseUrl: ${v.baseUrl || '(空)'}`);
    console.log(`     authorization 前 12 字: ${String(v.authorization || '(空)').slice(0, 12)}`);
    console.log(`     credential.expiresAt: ${v.credential?.expiresAt || '(无)'}`);
  }
  console.log(`  文件里的账号数: ${Object.keys(doc).length}`);
} catch (err) {
  console.log(`  读不到: ${err.message}`);
}

/* ④ 用签名凭据打一次 client-permission-validate，看原始响应 */
console.log('\n  ── ④ client-permission-validate 原始响应（看有没有 app_key）──');
try {
  const { QuotaService } = await import('../src/quota.mjs');
  const { AccountStore } = await import('../src/accounts.mjs');
  const { RefreshState } = await import('../src/refresh.mjs');
  const { loadConfig } = await import('../src/config.mjs');

  const cfg = loadConfig(new URL('../config.json', import.meta.url).pathname.replace(/^\//, ''));
  const store = new AccountStore({ dataFile: new URL('../data/accounts.json', import.meta.url).pathname.replace(/^\//, '') });
  store.oauthFile = new URL('../data/oauth-accounts.json', import.meta.url).pathname.replace(/^\//, '');
  store.refreshState = new RefreshState(new URL('../data/refresh-state.json', import.meta.url).pathname.replace(/^\//, ''));
  store.scan();

  const q = new QuotaService({ accounts: store, config: cfg.credits || {}, refreshState: store.refreshState });
  // ⚠️ client-permission-validate 在**控制面**（agentarts.cn-southwest-2.myhuaweicloud.com），
  //    不是模型网关。上一次探针把 `resolveGateway()` 的返回值当基址用，于是打到了
  //    modelgw-… 上拿到 401 —— 那是我的探针写错了，不是账号的问题。
  const CONTROL_PLANE = 'https://agentarts.cn-southwest-2.myhuaweicloud.com';
  for (const id of store.ids()) {
    const acc = store.get(id);
    console.log(`\n  【${acc.short}】${acc.label}`);
    const got = await q.resolveCredential(id);
    console.log(`     resolveCredential: ${got.error ? '✗ ' + got.error : '✓ source=' + got.source}`);
    if (got.error) continue;
    const url = `${CONTROL_PLANE}/v1/claw/client-permission-validate`;
    const { signV4 } = await import('../src/quota.mjs');
    const headers = signV4({ method: 'GET', url, credential: got.credential, contentType: 'application/json;charset=utf8' });
    const res = await q.fetchJson(url, { method: 'GET', headers });
    console.log(`     GET ${url}`);
    console.log(`     HTTP ${res.status}`);
    // ⚠️ 顶层没有 model_info —— 它在 subscription 里面。
    //    之前探针只看顶层，所以误判成"拿不到 app_key"。这里两处都看。
    const mi = res.json?.model_info || res.json?.subscription?.model_info || res.json?.modelInfo || {};
    const ai = mi.model_auth_info || {};
    console.log(`     顶层键: ${Object.keys(res.json || {}).join(', ')}`);
    console.log(`     subscription 里的键: ${Object.keys(res.json?.subscription || {}).join(', ')}`);
    console.log(`     有 model_auth_info? ${!!mi.model_auth_info}`);
    console.log(`     model_app_key 前 8 字: ${ai.model_app_key ? ai.model_app_key.slice(0, 8) + '…' : '(无)'}`);
    console.log(`     model_app_secret 存在? ${!!ai.model_app_secret}`);
    console.log(`     model_api_url_base: ${mi.model_api_url_base || '(无)'}`);
    console.log(`     account_id=${res.json?.account_id}  principal_id=${res.json?.principal_id}`);
    console.log(`     subscription.status=${res.json?.subscription?.status || '(无)'}`);
    if (!res.ok) console.log(`     error_code=${res.json?.error_code} error_msg=${res.json?.error_msg}`);
  }
} catch (err) {
  console.log(`  ✗ 探测失败: ${err.message}`);
  console.log(String(err.stack).split('\n').slice(1, 4).join('\n'));
}
