/**
 * 补网关凭据：把「有临时 AK/SK、但没有 MaaS 网关 Basic key」的号修好。
 *
 * 背景（这是多账号下最容易踩的一个坑）：
 *   一号登录进号池有两条路 ——
 *     A. **自助登录**（项目自己跑 OAuth）：一路走到 `client-permission-validate`，
 *        顺手就把 `model_auth_info` 里的 app_key/app_secret 拿回来写了档案。
 *     B. **一键授权**（借本机 OfficeAce 桌面端的会话）：只让桌面端写一份档案和
 *        用户目录，**不产生 routing_state/users/<id>/models.json** ——
 *        而网关 Basic key 一直是从那个文件里读的。桌面端之所以有，是因为它自己
 *        请求过模型；没请求过就没有。
 *
 * 走 B 进来的号于是变成"看得见、用不了"：在号池里、健康度写着"无凭据"、
 * 积分也读得到（额度查询只要 AK/SK），但一条凭据都没有，转发永远不会选它。
 * 更糟的是汇总数字会跟着骗人：「今日签到 2/2」「剩余积分 13000」看着像两个号都能用。
 *
 * 好消息是它**补得回来**：控制面 `client-permission-validate` 现在就能把那对 key
 * 换出来，而临时 AK/SK 项目本来就会自己续期。所以不需要用户重新登录一次。
 *
 * 这个模块被两处调用：
 *   ① 一键授权绑定成功那一刻（`authflow.mjs`）；
 *   ② 启动时 / 每次发现之后扫一遍（`index.mjs`），把历史上攒下的这种号一起修掉。
 */

import { createLogger } from './logger.mjs';
import { signV4 } from './quota.mjs';

const log = createLogger('gateway-key');

/** 控制面（不是模型网关）—— `client-permission-validate` 在这边 */
export const CONTROL_PLANE_BASE = 'https://agentarts.cn-southwest-2.myhuaweicloud.com';

/**
 * 这个账号缺不缺网关凭据？
 * @returns {boolean}
 */
export function needsGatewayCredential(acc) {
  return !!acc && (acc.credentials?.length || 0) === 0;
}

/**
 * 取一对网关 Basic key。**纯读取，不落盘** —— 写盘由调用方决定，
 * 免得探测性质的调用把档案改了。
 *
 * @param {string} accountId
 * @param {{ accounts: import('./accounts.mjs').AccountStore, credits: any, controlPlaneBase?: string }} deps
 * @returns {Promise<{ok:true, appKey:string, appSecret:string, baseUrl:string, accountId:string, principalId:string, credentialSource:string} | {ok:false, error:string, stage:string}>}
 */
export async function fetchGatewayKey(accountId, { accounts, credits, controlPlaneBase = CONTROL_PLANE_BASE } = {}) {
  const id = String(accountId || '');
  if (!accounts || !credits) return { ok: false, error: '缺少依赖（accounts / credits）', stage: 'setup' };
  const acc = accounts.get(id);
  if (!acc) return { ok: false, error: '账号不存在', stage: 'lookup' };

  // 临时 AK/SK：优先续期换回来的那份，其次磁盘档案里的
  let got = null;
  try {
    got = await credits.resolveCredential(id);
  } catch (err) {
    return { ok: false, error: `凭据解析异常：${err.message}`, stage: 'credential' };
  }
  if (!got || got.error) {
    return {
      ok: false,
      // 这句原样透出去，用户看日志就知道该去重新登录
      error: `拿不到临时 AK/SK：${got?.error || '未知原因'}`,
      stage: 'credential',
    };
  }

  const url = `${String(controlPlaneBase).replace(/\/+$/, '')}/v1/claw/client-permission-validate`;
  let res = null;
  try {
    const headers = signV4({
      method: 'GET',
      url,
      credential: got.credential,
      contentType: 'application/json;charset=utf8',
    });
    res = await credits.fetchJson(url, { method: 'GET', headers });
  } catch (err) {
    return { ok: false, error: `控制面请求失败：${err.message}`, stage: 'validate' };
  }
  if (!res?.ok || !res.json) {
    return {
      ok: false,
      error: `控制面 HTTP ${res?.status ?? '?'}：${res?.json?.error_msg || String(res?.text || '').slice(0, 140) || '空响应'}`,
      stage: 'validate',
    };
  }

  // ⚠️ `model_info` 在 **subscription 里面**，不在顶层。
  //    只看顶层会误判成"这个号没开通服务"，然后把一个完全正常的号报成坏的。
  const mi = res.json.model_info || res.json.subscription?.model_info || res.json.modelInfo || null;
  const ai = mi?.model_auth_info || null;
  if (!ai?.model_app_key || !ai?.model_app_secret) {
    return {
      ok: false,
      error: '控制面响应里没有 model_auth_info（这个号可能还没开通服务，先去客户端兑换邀请码）',
      stage: 'provision',
      topKeys: Object.keys(res.json).join(','),
    };
  }

  const host = String(mi.model_api_url_base || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!host) return { ok: false, error: '云端没给 model_api_url_base（网关地址）', stage: 'provision' };

  return {
    ok: true,
    appKey: String(ai.model_app_key),
    appSecret: String(ai.model_app_secret),
    baseUrl: `https://${host}/v2`,
    accountId: String(res.json.account_id || ''),
    principalId: String(res.json.principal_id || ''),
    credentialSource: got.source || '',
  };
}

/**
 * 扫一遍号池，把所有缺网关凭据的号补上。
 *
 * 逐号 try/catch：一个号补不上（比如没开通服务）不能害得后面的号也不补。
 *
 * @param {{ accounts: any, credits: any, enabledOnly?: boolean, ids?: string[] | null }} opts
 * @returns {Promise<{ checked:number, filled:number, failed:number, skipped:number, results:Array }>}
 */
export async function backfillGatewayCredentials({ accounts, credits, enabledOnly = true, ids = null } = {}) {
  const out = { checked: 0, filled: 0, failed: 0, skipped: 0, results: [] };
  if (!accounts || !credits) return out;

  const list = Array.isArray(ids) && ids.length ? ids.map(String) : accounts.ids();
  for (const id of list) {
    const acc = accounts.get(id);
    if (!acc) continue;
    if (enabledOnly && !acc.enabled) {
      out.skipped += 1;
      continue;
    }
    if (!needsGatewayCredential(acc)) {
      out.skipped += 1;
      continue;
    }
    out.checked += 1;
    let r = null;
    try {
      r = await fetchGatewayKey(id, { accounts, credits });
    } catch (err) {
      r = { ok: false, error: err.message, stage: 'unexpected' };
    }
    if (!r.ok) {
      out.failed += 1;
      out.results.push({ id, ok: false, error: r.error, stage: r.stage });
      log.warn('补网关凭据失败', { id, stage: r.stage, error: r.error });
      continue;
    }
    const wrote = accounts.backfillGatewayCredential(id, r);
    if (wrote) {
      out.filled += 1;
      out.results.push({ id, ok: true, baseUrl: r.baseUrl });
      log.info('已为该账号补上网关凭据', { id, baseUrl: r.baseUrl, from: r.credentialSource });
    } else {
      out.failed += 1;
      out.results.push({ id, ok: false, error: '取到了 key 但没写进档案（可能账号 ID 对不上）', stage: 'persist' });
    }
  }
  return out;
}
