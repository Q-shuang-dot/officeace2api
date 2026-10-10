/**
 * 探针：给「没有网关凭据」的账号补上凭据，然后**真的用这条凭据打一发**。
 *
 * 为什么需要：账号通过「一键授权」进来时，项目只扫到了它的档案（oauth-profile）
 * 和目录（user-dir），从来没有拿到过 MaaS 网关的 Basic key。桌面端之所以有，
 * 是因为它自己请求过模型、把 key 写进了 routing_state/users/<id>/models.json。
 * 所以这种号在池子里是"看得见、用不了"。
 *
 * 但控制面的 client-permission-validate 现在就能把它换出来（响应里
 * subscription.model_info.model_auth_info 就是那对 key），而临时 AK/SK
 * 项目已经会自己续期。所以补得回来。
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url);
const p = (rel) => decodeURIComponent(new URL(rel, ROOT).pathname).replace(/^\//, '');

const [{ AccountStore, toAccountRecord }, { QuotaService }, { RefreshState }, { loadConfig }, { signV4 }] =
  await Promise.all([
    import('../src/accounts.mjs'),
    import('../src/quota.mjs'),
    import('../src/refresh.mjs'),
    import('../src/config.mjs'),
    import('../src/quota.mjs'),
  ]);

const cfg = loadConfig(p('config.json'));
const store = new AccountStore({ dataFile: p('data/accounts.json') });
store.oauthFile = p('data/oauth-accounts.json');
store.refreshState = new RefreshState(p('data/refresh-state.json'));
store.scan();

const CONTROL_PLANE = 'https://agentarts.cn-southwest-2.myhuaweicloud.com';
const quota = new QuotaService({ accounts: store, config: cfg.credits || {}, refreshState: store.refreshState });

/** 把一个账号的网关 Basic 凭据取出来（不落盘，先只看能不能取到） */
async function fetchGatewayKey(accountId) {
  const acc = store.get(accountId);
  if (!acc) return { error: '账号不存在' };
  if (acc.credentials?.length) return { error: '已经有凭据了，不需要补', already: true };

  const got = await quota.resolveCredential(accountId);
  if (got.error) return { error: `拿不到临时 AK/SK：${got.error}`, stage: 'credential' };

  const url = `${CONTROL_PLANE}/v1/claw/client-permission-validate`;
  const headers = signV4({
    method: 'GET',
    url,
    credential: got.credential,
    contentType: 'application/json;charset=utf8',
  });
  const res = await quota.fetchJson(url, { method: 'GET', headers });
  if (!res.ok || !res.json) {
    return { error: `控制面 HTTP ${res.status}：${res.json?.error_msg || res.text.slice(0, 120)}`, stage: 'validate' };
  }
  const mi = res.json.model_info || res.json.subscription?.model_info || res.json.modelInfo || null;
  const ai = mi?.model_auth_info || null;
  if (!ai?.model_app_key || !ai?.model_app_secret) {
    return { error: '控制面响应里没有 model_auth_info（这个号可能还没开通服务）', stage: 'validate', keys: Object.keys(res.json) };
  }
  const host = String(mi.model_api_url_base || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return {
    appKey: String(ai.model_app_key),
    appSecret: String(ai.model_app_secret),
    baseUrl: host ? `https://${host}/v2` : '',
    accountId: res.json.account_id || '',
    principalId: res.json.principal_id || '',
    credentialSource: got.source,
  };
}

console.log('══ 补凭据：能不能取到 ══');
const results = {};
for (const id of store.ids()) {
  const acc = store.get(id);
  console.log(`\n  【${acc.short}】${acc.label}  现有凭据 ${acc.credentials?.length ?? 0}`);
  const r = await fetchGatewayKey(id);
  results[id] = r;
  if (r.error) {
    console.log(`     ✗ ${r.error}`);
  } else {
    console.log(`     ✓ 取到 key（临时凭据来源 ${r.credentialSource}）`);
    console.log(`       baseUrl=${r.baseUrl}`);
    console.log(`       accountId=${r.accountId}  principalId=${r.principalId}`);
    console.log(`       appKey 指纹=${r.appKey.slice(0, 8)}…${r.appKey.slice(-4)}`);
  }
}

/* 真的用补出来的那条凭据打一发，证明它可用 */
console.log('\n══ 拿补出来的凭据实打一发上游 ══');
const target = Object.entries(results).find(([, r]) => !r.error && r.baseUrl);
if (!target) {
  console.log('  （没有可试的账号）');
} else {
  const [id, r] = target;
  const authorization = `Basic ${Buffer.from(`${r.appKey}:${r.appSecret}`).toString('base64')}`;
  const url = `${r.baseUrl}/chat/completions`;
  const body = JSON.stringify({
    model: 'deepseek-v4-flash-0731',
    messages: [{ role: 'user', content: '只回一个字：好' }],
    max_tokens: 8,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    console.log(`  POST ${url}`);
    console.log(`  HTTP ${res.status}`);
    if (res.ok) {
      const j = JSON.parse(text);
      console.log(`  ✓ 可用！content=${JSON.stringify(j.choices?.[0]?.message?.content)} usage=${JSON.stringify(j.usage)}`);
    } else {
      console.log(`  ✗ 响应前 300 字: ${text.slice(0, 300)}`);
    }
  } catch (err) {
    console.log(`  ✗ 请求失败: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  void id;
}
