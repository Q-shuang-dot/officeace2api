/**
 * 一次性诊断：现在这套东西到底能不能用？
 *
 *   1) 直接用 models.json 里那条 Basic 凭据打上游网关（绕过本服务）
 *   2) 打本服务的 /v1/chat/completions（走号池 → 连接池）
 *
 * 只读 + 只发一次最小请求，不改任何文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY = 'sk-officeace';
const LOCAL = 'http://127.0.0.1:7864';

function credFromModelsJson() {
  const root = path.join(os.homedir(), '.office-claw', '.jiuwenclaw', 'config', 'routing_state', 'users');
  if (!fs.existsSync(root)) return null;
  for (const dir of fs.readdirSync(root)) {
    const f = path.join(root, dir, 'models.json');
    if (!fs.existsSync(f)) continue;
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const v of Object.values(doc)) {
      if (!Array.isArray(v)) continue;
      for (const entry of v) {
        const cfg = entry?.model_client_config || entry?.modelClientConfig || entry;
        const base = String(cfg?.api_base || '').replace(/\/+$/, '');
        const auth = cfg?.custom_headers?.Authorization || cfg?.headers?.Authorization;
        if (base && auth) return { baseUrl: base, authorization: auth, userId: decodeURIComponent(dir), model: cfg.model_name || '' };
      }
    }
  }
  return null;
}

function mask(s) {
  return String(s || '').length > 18 ? `${s.slice(0, 18)}…(${s.length})` : s;
}

async function post(url, { headers = {}, body, timeoutMs = 60000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(t);
  }
}

const out = [];

// ① 直连上游
const cred = credFromModelsJson();
if (!cred) {
  out.push('① 直连上游：没找到 models.json 凭据');
} else {
  out.push(`① 直连上游 baseUrl=${cred.baseUrl}`);
  out.push(`   userId=${cred.userId}`);
  out.push(`   Authorization=${mask(cred.authorization)}`);
  const r = await post(`${cred.baseUrl}/chat/completions`, {
    headers: { Authorization: cred.authorization },
    body: { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false },
  });
  out.push(`   → HTTP ${r.status}  ${r.text.replace(/\s+/g, ' ').slice(0, 400)}`);
}

// ② 走本服务
{
  const r = await post(`${LOCAL}/v1/chat/completions`, {
    headers: { Authorization: `Bearer ${KEY}` },
    body: { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false },
  });
  out.push(`② 走本服务 /v1/chat/completions → HTTP ${r.status}  ${r.text.replace(/\s+/g, ' ').slice(0, 500)}`);
}

console.log(out.join('\n'));
