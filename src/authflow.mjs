/**
 * 一键授权
 *
 * OfficeAce 的登录链路（从 green-package/api/dist/auth/huawei-oauth.js 和
 * 本机 API 实测确认）：
 *
 *   1. POST  <本机API>/api/login/authorize
 *        → { authorizeUrl, state }
 *        authorizeUrl 是华为云统一登录页，内嵌一层 OAuth2 授权：
 *          https://auth.huaweicloud.com/authui/login.html?service=<URL编码的
 *            https://auth.huaweicloud.com/authui/v1/oauth2/authorize
 *              ?client_id=pdp5_for_agentarts
 *              &code_challenge=<PKCE S256>
 *              &state=<32位hex>
 *              &scope=openid
 *              &redirect_uri=https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/auth/callback
 *              &response_type=code>
 *
 *   2. 用户在浏览器（或手机）用华为账号登录并授权 → 云端回调把 code 按 state 存起来
 *
 *   3. GET   <本机API>/api/login/oauth/poll?state=<state>
 *        → 本机服务转发到 云端 /v1/claw/auth/code?state=...
 *        → 应用拿 code 换 token，再换 IAM 临时 AK/SK，写进账号档案
 *
 *   4. GET   <本机API>/api/islogin  → { islogin, userId }
 *        → 账号目录出现新 ID，即授权完成，自动并入号池
 *
 * 所以「一键授权」= 调 1 拿链接 → 打开 → 轮询 3/4 → 自动入库。
 * 不依赖任何猜测的接口，全部是应用自己在跑的流程。
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { createLogger } from './logger.mjs';
import { request, looksLikeOfficeAceApi } from './http.mjs';

const log = createLogger('authflow');

const DEFAULT_APP_CANDIDATES = [
  'https://127.0.0.1:3004',
  'https://localhost:3004',
  'http://127.0.0.1:3004',
  'http://localhost:3004',
];

const CLOUD_BASE = 'https://agentarts.cn-southwest-2.myhuaweicloud.com';
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * 这个 userId 看着像**真实**的华为云账号吗？
 *
 * 真实的是 32 位小写 hex（例：`09f8e7d6c5b4a39281706f5e4d3c2b1a`）。
 * 桌面端在授权过程中会上报 `pending-<64位hex>` 这种临时值 ——
 * 拿它当账号 ID 只会造出一个永远对不上号的幽灵键。
 * 宁可判"还没好、下一轮再看"，也不要写进盘里。
 */
export function isRealUserId(userId) {
  return /^[0-9a-f]{32}$/.test(String(userId || '').trim());
}

export class AuthFlow {
  /**
   * @param {{accounts: import('./accounts.mjs').AccountStore,
   *          appApis?: string[], onBound?: (task:object)=>void}} opts
   */
  constructor({ accounts, appApis, onBound } = {}) {
    this.accounts = accounts;
    this.appApis = (appApis && appApis.length ? appApis : DEFAULT_APP_CANDIDATES).slice();
    this.onBound = onBound || (() => {});
    this.tasks = new Map();
    this.seq = 0;
    this.app = null; // 本机 API 探测结果
    this.appCheckedAt = 0;
  }

  /* ------------------------------------------------ 本机 OfficeAce API 探测 */

  async detectApp({ force = false } = {}) {
    if (!force && this.app && Date.now() - this.appCheckedAt < 15000) return this.app;
    for (const base of this.appApis) {
      const info = await looksLikeOfficeAceApi(base);
      if (info) {
        this.app = info;
        this.appCheckedAt = Date.now();
        if (this.app.baseUrl !== this._lastLoggedApp) {
          this._lastLoggedApp = this.app.baseUrl;
          log.info('发现本机 OfficeAce API', {
            baseUrl: info.baseUrl,
            islogin: info.islogin,
            provider: info.provider,
          });
        }
        return this.app;
      }
    }
    this.app = null;
    this.appCheckedAt = Date.now();
    return null;
  }

  appStatus() {
    return {
      found: !!this.app,
      ...(this.app || { baseUrl: '', islogin: false, userId: null, provider: '', providerName: '' }),
      candidates: this.appApis,
      checkedAt: this.appCheckedAt,
    };
  }

  /* ------------------------------------------------------------ 发起授权 */

  async start({ label = '' } = {}) {
    const app = await this.detectApp({ force: true });
    if (!app) {
      const err = new Error(
        '没找到本机 OfficeAce 服务（默认 https://127.0.0.1:3004）。请先启动 OfficeAce 桌面端再试。',
      );
      err.code = 'APP_NOT_FOUND';
      throw err;
    }

    const res = await request(`${app.baseUrl}/api/login/authorize`, {
      method: 'POST',
      body: {},
      headers: { Accept: 'application/json' },
      timeoutMs: 20000,
      insecure: true,
    });
    if (!res.ok || !res.json?.authorizeUrl) {
      const msg = res.json?.message || res.json?.error || `HTTP ${res.status}`;
      throw new Error(`本机服务没给出授权链接：${msg}`);
    }

    const before = new Set(this.accounts ? this.accounts.ids() : []);
    const id = `auth-${++this.seq}-${Date.now().toString(36)}`;
    const task = {
      id,
      mode: 'app',
      label: String(label || '').trim(),
      state: res.json.state || extractState(res.json.authorizeUrl),
      authorizeUrl: res.json.authorizeUrl,
      appBaseUrl: app.baseUrl,
      status: 'pending',
      startedAt: Date.now(),
      expiresAt: Date.now() + STATE_TTL_MS,
      beforeUserIds: [...before],
      newUserId: '',
      newAccountId: '',
      polls: 0,
      lastPoll: null,
      error: '',
      events: [],
    };
    this.tasks.set(id, task);
    this._event(task, `已向本机 OfficeAce 申请授权链接，state=${task.state}`);
    log.info('一键授权已发起', { state: task.state, app: app.baseUrl });
    return this.publicView(task);
  }

  /* ---------------------------------------------------------------- 轮询 */

  async check(id) {
    const task = this.tasks.get(String(id || ''));
    if (!task) throw new Error('授权任务不存在或已清理');
    if (task.status === 'bound' || task.status === 'failed') return this.publicView(task);

    if (Date.now() > task.expiresAt) {
      task.status = 'expired';
      task.error = '授权链接超过 10 分钟未完成，请重新发起';
      this._event(task, task.error);
      return this.publicView(task);
    }

    task.polls += 1;

    // 1) 直连云端：这个 state 有没有被回调过
    let cloud = null;
    try {
      const r = await request(`${CLOUD_BASE}/v1/claw/auth/code?state=${encodeURIComponent(task.state)}`, {
        headers: { Accept: 'application/json' },
        timeoutMs: 12000,
        // 公网端点。写死 false 是故意的：就算 http.mjs 的默认值哪天又变回
        // insecure，这条也不能裸奔 —— 它的返回值直接决定拿不拿授权码。
        insecure: false,
      });
      cloud = { status: r.status, json: r.json, text: r.text.slice(0, 400) };
      task.lastPoll = { at: Date.now(), cloudStatus: r.status, errorCode: r.json?.error_code || '' };
      if (r.status === 404 && r.json?.error_code === 'AgentArts.11000009') {
        // 正常：用户还没完成
      } else if (r.status === 200) {
        this._event(task, '云端已收到授权回调');
      } else if (r.json?.error_code && r.json.error_code !== 'AgentArts.11000009') {
        this._event(task, `云端返回 ${r.json.error_code}: ${r.json.error_msg || ''}`);
      }
    } catch (err) {
      task.lastPoll = { at: Date.now(), error: err.message };
    }

    // 2) 让本机应用去兑换（应用自己会拿 code 换 token 并落盘）
    try {
      await request(
        `${task.appBaseUrl}/api/login/oauth/poll?state=${encodeURIComponent(task.state)}`,
        { headers: { Accept: 'application/json' }, timeoutMs: 15000, insecure: true },
      );
    } catch (err) {
      log.debug('poll 代理失败', { error: err.message });
    }

    // 3) 看应用是否已登录
    const info = await looksLikeOfficeAceApi(task.appBaseUrl);
    if (info) {
      this.app = info;
      this.appCheckedAt = Date.now();
      // ⚠️ 这里以前不校验 userId 的格式，只要 `islogin` 为真就当成"新账号"。
      //    于是桌面端在中途上报一个**临时 userId**（形如 `pending-<64位hex>`）时，
      //    它会被当成真实账号：写进 accounts.json 的 labels，还会让判定
      //    `task.newUserId || task.newAccountId` 成立、把状态标成"授权完成"。
      //    那种键永远对应不上任何真实账号，只会以"幽灵别名"的形式长期留在盘上。
      //    真实的华为云账号 ID 是 32 位 hex，这里按前缀挡掉。
      if (info.islogin && info.userId && !task.beforeUserIds.includes(info.userId) && isRealUserId(info.userId)) {
        task.newUserId = info.userId;
        this._event(task, `本机应用已登录：${info.userId}`);
      } else if (info.islogin && info.userId && !isRealUserId(info.userId)) {
        this._event(task, `本机应用上报的 userId 还不是正式账号（${String(info.userId).slice(0, 16)}…），先不当作新账号`);
      }
    }

    // 4) 扫盘：新账号目录出现即视为授权完成
    if (this.accounts) {
      const before = new Set(task.beforeUserIds);
      // cached：这条轮询每 3 秒跑一次，同一秒里撞上别的调用方时复用上一次结果就够了。
      // 真冒出新账号也不会漏 —— 下一轮（3 秒后）照样看得见，而授权本来就要等下一轮。
      this.accounts.scan({ cached: true });
      const fresh = this.accounts.ids().filter((x) => !before.has(x));
      if (fresh.length) {
        task.newAccountId = fresh[0];
        this._event(task, `号池新增账号 ${task.newAccountId}`);
      }
    }

    if (task.newUserId || task.newAccountId) {
      const acc = task.newAccountId ? this.accounts?.get(task.newAccountId) : null;
      if (acc && task.label) {
        this.accounts.setLabel(acc.id, task.label);
        acc.label = task.label;
      }
      task.status = 'bound';
      task.boundAt = Date.now();
      this._event(task, '授权完成，账号已并入号池');
      log.info('一键授权完成', { state: task.state, accountId: task.newAccountId, userId: task.newUserId });
      // 走这条路进来的号只有档案、没有网关凭据（项目自己没换过 key）。
      // 补一下，否则它在池子里是"看得见、用不了"。
      if (this.onBound) {
        try {
          await this.onBound(task);
        } catch (err) {
          log.warn('onBound 钩子失败', { error: err.message });
        }
      }
    } else if (!task.lastPoll?.cloudStatus && !task.lastPoll?.error) {
      task.lastPoll = { at: Date.now(), note: '云端未响应，稍后重试' };
    }

    return this.publicView(task);
  }

  cancel(id) {
    const task = this.tasks.get(String(id || ''));
    if (!task) return false;
    if (task.status === 'pending') {
      task.status = 'failed';
      task.error = '已取消';
      this._event(task, '用户取消');
    }
    return true;
  }

  clear() {
    let n = 0;
    for (const [id, task] of this.tasks) {
      if (task.status !== 'pending') {
        this.tasks.delete(id);
        n += 1;
      }
    }
    return n;
  }

  list() {
    return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt).map((t) => this.publicView(t));
  }

  pending() {
    return [...this.tasks.values()].filter((t) => t.status === 'pending').map((t) => this.publicView(t));
  }

  /* ------------------------------------------------------------- 工具 */

  _event(task, message) {
    task.events.push({ at: Date.now(), message });
    if (task.events.length > 40) task.events.shift();
    log.debug('auth flow', { state: task.state, message });
  }

  publicView(task) {
    return {
      id: task.id,
      mode: task.mode,
      label: task.label,
      state: task.state,
      authorizeUrl: task.authorizeUrl,
      qrSeed: task.authorizeUrl,
      appBaseUrl: task.appBaseUrl,
      status: task.status,
      startedAt: task.startedAt,
      expiresAt: task.expiresAt,
      secondsLeft: Math.max(0, Math.floor((task.expiresAt - Date.now()) / 1000)),
      beforeUserIds: task.beforeUserIds,
      newUserId: task.newUserId,
      newAccountId: task.newAccountId,
      polls: task.polls,
      lastPoll: task.lastPoll,
      error: task.error,
      events: task.events,
      // 拆出可读的分层信息，便于面板展示
      oauth: describeAuthorizeUrl(task.authorizeUrl),
    };
  }
}

/** 从 authorizeUrl 里拆出华为登录页 + 内层 OAuth 参数 */
export function describeAuthorizeUrl(authorizeUrl) {
  try {
    const outer = new URL(authorizeUrl);
    const service = outer.searchParams.get('service');
    const inner = service ? new URL(service) : null;
    return {
      loginPage: `${outer.origin}${outer.pathname}`,
      oauthEndpoint: inner ? `${inner.origin}${inner.pathname}` : '',
      clientId: inner?.searchParams.get('client_id') || '',
      redirectUri: inner?.searchParams.get('redirect_uri') || '',
      scope: inner?.searchParams.get('scope') || '',
      state: inner?.searchParams.get('state') || '',
      responseType: inner?.searchParams.get('response_type') || '',
      pkce: inner?.searchParams.get('code_challenge_method') || '',
    };
  } catch {
    return null;
  }
}

function extractState(authorizeUrl) {
  const d = describeAuthorizeUrl(authorizeUrl);
  return d?.state || '';
}

/** 面板用：把华为登录链接按「手机可扫」的形式给出来 */
export function authLinkHints(task) {
  return {
    desktop: task.authorizeUrl,
    note: '用同一个华为账号在任意浏览器打开即可；链接 10 分钟内有效。',
  };
}

export { DEFAULT_APP_CANDIDATES, CLOUD_BASE, STATE_TTL_MS };
