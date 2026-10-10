/**
 * 凭据池：轮询 + 冷却 + 失效回收
 *
 * 上游是华为 AgentArts 网关（APIG），同一 AppKey 在「单模型」维度有 TPM 限流
 * （ModelArts.81111 / 81114）。这里做两件事：
 *   1. 同一 baseUrl 下多条凭据轮询；
 *   2. 命中限流时只冷却「凭据 x 模型」组合，命中鉴权错误时冷却整条凭据。
 */

import { createLogger } from './logger.mjs';
import { fingerprintOf } from './fingerprint.mjs';

const log = createLogger('pool');

export class CredentialPool {
  constructor({ cooldownOnRateLimitMs = 20000, cooldownOnAuthErrorMs = 300000, perModelCooldown = true, cooldownOnEmptyCreditsMs = 600000, cooldownOnModelRejectMs = 60000 } = {}) {
    this.entries = [];
    this.rateLimitCooldownMs = cooldownOnRateLimitMs;
    this.authCooldownMs = cooldownOnAuthErrorMs;
    this.perModelCooldown = perModelCooldown;
    this.emptyCreditsCooldownMs = cooldownOnEmptyCreditsMs;
    /**
     * 「上游不认这个模型」时的短冷却（默认 60 秒）。
     * 与 rateLimit 的 20 秒、auth 的 5 分钟都分开 —— 三者原因完全不同。
     */
    this.modelRejectCooldownMs = cooldownOnModelRejectMs;
    this.cursor = 0;
    /**
     * 账号积分表：userId -> { remaining, ok, at }
     * 由 QuotaService 每次读到额度后灌进来，用来做「积分熔断」——
     * 余额见底的号不再接活，免得每次请求都撞 403 再重试。
     */
    this.credits = new Map();
  }

  add(cred) {
    const key = fingerprintOf(cred);
    if (this.entries.some((e) => e.key === key)) return false;
    this.entries.push({
      key,
      baseUrl: cred.baseUrl,
      headers: cred.headers,
      source: cred.source || '',
      userId: cred.userId || '',
      accountId: cred.accountId || '',
      provider: cred.provider || 'OpenAI',
      models: new Set(cred.models || []),
      stats: { ok: 0, fail: 0, rateLimited: 0, lastUsedAt: 0, lastError: '' },
      cooldownUntil: 0,
      modelCooldown: new Map(),
      /**
       * 这条凭据被上游明确拒绝过的模型名（81004 / 81009）。
       *
       * 和 `modelCooldown` 分开存：冷却会随时间流逝自动失效，
       * 但「这个号没有这个模型」是**事实**，不会因为过了 60 秒就变成有。
       * 用来判断「池里是不是每个号都拒绝过这个模型」→ 直接回一个干净的错，
       * 而不是把 3 次重试配额全花在一个必然失败的组合上。
       */
      rejectedModels: new Set(),
    });
    log.info('凭据已加入池', { baseUrl: cred.baseUrl, source: cred.source });
    return true;
  }

  /**
   * 灌入最新积分余额。
   * @param {Array<{userId:string, accountId?:string, remaining:number, ok:boolean}>} list
   */
  setCredits(list) {
    if (!Array.isArray(list)) return 0;
    let n = 0;
    const at = Date.now();
    for (const item of list) {
      const keys = [item.userId, item.accountId, item.id].filter(Boolean);
      for (const k of keys) {
        this.credits.set(String(k), { remaining: Number(item.remaining) || 0, ok: item.ok !== false, at });
        n += 1;
      }
    }
    this.pruneCredits();
    return n;
  }

  /** 丢掉已经不在池子里的账号的余额记录，免得误伤后来复用的同 ID 新号 */
  pruneCredits() {
    if (this.credits.size === 0) return 0;
    if (this.entries.length === 0) {
      const n = this.credits.size;
      this.credits.clear();
      return n;
    }
    const alive = new Set();
    for (const e of this.entries) {
      if (e.userId) alive.add(e.userId);
      if (e.accountId) alive.add(e.accountId);
    }
    let removed = 0;
    for (const k of [...this.credits.keys()]) {
      if (!alive.has(k)) { this.credits.delete(k); removed += 1; }
    }
    return removed;
  }

  /** 这个凭据的积分够不够用（读不到额度时一律当作够用，不拦） */
  creditsOf(entry) {
    if (!entry) return null;
    const rec = this.credits.get(entry.userId) || (entry.accountId ? this.credits.get(entry.accountId) : null);
    return rec || null;
  }

  /** 积分见底 → 冷却一段时间（默认 10 分钟），期间不选它 */
  isOutOfCredits(entry) {
    const rec = this.creditsOf(entry);
    return !!rec && rec.ok && rec.remaining <= 0;
  }

  /** 面板热更新：把余额见底的冷却时长改掉；0 = 关掉熔断 */
  setEmptyCreditsCooldown(ms) {
    const v = Number(ms);
    if (Number.isFinite(v) && v >= 0) {
      this.emptyCreditsCooldownMs = v;
      log.info('积分熔断冷却已更新', { ms: v, enabled: v > 0 });
    }
  }

  /**
   * 池里**每一条凭据都拒绝过**的模型。
   *
   * 这些就是「本地目录里有、但一个号都用不了」的模型 —— 实测一号+二号的时候
   * 33 个模型里有 24 个是这种状态（上游要么 81009 名字不认、要么 81004 没权限），
   * 而 `/v1/models` 照样把它们全列出来，用户照着试一个错一个。
   *
   * 面板拿它标一下「暂不可用」；要不要从 /v1/models 里藏掉交给上游配置决定，
   * 这里只负责**说真话**。
   */
  unavailableModels() {
    const total = this.entries.length;
    if (!total) return [];
    const out = [];
    // 从第一条凭据的候选集出发够用了：一份模型目录本来就是网关级的
    for (const model of this.entries[0].models) {
      let rejected = 0;
      for (const e of this.entries) if (e.rejectedModels.has(model)) rejected += 1;
      if (rejected >= total) out.push(model);
    }
    return out;
  }

  get size() {
    return this.entries.length;
  }

  /** 面板改配置后热更新冷却策略 */
  setCooldowns({ cooldownOnRateLimitMs, cooldownOnAuthErrorMs, perModelCooldown, credentialPerModelCooldown } = {}) {
    if (Number.isFinite(Number(cooldownOnRateLimitMs))) this.rateLimitCooldownMs = Number(cooldownOnRateLimitMs);
    if (Number.isFinite(Number(cooldownOnAuthErrorMs))) this.authCooldownMs = Number(cooldownOnAuthErrorMs);

    // 两个键名都认。
    //
    // config.json 里存的是 credentialPerModelCooldown（面板复选框也是这个名字），
    // 而这里以前只读 perModelCooldown —— 于是面板上那个「按模型冷却」开关
    // 改完看着存进去了、日志还打「冷却策略已更新」，实际压根没生效，要重启才行。
    const pm =
      typeof perModelCooldown === 'boolean'
        ? perModelCooldown
        : typeof credentialPerModelCooldown === 'boolean'
          ? credentialPerModelCooldown
          : null;
    if (pm !== null) this.perModelCooldown = pm;

    log.info('冷却策略已更新', {
      rateLimitMs: this.rateLimitCooldownMs,
      authMs: this.authCooldownMs,
      perModel: this.perModelCooldown,
    });
  }

  /** 清掉所有冷却状态（面板上的「重新发现」顺带做一次） */
  clearCooldowns() {
    const now = Date.now();
    let n = 0;
    for (const e of this.entries) {
      if (e.cooldownUntil > now) n += 1;
      if (e.modelCooldown.size) n += 1;
      e.cooldownUntil = 0;
      e.modelCooldown.clear();
    }
    return n;
  }

  list() {
    const now = Date.now();
    return this.entries.map((e, i) => ({
      index: i,
      key: e.key,
      baseUrl: e.baseUrl,
      source: e.source,
      userId: e.userId,
      accountId: e.accountId,
      models: [...e.models],
      ok: e.stats.ok,
      fail: e.stats.fail,
      rateLimited: e.stats.rateLimited,
      lastUsedAt: e.stats.lastUsedAt,
      lastError: e.stats.lastError,
      cooldownMsLeft: Math.max(0, e.cooldownUntil - now),
      modelCooldowns: [...e.modelCooldown.entries()]
        .filter(([, until]) => until > now)
        .map(([model, until]) => ({ model, msLeft: until - now })),
      // 上游明确拒绝过的模型（面板可用来解释「为什么这个模型打不通」）
      rejectedModels: [...e.rejectedModels],
      authPreview: authPreviewOf(e.headers),
      // 积分熔断状态
      creditsRemaining: this.creditsOf(e)?.remaining ?? null,
      outOfCredits: this.isOutOfCredits(e),
    }));
  }

  /**
   * 选一条可用凭据。
   * 优先级：① 没冷却且积分够 ② 没冷却但积分见底 ③ 冷却中（挑最快解冻的）
   * 读不到额度时视为「够用」，绝不因为查不到余额就把用户的请求拦下来。
   */
  pick(model) {
    if (this.entries.length === 0) return null;
    const now = Date.now();
    const total = this.entries.length;
    const order = [];
    for (let i = 0; i < total; i += 1) order.push((this.cursor + i) % total);
    this.cursor = (this.cursor + 1) % total;

    const usable = [];
    const broke = [];
    const throttled = [];
    for (const idx of order) {
      const e = this.entries[idx];
      const modelUntil = this.perModelCooldown && model ? e.modelCooldown.get(model) || 0 : 0;
      const until = Math.max(e.cooldownUntil, modelUntil);
      if (until > now) { throttled.push({ e, until }); continue; }
      if (this.emptyCreditsCooldownMs > 0 && this.isOutOfCredits(e)) { broke.push(e); continue; }
      usable.push(e);
    }
    if (usable.length) return usable[0];
    // 全都见底了也得返回一个 —— 总比直接 503 强，而且余额可能是刚过期、实际还能用
    if (broke.length) return broke[0];
    throttled.sort((a, b) => a.until - b.until);
    return throttled[0] ? throttled[0].e : null;
  }

  markOk(entry, model) {
    entry.stats.ok += 1;
    entry.stats.lastUsedAt = Date.now();
    entry.stats.lastError = '';
    if (model) {
      entry.models.add(model);
      // 「这个号没有这个模型」是个**假设**，一旦成功过一次就被推翻了。
      // 必须在这里擦掉，否则那次 81004 会永久把这条组合关在门外 ——
      // 上游加了权限、或者当初判错了，好模型也会一直被跳过。
      if (entry.rejectedModels.delete(model)) {
        log.info('该凭据其实能用这个模型，已撤销之前的拒绝标记', {
          baseUrl: entry.baseUrl,
          model,
        });
      }
    }
  }

  markRateLimited(entry, model, message) {
    entry.stats.fail += 1;
    entry.stats.rateLimited += 1;
    entry.stats.lastError = message || 'rate limited';
    const until = Date.now() + this.rateLimitCooldownMs;
    if (this.perModelCooldown && model) entry.modelCooldown.set(model, until);
    else entry.cooldownUntil = Math.max(entry.cooldownUntil, until);
    log.warn('凭据限流冷却', { baseUrl: entry.baseUrl, model, ms: this.rateLimitCooldownMs });
  }

  markAuthFailed(entry, message) {
    entry.stats.fail += 1;
    entry.stats.lastError = message || 'auth failed';
    entry.cooldownUntil = Date.now() + this.authCooldownMs;
    log.warn('凭据鉴权失败冷却', { baseUrl: entry.baseUrl, ms: this.authCooldownMs, message });
  }

  markFailed(entry, message) {
    entry.stats.fail += 1;
    entry.stats.lastError = message || 'failed';
  }

  /**
   * 上游说「这个**模型**不行」（ModelArts.81004 没权限 / 81009 名字不对）。
   *
   * ⚠️ 这**不是**鉴权失败，绝不能走 `markAuthFailed` —— 那条会把整条凭据
   * 冷却默认 5 分钟，于是"随手打一个模型名"就能把整个池子打哑。
   * 实测过：`glm-5.3-zx` → 81004 → 唯一凭据 268 秒不可用。
   *
   * 只给「凭据 × 模型」这个组合一个短冷却：名字不对的话，同一个模型再打多少次
   * 都一样，没必要每次都把 3 次重试配额花在它上面；但**其他模型完全不受影响**。
   *
   * @returns {{ modelUnavailable: boolean, cooled: number }}
   *   `modelUnavailable` = 池里每一条凭据都已经拒绝过这个模型。
   *   这时调用方应该直接告诉用户「这个模型用不了」，别再重试了。
   */
  markModelRejected(entry, model, message) {
    entry.stats.fail += 1;
    entry.stats.lastError = message || 'model rejected';
    if (!model) return { modelUnavailable: false, cooled: 0 };
    entry.modelCooldown.set(model, Date.now() + this.modelRejectCooldownMs);
    entry.rejectedModels.add(model);
    return this.modelAvailability(model);
  }

  /** 这个模型现在还有没有任何一条凭据「没拒绝过它」 */
  modelAvailability(model) {
    if (!model) return { modelUnavailable: false, cooled: 0 };
    const total = this.entries.length;
    let rejected = 0;
    for (const e of this.entries) if (e.rejectedModels.has(model)) rejected += 1;
    return { modelUnavailable: total > 0 && rejected >= total, cooled: rejected };
  }

  /** 从磁盘重新发现的凭据里剔除已不存在的（被 app 注销/切换账号） */
  /**
   * 按指纹点名删一条凭据。
   *
   * 用在「已删除（忽略）的账号不许再发请求」这条硬规则上：retain() 是按
   * 白名单整体过滤，而这里需要精确剔掉某几条、又不想动别的。
   * `config.json` 手工那条也照删 —— 它要是正好属于被删掉的账号，同样不该留着。
   */
  removeByKey(key) {
    const k = String(key || '');
    if (!k) return false;
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.key !== k);
    const removed = before !== this.entries.length;
    if (removed) {
      log.info('点名剔除凭据', { baseUrl: String(k).split('||')[0] });
      this.pruneCredits();
    }
    return removed;
  }

  /**
   * 只保留 validKeys 里的凭据。
   *
   * allowEmpty=false（默认）：传空集合视为「还没发现任何东西」，直接跳过，
   *   避免一次读取失败的抖动把整个池子清空。
   * allowEmpty=true：空集合就是「一条都不该留」，真的清空。
   *   号池模式下必须这样，否则停用账号后旧凭据会赖在池子里继续被调度。
   */
  retain(validKeys, { allowEmpty = false } = {}) {
    if (!validKeys) return 0;
    if (validKeys.size === 0 && !allowEmpty) return 0;
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.source === 'config.json' || validKeys.has(e.key));
    const removed = before - this.entries.length;
    if (removed > 0) {
      log.info('剔除失效凭据', { removed });
      this.pruneCredits();
    }
    return removed;
  }
}

function authPreviewOf(headers) {
  const auth = Object.entries(headers || {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1] || '';
  if (!auth) return '';
  const value = auth.replace(/^\w+\s+/, '');
  const decoded = safeDecode(value);
  if (decoded && decoded.includes(':')) {
    const [a, b] = decoded.split(':');
    return `${a.slice(0, 8)}…:${(b || '').slice(0, 4)}…`;
  }
  return `${auth.slice(0, 12)}…`;
}

function safeDecode(value) {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    return /^[\x20-\x7e]+$/.test(text) ? text : '';
  } catch {
    return '';
  }
}
