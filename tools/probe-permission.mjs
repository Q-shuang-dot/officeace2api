// 排障工具：打印 /v1/claw/client-permission-validate 的完整返回
//
// 用当前号池里第一条凭据去问云端「我能用什么」，把 modelInfo 整个摊开看。
// 结论用来决定「自己 OAuth 拿到凭据后怎么拼上游连接」。
//
//   node tools/probe-permission.mjs

import path from 'node:path';
import { AccountStore } from '../src/accounts.mjs';
import { RefreshState } from '../src/refresh.mjs';
import { signV4, DEFAULT_AGENTARTS_BASE } from '../src/quota.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

function mask(v, keep = 10) {
  const s = String(v || '');
  if (s.length <= keep * 2) return s;
  return `${s.slice(0, keep)}…${s.slice(-4)} (${s.length})`;
}

/** 深度遍历，把像密钥的字段打码 */
function scrub(obj, depth = 0) {
  if (depth > 8) return '…';
  if (Array.isArray(obj)) return obj.map((v) => scrub(v, depth + 1));
  if (!obj || typeof obj !== 'object') {
    if (typeof obj === 'string' && obj.length > 80) return mask(obj);
    return obj;
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const kl = k.toLowerCase();
    if (/(secret|token|password|passwd|auth|key|credential)/.test(kl) && typeof v === 'string') {
      out[k] = mask(v, 12);
    } else {
      out[k] = scrub(v, depth + 1);
    }
  }
  return out;
}

const store = new AccountStore({ dataFile: path.join(ROOT, 'data', 'accounts.json') });
store.load();
store.scan();
const acc = [...store.accounts.values()][0];
if (!acc?.profile?.accessKeyId) {
  console.log('没发现带临时凭据的账号，先把 OfficeAce 登录一次');
  process.exit(1);
}

// 磁盘档案是 24 小时就过期的旧凭据；真正能用的是 refresh-state.json 里那份。
// 服务里由 QuotaService.seedRefreshedCredentials() 回灌，这里手动来一遍。
const state = new RefreshState(path.join(ROOT, 'data', 'refresh-state.json'));
const live = state.usableCredential(acc.id);
if (live) store.applyRefreshedCredential(acc.id, live);

const p = store.get(acc.id).profile;
const credential = {
  accessKey: p.accessKeyId,
  secretKey: p.secretAccessKey,
  securityToken: p.securityToken,
  projectId: p.projectId,
};

console.log('=== 用哪个号 ===');
console.log(`  账号    : ${acc.label || acc.short}`);
console.log(`  AK      : ${mask(p.accessKeyId, 8)}`);
console.log(`  有安全令牌: ${p.securityToken ? '是 (' + mask(p.securityToken, 8) + ')' : '否'}`);
console.log(`  projectId : ${p.projectId || '(空)'}`);
console.log(`  凭据来源  : ${p.refreshed ? '已自动续期' : '磁盘档案'}`);
console.log(`  网关      : ${acc.credentials[0]?.baseUrl || '(无)'}`);

const origin = DEFAULT_AGENTARTS_BASE;
const url = `${origin}/v1/claw/client-permission-validate`;

console.log('\n=== 请求 ===');
console.log(`  GET ${url}`);

const headers = signV4({ method: 'GET', url, credential, contentType: 'application/json;charset=utf8' });
const res = await fetch(url, { method: 'GET', headers });
const text = await res.text();

console.log(`\n=== 响应 HTTP ${res.status} ===`);
let json = null;
try {
  json = JSON.parse(text);
} catch { /* 非 JSON */ }

if (!json) {
  console.log(text.slice(0, 800));
} else {
  console.log('  顶层字段: ' + Object.keys(json).join(', '));

  const mi = json.model_info || json.subscription?.model_info || json.modelInfo;
  if (mi) {
    console.log('\n=== modelInfo 结构 ===');
    console.log(JSON.stringify(scrub(mi), null, 2));
  } else {
    console.log('\n  没找到 model_info，完整响应：');
    console.log(JSON.stringify(scrub(json), null, 2).slice(0, 3000));
  }
}
