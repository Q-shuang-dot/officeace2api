/**
 * 凭据 & 模型自动发现
 *
 * OfficeAce 桌面端把「上游模型网关的 api_base + Authorization」写进本机文件：
 *   ~/.office-claw/.jiuwenclaw/config/routing_state/users/<uid>/models.json
 *   ~/.office-claw/relayclaw/jiuwenclaw/config/routing_state/users/<uid>/models.json
 *   <installRoot>/.office-claw/...（便携安装时）
 *
 * 其中 model_client_config 形如：
 *   {
 *     "api_base": "https://modelgw-0004.<region>.huaweicloud-agentarts.com/v2",
 *     "api_key": "huawei-maas-session",          // 占位，真实鉴权在 custom_headers
 *     "model_name": "deepseek-v4.1-flash",
 *     "client_provider": "OpenAI",
 *     "custom_headers": { "Authorization": "Basic <AK:SK>" }
 *   }
 *
 * 另有 ~/.office-claw/users/<uid>/model.json 提供「账号 -> 模型 -> baseUrl」目录。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.mjs';
import { listDirs, readJson, safeJson, home, trimSlash, maskSecret } from './util.mjs';

const log = createLogger('discover');

const PLACEHOLDER_KEYS = new Set([
  '',
  'huawei-maas-session',
  'placeholder-api-key',
  'sk-xxxxxxxxx',
  'your-api-key',
]);

function candidateRoots() {
  const roots = [];
  const h = home();
  roots.push(path.join(h, '.office-claw'));
  if (process.env.OFFICEACE_INSTALL_DIR) {
    roots.push(path.join(process.env.OFFICEACE_INSTALL_DIR, '.office-claw'));
  }
  // 常见安装位置（便携版会把 .office-claw 放在安装目录下）
  for (const drive of ['C', 'D', 'E']) {
    for (const dir of ['软件', 'Program Files', 'Program Files (x86)']) {
      roots.push(path.join(`${drive}:\\`, dir, 'OfficeAce', '.office-claw'));
    }
  }
  return roots;
}

function routingStateDirs(root) {
  return [
    path.join(root, '.jiuwenclaw', 'config', 'routing_state', 'users'),
    path.join(root, 'relayclaw', 'jiuwenclaw', 'config', 'routing_state', 'users'),
    path.join(root, 'plugin-host', 'routing_state', 'users'),
  ];
}

function userDirs(root) {
  return [path.join(root, 'users'), path.join(root, '.jiuwenclaw', 'users')];
}

/** 归一化一条 model_client_config -> 凭据片段 */
function credentialFromConfig(cfg, ctx) {
  if (!cfg || typeof cfg !== 'object') return null;
  const baseUrl = trimSlash(cfg.api_base || cfg.baseUrl || cfg.base_url || '');
  if (!baseUrl) return null;

  const headers = {};
  const custom = cfg.custom_headers || cfg.customHeaders || cfg.headers;
  if (custom && typeof custom === 'object') {
    for (const [k, v] of Object.entries(custom)) {
      if (typeof v === 'string' && v.trim()) headers[k] = v.trim();
    }
  }

  const rawKey = String(cfg.api_key || '').trim();
  const hasAuthHeader = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
  if (!hasAuthHeader && rawKey && !PLACEHOLDER_KEYS.has(rawKey)) {
    headers.Authorization = rawKey.startsWith('Bearer ') || rawKey.startsWith('Basic ') ? rawKey : `Bearer ${rawKey}`;
  }
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) return null;

  return {
    baseUrl,
    headers,
    modelName: cfg.model_name || cfg.modelName || '',
    provider: cfg.client_provider || cfg.provider || 'OpenAI',
    modelProvider: ctx.modelProvider || '',
    source: ctx.source,
    userId: ctx.userId || '',
  };
}

function collectFromRoutingState(file, userId) {
  const doc = readJson(file);
  if (!doc || typeof doc !== 'object') return [];
  const out = [];
  const lists = [];
  if (Array.isArray(doc.defaults)) lists.push(doc.defaults);
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'defaults' || key === '_meta') continue;
    if (Array.isArray(value)) lists.push(value);
    else if (value && typeof value === 'object' && Array.isArray(value.entries)) lists.push(value.entries);
  }
  for (const list of lists) {
    for (const entry of list) {
      const cfg = entry?.model_client_config || entry?.modelClientConfig || entry;
      const cred = credentialFromConfig(cfg, {
        source: file,
        userId,
        modelProvider: entry?.model_provider || entry?.modelProvider || '',
      });
      if (cred) out.push(cred);
    }
  }
  return out;
}

function collectCatalogFromModelJson(file) {
  const doc = readJson(file);
  if (!doc || typeof doc !== 'object') return [];
  const out = [];
  for (const [account, models] of Object.entries(doc)) {
    if (!Array.isArray(models)) continue;
    for (const m of models) {
      if (!m || typeof m !== 'object') continue;
      const id = m.id || m.name;
      if (!id) continue;
      out.push({
        id: String(id),
        account,
        baseUrl: trimSlash(m.baseUrl || m.base_url || ''),
        ownedBy: m.owned_by || 'system',
        created: Number(m.created) || 0,
      });
    }
  }
  return out;
}

function fingerprint(baseUrl, headers) {
  const auth = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1] || '';
  return `${baseUrl}||${auth}`;
}

/**
 * 扫描本机，返回 { credentials: [...], catalog: [...] }
 */
export function discover({ installDirs = [] } = {}) {
  const credentialMap = new Map();
  const catalog = [];
  const seenCatalog = new Set();

  const explicit = [process.env.OFFICEACE_MODELS_JSON, process.env.OFFICEACE_ROUTING_STATE].filter(Boolean);

  const routingFiles = [...explicit];
  for (const root of [...candidateRoots(), ...installDirs]) {
    for (const dir of routingStateDirs(root)) {
      for (const userDir of listDirs(dir)) {
        const f = path.join(userDir, 'models.json');
        if (fs.existsSync(f)) routingFiles.push(f);
      }
    }
    for (const dir of userDirs(root)) {
      for (const userDir of listDirs(dir)) {
        const mj = path.join(userDir, 'model.json');
        if (fs.existsSync(mj)) {
          for (const item of collectCatalogFromModelJson(mj)) {
            const key = `${item.id}@${item.baseUrl}`;
            if (!seenCatalog.has(key)) {
              seenCatalog.add(key);
              catalog.push(item);
            }
          }
        }
      }
    }
  }

  const scannedFiles = new Set();
  for (const file of routingFiles) {
    if (scannedFiles.has(file)) continue;
    scannedFiles.add(file);
    if (!fs.existsSync(file)) continue;
    // 目录名是「<账号ID>:<IAM用户ID>」的 URL 编码形式，解开才是身份标识，
    // 否则和号池（accounts.mjs）里的 ID 对不上。
    const rawId = path.basename(path.dirname(file));
    let userId = rawId;
    try {
      userId = decodeURIComponent(rawId);
    } catch {
      /* 保持原样 */
    }
    for (const cred of collectFromRoutingState(file, userId)) {
      const key = fingerprint(cred.baseUrl, cred.headers);
      const existing = credentialMap.get(key);
      if (existing) {
        if (cred.modelName && !existing.models.includes(cred.modelName)) existing.models.push(cred.modelName);
      } else {
        credentialMap.set(key, {
          id: `cred-${credentialMap.size + 1}`,
          baseUrl: cred.baseUrl,
          headers: cred.headers,
          provider: cred.provider,
          modelProvider: cred.modelProvider,
          userId: cred.userId,
          source: cred.source,
          models: cred.modelName ? [cred.modelName] : [],
        });
      }
    }
  }

  const credentials = [...credentialMap.values()].map((c) => ({
    ...c,
    authPreview: maskSecret(
      Object.entries(c.headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1] || '',
    ),
  }));

  log.debug('discover done', {
    files: [...scannedFiles].map((f) => path.basename(path.dirname(f))),
    credentials: credentials.length,
    catalog: catalog.length,
  });

  return { credentials, catalog };
}

export function extractBaseFromAny(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') {
    const parsed = safeJson(obj);
    return parsed ? extractBaseFromAny(parsed) : '';
  }
  return trimSlash(obj.api_base || obj.baseUrl || '');
}

export { candidateRoots as _discoveryRoots };
