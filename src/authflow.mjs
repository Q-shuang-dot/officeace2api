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

// 问云端的节奏（`config.auth.pollSeconds`）。
//
// 这条配置以前是**死的** —— 全仓库没有一处读它，真正决定节奏的是
// index.mjs 里 regTimer 的 `register.tickSeconds`（5 秒）加上注册状态机
// 自己那一遍、面板点一下、桌面端自己也在问，四路叠一起。现在真接上了，
// 而且它是**每个 state** 的底线：不管几个调用方来问，一个间隔只真问一次。
const DEFAULT_POLL_SECONDS = 5;

// 被云端嫌「同一个 state 问太多」之后，退避的上限。
//
// 为什么要有上限：链接总共只有 10 分钟有效期（STATE_TTL_MS），退到 60 秒
// 还能问 10 次 —— 够把「用户刚点了授权」这件事认出来，又不至于把 state
// 问进更长的黑屋。退避是**指数**的：5 → 10 → 20 → 40 → 60（封顶）。
const MAX_POLL_BACKOFF_MS = 60 * 1000;

/**
 * 云端在嫌「同一个 state 请求太多」吗？
 *
 * 实测原文（反复轮询同一个 state 时会撞到）：
 *   AgentArts.1100011: Too many requests for the same state. Please retry later.
 * 关键是**别把它当成"用户还没完成"**：那样会保持原节奏接着砸，越砸越问不到，
 * 最后一整条链接在 10 分钟到点被判超时 —— 表现就是
 * 「注册任务失败：一键授权失败：授权链接超过 10 分钟未完成」。
 */
function isRateLimited(res) {
  if (!res) return false;
  if (res.status === 429 || res.status === 503) return true;
  if (res.json?.error_code === 'AgentArts.1100011') return true;
  const text = `${res.json?.error_msg || ''} ${res.text || ''}`;
  return /too many requests/i.test(text);
}

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
   *          appApis?: string[],
   *          onBound?: (task:object)=>void,
   *          pollSeconds?: number,
   *          stateTtlMinutes?: number}} opts
   */
  constructor({ accounts, appApis, onBound, pollSeconds, stateTtlMinutes } = {}) {
    this.accounts = accounts;
    this.appApis = (appApis && appApis.length ? appApis : DEFAULT_APP_CANDIDATES).slice();
    this.onBound = onBound || (() => {});
    // 问云端同一 state 的最快节奏。被限流时 check() 会自己指数退避，不再按它硬打。
    this.pollSeconds = Math.max(1, Number(pollSeconds) || DEFAULT_POLL_SECONDS);
    // 授权链接的有效期（`config.auth.stateTtlMinutes`）。
    // 这条也是死配置 —— 代码里原本写死 10 分钟，改了配置不生效。
    const ttlMinutes = Number(stateTtlMinutes);
    this.stateTtlMs = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes * 60 * 1000 : STATE_TTL_MS;
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
      expiresAt: Date.now() + this.stateTtlMs,
      beforeUserIds: [...before],
      newUserId: '',
      newAccountId: '',
      polls: 0,
      // 下一次允许问云端的时间。**挂在 task 上**，所以不管几个调用方来问，
      // 同一个 state 每个间隔只真问一次。
      nextPollAt: 0,
      intervalMs: this.pollSeconds * 1000,
      rateLimited: 0, // 云端嫌问太快的次数，退避的依据
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

  async check(id, { force = false } = {}) {
    const task = this.tasks.get(String(id || ''));
    if (!task) throw new Error('授权任务不存在或已清理');
    if (task.status === 'bound' || task.status === 'failed') return this.publicView(task);

    if (Date.now() > task.expiresAt) {
      task.status = 'expired';
      const mins = Math.round(this.stateTtlMs / 60000);
      task.error = `授权链接超过 ${mins} 分钟未完成，请重新发起`;
      this._event(task, task.error);
      return this.publicView(task);
    }

    // 到点了吗？没到点就**不碰云端**，但本机那两步（看 islogin / 扫盘）照样做 ——
    // 它们在下面 3) 4)，是认「授权完成」的主要依据，而且都是本机调用，便宜。
    //
    // 为什么必须节流：同一个 state 的轮询方有四路 —— regTimer（5 秒一轮）、
    // 注册状态机自己又 check 一遍、面板点「检查」、还有本机 OfficeAce 应用
    // 自己也在问云端。四路叠上去云端就开始回
    //   AgentArts.1100011: Too many requests for the same state. Please retry later.
    // 于是**越问越问不到**，最后 10 分钟到点被判超时 ——
    // 表现就是「注册任务失败：一键授权失败：授权链接超过 10 分钟未完成」。
    // 节流挂在 task 上：不管谁来问，一个间隔只真问一次。
    const due = force || Date.now() >= (task.nextPollAt || 0);
    if (due) {
      task.polls += 1;
      // 先把「下次允许的时间」推到未来，**再**发请求。
      // 顺序反了的话：四个调用方同一瞬间进来，会各发一次（它们都在
      // nextPollAt 被更新之前判断 due）—— 那正是要治的毛病。
      task.nextPollAt = Date.now() + (task.intervalMs || this.pollSeconds * 1000);

      // 1) 直连云端：这个 state 有没有被回调过
      try {
        const r = await request(`${CLOUD_BASE}/v1/claw/auth/code?state=${encodeURIComponent(task.state)}`, {
          headers: { Accept: 'application/json' },
          timeoutMs: 12000,
          // 公网端点。写死 false 是故意的：就算 http.mjs 的默认值哪天又变回
          // insecure，这条也不能裸奔 —— 它的返回值直接决定拿不拿授权码。
          insecure: false,
        });
        const res = { status: r.status, json: r.json, text: r.text.slice(0, 400) };
        task.lastPoll = { at: Date.now(), cloudStatus: r.status, errorCode: r.json?.error_code || '' };
        if (isRateLimited(res)) {
          // 限流**不是**「用户还没完成」。把它当完成态之外的"再等等、但慢点问"，
          // 否则会保持原节奏继续砸，越砸越问不到。
          const wait = this._schedulePoll(task, true);
          task.lastPoll.rateLimited = true;
          task.lastPoll.nextInMs = wait;
        } else {
          this._schedulePoll(task, false);
          // 「还没好」必须按 **error_code** 判，不能按状态码。
          // 实测这条路回的是 HTTP 202 + AgentArts.11000009（不是 404），
          // 按 404 判会让每一次轮询都记一条事件 —— 事件表只有 40 条，
          // 几十秒就被同一句话「Authorization code is not ready」占满，
          // 真正要看的信息（新增账号、授权完成、限流）反而被挤掉。
          const notReady =
            r.json?.error_code === 'AgentArts.11000009' || /not ready/i.test(r.json?.error_msg || '');
          if (notReady) {
            // 正常：用户还没在浏览器里完成授权
          } else if (r.status === 200) {
            this._event(task, '云端已收到授权回调');
          } else if (r.json?.error_code) {
            this._event(task, `云端返回 ${r.json.error_code}: ${r.json.error_msg || ''}`);
          }
        }
      } catch (err) {
        task.lastPoll = { at: Date.now(), error: err.message };
        // 网络抽风也按节奏重试，不空转（空转就是四路一起砸）
        this._schedulePoll(task, false);
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

  /**
   * 排下一次问云端的时间，返回这次的间隔（毫秒）。
   *
   * backoff=true：指数退避（×2，封顶 MAX_POLL_BACKOFF_MS），这是被云端限流后的反应。
   * backoff=false：拿到正常答复，立刻回到 pollSeconds 的原节奏。
   *
   * 事件只在第 1 次和每 5 次记一条 —— 事件列表只有 40 条，被退避刷满就等于
   * 把「授权到底走到哪一步」这些真正要看的信息挤掉了。
   */
  _schedulePoll(task, backoff) {
    const base = this.pollSeconds * 1000;
    if (backoff) {
      task.rateLimited += 1;
      task.intervalMs = Math.min(MAX_POLL_BACKOFF_MS, Math.max(base * 2, (task.intervalMs || base) * 2));
      if (task.rateLimited === 1 || task.rateLimited % 5 === 0) {
        this._event(task, `云端嫌问得太快（第 ${task.rateLimited} 次），放慢到每 ${Math.round(task.intervalMs / 1000)} 秒问一次`);
      }
    } else {
      task.intervalMs = base;
      task.rateLimited = 0;
    }
    task.nextPollAt = Date.now() + task.intervalMs;
    return task.intervalMs;
  }

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
      // 问云端的节奏（面板可以显示"下次询问还剩几秒"、"被限流退避中"）
      poll: {
        intervalMs: task.intervalMs || 0,
        nextPollAt: task.nextPollAt || 0,
        nextInMs: Math.max(0, (task.nextPollAt || 0) - Date.now()),
        rateLimited: task.rateLimited || 0,
      },
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

export { DEFAULT_APP_CANDIDATES, CLOUD_BASE, STATE_TTL_MS };
