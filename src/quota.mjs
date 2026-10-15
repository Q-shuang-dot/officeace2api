/**
 * 积分额度：把「这个号还剩多少积分」从华为云问出来
 *
 * 数据源（全部由 OfficeAce / 华为 AgentArts 官方接口提供，逆向自
 *   packages/api/dist/index.js 的 SubscriptionStore.cloudFetch
 *   packages/api/dist/huawei-signed-request-PAPO4MQP.js 的签名器）
 *
 *  1. GET  {agentarts}/v1/claw/client-permission-validate      SDK-HMAC-SHA256
 *       → 校验凭据，并取回该账号专属网关地址 model_api_url_base
 *
 *  2. GET  {gateway}/v1/subscription   （头 x-subscription-type: v2）  V11-HMAC-SHA256
 *       → 套餐信息 + 积分额度
 *         skus[].quotas[]  : { sku_attr_code:'officeace_points', sku_value:总额, current_value:已用 }
 *         skus[].quotas[]  : { sku_attr_code:'online_search_count', ... } 联网搜索次数
 *         bonus_skus[]     : 奖励积分 { activity_name, points:总额, current_value:已用, expired_time }
 *       剩余 = sku_value - current_value（OfficeAce 自己的算法，见其 AK() 函数）
 *
 *  3. GET  {gateway}/v1/subscription/usage?sku_attr_code=officeace_points&aggregation=day
 *       → 每日消耗明细 { consumed_amount, total_token, created_at }（按北京时间的自然日分桶）
 *
 *  4. GET  {gateway}/v1/model-token-rates
 *       → 每个模型的积分换算率（多少 token 扣 1 积分）
 *
 * 两套签名：
 *   SDK-HMAC-SHA256：标准 V4 风格，AK 直接做密钥
 *   V11-HMAC-SHA256：多了 region 作用域，密钥要先派生
 *     CredentialScope = <YYYYMMDD>/<region>/apic
 *     SigningKey      = HMAC(HMAC(AK, SK), scope + 0x01)[0..32]
 *     Signature       = HMAC(SigningKey, StringToSign)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.mjs';
import { writeFileAtomic } from './util.mjs';
import { RefreshState, CredentialRefresher, overlayCredential } from './refresh.mjs';

const log = createLogger('quota');

/** AgentArts 总控域名（提供 /v1/claw/* 和默认的订阅入口） */
export const DEFAULT_AGENTARTS_BASE = 'https://agentarts.cn-southwest-2.myhuaweicloud.com';
/** 默认模型网关（订阅接口主要在这里） */
const DEFAULT_GATEWAY = 'https://modelgw-0004.officeace.cn-southwest-2.huaweicloud-agentarts.com';
const DEFAULT_REGION = 'cn-southwest-2';
/** V11 的 CredentialScope 服务名，APIG 固定 apic */
const SCOPE_SERVICE = 'apic';

/* ============================================================ 签名 */

const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmacHex = (key, data) => crypto.createHmac('sha256', key).update(data).digest('hex');
const rfc3986 = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function sdkDate(d = new Date()) {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function canonicalUri(url) {
  let p = (url.pathname || '/').split('/').map((seg) => rfc3986(decodeURIComponent(seg))).join('/');
  if (!p.endsWith('/')) p += '/';
  return p;
}

function canonicalQuery(url) {
  const pairs = [];
  url.searchParams.forEach((v, k) => pairs.push([k, v]));
  pairs.sort(([a, b], [c, d]) => (a === c ? b.localeCompare(d) : a.localeCompare(c)));
  return pairs.map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join('&');
}

function normalizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  }
  return out;
}

function canonicalRequest(method, url, headers, names, payloadHash) {
  const head = `${names.map((n) => `${n}:${headers[n]}`).join('\n')}\n`;
  return [method.toUpperCase(), canonicalUri(url), canonicalQuery(url), head, names.join(';'), payloadHash].join('\n');
}

/** 大小写不敏感地设头（会把同名的旧头删掉，避免签名对不上） */
function setHeader(headers, name, value) {
  for (const k of Object.keys(headers)) {
    if (k !== name && k.toLowerCase() === name.toLowerCase()) delete headers[k];
  }
  headers[name] = value;
}

function putCommonHeaders(headers, { url, credential, contentType, sdkDateOverride }) {
  // `sdkDateOverride` 只给测试用：`X-Sdk-Date` 是**秒级**的，两次签名如果跨过
  // 一秒边界就不一样，测试没法稳定断言"同一输入出同一签名"。传进来一个固定值
  // 就能钉住。
  // 注意大小写不敏感：靠 `headers` 传 `X-Sdk-Date` / `x-sdk-date` 都会被这里的
  // `setHeader` 覆盖掉，所以想钉住就**必须走这个参数**。
  setHeader(headers, 'X-Sdk-Date', sdkDateOverride || sdkDate());
  if (credential.securityToken) setHeader(headers, 'X-Security-Token', credential.securityToken);
  setHeader(headers, 'Host', new URL(url).host);
  if (contentType) setHeader(headers, 'Content-Type', contentType);
  if (credential.projectId) setHeader(headers, 'X-Project-ID', credential.projectId);
}

/** 标准 SDK-HMAC-SHA256：密钥就是 SK 本身 */
export function signV4({ method, url, credential, bodyText = '', headers = {}, contentType, sdkDateOverride }) {
  const out = { ...headers };
  putCommonHeaders(out, { url, credential, contentType, sdkDateOverride });
  const norm = normalizeHeaders(out);
  const names = Object.keys(norm).sort();
  const cr = canonicalRequest(method, new URL(url), norm, names, sha256Hex(bodyText));
  const sts = ['SDK-HMAC-SHA256', norm['x-sdk-date'], sha256Hex(cr)].join('\n');
  const sig = hmacHex(credential.secretKey, sts);
  out.Authorization = `SDK-HMAC-SHA256 Access=${credential.accessKey}, SignedHeaders=${names.join(';')}, Signature=${sig}`;
  return out;
}

/**
 * V11-HMAC-SHA256：APIG 的区域作用域签名。
 * 派生密钥那一步是华为特有的：HMAC(HMAC(AK, SK), scope + 0x01)，取 32 字节。
 */
export function signV11({ method, url, credential, region = DEFAULT_REGION, bodyText = '', headers = {}, contentType, sdkDateOverride }) {
  const out = { ...headers };
  putCommonHeaders(out, { url, credential, contentType, sdkDateOverride });
  const norm = normalizeHeaders(out);
  const names = Object.keys(norm).sort();
  const date = norm['x-sdk-date'];
  const scope = `${date.slice(0, 8)}/${region}/${SCOPE_SERVICE}`;
  const cr = canonicalRequest(method, new URL(url), norm, names, sha256Hex(bodyText));
  const sts = ['V11-HMAC-SHA256', date, scope, sha256Hex(cr)].join('\n');
  const step1 = crypto.createHmac('sha256', credential.accessKey).update(credential.secretKey).digest();
  const seed = Buffer.concat([Buffer.from(scope, 'utf8'), Buffer.from([1])]);
  const signingKey = crypto.createHmac('sha256', step1).update(seed).digest().subarray(0, 32).toString('hex');
  const sig = hmacHex(signingKey, sts);
  out.Authorization = `V11-HMAC-SHA256 Credential=${credential.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`;
  return out;
}

/* ============================================================ 解析 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const ms = (v) => {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? t : 0;
};

/** 套餐档位：officeace.personal.package.trial → trial */
function tierOf(skuCode) {
  const last = String(skuCode || '').split('.').pop() || '';
  return last || 'trial';
}

const TIER_NAMES = {
  trial: '试用版',
  starter: '入门版',
  standard: '标准版',
  advanced: '高级版',
  premium: '尊享版',
  ultimate: '旗舰版',
};

const SUBSCRIBE_STATUS = {
  SUBSCRIBED: '正常',
  EXPIRED: '已到期',
  UNSUBSCRIBED: '未订阅',
  FROZEN: '已冻结',
};

/** 北京时间（UTC+8）的 YYYY-MM-DD */
function bjDay(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return '';
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 把 /v1/subscription 的响应翻成人话。
 * 剩余额度算法与 OfficeAce 前端一致：总额 − 已用，过期条目不计入。
 */
export function summarizeSubscription(sub, { now = Date.now() } = {}) {
  const skus = Array.isArray(sub?.skus) ? sub.skus : [];
  const bonusSkus = Array.isArray(sub?.bonus_skus) ? sub.bonus_skus : [];

  const planSkus = [];
  const bonusItems = [];
  let searchTotal = 0;
  let searchUsed = 0;
  let searchFound = false;

  for (const sku of skus) {
    const quotas = Array.isArray(sku?.quotas) ? sku.quotas : [];
    let ptsTotal = 0;
    let ptsUsed = 0;
    for (const q of quotas) {
      const exp = ms(q?.expired_time);
      if (exp && exp <= now) continue; // 过期的额度不算
      if (q?.sku_attr_code === 'officeace_points') {
        ptsTotal += num(q.sku_value);
        ptsUsed += num(q.current_value);
      } else if (q?.sku_attr_code === 'online_search_count') {
        searchFound = true;
        searchTotal += num(q.sku_value);
        searchUsed += num(q.current_value);
      }
    }
    const tier = tierOf(sku?.sku_code);
    planSkus.push({
      skuCode: String(sku?.sku_code || ''),
      name: String(sku?.sku_name || '') || TIER_NAMES[tier] || tier,
      tier,
      tierName: TIER_NAMES[tier] || tier,
      status: String(sku?.subscribe_status || ''),
      statusText: SUBSCRIBE_STATUS[sku?.subscribe_status] || String(sku?.subscribe_status || '未知'),
      effectiveAt: ms(sku?.effective_time),
      expiresAt: ms(sku?.expired_time),
      points: {
        total: round2(ptsTotal),
        used: round2(ptsUsed),
        remaining: round2(Math.max(0, ptsTotal - ptsUsed)),
        unlimited: ptsTotal === -1,
      },
    });
  }

  for (const b of bonusSkus) {
    const exp = ms(b?.expired_time);
    const total = num(b?.points);
    const used = num(b?.current_value);
    const expired = !!exp && exp <= now;
    bonusItems.push({
      activityId: String(b?.activity_id || ''),
      name: String(b?.activity_name || b?.activity_id || '奖励积分'),
      total: round2(total),
      used: round2(used),
      remaining: round2(Math.max(0, total - used)),
      effectiveAt: ms(b?.effective_time),
      expiresAt: exp,
      expired,
      daily: /daily|checkin|check-in/i.test(String(b?.cbc_resource_id || '')) || /签到|每日/.test(String(b?.activity_name || '')),
    });
  }

  const aliveBonus = bonusItems.filter((b) => !b.expired);
  const planTotal = sum(planSkus.map((s) => s.points.total));
  const planUsed = sum(planSkus.map((s) => s.points.used));
  const planRemaining = sum(planSkus.map((s) => s.points.remaining));
  const bonusTotal = sum(aliveBonus.map((b) => b.total));
  const bonusUsed = sum(aliveBonus.map((b) => b.used));
  const bonusRemaining = sum(aliveBonus.map((b) => b.remaining));

  const main = planSkus[0] || null;
  const earliestExpiry = aliveBonus.length ? Math.min(...aliveBonus.map((b) => b.expiresAt)) : main?.expiresAt || 0;

  const total = round2(planTotal + bonusTotal);
  const used = round2(planUsed + bonusUsed);
  const remaining = round2(planRemaining + bonusRemaining);

  return {
    ok: true,
    fetchedAt: now,
    plan: {
      name: main?.name || '未开通',
      tier: main?.tier || 'trial',
      tierName: main?.tierName || '试用版',
      status: String(sub?.subscribe_status || main?.status || ''),
      statusText: SUBSCRIBE_STATUS[String(sub?.subscribe_status || '')] || main?.statusText || '未知',
      effectiveAt: main?.effectiveAt || 0,
      expiresAt: main?.expiresAt || 0,
    },
    plans: planSkus,
    // 积分账本
    points: {
      total,
      used,
      remaining,
      percentUsed: total > 0 ? round2((used / total) * 100) : 0,
      planTotal: round2(planTotal),
      planUsed: round2(planUsed),
      planRemaining: round2(planRemaining),
      bonusTotal: round2(bonusTotal),
      bonusUsed: round2(bonusUsed),
      bonusRemaining: round2(bonusRemaining),
    },
    bonuses: bonusItems,
    searches: searchFound
      ? { total: searchTotal, used: searchUsed, remaining: Math.max(0, searchTotal - searchUsed) }
      : null,
    nextExpiryAt: earliestExpiry,
    // 给面板直接用的一句话
    headline: remaining > 0 ? `剩 ${fmtPoints(remaining)} 积分` : '积分已用完',
    subline: buildSubline({
      remaining,
      planRemaining,
      bonusRemaining: bonusRemaining,
      searches: searchFound ? Math.max(0, searchTotal - searchUsed) : null,
      expiresAt: main?.expiresAt || 0,
      now,
    }),
    raw: { skus, bonus_skus: bonusSkus },
  };
}

function buildSubline({ remaining, planRemaining, bonusRemaining, searches, expiresAt, now }) {
  const parts = [];
  if (planRemaining > 0) parts.push(`套餐 ${fmtPoints(planRemaining)}`);
  if (bonusRemaining > 0) parts.push(`奖励 ${fmtPoints(bonusRemaining)}`);
  if (!parts.length) parts.push('已用完');
  const search = searches === null ? '' : ` · 联网搜索剩 ${searches} 次`;
  const days = expiresAt ? Math.ceil((expiresAt - now) / 86400000) : null;
  const valid = days === null ? '' : days > 0 ? ` · 有效期还剩 ${days} 天` : ' · 已过期';
  return parts.join(' + ') + search + valid;
}

function sum(list) {
  return list.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
function fmtPoints(n) {
  const v = Number(n) || 0;
  if (Math.abs(v - Math.round(v)) < 0.005) return String(Math.round(v));
  return v.toFixed(2);
}

/* ============================================================ 服务 */

/** 面板用的「一行看懂」文字卡，纯 ASCII + 中文，复制到哪里都不乱码 */
function renderText(summary) {
  if (!summary?.ok) {
    return summary?.error ? `拿不到积分额度：${summary.error}` : '还没查询过积分额度';
  }
  const L = [];
  const { plan, points, searches, bonuses } = summary;
  const days = plan.expiresAt ? Math.ceil((plan.expiresAt - Date.now()) / 86400000) : null;
  L.push(`【${plan.name}】${plan.statusText}${days !== null ? `，有效期还剩 ${days} 天` : ''}`);
  if (plan.expiresAt) L.push(`到期：${new Date(plan.expiresAt).toLocaleString('zh-CN')}`);
  L.push('');
  L.push(`总共 ${fmtPoints(points.total)} 积分   已用 ${fmtPoints(points.used)}   剩余 ${fmtPoints(points.remaining)}`);
  L.push(`  套餐积分 ${fmtPoints(points.planRemaining)} / ${fmtPoints(points.planTotal)}`);
  L.push(`  奖励积分 ${fmtPoints(points.bonusRemaining)} / ${fmtPoints(points.bonusTotal)}`);
  if (searches) L.push(`  联网搜索剩 ${searches.remaining} 次（共 ${searches.total}）`);
  if (bonuses.length) {
    L.push('');
    L.push('奖励明细：');
    for (const b of bonuses) {
      L.push(
        `  ${b.expired ? '（已过期）' : ''}${b.name}  剩 ${fmtPoints(b.remaining)} / ${fmtPoints(b.total)}` +
          (b.expiresAt ? `  到 ${new Date(b.expiresAt).toLocaleString('zh-CN')}` : ''),
      );
    }
  }
  return L.join('\n');
}

export class QuotaService {
  /**
   * @param {object} opts
   * @param {import('./accounts.mjs').AccountStore} opts.accounts
   * @param {object} [opts.config]       config.quota
   * @param {string} [opts.historyFile]  历史快照文件
   */
  constructor({ accounts, config = {}, historyFile = '', refreshStateFile = '' }) {
    this.accounts = accounts;
    this.config = config;
    this.historyFile = historyFile;
    this.cache = new Map(); // accountId -> { at, data }
    this.inflight = new Map(); // accountId -> Promise
    this.history = loadHistory(historyFile);
    this.lastError = '';
    /** 每个账号最近一次的失败原因（accountId -> 文案）。成功即清除。 */
    this.lastErrorByAccount = Object.create(null);
    /** 全局 `lastError` 是哪个账号留下的（成功时用来判断该不该擦掉） */
    this.lastErrorAccount = '';
    this.region = config.region || DEFAULT_REGION;
    this.ttlMs = Math.max(30, Number(config.ttlSeconds) || 300) * 1000;
    this.timeoutMs = Math.max(3000, Number(config.timeoutMs) || 20000);
    this.gatewayOverride = String(config.gateway || '').trim();

    // 凭据自动续期：临时 AK/SK 只有 24 小时，refresh_token 能撑 30 天
    this.refreshEnabled = config.autoRefreshCredentials !== false;
    this.refreshState = new RefreshState(refreshStateFile);
    this.refresher = new CredentialRefresher({ state: this.refreshState, config: config.refresh || {} });
    this.refreshing = new Map(); // accountId -> Promise，防并发重复续期

    // 签到记录：同一天同一个活动只签一次
    this.claimFile = historyFile ? path.join(path.dirname(historyFile), 'bonus-claims.json') : '';
    this.claims = loadHistory(this.claimFile);

    // 每读到一次新额度就回调一把，用来给连接池喂「积分熔断」数据
    this.onUpdate = typeof config.onUpdate === 'function' ? config.onUpdate : null;

    // 启动时把上次跑出来的续期凭据补回内存里 —— 否则重启后面板会拿磁盘上那份
    // 过期的旧凭据显示「已过期」，看着像坏了，其实我们手里有新的。
    this.seedRefreshedCredentials();
  }

  /**
   * 把 data/refresh-state.json 里还新鲜的凭据回灌到账号档案。
   * 幂等，随便调；回灌的是内存，不碰 OfficeAce 的任何文件。
   */
  seedRefreshedCredentials() {
    if (!this.refreshEnabled || typeof this.accounts?.applyRefreshedCredential !== 'function') return 0;
    let n = 0;
    for (const rec of this.refreshState.list()) {
      // 账号 ID 可能长可能短，两种写法都试一遍
      const target = this.accounts.ids().find((id) => id === rec.accountId || id.startsWith(rec.accountId) || rec.accountId.startsWith(id));
      if (!target) continue;
      if (this.accounts.applyRefreshedCredential(target, rec.credential)) n += 1;
    }
    if (n) log.info('已从续期状态补回凭据', { accounts: n });
    return n;
  }

  /** 把当前缓存里的余额推给订阅方（连接池用它决定还选不选这个号） */
  notify() {
    if (!this.onUpdate) return;
    try {
      const items = this.accounts.ids().map((id) => {
        const q = this.peek(id);
        return {
          id,
          userId: id,
          remaining: q?.ok ? Number(q.points?.remaining) || 0 : null,
          ok: !!q?.ok,
        };
      });
      this.onUpdate(items);
    } catch (err) {
      log.debug('推送积分给连接池失败', { error: err.message });
    }
  }

  /* ---- 取凭据（过期就自动续期） ---- */

  /**
   * 拿到「现在能用」的凭据。
   * 优先级：① 续期换回来的新凭据 ② 磁盘档案里还没过期的 ③ 触发续期
   */
  async resolveCredential(accountId) {
    const acc = this.accounts.get(accountId);
    if (!acc) return { error: '账号不存在' };
    const base = acc.profile;
    if (!base?.accessKeyId || !base?.secretAccessKey) {
      return { error: '这个号没有临时 AK/SK（安装密钥解不开，或还没登录过）' };
    }
    const cred = acc.credentials[0];
    const agentartsBase = new URL(cred?.baseUrl || DEFAULT_AGENTARTS_BASE).origin;

    // ① 续期记录里还有新鲜的
    const cached = this.refreshState.usableCredential(accountId);
    if (cached) {
      const p = overlayCredential(base, cached);
      return {
        account: acc,
        profile: p,
        credential: {
          accessKey: p.accessKeyId,
          secretKey: p.secretAccessKey,
          securityToken: p.securityToken,
          projectId: p.projectId,
        },
        agentartsBase,
        source: 'refreshed',
      };
    }

    // ② 磁盘上的还没过期
    if (base.expiresAt && base.expiresAt > Date.now() + 120000) {
      return {
        account: acc,
        profile: base,
        credential: {
          accessKey: base.accessKeyId,
          secretKey: base.secretAccessKey,
          securityToken: base.securityToken,
          projectId: base.projectId,
        },
        agentartsBase,
        source: 'disk',
      };
    }

    // ③ 过期了 —— 试试续期
    if (this.refreshEnabled && base.refreshToken) {
      const r = await this.refreshCredential(accountId);
      if (r.ok) {
        const p = overlayCredential(base, r.credential);
        return {
          account: acc,
          profile: p,
          credential: {
            accessKey: p.accessKeyId,
            secretKey: p.secretAccessKey,
            securityToken: p.securityToken,
            projectId: p.projectId,
          },
          agentartsBase,
          source: 'refreshed',
          justRefreshed: true,
        };
      }
      return { error: `凭据已过期，续期失败：${r.error}` };
    }

    if (!base.expiresAt || base.expiresAt < Date.now()) {
      return { error: '凭据已过期，需要重新登录 OfficeAce' };
    }
    return { error: '这个号缺少可用的 security_token，需要重新登录 OfficeAce' };
  }

  /**
   * 手里一份可用的 refresh_token 都没有了吗？
   *
   * ⚠️ **只做诊断/展示用，不参与「该不该上膛」的决策。**
   * 判据是「档案里那份和轮换那份是不是都被拉黑了」，听起来对，实际会误判：
   * 续期成功之后档案被换成轮换那份，而轮换那份同时也在死名单上（它是被用掉的那份），
   * 于是这个方法会报「链子死了」—— 明明还能用。决策一律走 `_chainWouldPickNone()`
   * （问 pickToken 本人，跟 CredentialRefresher 内部是同一个问题）。
   */
  _tokenChainDead(accountId) {
    try {
      const rec = this.refreshState?.get?.(accountId);
      if (!rec) return false;
      const dead = new Set(rec.deadTokens || []);
      const disk = String(this.accounts.get(accountId)?.profile?.refreshToken || '');
      if (disk && !dead.has(disk)) return false;
      const rotated = String(rec.rotatedToken || '');
      if (rotated && !dead.has(rotated)) return false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 用「最近一次登录拿到的 refresh_token」把续期链救回来。
   *
   * 场景：用户重新走了一遍自助登录（面板「导入账号」），那份 refresh_token 是
   * 全新的、没被任何一方用过 —— 但账号档案（acc.profile）里的还是旧的那份，
   * 于是续期仍然撞 STS5.1806，用户会觉得「我都重登了怎么还是红的」。
   * 这里把新的那份捞出来重新上膛（只写我们自己的 data/refresh-state.json）。
   */
  _rearmFromLogin(accountId) {
    if (!this.accounts?.oauthRefreshToken) return { ok: false, error: '没有找到自助登录记录' };
    let rec = null;
    try {
      rec = this.accounts.oauthRefreshToken(accountId);
    } catch (err) {
      return { ok: false, error: `读取自助登录记录失败：${err.message}` };
    }
    if (!rec?.refreshToken) return { ok: false, error: '自助登录记录里没有 refresh_token' };
    // 锚点 = 档案里那份（已经被消费掉的）老 token，rearm 拿它来判断
    // 「磁盘这份是新的」，从而让 pickToken 走进 disk-renewed 分支。
    const previousDiskToken = String(this.accounts.get(accountId)?.profile?.refreshToken || '');
    const r = this.refreshState.rearm(accountId, rec.refreshToken, {
      reason: 'self-login',
      refreshExpiresAt: rec.refreshExpiresAt || 0,
      previousDiskToken,
    });
    if (r.ok) {
      // 只上膛不够：refresh() 是拿 profile.refreshToken 当锚点去挑 token 的，
      // 档案里那份还是旧的（已被拉黑）就会继续判 None。这里必须一起换掉。
      this.accounts.applyRearmedToken?.(accountId, rec.refreshToken, { refreshExpiresAt: rec.refreshExpiresAt || 0 });
      this.accounts.forgetBroken?.(accountId);
    }
    return r;
  }

  /**
   * 手头这份登录记录里的 token 值不值得拿来重新上膛？
   *
   * 判据（两条都要满足）：
   *   ① 它不在死名单里 —— 在名单里就说明我们已经拿它去撞过、被拒了
   *   ② 它跟当前锚点不一样 —— 一样的话它就是「磁盘上那份」，不是新的
   *
   * ⚠️ 曾经只看「跟锚点/轮换值都不一样」。但续期成功之后档案会被换成轮换那份，
   * 于是**同一份登录 token** 又满足了「跟锚点不一样」，下一轮就重复上膛一次；
   * 上膛会把锚点改成它自己，pickToken 于是判 None —— 一次成功之后原地断链。
   */
  _loginTokenIsNew(accountId, rec) {
    const token = String(rec?.refreshToken || '');
    if (!token) return false;
    const st = this.refreshState?.get?.(accountId);
    const anchor = String(st?.diskTokenUsed || '');
    const rotated = String(st?.rotatedToken || '');
    if ((st?.deadTokens || []).includes(token)) return false;
    return token !== anchor && token !== rotated;
  }

  /**
   * 现在这份档案，pickToken 会不会直接判 None？
   *
   * 这是「该不该上膛」的**权威判据** —— 它跟 CredentialRefresher 内部问的是
   * 同一个问题。只看 token 字面是否相等会误判：续期成功后档案换成轮换那份，
   * 明明还能用，却因为「跟锚点不一样」被当成新登录，白白上膛一次把链子弄断。
   */
  _chainWouldPickNone(accountId) {
    try {
      if (typeof this.refreshState?.pickToken !== 'function') return false;
      const acc = this.accounts.get(accountId);
      const pick = this.refreshState.pickToken(accountId, String(acc?.profile?.refreshToken || ''));
      return !pick.token;
    } catch {
      return false;
    }
  }

  /** 续期（带单飞，避免同一个号并发续期把 refresh_token 用掉两次） */
  async refreshCredential(accountId) {
    const id = String(accountId || '');
    if (this.refreshing.has(id)) return this.refreshing.get(id);
    const acc = this.accounts.get(id);
    if (!acc?.profile) return { ok: false, error: '账号不存在' };

    // 该不该重新上膛？
    //   ① 现在这份档案挑不出任何可发的 token（链子烧穿）
    //   ② 而且手头有一份**没用过**的新登录 token
    // 两条都成立才上膛。少任何一条都必须原样不动 —— 上膛会把锚点改写掉，
    // 在「本来还能用」的时候上膛，等于亲手把链子弄断。
    const login = this.accounts.oauthRefreshToken?.(id) || null;
    if (this._chainWouldPickNone(id) && this._loginTokenIsNew(id, login)) {
      const rearm = this._rearmFromLogin(id);
      if (rearm.ok) {
        log.info('已用最近一次登录的 token 重新上膛，续期链恢复', { id });
      } else {
        log.debug('没有可用的新登录记录', { id, error: rearm.error });
      }
    }
    // 诊断：上膛之后到底会挑哪一份（走 log，不额外写文件）
    if (process.env.OFFICEACE_DEBUG_PICK) {
      try {
        const st = this.refreshState.get(id);
        const pick = this.refreshState.pickToken(id, acc.profile?.refreshToken || '');
        log.warn('续期挑 token 诊断', {
          id,
          profileTail: String(acc.profile?.refreshToken || '').slice(-16),
          anchorTail: String(st?.diskTokenUsed || '').slice(-16),
          deadCount: (st?.deadTokens || []).length,
          broken: !!st?.broken,
          pick: pick.source,
        });
      } catch (err) {
        log.warn('诊断失败', { error: err.message });
      }
    }

    const task = this.refresher
      .refresh(acc.profile, { accountId: id })
      .then((r) => {
        // 续期成功 → 回填到账号档案（只改内存）。这样面板、统计、连接池
        // 立刻看到新凭据，不会再显示「已过期」。
        if (r?.ok && r.credential) {
          try {
            this.accounts.applyRefreshedCredential?.(id, r.credential);
          } catch (err) {
            log.warn('回填续期凭据失败', { id, error: err.message });
          }
        }
        // 轮换出来的 refresh_token 也要跟着换到档案上（仅内存）。
        //
        // 为什么必须换：我们这份档案是从只读的桌面端档案读出来的 T0，云端那边
        // 每续一次就作废上一份。下一轮再拿 T0 去问 pickToken，锚点也对得上 T0，
        // 于是判定「磁盘那份早用过」→ 判 None，链子就在**一次成功后**原地断掉。
        //
        // `markConsumed` 不要传：锚点的推进由 `RefreshState.record()` 自己决定
        // （它知道这次发的是不是档案那条线的那一份）。在这里推锚点会让锚点和
        // profile 指向同一份，下一轮 pickToken 就会放着新鲜 token 不用。
        if (r?.ok) {
          try {
            const st = this.refreshState.get(id);
            if (st?.rotatedToken && !(st.deadTokens || []).includes(st.rotatedToken)) {
              this.accounts.applyRearmedToken?.(id, st.rotatedToken, {
                refreshExpiresAt: st.refreshExpiresAt || 0,
              });
            }
          } catch (err) {
            log.warn('回填轮换 refresh_token 失败', { id, error: err.message });
          }
        }
        return r;
      })
      .catch((err) => ({ ok: false, error: err.message, errorCode: 'EXCEPTION' }))
      .finally(() => {
        this.refreshing.delete(id);
        // 凭据变了，缓存里的额度作废
        this.cache.delete(id);
      });
    this.refreshing.set(id, task);
    return task;
  }

  /** 兼容旧调用名 */
  credentialOf(accountId) {
    const acc = this.accounts.get(accountId);
    if (!acc) return { error: '账号不存在' };
    const p = acc.profile;
    if (!p?.accessKeyId || !p?.secretAccessKey) return { error: '这个号没有临时 AK/SK' };
    return {
      account: acc,
      credential: {
        accessKey: p.accessKeyId,
        secretKey: p.secretAccessKey,
        securityToken: p.securityToken,
        projectId: p.projectId,
      },
      agentartsBase: new URL(acc.credentials[0]?.baseUrl || DEFAULT_AGENTARTS_BASE).origin,
      source: 'disk',
    };
  }

  /** 该账号专属网关：先问 /v1/claw/client-permission-validate */
  async resolveGateway({ credential, agentartsBase }) {
    if (this.gatewayOverride) return this.gatewayOverride.replace(/\/+$/, '');
    const url = `${agentartsBase.replace(/\/+$/, '')}/v1/claw/client-permission-validate`;
    try {
      const headers = signV4({ method: 'GET', url, credential, contentType: 'application/json;charset=utf8' });
      const res = await this.fetchJson(url, { method: 'GET', headers });
      const base = res?.json?.subscription?.model_info?.model_api_url_base || res?.json?.model_info?.model_api_url_base;
      if (base && typeof base === 'string') return `https://${base.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
    } catch (err) {
      log.debug('取专属网关失败，用默认', { error: err.message });
    }
    return DEFAULT_GATEWAY;
  }

  /* ---- 四个接口 ---- */

  async fetchJson(url, options) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* 非 JSON */
      }
      return { status: res.status, ok: res.ok, text, json };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 拉某个账号的完整额度快照 */
  async fetchOne(accountId) {
    const got = await this.resolveCredential(accountId);
    if (got.error) return { ok: false, fetchedAt: Date.now(), error: got.error, accountId };

    const { credential } = got;
    const gateway = await this.resolveGateway(got);
    const base = gateway;
    const v11 = (method, pathWithQuery, extraHeaders = {}, body = '') => {
      const url = base + pathWithQuery;
      const headers = signV11({
        method,
        url,
        credential,
        region: this.region,
        bodyText: body,
        headers: extraHeaders,
        contentType: method === 'GET' ? undefined : 'application/json;charset=utf8',
      });
      return this.fetchJson(url, { method, headers, body: method === 'GET' ? undefined : body });
    };

    const now = new Date();
    const start = new Date(now.getTime() - 30 * 86400e3).toISOString();
    const end = now.toISOString();

    let sub;
    try {
      sub = await v11('GET', '/v1/subscription', { 'x-subscription-type': 'v2' });
    } catch (err) {
      return { ok: false, fetchedAt: Date.now(), error: `订阅接口请求失败：${err.message}`, accountId, gateway };
    }
    if (!sub.ok) {
      return {
        ok: false,
        fetchedAt: Date.now(),
        accountId,
        gateway,
        error: `订阅接口返回 HTTP ${sub.status}${sub.json?.error_msg ? ` · ${sub.json.error_msg}` : ''}`,
      };
    }

    const summary = summarizeSubscription(sub.json);
    summary.accountId = accountId;
    summary.userName = got.account.profile?.userName || '';
    summary.label = got.account.label || '';
    summary.gateway = gateway;
    summary.region = this.region;
    summary.credentialSource = got.source;
    summary.justRefreshed = !!got.justRefreshed;

    // 用量 + 费率：拿不到不算失败
    summary.usage = { items: [], days: 0, last30: 0, today: 0, todayTokens: 0 };
    try {
      const u = await v11(
        'GET',
        `/v1/subscription/usage?sku_attr_code=officeace_points&aggregation=day&start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}&limit=100`,
      );
      if (u.ok && Array.isArray(u.json?.items)) {
        const items = u.json.items
          .map((it) => ({
            day: bjDay(it.created_at),
            consumed: round2(num(it.consumed_amount)),
            tokens: num(it.total_token),
            createdAt: ms(it.created_at),
          }))
          .filter((it) => it.day)
          .sort((a, b) => a.createdAt - b.createdAt);
        const today = bjDay(Date.now());
        const todayItem = items.find((it) => it.day === today);
        summary.usage = {
          items,
          days: items.length,
          last30: round2(sum(items.map((it) => it.consumed))),
          today: todayItem ? todayItem.consumed : 0,
          todayTokens: todayItem ? todayItem.tokens : 0,
          avgPerDay: items.length ? round2(sum(items.map((it) => it.consumed)) / items.length) : 0,
        };
      }
    } catch (err) {
      summary.usage.error = err.message;
    }

    try {
      const r = await v11('GET', '/v1/model-token-rates');
      if (r.ok && Array.isArray(r.json?.models)) {
        summary.rates = r.json.models.map((m) => ({
          model: String(m.model_name || ''),
          promptPerPoint: num(m.prompt_tokens_per_point),
          completionPerPoint: num(m.completion_tokens_per_point),
          cachedPerPoint: num(m.cached_tokens_per_point),
          coefficient: num(m.cost_coefficient),
        }));
      }
    } catch (err) {
      summary.ratesError = err.message;
    }

    summary.text = renderText(summary);
    summary.runsOutText = estimateRunout(summary);
    return summary;
  }

  /* ---- 签到领积分 ---- */

  /**
   * 领奖励积分。
   *
   * 接口是 `POST {网关}/v1/subscription/bonus/claim`（官方就是无 body 调的），
   * 但实测裸 POST 会被服务端判 500 `OfficeAce.11020001`——
   * **必须带 `Content-Type: application/json` 且 body 给一个 `{}`** 才返回 200。
   * 响应里的 `bonus_skus` 就是当前所有奖励活动（含刚领到的）。
   *
   * 一天一个活动只能领一次，重复领不会报错（返回同样的列表，`current_value` 不变），
   * 所以本方法自己记 `bonus-claims.json`，同一天不重复打。
   */
  async claimBonus(accountId, { force = false } = {}) {
    const id = String(accountId || '');

    // 同一天不重复打接口。
    //
    // 上面注释里承诺了这件事，但实现只在 claimAll 里有这个判断，
    // 而面板上单号点「签到」走的正是这个方法 —— 于是同一账号反复点
    // 就会真的反复打接口（force 声明了却从来没被用过）。
    if (!force && this.claimedToday(id)) {
      const hit = this.peek(id);
      return {
        ok: true,
        accountId: id,
        day: bjDay(Date.now()),
        claimed: [],
        gained: 0,
        bonuses: (hit?.bonuses || []).map(({ raw, ...rest }) => rest),
        alreadyClaimed: true,
        firstTimeToday: false,
        note: '今天已经签过了',
      };
    }

    const got = await this.resolveCredential(id);
    if (got.error) return { ok: false, accountId: id, error: got.error, claimed: [] };

    const gateway = await this.resolveGateway(got);
    const url = `${gateway}/v1/subscription/bonus/claim`;

    // 领之前先记下现状，领完好算「多了多少」
    const before = this.peek(id);
    const beforeMap = new Map((before?.bonuses || []).map((b) => [b.activityId, b.remaining]));

    const bodyText = '{}';
    let res;
    let text;
    try {
      const headers = signV11({
        method: 'POST',
        url,
        credential: got.credential,
        region: this.region,
        bodyText,
        contentType: 'application/json;charset=utf8',
        headers: { 'x-subscription-type': 'v2' },
      });
      res = await this.fetchJson(url, { method: 'POST', headers, body: bodyText });
      text = res.text;
    } catch (err) {
      return { ok: false, accountId: id, error: `签到请求失败：${err.message}`, claimed: [] };
    }

    if (!res.ok) {
      const code = res.json?.error_code || `HTTP ${res.status}`;
      const msg = res.json?.error_msg || (text || '').slice(0, 200);
      return { ok: false, accountId: id, error: `签到被拒：${code}${msg ? ' · ' + msg : ''}`, errorCode: code, claimed: [] };
    }

    const skus = Array.isArray(res.json?.bonus_skus) ? res.json.bonus_skus : [];
    const after = skus.map((b) => {
      const total = num(b.points);
      const used = num(b.current_value);
      return {
        activityId: String(b.activity_id || ''),
        name: String(b.activity_name || b.activity_id || '奖励'),
        total: round2(total),
        used: round2(used),
        remaining: round2(Math.max(0, total - used)),
        expiresAt: ms(b.expired_time),
        raw: b,
      };
    });

    // 「领到了」的判定：这个活动之前不在，或者剩余变多了
    //
    // ⚠️ 两个数不能混：
    //   - `total`（活动总量）是**累计发放**，一个活动可能同时由多个渠道
    //     （别人代签、OfficeAce 桌面端签到、活动页手动领）在发。
    //   - `gained`（这次签到**新增**多少）只能按**剩余量的增量**算。
    // 以前首次见到的活动直接拿 `total` 当 gained —— 签到页上明明只多出
    // 一点，却显示「领到 100」，`total` 还被累加进 rec.total 永久虚高。
    // 首次见到时没有 before 快照，退一步用 `remaining`（余额增量），
    // 它至少不会把「早就发过、只是我们没记录」的部分算成这次的收获。
    const prevSnapshots = [
      ...(Array.isArray(before?.bonuses) ? before.bonuses : []),
      ...(Array.isArray(before?.raw?.bonus_skus) ? before.raw.bonus_skus : []),
    ];
    const baselineMap = new Map();
    for (const b of prevSnapshots) {
      const key = String(b.activityId || b.activity_id || '');
      if (!key) continue;
      const remaining = num(b.remaining ?? num(b.points) - num(b.current_value));
      // 同一活动以 bonuses 里的口径为准（它已经 round2 过）
      if (!baselineMap.has(key) || b.activityId) {
        baselineMap.set(key, remaining);
      }
    }
    for (const [k, v] of beforeMap) if (!baselineMap.has(k)) baselineMap.set(k, v);

    const claimed = [];
    for (const b of after) {
      const prev = baselineMap.get(b.activityId);
      if (prev === undefined) {
        // 首次见到这个活动：只能按当前余额算，绝不按 total
        if (b.remaining > 0.001) {
          claimed.push({
            activityId: b.activityId,
            name: b.name,
            gained: round2(b.remaining),
            remaining: b.remaining,
            total: b.total,
            expiresAt: b.expiresAt,
            firstSeen: true,
          });
        }
        continue;
      }
      if (b.remaining > prev + 0.001) {
        claimed.push({
          activityId: b.activityId,
          name: b.name,
          gained: round2(b.remaining - prev),
          remaining: b.remaining,
          total: b.total,
          expiresAt: b.expiresAt,
        });
      }
    }

    // 记一笔，同一天不重复打
    const day = bjDay(Date.now());
    // ⚠️ 这个判断必须在写 rec.days[day] **之前** 做。
    // 以前是先写再读（而且 beforeRec 和 rec 是同一个对象），
    // 读到的永远是自己刚写进去的值，于是 firstTimeToday 恒为 false。
    const firstTimeToday = !this.claims[id]?.days?.[day]?.at;
    const rec = this.claims[id] || (this.claims[id] = { days: {}, total: 0 });
    rec.days[day] = { at: Date.now(), claimed: claimed.map((c) => ({ name: c.name, gained: c.gained })) };
    rec.total = round2((rec.total || 0) + claimed.reduce((n, c) => n + c.gained, 0));
    const days = Object.keys(rec.days).sort();
    while (days.length > 60) delete rec.days[days.shift()];
    this.saveClaims();

    // 额度变了，缓存作废，下次读就是最新的
    this.cache.delete(id);

    log.info('签到完成', { accountId: id, claimed: claimed.length, gained: claimed.reduce((n, c) => n + c.gained, 0) });

    return {
      ok: true,
      accountId: id,
      day,
      claimed,
      gained: round2(claimed.reduce((n, c) => n + c.gained, 0)),
      bonuses: after.map(({ raw, ...rest }) => rest),
      // 今天调过接口且成功了，但这次没新增 —— 多半是别处已经领过了
      alreadyClaimed: !claimed.length,
      firstTimeToday,
    };
  }

  /** 今天签过了没 */
  claimedToday(accountId) {
    const rec = this.claims[String(accountId || '')];
    return !!rec?.days?.[bjDay(Date.now())]?.at;
  }

  /** 签到历史（最近的） */
  claimHistory(accountId) {
    const rec = this.claims[String(accountId || '')];
    if (!rec?.days) return { total: 0, today: '', days: [] };
    return {
      total: rec.total || 0,
      today: this.claimedToday(accountId) ? bjDay(Date.now()) : '',
      days: Object.entries(rec.days)
        .map(([day, v]) => ({ day, at: v.at, gained: round2(v.claimed.reduce((n, c) => n + c.gained, 0)), items: v.claimed }))
        .sort((a, b) => b.day.localeCompare(a.day))
        .slice(0, 30),
    };
  }

  saveClaims() {
    if (!this.claimFile) return;
    try {
      fs.mkdirSync(path.dirname(this.claimFile), { recursive: true });
      // 原子写：这份记录决定「今天到底签没签过」，写坏一次就会重复打接口
      // （上游虽不报错，但会白等一次，而且我们自己的统计会乱）。
      writeFileAtomic(this.claimFile, JSON.stringify(this.claims, null, 2), { mode: 0o600 });
    } catch (err) {
      log.debug('保存签到记录失败', { error: err.message });
    }
  }

  /** 批量签到：号池里所有启用且凭据可用的号 */
  async claimAll({ force = false } = {}) {
    const out = [];
    let gained = 0;
    for (const id of this.accounts.ids()) {
      const acc = this.accounts.get(id);
      if (!acc?.enabled) {
        out.push({ id, label: acc?.label || '', ok: false, skipped: true, error: '账号已停用' });
        continue;
      }
      if (!force && this.claimedToday(id)) {
        out.push({ id, label: acc.label || '', ok: true, skipped: true, error: '', gained: 0, note: '今天已经签过了' });
        continue;
      }
      const r = await this.claimBonus(id, { force });
      gained += r.gained || 0;
      out.push({ id, label: acc.label || '', ...r });
    }
    return { ok: out.every((r) => r.ok || r.skipped), results: out, gained: round2(gained) };
  }

  /* ---- 带缓存与并发合并的单账号查询 ---- */
  async get(accountId, { force = false } = {}) {
    const id = String(accountId || '');
    const hit = this.cache.get(id);
    if (!force && hit && Date.now() - hit.at < this.ttlMs) return hit.data;
    if (this.inflight.has(id)) return this.inflight.get(id);
    const task = this.fetchOne(id)
      .catch((err) => ({ ok: false, fetchedAt: Date.now(), accountId: id, error: err.message }))
      .then((data) => {
        this.cache.set(id, { at: Date.now(), data });
        this.recordHistory(id, data);
        this.inflight.delete(id);
        /**
         * 错误按账号分开记，同时保留一个全局的「最近一次失败」。
         *
         * ⚠️ 以前只有一个全局 `lastError`，而且是**只写不清**：A 号失败过一次留下的
         * 文案会一直被 B 号看见，B 号成功了也不会擦掉。多账号下就更乱 ——
         * `/admin/api/credits` 的 `summary.lastError` 永远是"最后一个出错账号"的，
         * 面板上于是出现「两个号都 ok、error 为空，但汇总里却挂着一条旧错误」。
         */
        if (data.ok) {
          delete this.lastErrorByAccount[String(id)];
          // 全局那条：如果它就是本账号留下的，成功了就该擦掉
          if (this.lastErrorAccount === String(id)) {
            this.lastError = '';
            this.lastErrorAccount = '';
          }
        } else {
          const msg = data.error || '未知错误';
          this.lastErrorByAccount[String(id)] = msg;
          this.lastError = msg;
          this.lastErrorAccount = String(id);
        }
        this.notify();
        return data;
      });
    this.inflight.set(id, task);
    return task;
  }

  /** 刷新全部（或指定的几个）账号 */
  async refresh(ids = null, { force = true } = {}) {
    const list = ids && ids.length ? ids.map(String) : this.accounts.ids();
    const out = {};
    for (const id of list) {
      out[id] = await this.get(id, { force });
    }
    this.notify();
    return out;
  }

  /** 缓存里的（不触发请求） */
  peek(accountId) {
    const hit = this.cache.get(String(accountId || ''));
    return hit ? hit.data : null;
  }

  /** 面板要的：每个账号一条 + 汇总 */
  view() {
    const items = this.accounts.ids().map((id) => {
      const acc = this.accounts.get(id);
      const q = this.peek(id);
      const rs = this.refreshState.get(id);
      const live = this.refreshState.usableCredential(id);
      const claim = this.claimHistory(id);
      return {
        id,
        label: acc?.label || '',
        userName: acc?.userName || '',
        enabled: !!acc?.enabled,
        loaded: !!q,
        ok: !!q?.ok,
        error: q && !q.ok ? q.error : '',
        fetchedAt: q?.fetchedAt || 0,
        staleMs: q ? Date.now() - q.fetchedAt : 0,
        headline: q?.ok ? q.headline : '',
        subline: q?.ok ? q.subline : '',
        plan: q?.ok ? q.plan : null,
        points: q?.ok ? q.points : null,
        bonuses: q?.ok ? q.bonuses : [],
        searches: q?.ok ? q.searches : null,
        usage: q?.ok ? q.usage : null,
        rates: q?.ok ? q.rates || [] : [],
        runsOutText: q?.ok ? q.runsOutText : '',
        text: q?.ok ? q.text : q ? `拿不到积分额度：${q.error}` : '',
        // 凭据续期
        refreshable: !!acc?.profile?.refreshToken,
        refreshPending: this.refreshing.has(id),
        credentialSource: q?.credentialSource || (live ? 'refreshed' : 'disk'),
        refreshedAt: rs?.refreshedAt || 0,
        refreshCount: rs?.count || 0,
        refreshExpiresAt: acc?.profile?.refreshExpiresAt || 0,
        liveCredentialExpiresAt: live ? Date.parse(live.expiresAt) || 0 : 0,
        // 签到
        claimedToday: !!claim.today,
        claimTotal: claim.total,
        claimDays: claim.days,
        canClaim: !!acc?.enabled,
      };
    });

    const okOnes = items.filter((i) => i.ok && i.points);
    const enabledOnes = items.filter((i) => i.enabled && i.ok && i.points);
    return {
      items,
      summary: {
        accounts: items.length,
        loaded: items.filter((i) => i.loaded).length,
        ok: okOnes.length,
        failed: items.filter((i) => i.loaded && !i.ok).length,
        remaining: round2(sum(okOnes.map((i) => i.points.remaining))),
        remainingEnabled: round2(sum(enabledOnes.map((i) => i.points.remaining))),
        used: round2(sum(okOnes.map((i) => i.points.used))),
        total: round2(sum(okOnes.map((i) => i.points.total))),
        searchesRemaining: sum(okOnes.map((i) => (i.searches ? i.searches.remaining : 0))),
        // Math.min() 收到空数组会返回 Infinity，JSON 序列化后变成 null，
      // 面板上「下次到期」就会显示成 1970 / Invalid Date。
      // 有账号但都没给出过期时间（订阅响应缺 expired_time，试用号常见）时按 0 处理。
      nextExpiryAt: (() => {
        const exps = okOnes.map((i) => i.plan?.expiresAt).filter((t) => Number.isFinite(t) && t > 0);
        return exps.length ? Math.min(...exps) : 0;
      })(),
        ttlSeconds: Math.round(this.ttlMs / 1000),
        lastRefreshAt: Math.max(0, ...items.map((i) => i.fetchedAt)),
        lastError: this.lastError,
        /** 哪个账号留下了上面那条错误（空 = 没有未清除的错误） */
        lastErrorAccount: this.lastErrorAccount,
        /** 每个还没恢复正常的账号各自的失败原因 */
        lastErrorByAccount: { ...this.lastErrorByAccount },
        // 续期 & 签到
        refreshedAccounts: items.filter((i) => i.credentialSource === 'refreshed').length,
        refreshableAccounts: items.filter((i) => i.refreshable).length,
        /**
         * ⚠️ `claimedToday` 只说明「今天成功打过一次签到接口」，**不说明领到分**。
         *
         * 上游对已领过的号会回 200 + 空奖励（`alreadyClaimed`），代码照样把它记成
         * 「今天签过了」。于是面板显示「今日签到 2/2」，而 `claimTotal` 是 0 ——
         * 两个数字摆在一起自相矛盾，用户会以为积分丢了。
         * 所以另外分开数：真拿到分的、和只是接口调通的。
         */
        claimedToday: items.filter((i) => i.claimedToday).length,
        claimedWithGain: items.filter((i) => i.claimedToday && i.claimTotal > 0).length,
        claimTotal: round2(sum(items.map((i) => i.claimTotal))),
        autoRefreshCredentials: !!this.refreshEnabled,
      },
    };
  }

  /* ---- 历史快照，用来看「掉得多快」 ---- */

  recordHistory(id, data) {
    if (!data?.ok || !this.historyFile) return;
    const list = this.history[id] || (this.history[id] = []);
    const last = list[list.length - 1];
    // 同一分钟内不重复记
    if (last && data.fetchedAt - last.at < 60000) {
      list[list.length - 1] = { at: data.fetchedAt, remaining: data.points.remaining, used: data.points.used };
    } else {
      list.push({ at: data.fetchedAt, remaining: data.points.remaining, used: data.points.used });
    }
    while (list.length > 300) list.shift();
    this.saveHistory();
  }

  historyOf(id) {
    return this.history[String(id || '')] || [];
  }

  saveHistory() {
    try {
      fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
      // 原子写：这份是「近 30 天消耗」画图的底稿，半截 JSON 会让曲线整段消失
      writeFileAtomic(this.historyFile, JSON.stringify(this.history), { mode: 0o600 });
    } catch (err) {
      log.debug('保存积分历史失败', { error: err.message });
    }
  }
}

function estimateRunout(summary) {
  const u = summary?.usage;
  if (!u || !u.items?.length) return '';
  const recent = u.items.slice(-7);
  const avg = sum(recent.map((i) => i.consumed)) / recent.length;
  if (!(avg > 0)) return '近 7 天没消耗';
  const days = summary.points.remaining / avg;
  if (!Number.isFinite(days)) return '';
  if (days >= 3650) return '按近 7 天速度，几年都用不完';
  return `按近 7 天平均（${fmtPoints(avg)} 积分/天），还能用约 ${Math.floor(days)} 天`;
}

function loadHistory(file) {
  if (!file) return {};
  try {
    if (!fs.existsSync(file)) return {};
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return doc && typeof doc === 'object' ? doc : {};
  } catch {
    return {};
  }
}
