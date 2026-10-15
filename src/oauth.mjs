/**
 * 自助登录：不依赖 OfficeAce 桌面端，自己把华为账号登录跑完并接入号池。
 *
 * 为什么要自己实现
 * ----------------
 * 原来的「一键授权」是去问本机 OfficeAce 要链接（`POST /api/login/authorize`）。
 * 这有两个问题：
 *   1. 桌面端必须开着 —— 而 `OFFICE_CLAW_WINDOWS_RANDOM_PORTS=true`，Windows 上
 *      它的监听端口还是随机的，写死 3004 本来就不靠谱；
 *   2. 桌面端一关，整个导入功能就废了。
 *
 * 而 OfficeAce 本身走的就是一条标准的 OAuth 授权码 + PKCE 流程，客户端能做，
 * 我们也能做。链路的每一环都是从它自己的实现里读出来的：
 *
 *   packages/green-package/api/dist/auth/huawei-oauth.js     createAuthorizationRequest / exchangeCode
 *   packages/api/dist/index.js                               GET /v1/claw/auth/code?state=   ← 关键
 *
 * 完整链路
 * --------
 *   ① POST {cloud}/v1/claw/auth/state                    → state（云端签发，不用鉴权）
 *   ② 本地生成 PKCE + DPoP 密钥对（私钥只留在本地）
 *   ③ 拼 authorizeUrl，让用户去浏览器登录
 *   ④ GET  {cloud}/v1/claw/auth/code?state=<state>        → 202 等 / 200 拿到 code
 *   ⑤ POST {sts}/v1/oauth2/tokens
 *        grant_type=authorization_code + code + code_verifier + DPoP
 *                                                       → 临时 AK/SK + security_token + project_id
 *   ⑥ GET  {cloud}/v1/claw/client-permission-validate     → model_app_key / model_app_secret / 网关地址
 *   ⑦ 入库：MaaS 网关用 Basic(model_app_key:model_app_secret)，这对**不会过期**；
 *          临时凭据单独存着，用来签名控制面和续期。
 *
 * 一句话：④ 那一步是整件事的钥匙——桌面端就是靠轮询它把授权码取回来的。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.mjs';
import { generateDpopProof, idTokenClaims, DEFAULT_TOKEN_URL, DEFAULT_CLIENT_ID } from './refresh.mjs';
import { writeFileSecure } from './util.mjs';

const log = createLogger('oauth');

const DEFAULT_CLOUD_BASE = 'https://agentarts.cn-southwest-2.myhuaweicloud.com';
const DEFAULT_AUTH_BASE = 'https://auth.huaweicloud.com';
const DEFAULT_REDIRECT_URI = `${DEFAULT_CLOUD_BASE}/v1/claw/auth/callback`;

/** 登录会话的存活时间，和 OfficeAce 的 DEFAULT_STATE_TTL_MS 保持一致 */
const LOGIN_TTL_MS = 10 * 60 * 1000;
/** 轮询授权码的间隔 */
const POLL_INTERVAL_MS = 2500;
/** 授权码还没好时云端返回的状态码 */
const CODE_NOT_READY = 202;

/**
 * 同时最多允许几个「还没登完」的会话。
 *
 * 每个 pending 会话都在按 2.5 秒一次的节奏问云端要授权码。不限量的话，
 * 一个脚本连点（或者面板被卡住重复发）就能攒出几十个，等于拿你的账号去压
 * 华为云 —— 轻则被限流，重则影响这个号的正常调用。
 */
const MAX_PENDING_SESSIONS = 5;

const bgImg = 'https://res.hc-cdn.com/AgentArts-Console/26.4.7/hws/assets/login/bg2.png';
const adImg = 'https://res.hc-cdn.com/AgentArts-Console/26.4.7/hws/assets/login/ad2.png';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/* ============================================================ 密钥生成 */

/** PKCE：S256。verifier 43~128 字符，challenge = base64url(sha256(verifier)) */
export function generatePkce() {
  const verifier = b64u(crypto.randomBytes(32));
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * 生成一对 P-256 的 DPoP 密钥。
 * 私钥（d）只留本地；对外发的 proof JWT 里只带公钥。
 */
async function generateDpopKeyPair() {
  const pair = await crypto.webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const privateJwk = await crypto.webcrypto.subtle.exportKey('jwk', pair.privateKey);
  const publicJwk = await crypto.webcrypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    privateJwk: { kty: 'EC', crv: 'P-256', x: privateJwk.x, y: privateJwk.y, d: privateJwk.d },
    publicJwk: { kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y },
  };
}

/** 按 OfficeAce 的写法拼授权地址 */
export function buildAuthorizeUrl({ authBase = DEFAULT_AUTH_BASE, clientId = DEFAULT_CLIENT_ID, state, challenge, redirectUri = DEFAULT_REDIRECT_URI }) {
  const params = new URLSearchParams({
    client_id: clientId,
    code_challenge: challenge,
    code_challenge_method: 'SHA-256',
    state,
    scope: 'openid',
    redirect_uri: redirectUri,
    response_type: 'code',
  });
  const inner = `${authBase}/authui/v1/oauth2/authorize?${params.toString()}`;
  return `${authBase}/authui/login.html?service=${encodeURIComponent(inner)}&background_img_url=${encodeURIComponent(bgImg)}&portal_img_url=${encodeURIComponent(adImg)}`;
}

/**
 * 拼一个「先登出、再去授权」的地址，用来**换一个账号**登录。
 *
 * 为什么需要它：华为云那边有会话就会**直接放行**。
 * 实测（`tools/probe-auth-switch.mjs`，不带任何 cookie 时）：
 *
 *   GET /authui/v1/oauth2/authorize            → 302 /authui/login?service=…   ← 没会话，要登录
 *   GET /authui/v1/oauth2/authorize&prompt=login → 同上（prompt 不影响判定）
 *
 * 浏览器里带着会话时，同一条 authorize 会**直接 302 回 redirect_uri 并带上 code**
 * —— 也就是「点了导入账号，结果它拿当前会话把同一个号又登了一遍」。
 * 那时候号池里只会多出一条同 ID 的账号（被并进已有的那条），用户看到的就是
 * 「我想加个新号，它却直接给我登录了」。
 *
 * 所以新增一个号必须先把会话清掉。`/authui/logout` 支持 `service=` 参数
 * （实测：302 到那个 service），把 authorize 地址塞进去，就是标准的
 * 「登出后回到授权流程」——那时没有会话可复用，只能重新输账号密码。
 *
 * ⚠️ 副作用要说清楚：这会把你**在华为云那边的登录状态一起登出**
 * （其它标签页、控制台都要重新登）。这是唯一能可靠换账号的办法，
 * 所以面板上做成一个单独的按钮，不默认走这条。
 */
export function buildSwitchAccountUrl({ authBase = DEFAULT_AUTH_BASE, authorizeUrl }) {
  return `${authBase}/authui/logout?service=${encodeURIComponent(authorizeUrl)}`;
}

/* ============================================================ 会话状态 */

/**
 * 登录会话。存在内存里；同时落盘一份（0600），服务重启后不丢正在进行的登录。
 * 注意：会话里含 DPoP 私钥和 code_verifier，属于敏感数据。
 */
export class LoginSessions {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      if (!fs.existsSync(this.file)) return;
      const doc = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const now = Date.now();
      for (const [id, s] of Object.entries(doc || {})) {
        // 过期的直接丢掉，不用再占地方
        if (s && s.expiresAt > now) this.map.set(id, s);
      }
    } catch (err) {
      log.warn('读取登录会话失败，按空处理', { error: err.message });
    }
  }

  save() {
    if (!this.file) return;
    try {
      const doc = {};
      for (const [id, s] of this.map) doc[id] = s;
      // 会话里有 DPoP 私钥和 code_verifier，权限必须真的收紧（Windows 见 util.lockDownFile）
      writeFileSecure(this.file, JSON.stringify(doc, null, 2));
    } catch (err) {
      log.warn('保存登录会话失败', { error: err.message });
    }
  }

  create(session) {
    this.map.set(session.id, session);
    this.save();
    return session;
  }

  get(id) {
    const s = this.map.get(String(id || ''));
    if (!s) return null;
    if (s.expiresAt <= Date.now()) {
      s.status = 'expired';
      s.error = '登录链接超过 10 分钟没完成，请重新发起';
      this.save();
    }
    return s;
  }

  update(id, patch) {
    const s = this.map.get(String(id || ''));
    if (!s) return null;
    Object.assign(s, patch);
    this.save();
    return s;
  }

  drop(id) {
    const ok = this.map.delete(String(id || ''));
    if (ok) this.save();
    return ok;
  }

  /**
   * 清掉「已经结束」和「已经过期」的会话。
   *
   * 注意这里连过期的 pending 一起删：过了 TTL 的会话永远不可能再完成，
   * 留着只会让磁盘上的会话越堆越多（它们状态还是 pending，光看状态判断不出来）。
   */
  prune() {
    const now = Date.now();
    let n = 0;
    for (const [id, s] of this.map) {
      const finished = s.status !== 'pending' && s.status !== 'polling';
      const dead = !(s.expiresAt > now);
      if (finished || dead) {
        this.map.delete(id);
        n += 1;
      }
    }
    if (n) this.save();
    return n;
  }

  list() {
    return [...this.map.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
}

/* ============================================================ 主流程 */

export class LoginFlow {
  /**
   * @param {object} opts
   * @param {object} opts.accounts  AccountStore
   * @param {object} [opts.config]  config.credits 那一块
   * @param {string} [opts.sessionFile]  登录会话落盘路径
   * @param {string} [opts.accountFile]  自助登录账号的落盘路径
   */
  constructor({ accounts, config = {}, sessionFile = '', accountFile = '', onDone = null }) {
    this.accounts = accounts;
    this.onDone = typeof onDone === 'function' ? onDone : null;
    this.cloudBase = String(config.cloudBase || DEFAULT_CLOUD_BASE).replace(/\/+$/, '');
    this.authBase = String(config.authBase || DEFAULT_AUTH_BASE).replace(/\/+$/, '');
    this.tokenUrl = String(config.refresh?.tokenUrl || DEFAULT_TOKEN_URL);
    this.clientId = String(config.refresh?.clientId || DEFAULT_CLIENT_ID);
    this.redirectUri = String(config.redirectUri || DEFAULT_REDIRECT_URI);
    this.timeoutMs = Math.max(5000, Number(config.timeoutMs) || 25000);
    this.accountFile = accountFile;
    this.sessions = new LoginSessions(sessionFile);
    /** 自助登录进来的账号（含私钥），key = 账号 ID */
    this.store = loadOauthAccounts(accountFile);
    this._timers = new Map();
    this._resumePending();

    // 定期清扫。没有它的话，被中断 / 过期的会话会一直躺在 data/login-sessions.json
    // 里越堆越多（清理接口平时没人调）。
    this._sweeper = setInterval(() => {
      try {
        const n = this.clear();
        if (n) log.info('清理已结束的登录会话', { removed: n });
      } catch (err) {
        log.warn('清理登录会话失败', { error: err.message });
      }
    }, 60_000);
    if (typeof this._sweeper.unref === 'function') this._sweeper.unref();
  }

  /**
   * 服务重启后把还没完成的登录会话接着轮下去。
   *
   * 不接的话会出现这种尴尬情况：用户在浏览器里登录到一半，服务重启了一下，
   * 面板永远停在「等你登录…」，而云端其实早就把码准备好了。
   */
  _resumePending() {
    // 先把过期的淘汰掉：过了 TTL 的会话永远不可能再完成，
    // 给它们起轮询纯粹是白打云端接口（曾经一次开机就打出去 29 发）。
    this.sessions.prune();

    const now = Date.now();
    const pending = this.sessions
      .list()
      .filter((s) => s.status === 'pending' && s.expiresAt > now)
      // 只恢复最近的那几个：会话文件里可能躺着十几个没登完的（脚本连点、
      // 面板卡住重复发），全部拉起来就是开机瞬间打出去一串云端请求。
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, MAX_PENDING_SESSIONS);

    for (const s of pending) {
      log.info('恢复未完成的登录会话', { id: s.id, state: s.state });
      this._startPolling(s.id);
    }
    return pending.length;
  }

  /* -------------------------------------------------- ① 发起 */

  /**
   * 向云端要一个 state，拼出授权链接。
   * 返回给前端的只有链接和会话 id，私钥不出本机。
   *
   * @param {boolean} opts.forceLogin
   *   `true` = **换一个账号**：链接先指向华为云登出，登出完再回授权流程。
   *   不加这个的话，浏览器里只要还有华为云会话，云端就会**直接放行**、
   *   拿当前账号再登一遍 —— 用户点了「导入账号」想加新号，结果看不到登录页。
   *   见 `buildSwitchAccountUrl()` 里的实测记录。
   */
  async start({ label = '', forceLogin = false } = {}) {
    // 手里攒了太多没登完的会话就顶掉最老的，保证总量不会无限涨。
    //
    // 这里刻意不用「直接拒绝」：用户攒下几个没登完的会话太正常了
    // （点了没登、换了浏览器、把页面关了），拒绝会让人以为功能坏了。
    // 顶掉最老的 = 保住最近的意图，同时不让轮询无限堆下去
    // —— 每个 pending 会话都在按 2.5 秒一次问云端要授权码，攒到几十个
    // 就是拿这个账号去压华为云了。
    const waiting = this.sessions
      .list()
      .filter((s) => s.status === 'pending' && s.expiresAt > Date.now())
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    if (waiting.length >= MAX_PENDING_SESSIONS) {
      const evict = waiting.slice(0, waiting.length - MAX_PENDING_SESSIONS + 1);
      for (const s of evict) {
        this._stopPolling(s.id);
        this.sessions.drop(s.id);
      }
      log.info('未完成的登录太多，顶掉最老的几个', {
        evicted: evict.length,
        kept: waiting.length - evict.length,
      });
    }

    const state = await this._fetchState();
    const { verifier, challenge } = generatePkce();
    const { privateJwk, publicJwk } = await generateDpopKeyPair();

    const id = `login-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const authorizeUrl = buildAuthorizeUrl({
      authBase: this.authBase,
      clientId: this.clientId,
      state,
      challenge,
      redirectUri: this.redirectUri,
    });
    // 「换账号」模式：先把华为云那边的会话登出，再回授权流程。
    // 授权地址本身不变（state / PKCE / DPoP 都用同一套），只是前面套一层登出。
    const url = forceLogin ? buildSwitchAccountUrl({ authBase: this.authBase, authorizeUrl }) : authorizeUrl;

    const session = {
      id,
      state,
      codeVerifier: verifier,
      dpopPrivateJwk: privateJwk,
      dpopPublicJwk: publicJwk,
      authorizeUrl,
      // 面板打开的地址（换账号模式下是登出链接，会自己转回 authorizeUrl）
      url,
      forceLogin: !!forceLogin,
      label: String(label || '').trim(),
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + LOGIN_TTL_MS,
      polls: 0,
      // 完成后的结果（不含任何密钥）
      accountId: '',
      userId: '',
      userName: '',
      baseUrl: '',
      error: '',
    };
    this.sessions.create(session);
    log.info('自助登录已发起', { state, forceLogin: !!forceLogin });
    this._startPolling(id);
    return this.view(session);
  }

  async _fetchState() {
    const url = `${this.cloudBase}/v1/claw/auth/state`;
    const res = await this._fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const text = await res.text();
    let state = '';
    try {
      state = JSON.parse(text).state || '';
    } catch {
      /* 非 JSON */
    }
    if (!state) throw new Error(`云端没给出 state：HTTP ${res.status} ${text.slice(0, 200)}`);
    return state;
  }

  /* -------------------------------------------------- ② 轮询取码 */

  _startPolling(id) {
    const tick = async () => {
      const s = this.sessions.get(id);
      if (!s || s.status !== 'pending') {
        this._stopPolling(id);
        return;
      }
      s.polls += 1;
      this.sessions.update(id, { polls: s.polls });
      try {
        const done = await this._tick(id);
        if (done) this._stopPolling(id);
      } catch (err) {
        // 单次失败不算数，等下一轮；连续失败才标失败
        s.error = err.message;
        if (s.polls >= 60) {
          this.sessions.update(id, { status: 'failed', error: `轮询超时：${err.message}` });
          this._stopPolling(id);
        }
      }
    };
    // 不用 setInterval：每轮结束再排下一次，避免慢请求堆叠
    const loop = async () => {
      await tick();
      if (this._timers.has(id)) {
        this._timers.set(id, setTimeout(loop, POLL_INTERVAL_MS));
      }
    };
    this._timers.set(id, setTimeout(loop, 1500));
  }

  _stopPolling(id) {
    const t = this._timers.get(id);
    if (t) clearTimeout(t);
    this._timers.delete(id);
  }

  /**
   * 一轮轮询。返回 true 表示这单结束了（成功或失败）。
   * 这是整个流程里最关键的一步：桌面端也是靠这个接口把授权码取回来的。
   */
  async _tick(id) {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'pending') return true;
    if (s.expiresAt <= Date.now()) {
      this.sessions.update(id, { status: 'expired', error: '登录链接超过 10 分钟没完成，请重新发起' });
      return true;
    }

    const url = `${this.cloudBase}/v1/claw/auth/code?state=${encodeURIComponent(s.state)}`;
    const res = await this._fetch(url, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }

    if (res.status === CODE_NOT_READY) {
      // 用户还没在浏览器里点完，正常
      return false;
    }
    if (res.status === 404) {
      this.sessions.update(id, { status: 'expired', error: '授权码已失效或 state 不认识，请重新发起' });
      return true;
    }
    if (!res.ok) {
      // 其他错误先记下来，下一轮再试（云端偶尔会 5xx）
      this.sessions.update(id, { error: `取授权码返回 HTTP ${res.status}` });
      return false;
    }

    const code = json?.code || json?.authorization_code || '';
    if (!code) {
      this.sessions.update(id, { error: '云端说好了，但没给 code', status: 'failed' });
      return true;
    }
    if (json.error) {
      this.sessions.update(id, { status: 'failed', error: String(json.error_msg || json.error) });
      return true;
    }

    // 拿到码 → 换令牌 → 开通 → 入库
    try {
      await this._finish(id, code);
      return true;
    } catch (err) {
      this.sessions.update(id, { status: 'failed', error: err.message });
      return true;
    }
  }

  /* -------------------------------------------------- ③ 换令牌 */

  async _exchangeCode(code, { codeVerifier, dpopPrivateJwk, dpopPublicJwk }) {
    const dpopJwt = await generateDpopProof(dpopPrivateJwk, dpopPublicJwk, 'POST', this.tokenUrl);
    const body = new URLSearchParams({
      client_id: this.clientId,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri,
    }).toString();

    const res = await this._fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: dpopJwt },
      body,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    if (!res.ok || !json) {
      const msg = json?.error_description || json?.error_msg || json?.error || text.slice(0, 200);
      throw new Error(`换令牌失败（HTTP ${res.status}）：${msg}`);
    }

    const c = json.credentials || json;
    if (!c?.access_key_id || !c?.secret_access_key) {
      throw new Error('换令牌成功，但返回里没有 AK/SK');
    }

    const claims = idTokenClaims(json.id_token || '');
    return {
      credential: {
        accessKeyId: String(c.access_key_id),
        secretAccessKey: String(c.secret_access_key),
        securityToken: String(c.security_token || ''),
        projectId: String(c.project_id || ''),
        expiresAt: String(c.expiration || ''),
      },
      refreshToken: String(json.refresh_token || ''),
      idToken: String(json.id_token || ''),
      userName: claims.preferred_username || claims.name || '',
      userId: claims.sub || '',
    };
  }

  /* -------------------------------------------------- ④ 开通 / 拿网关 */

  /**
   * 用刚换到的临时凭据问云端：「我能用什么模型、走哪个网关」。
   *
   * 返回的 model_app_key / model_app_secret 是 MaaS 网关 Basic 认证用的那对。
   * 它**不随临时凭据过期**，所以这是真正长期有效的上游凭据。
   *
   * 注意：未开通的号这里会拿不到 model_info —— 那是「需要兑换邀请码」的状态，
   * 界面上要给出明确提示，而不是干等。
   */
  async _fetchModelInfo(credential) {
    const url = `${this.cloudBase}/v1/claw/client-permission-validate`;
    const { signV4 } = await import('./quota.mjs');
    const headers = signV4({
      method: 'GET',
      url,
      credential: {
        accessKey: credential.accessKeyId,
        secretKey: credential.secretAccessKey,
        securityToken: credential.securityToken,
        projectId: credential.projectId,
      },
      contentType: 'application/json;charset=utf8',
    });
    const res = await this._fetch(url, { method: 'GET', headers });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    if (!res.ok || !json) {
      const msg = json?.error_msg || json?.error_code || text.slice(0, 200);
      throw new Error(`开通校验失败（HTTP ${res.status}）：${msg}`);
    }

    const mi = json.model_info || json.subscription?.model_info || json.modelInfo || null;
    const accountId = json.account_id || '';
    const principalId = json.principal_id || '';

    if (!mi?.model_auth_info?.model_app_key) {
      const err = new Error(
        json.subscription?.status === 'PENDING' || !mi
          ? '这个账号还没开通服务，需要先在客户端里兑换邀请码；开通后再重新导入一次即可'
          : '云端没返回模型网关信息，可能该账号没有可用套餐',
      );
      err.code = 'NOT_PROVISIONED';
      err.accountId = accountId;
      throw err;
    }

    const host = String(mi.model_api_url_base || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return {
      accountId,
      principalId,
      appKey: String(mi.model_auth_info.model_app_key),
      appSecret: String(mi.model_auth_info.model_app_secret),
      baseUrl: host ? `https://${host}/v2` : '',
      raw: json,
    };
  }

  /* -------------------------------------------------- ⑤ 收尾入库 */

  async _finish(id, code) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.update(id, { status: 'exchanging' });

    const tok = await this._exchangeCode(code, s);
    const info = await this._fetchModelInfo(tok.credential);
    if (!info.baseUrl) throw new Error('云端给的网关地址是空的');

    const accountId = info.accountId || tok.userId;
    const userId = info.principalId || tok.userId;
    const accId = `${accountId}:${userId}`;
    const label = s.label || tok.userName || `账号 ${accountId.slice(0, 8)}`;

    // MaaS 网关要的是 Basic(appKey:appSecret)，这对不过期
    const authorization = `Basic ${Buffer.from(`${info.appKey}:${info.appSecret}`).toString('base64')}`;

    const record = {
      id: accId,
      label,
      accountId,
      userId,
      userName: tok.userName,
      baseUrl: info.baseUrl,
      authorization,
      createdAt: Date.now(),
      // 临时凭据 + refresh_token + DPoP 私钥：都留在本机，用来签名控制面和续期
      credential: tok.credential,
      refreshToken: tok.refreshToken,
      dpopPrivateJwk: s.dpopPrivateJwk,
      dpopPublicJwk: s.dpopPublicJwk,
    };

    this.store[accId] = this.store[accId] || record;
    this.store[accId] = { ...this.store[accId], ...record };
    saveOauthAccounts(this.accountFile, this.store);

    // 让它立刻出现在号池里：不用等下次扫描
    this.accounts.attachOauthAccount(this.store[accId]);

    this.sessions.update(id, {
      status: 'done',
      accountId: accId,
      userId,
      userName: tok.userName,
      baseUrl: info.baseUrl,
      finishedAt: Date.now(),
    });
    log.info('自助登录完成', { accountId: accId, userName: tok.userName, baseUrl: info.baseUrl });

    // 通知外面重建连接池，不然新号要等下一次扫描才会被调度到
    try {
      await this.onDone?.(accId);
    } catch (err) {
      log.warn('自助登录完成回调失败', { error: err.message });
    }
  }

  /* -------------------------------------------------- 对外视图 */

  /** 脱敏后的会话视图：绝不带 code_verifier / 私钥 / token */
  view(s) {
    if (!s) return null;
    return {
      id: s.id,
      status: s.status,
      // 面板要打开的地址。换账号模式下是登出链接（会自己转回授权流程），
      // 所以前端一律用它，不要自己拼。
      url: s.url || s.authorizeUrl,
      // 授权地址本身也留着：排障时想知道"去掉登出那层之后到底是什么"。
      authorizeUrl: s.authorizeUrl,
      // 这次是不是「换账号」模式（先登出再登录）
      forceLogin: !!s.forceLogin,
      state: s.state,
      label: s.label,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      expiresInMs: Math.max(0, s.expiresAt - Date.now()),
      polls: s.polls,
      remainingMs: Math.max(0, s.expiresAt - Date.now()),
      accountId: s.accountId || '',
      user: s.userName || '',
      baseUrl: s.baseUrl || '',
      error: s.error || '',
      done: s.status === 'done',
    };
  }

  get(id) {
    return this.view(this.sessions.get(id));
  }

  cancel(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    this._stopPolling(id);
    this.sessions.update(id, { status: 'canceled', error: '已取消' });
    return true;
  }

  /**
   * 清理已结束 / 已过期的会话。
   *
   * ⚠️ 这里曾经是「先把所有定时器全停掉，再 prune()」。而 prune() 会保留
   * pending 的会话 —— 两者一凑，结果是：还在等的会话被拔了定时器，然后就
   * 一直卡在 pending 不动了：不轮询、也不超时（超时判断在 _tick 里，
   * 而 _tick 已经不会再跑了）。用户现象就是「浏览器里明明登录成功了，
   * 面板一直显示等你登录…」。
   *
   * 规矩：**只对确实要删掉的会话停表**。还活着的一律不碰。
   */
  clear() {
    const now = Date.now();
    let n = 0;
    for (const s of this.sessions.list()) {
      const stillWaiting = s.status === 'pending' && s.expiresAt > now;
      if (stillWaiting) continue;
      this._stopPolling(s.id);
      if (this.sessions.drop(s.id)) n += 1;
    }
    return n;
  }

  /** 已入库的自助登录账号（脱敏） */
  list() {
    return Object.values(this.store).map((a) => ({
      id: a.id,
      label: a.label,
      userName: a.userName,
      baseUrl: a.baseUrl,
      createdAt: a.createdAt,
      hasRefreshToken: !!a.refreshToken,
      tempExpiresAt: a.credential?.expiresAt || '',
    }));
  }

  _fetch(url, options = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  }
}

/* ============================================================ 落盘 */

function loadOauthAccounts(file) {
  if (!file) return {};
  try {
    if (!fs.existsSync(file)) return {};
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return doc && typeof doc === 'object' ? doc : {};
  } catch (err) {
    log.warn('读取自助登录账号失败，按空处理', { error: err.message });
    return {};
  }
}

function saveOauthAccounts(file, store) {
  if (!file) return;
  try {
    // 里面有 refresh_token 和 DPoP 私钥。注意 mode 在 Windows 上是无效的，
    // 真正把权限收紧到只有当前用户的是 writeFileSecure 里的 icacls。
    writeFileSecure(file, JSON.stringify(store, null, 2));
  } catch (err) {
    log.warn('保存自助登录账号失败', { error: err.message });
  }
}
