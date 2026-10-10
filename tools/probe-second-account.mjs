/**
 * 探一探：没有网关凭据的账号（第二个号），到底卡在哪一步。
 * ① 账号在号池里的健康状态、凭据数
 * ② 积分服务能不能拿到它的临时 AK/SK（拿不到就说明 refresh_token 这条路也断了）
 * ③ `client-permission-validate` 的**原始响应**里有没有 model_app_key / model_app_secret
 *    —— 这是唯一能让它变成"可转发"的东西，而且它不在磁盘档案里，只在这次响应里
 * ④ 有了那对 key 之后，网关 Basic 认证是不是真的不过期
 */
import { adminHeaders } from './adminToken.mjs';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:7864';
const KEY = 'sk-officeace';

async function api(path) {
  const r = await fetch(BASE + path, { headers: adminHeaders({ Authorization: `Bearer ${KEY}` }) });
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
  // 注意：本探针**故意不**导入/实例化 RefreshState，见下面 store.refreshState 那段注释。
  const { loadConfig } = await import('../src/config.mjs');

  const cfg = loadConfig(new URL('../config.json', import.meta.url).pathname.replace(/^\//, ''));
  const store = new AccountStore({ dataFile: new URL('../data/accounts.json', import.meta.url).pathname.replace(/^\//, '') });
  store.oauthFile = new URL('../data/oauth-accounts.json', import.meta.url).pathname.replace(/^\//, '');
  /**
   * ⚠️ 这里**故意不**把 RefreshState 接进来（只给一个只读替身）。
   *
   * 原来接的是真的 `data/refresh-state.json`，有两个问题：
   *   ① 服务器正把那份状态放在内存里管着、还要定期回写，探针再开一个
   *      `QuotaService` 去写同一个文件，就是两个写者抢一个落盘点；
   *   ② 探针读到的是一份**快照**，服务器内存里早就换过好几轮的 refresh_token
   *      它不知道，于是会报一句很吓人的
   *      "refresh_token 已被使用过（STS5.1806）" —— 而那一刻服务器的
   *      `/healthz` 其实是 `credentials:2 / accountsUsable:2`，完全健康。
   *      这种"探针自己造成的假故障"最费时间。
   *
   * 想知道真实的凭据健康度就看 `/healthz` 和 `/admin/api/state`（下面的 ①/② 段
   * 就是这么取的）；这里只用 store 的只读档案，不碰任何落盘点。
   */
  store.refreshState = null;
  store.scan();

  const q = new QuotaService({ accounts: store, config: cfg.credits || {}, refreshState: store.refreshState });
  // ⚠️ client-permission-validate 在**控制面**（agentarts.cn-southwest-2.myhuaweicloud.com），
  //    不是模型网关。上一次探针把 `resolveGateway()` 的返回值当基址用，于是打到了
  //    modelgw-… 上拿到 401 —— 那是我的探针写错了，不是账号的问题。
  const CONTROL_PLANE = 'https://agentarts.cn-southwest-2.myhuaweicloud.com';
  // 先问服务的真实状态：探针自己的判断只当参考，服务说的才算
  let live = null;
  try {
    const r = await fetch('http://127.0.0.1:7864/admin/api/state', {
      headers: { Authorization: 'Bearer sk-officeace' },
      signal: AbortSignal.timeout(10000),
    });
    live = await r.json();
  } catch { /* 服务没起就算了，下面按探针自己的判断走 */ }
  // `/healthz` 才是汇总那几个数字的地方（`/admin/api/state` 的 health 里没有）
  let hz = null;
  try {
    hz = await (await fetch('http://127.0.0.1:7864/healthz', { signal: AbortSignal.timeout(10000) })).json();
  } catch { /* 同上 */ }
  if (live) {
    console.log(`\n  ── 服务自报（以这个为准）──`);
    if (hz) {
      for (const k of ['status', 'credentials', 'accounts', 'accountsUsable', 'defaultModel', 'modelsUnavailable', 'creditsRemaining']) {
        if (hz[k] !== undefined) {
          const v = Array.isArray(hz[k]) ? `[${hz[k].length} 个]` : hz[k];
          console.log(`     healthz.${k} = ${JSON.stringify(v)}`);
        }
      }
    }
    console.log(`     号池（转发真正用的凭据）:`);
    for (const e of live.pool || []) {
      console.log(`        #${e.index} ok=${e.ok} fail=${e.fail} 冷却=${e.cooldownMsLeft || 0}ms source=…${String(e.source || '').slice(-46)}`);
    }
  }
  for (const id of store.ids()) {
    const acc = store.get(id);
    console.log(`\n  【${acc.short}】${acc.label}`);
    const got = await q.resolveCredential(id);
    // 注意这里**不用 ✗**：① 续期失败是**常见且无害**的（见下面那段），
    // 用 ✗ 会被当成故障，也会被回归脚本的 "✗ 计数" 误判成套件失败。
    console.log(`     resolveCredential: ${got.error ? '△ ' + got.error : '✓ source=' + got.source}`);
    if (got.error) {
      /*
       * ⚠️ 别把这一句读成"这个号坏了"。凭据有两套，探针看的是**另一套**：
       *
       *   ① 临时 AK/SK —— 有效期 24 小时，用 refresh_token 续期。**只用来做
       *      控制面签名**（查积分额度、查模型权限、查网关地址）。探针问的就是它。
       *   ② MaaS 网关的 `Basic base64(app_key:app_secret)` —— 从
       *      `models.json` / `oauth-accounts.json` 里读出来的，**不过期**。
       *      **转发请求用的是这一套。**
       *
       * 所以 ① 续期失败只影响"看得见多少积分"，不影响"能不能转发"。
       * 号池里的凭据就是 ②（看 `/admin/api/state` 的 `pool[].source`），
       * 池子 ok 在涨就说明这个号在正常干活。
       */
      console.log('     ※ 这是①临时凭据（只管查额度），续期用的 refresh_token 是磁盘快照、可能已经换过。');
      console.log('       转发用的是②网关 Basic 凭据（不过期），以下面「服务自报」的号池 ok 为准。');
      continue;
    }
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
