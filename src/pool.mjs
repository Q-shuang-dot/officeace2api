/**
 * 凭据池：轮询 + 首包延迟/在途调度 + 会话黏性 + 冷却 + 连续失败熔断 + 失效回收
 *
 * 上游是华为 AgentArts 网关（APIG），同一 AppKey 在「单模型」维度有 TPM 限流
 * （ModelArts.81111 / 81114）。这里做两件事：
 *   1. 同一 baseUrl 下多条凭据轮询；
 *   2. 命中限流时只冷却「凭据 x 模型」组合，命中鉴权错误时冷却整条凭据。
 *
 * 运行态（冷却、熔断、会话黏性）可落盘到 `stateFile`，重启只恢复未过期项。
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createLogger } from './logger.mjs';
import { fingerprintOf } from './fingerprint.mjs';
import { writeFileAtomic } from './util.mjs';

const log = createLogger('pool');

export class CredentialPool {
  constructor({
    cooldownOnRateLimitMs = 20000,
    cooldownOnAuthErrorMs = 300000,
    perModelCooldown = true,
    cooldownOnEmptyCreditsMs = 600000,
    cooldownOnModelRejectMs = 60000,
    maxInFlightPerCredential = 2,
    sessionTtlSeconds = 1800,
    latencyWeightMs = 800,
    queueTimeoutMs = 10000,
    cooldownOnRateLimitMaxMs = 600000,
    breakerThreshold = 3,
    breakerCooldownMs = 60000,
    breakerMaxMs = 900000,
    stateFile = '',
    stateMaxAgeMs = 7 * 24 * 60 * 60 * 1000,
  } = {}) {
    this.entries = [];
    this.rateLimitCooldownMs = cooldownOnRateLimitMs;
    this.rateLimitCooldownMaxMs = Math.max(
      Number(cooldownOnRateLimitMs) || 20000,
      Number(cooldownOnRateLimitMaxMs) || 600000,
    );
    this.authCooldownMs = cooldownOnAuthErrorMs;
    this.perModelCooldown = perModelCooldown;
    this.emptyCreditsCooldownMs = cooldownOnEmptyCreditsMs;
    /**
     * 调度器参数：
     *   · 每条凭据同时在跑多少个请求（软上限，超了会挑最闲的，但仍可用）；
     *   · 会话黏性保持多久（命中缓存的关键，见 pick 的注释）；
     *   · 每多一个在途请求，相当于多等多少毫秒（把延迟和在途压到同一个分数里）。
     */
    this.maxInFlightPerCredential = Math.max(1, Number(maxInFlightPerCredential) || 2);
    // 0 = 关闭会话黏性；正数最小 60 秒，避免误填 1 秒导致完全失效。
    const ttlSeconds = Number(sessionTtlSeconds);
    this.sessionTtlMs = ttlSeconds === 0 ? 0 : Math.max(60_000, (ttlSeconds || 1800) * 1000);
    this.latencyWeightMs = Math.max(0, Number(latencyWeightMs) || 800);
    // 全部号都在途满时，最多等这么久再退回软上限；0 = 不排队。
    this.queueTimeoutMs = Math.max(0, Number(queueTimeoutMs) || 0);
    /**
     * 连续失败熔断：只针对「账号健康」失败（5xx / 传输层），
     * 400/401/413、客户端主动断开都不应该走到这里。
     *
     * 退避公式：base × 2^(level-1)，封顶 max；成功一次清零。
     */
    this.breakerThreshold = Math.max(1, Number(breakerThreshold) || 3);
    this.breakerCooldownMs = Math.max(1000, Number(breakerCooldownMs) || 60000);
    this.breakerMaxMs = Math.max(this.breakerCooldownMs, Number(breakerMaxMs) || 900000);
    /** 调度质量计数，面板/日志用；不参与选号。 */
    this.metrics = {
      affinityHits: 0,
      affinityMisses: 0,
      queueWaits: 0,
      queueAdmitted: 0,
      queueTimeouts: 0,
    };
    /**
     * 会话黏性表：sessionKey 的哈希 -> { stateKey, expiresAt }。
     *
     * 上游的 prefix cache 通常按「账号 + 模型 + 前缀」命中；同一个会话每轮
     * 轮询到不同账号，等于每轮都从零 prefill 几万 token。这里只保存账号的
     * 稳定 stateKey，不保存 entry 引用 —— 凭据被移除后引用会悬空。
     */
    this.sessions = new Map();
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
    /**
     * 号池运行态落盘：冷却、熔断、拒模、连败、会话黏性。
     *
     * 不存 Authorization、不存原始会话 key —— 前者是密钥，后者可能是用户
     * 的会话 ID 或首条消息哈希。状态文件里只留指纹/会话哈希和绝对时间戳。
     */
    this.stateFile = String(stateFile || '');
    this.stateMaxAgeMs = Math.max(60_000, Number(stateMaxAgeMs) || 7 * 24 * 60 * 60 * 1000);
    this.persisted = new Map();
    this.saveTimer = null;
    this.loadState();
  }

  add(cred) {
    const key = fingerprintOf(cred);
    if (this.entries.some((e) => e.key === key)) return false;
    const entry = {
      key,
      // 落盘键：优先账号 id（稳定），没有就取 Authorization 指纹的哈希。
      stateKey: stateKeyOf({
        accountId: cred.accountId || '',
        userId: cred.userId || '',
        baseUrl: cred.baseUrl || '',
        key,
      }),
      baseUrl: cred.baseUrl,
      headers: cred.headers,
      source: cred.source || '',
      userId: cred.userId || '',
      accountId: cred.accountId || '',
      provider: cred.provider || 'OpenAI',
      models: new Set(cred.models || []),
      stats: { ok: 0, fail: 0, rateLimited: 0, lastUsedAt: 0, lastError: '' },
      /** 当前正在跑的对话请求数（探测 / embeds 不计数）。 */
      inFlight: 0,
      /** 首包延迟的指数移动平均（ms），0 = 还没样本。 */
      ewmaTtfbMs: 0,
      ttfbSamples: 0,
      /** 每个模型自己的首包 EWMA：同一个号跑快模型和慢模型的分数不该互相污染。 */
      ttfbByModel: new Map(),
      cooldownUntil: 0,
      modelCooldown: new Map(),
      /** 连续账号健康失败次数（触发熔断后归零，成功清零）。 */
      consecutiveFails: 0,
      /** 当前熔断等级：0 = 未熔断；每触发一次 +1，成功清零。 */
      breakerLevel: 0,
      /** 连续 429 次数：用来做软限流的指数退避，成功清零。 */
      softRateStreak: 0,
      /**
       * 这条凭据被上游明确拒绝过的模型名（81004 / 81009）。
       *
       * 和 `modelCooldown` 分开存：冷却会随时间流逝自动失效，
       * 但「这个号没有这个模型」是**事实**，不会因为过了 60 秒就变成有。
       * 用来判断「池里是不是每个号都拒绝过这个模型」→ 直接回一个干净的错，
       * 而不是把 3 次重试配额全花在一个必然失败的组合上。
       */
      rejectedModels: new Set(),
    };
    this.restoreEntry(entry);
    this.entries.push(entry);
    log.info('凭据已加入池', { baseUrl: cred.baseUrl, source: cred.source });
    return true;
  }

  /**
   * 从 data/pool-state.json 恢复运行态。
   *
   * 只恢复「仍然有效」的东西：过期冷却、过期会话在这里就丢掉；
   * 状态文件损坏 / 过期时按空处理，宁可冷启动也不要把服务带崩。
   */
  loadState() {
    if (!this.stateFile) return 0;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch (err) {
      if (err?.code !== 'ENOENT') log.warn('号池状态读取失败，按空状态启动', { error: String(err?.message || err) });
      return 0;
    }
    if (!doc || typeof doc !== 'object') return 0;
    const savedAt = Date.parse(doc.savedAt || '');
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > this.stateMaxAgeMs) {
      log.warn('号池状态已过期，按空状态启动', { savedAt: doc.savedAt || '', maxAgeMs: this.stateMaxAgeMs });
      return 0;
    }
    const now = Date.now();
    const entries = doc.entries && typeof doc.entries === 'object' ? doc.entries : {};
    for (const [key, rec] of Object.entries(entries)) {
      if (!key || !rec || typeof rec !== 'object') continue;
      this.persisted.set(key, rec);
    }
    const sessions = doc.sessions && typeof doc.sessions === 'object' ? doc.sessions : {};
    for (const [hash, hit] of Object.entries(sessions)) {
      if (!hash || !hit || typeof hit !== 'object') continue;
      if (Number(hit.expiresAt) > now && hit.stateKey) {
        this.sessions.set(hash, { stateKey: String(hit.stateKey), expiresAt: Number(hit.expiresAt) });
      }
    }
    this.pruneSessions(now, true);
    if (this.persisted.size || this.sessions.size) {
      log.info('号池状态已恢复', { entries: this.persisted.size, sessions: this.sessions.size });
    }
    return this.persisted.size;
  }

  /** 把一条已存在的 entry 和落盘记录合并；不覆盖模型列表等运行期事实。 */
  restoreEntry(entry) {
    const rec = this.persisted.get(entry.stateKey);
    if (!rec || typeof rec !== 'object') return;
    const now = Date.now();
    const cooldownUntil = Number(rec.cooldownUntil) || 0;
    if (cooldownUntil > now) entry.cooldownUntil = cooldownUntil;
    entry.consecutiveFails = Math.max(0, Number(rec.consecutiveFails) || 0);
    entry.softRateStreak = Math.max(0, Number(rec.softRateStreak) || 0);
    // 熔断等级只在冷却仍有效时保留；过期后下一次失败从 base 重新开始。
    entry.breakerLevel = cooldownUntil > now ? Math.max(0, Number(rec.breakerLevel) || 0) : 0;
    if (rec.modelCooldown && typeof rec.modelCooldown === 'object') {
      for (const [model, until] of Object.entries(rec.modelCooldown)) {
        const t = Number(until) || 0;
        if (model && t > now) entry.modelCooldown.set(model, t);
      }
    }
    if (Array.isArray(rec.rejectedModels)) {
      for (const model of rec.rejectedModels) {
        if (typeof model === 'string' && model) entry.rejectedModels.add(model);
      }
    }
    if (rec.stats && typeof rec.stats === 'object') {
      entry.stats.ok = Math.max(0, Number(rec.stats.ok) || 0);
      entry.stats.fail = Math.max(0, Number(rec.stats.fail) || 0);
      entry.stats.rateLimited = Math.max(0, Number(rec.stats.rateLimited) || 0);
      entry.stats.lastUsedAt = Math.max(0, Number(rec.stats.lastUsedAt) || 0);
      entry.stats.lastError = String(rec.stats.lastError || '').slice(0, 300);
    }
  }

  /** 写一份状态快照；返回是否成功。失败只记日志，绝不阻塞请求。 */
  saveState() {
    if (!this.stateFile) return false;
    const now = Date.now();
    const doc = {
      version: 1,
      savedAt: new Date(now).toISOString(),
      entries: Object.create(null),
      sessions: Object.create(null),
    };
    for (const e of this.entries) {
      const modelCooldown = Object.create(null);
      for (const [model, until] of e.modelCooldown) {
        if (model && Number(until) > now) modelCooldown[model] = Number(until);
      }
      doc.entries[e.stateKey] = {
        cooldownUntil: e.cooldownUntil > now ? e.cooldownUntil : 0,
        modelCooldown,
        rejectedModels: [...e.rejectedModels],
        consecutiveFails: e.consecutiveFails || 0,
        breakerLevel: e.breakerLevel || 0,
        softRateStreak: e.softRateStreak || 0,
        stats: { ...e.stats },
      };
    }
    for (const [hash, hit] of this.sessions) {
      if (hit && hit.stateKey && Number(hit.expiresAt) > now) {
        doc.sessions[hash] = { stateKey: hit.stateKey, expiresAt: Number(hit.expiresAt) };
      }
    }
    try {
      writeFileAtomic(this.stateFile, JSON.stringify(doc), { mode: 0o600 });
      return true;
    } catch (err) {
      log.warn('号池状态落盘失败', { error: String(err?.message || err) });
      return false;
    }
  }

  /** 合并短时间内的多次变更，避免每个请求都 fsync 一次。 */
  queueSave() {
    if (!this.stateFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveState();
    }, 750);
    this.saveTimer.unref?.();
  }

  /** 退出前同步落盘（watchdog 强杀时也能留下最后一次快照）。 */
  flushState() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    return this.saveState();
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
   * 清空所有「这个模型不行」的标记。
   *
   * 模型目录**改了**（面板上增删别名、上游目录刷新）之后必须调一次，因为
   * 那些标记是**相对旧目录**学到的，留在新目录上会以两种方式说谎：
   *
   *   ① 某个模型名其实已经从目录里去掉了 → 标记成了没人管的垃圾；
   *   ② 某个名字被**重新定义**了（典型：同一个别名先指向 A、后来改指 B）
   *      → 旧标记会把新指向也一起判死。实测踩过：`gpt-4o` 先指 `glm-5.3-zx`
   *      （打不通），改指 `glm-5.2` 之后 `gpt-4o` 照样从 `/v1/models` 里消失，
   *      而它本来是好的。
   *
   * 「这个模型不行」是**结论**，不是事实 —— 结论的前提变了就得作废。
   * 清掉之后最多让客户端多试一次，试错一次会拿到准确的 400，代价可以接受。
   */
  clearModelRejections(onClear) {
    let cleared = 0;
    for (const e of this.entries) {
      cleared += e.rejectedModels?.size || 0;
      e.rejectedModels?.clear();
    }
    if (cleared) this.queueSave();
    if (cleared && typeof onClear === 'function') onClear(cleared);
    return cleared;
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
  setCooldowns({ cooldownOnRateLimitMs, cooldownOnRateLimitMaxMs, cooldownOnAuthErrorMs, perModelCooldown, credentialPerModelCooldown } = {}) {
    if (Number.isFinite(Number(cooldownOnRateLimitMs))) this.rateLimitCooldownMs = Number(cooldownOnRateLimitMs);
    if (Number.isFinite(Number(cooldownOnRateLimitMaxMs))) {
      this.rateLimitCooldownMaxMs = Math.max(this.rateLimitCooldownMs, Number(cooldownOnRateLimitMaxMs));
    }

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
      rateLimitMaxMs: this.rateLimitCooldownMaxMs,
      authMs: this.authCooldownMs,
      perModel: this.perModelCooldown,
    });
  }

  /** 面板/配置热更新：连续失败熔断参数。 */
  setBreakerPolicy({ breakerThreshold, breakerCooldownMs, breakerMaxMs } = {}) {
    if (Number.isFinite(Number(breakerThreshold))) this.breakerThreshold = Math.max(1, Number(breakerThreshold));
    if (Number.isFinite(Number(breakerCooldownMs))) {
      this.breakerCooldownMs = Math.max(1000, Number(breakerCooldownMs));
    }
    if (Number.isFinite(Number(breakerMaxMs))) {
      this.breakerMaxMs = Math.max(this.breakerCooldownMs, Number(breakerMaxMs));
    }
    log.info('熔断策略已更新', {
      threshold: this.breakerThreshold,
      cooldownMs: this.breakerCooldownMs,
      maxMs: this.breakerMaxMs,
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
      e.consecutiveFails = 0;
      e.breakerLevel = 0;
      e.softRateStreak = 0;
    }
    this.queueSave();
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
      inFlight: e.inFlight,
      ewmaTtfbMs: Math.round(e.ewmaTtfbMs || 0),
      ttfbSamples: e.ttfbSamples || 0,
      modelTtfb: Object.fromEntries(
        [...e.ttfbByModel.entries()].map(([name, rec]) => [
          name,
          { ms: Math.round(rec.ewma || 0), samples: rec.samples || 0 },
        ]),
      ),
      cooldownMsLeft: Math.max(0, e.cooldownUntil - now),
      consecutiveFails: e.consecutiveFails || 0,
      breakerLevel: e.breakerLevel || 0,
      breakerMsLeft: e.breakerLevel > 0 ? Math.max(0, e.cooldownUntil - now) : 0,
      softRateStreak: e.softRateStreak || 0,
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

  /** 清掉过期的会话绑定；只在表变大时做，避免每次 pick 都全表扫。 */
  pruneSessions(now = Date.now(), force = false) {
    if (!force && this.sessions.size < 512) return 0;
    let removed = 0;
    for (const [key, hit] of this.sessions) {
      if (!hit || hit.expiresAt <= now) {
        this.sessions.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * 选一条可用凭据。
   * 优先级：① 没冷却且积分够 ② 没冷却但积分见底 ③ 冷却中（挑最快解冻的）
   * 读不到额度时视为「够用」，绝不因为查不到余额就把用户的请求拦下来。
   *
   * 在同一档里不再纯轮询，而是按「首包延迟 + 在途数」打分：
   *   score = 该号 EWMA 首包 + latencyWeightMs × 在途数
   * 这样慢号自然少接活，快号多接；没有样本的新号用当前平均值兜底，
   * 不会因为「0 样本」被误判成最快。
   *
   * `sessionKey` 是会话黏性：同一个会话在 TTL 内优先回同一个号，命中上游
   * prefix cache（几万 token 的上下文，换号等于每轮重新 prefill）。
   * `trackInFlight` 只给对话请求用；探测/embeddings 不占在途配额。
   * `requireCapacity` 给 acquire 用：所有号都满时返回 null，让调用方等一等，
   * 而不是按软上限继续往上叠。
   */
  pick(model, { sessionKey = '', trackInFlight = false, requireCapacity = false } = {}) {
    if (this.entries.length === 0) return null;
    const now = Date.now();
    this.pruneSessions(now);
    // 内存和落盘都只持有会话 key 的哈希，不保存原始会话 ID / 首条消息哈希。
    const sessionHash = sessionKey ? hashSessionKey(sessionKey) : '';
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

    let affinityHit = false;
    let affinityMiss = false;
    const choose = (list) => {
      if (!list.length) return null;
      // 会话绑定的号还在这档里，且没超过在途上限 → 直接续用。
      if (sessionHash && this.sessionTtlMs > 0) {
        const hit = this.sessions.get(sessionHash);
        if (hit && hit.expiresAt > now) {
          const bound = this.entries.find((e) => e.stateKey === hit.stateKey);
          if (bound && list.includes(bound) && bound.inFlight < this.maxInFlightPerCredential) {
            if (!affinityHit) {
              this.metrics.affinityHits += 1;
              affinityHit = true;
            }
            return bound;
          }
          // 号被删了 / 冷却了 / 太忙了 → 解除绑定，重新选。
          if (!bound || !list.includes(bound)) this.sessions.delete(sessionHash);
        } else if (hit) {
          this.sessions.delete(sessionHash);
        }
        if (!affinityMiss) {
          this.metrics.affinityMisses += 1;
          affinityMiss = true;
        }
      }
      // 软上限：优先选没满的；全满了就退化成「最闲的」，不直接拒绝请求。
      const under = list.filter((e) => e.inFlight < this.maxInFlightPerCredential);
      // acquire 的等待模式：这一档全满就返回 null，由调用方等释放。
      if (requireCapacity && under.length === 0) return null;
      const candidates = under.length ? under : list;
      let sum = 0;
      let n = 0;
      for (const e of candidates) {
        const rec = model ? e.ttfbByModel.get(model) : null;
        const value = rec?.ewma > 0 ? rec.ewma : e.ewmaTtfbMs;
        if (value > 0) { sum += value; n += 1; }
      }
      const neutral = n ? sum / n : 0;
      let best = null;
      let bestScore = Infinity;
      for (const idx of order) {
        const e = this.entries[idx];
        if (!candidates.includes(e)) continue;
        const rec = model ? e.ttfbByModel.get(model) : null;
        const latency = rec?.ewma > 0 ? rec.ewma : e.ewmaTtfbMs > 0 ? e.ewmaTtfbMs : neutral;
        const score = latency + this.latencyWeightMs * e.inFlight;
        // 严格小于：同分时保留 order 里靠前的，等价于轮询的公平性。
        if (score < bestScore - 1e-9) { best = e; bestScore = score; }
      }
      return best || candidates[0];
    };

    let chosen = choose(usable);
    // 等待模式：有可用号但都满 → 让 acquire 等释放，别去碰见底/冷却的号。
    if (!chosen && requireCapacity && usable.length > 0) return null;
    // 全都见底了也得返回一个 —— 总比直接 503 强，而且余额可能是刚过期、实际还能用
    if (!chosen) chosen = choose(broke);
    if (!chosen) {
      throttled.sort((a, b) => a.until - b.until);
      chosen = throttled[0] ? throttled[0].e : null;
    }
    if (!chosen) return null;

    if (trackInFlight) chosen.inFlight += 1;
    if (sessionHash && this.sessionTtlMs > 0) {
      this.sessions.set(sessionHash, { stateKey: chosen.stateKey, expiresAt: now + this.sessionTtlMs });
      this.queueSave();
    }
    return chosen;
  }

  /**
   * 对话请求的入口：正常时等价于 pick；所有号都在途满时最多等
   * `queueTimeoutMs`，等到有人释放再选。超时后退回软上限（宁可多排一点，
   * 也不把请求直接 503 掉）。探测/embeddings 仍用同步的 pick。
   */
  async acquire(model, opts = {}) {
    if (!this.queueTimeoutMs) return this.pick(model, opts);
    const deadline = Date.now() + this.queueTimeoutMs;
    let waited = false;
    for (;;) {
      const entry = this.pick(model, { ...opts, requireCapacity: true });
      if (entry) {
        if (waited) this.metrics.queueAdmitted += 1;
        return entry;
      }
      if (!this.entries.length || Date.now() >= deadline) {
        if (waited) this.metrics.queueTimeouts += 1;
        return this.pick(model, opts);
      }
      if (!waited) {
        this.metrics.queueWaits += 1;
        waited = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** 调度质量快照（面板显示/测试用）。 */
  stats() {
    return {
      ...this.metrics,
      sessions: this.sessions.size,
      maxInFlightPerCredential: this.maxInFlightPerCredential,
      queueTimeoutMs: this.queueTimeoutMs,
      latencyWeightMs: this.latencyWeightMs,
      breakerThreshold: this.breakerThreshold,
      breakerCooldownMs: this.breakerCooldownMs,
      breakerMaxMs: this.breakerMaxMs,
      rateLimitMaxMs: this.rateLimitCooldownMaxMs,
    };
  }

  /**
   * 请求结束（成功 / 失败 / 客户端断开）都要还一次在途计数。
   * `ttfbMs` 只传真正测到的首包时间；失败/客户端秒断不要传，否则 EWMA 会失真。
   */
  release(entry, ttfbMs = 0, model = '') {
    if (!entry) return;
    if (entry.inFlight > 0) entry.inFlight -= 1;
    const ms = Number(ttfbMs);
    if (!Number.isFinite(ms) || ms <= 0) return;

    const update = (current, samples) => ({
      ewma: samples > 0 ? Math.round(current * 0.7 + ms * 0.3) : Math.round(ms),
      samples: samples + 1,
    });

    const all = update(entry.ewmaTtfbMs, entry.ttfbSamples);
    entry.ewmaTtfbMs = all.ewma;
    entry.ttfbSamples = all.samples;

    if (model) {
      const prev = entry.ttfbByModel.get(model) || { ewma: 0, samples: 0 };
      entry.ttfbByModel.set(model, update(prev.ewma, prev.samples));
    }
    this.queueSave();
  }

  markOk(entry, model) {
    entry.stats.ok += 1;
    entry.stats.lastUsedAt = Date.now();
    entry.stats.lastError = '';
    // 一次成功就证明「这条路现在是通的」：连败、熔断、软限流退避全部清零。
    entry.consecutiveFails = 0;
    entry.breakerLevel = 0;
    entry.softRateStreak = 0;
    entry.cooldownUntil = 0;
    if (model) entry.modelCooldown.delete(model);
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
    this.queueSave();
  }

  markRateLimited(entry, model, message, retryAfterMs = 0) {
    entry.stats.fail += 1;
    entry.stats.rateLimited += 1;
    entry.stats.lastError = message || 'rate limited';
    entry.softRateStreak = Math.min(20, (entry.softRateStreak || 0) + 1);
    const base = Math.max(this.rateLimitCooldownMs, Number(retryAfterMs) || 0);
    // 连续 429 指数退避：20s → 40s → 80s …；Retry-After 是下限，不是上限。
    const backoff = this.rateLimitCooldownMs * 2 ** Math.min(10, entry.softRateStreak - 1);
    const waitMs = Math.min(this.rateLimitCooldownMaxMs, Math.max(base, backoff));
    const until = Date.now() + waitMs;
    if (this.perModelCooldown && model) entry.modelCooldown.set(model, until);
    else entry.cooldownUntil = Math.max(entry.cooldownUntil, until);
    this.queueSave();
    log.warn('凭据限流冷却', {
      baseUrl: entry.baseUrl,
      model,
      ms: waitMs,
      streak: entry.softRateStreak,
      retryAfterMs: Number(retryAfterMs) || 0,
    });
  }

  markAuthFailed(entry, message) {
    entry.stats.fail += 1;
    entry.stats.lastError = message || 'auth failed';
    entry.cooldownUntil = Date.now() + this.authCooldownMs;
    this.queueSave();
    log.warn('凭据鉴权失败冷却', { baseUrl: entry.baseUrl, ms: this.authCooldownMs, message });
  }

  markFailed(entry, message) {
    entry.stats.fail += 1;
    entry.stats.lastError = message || 'failed';
    entry.consecutiveFails = (entry.consecutiveFails || 0) + 1;
    if (entry.consecutiveFails < this.breakerThreshold) {
      this.queueSave();
      return;
    }
    // 熔断等级递增 → 冷却时间指数增长；触发一次后把本次连败清零，
    // 冷却结束后的第一次失败会重新累计，不会因为旧计数立刻二连跳。
    const level = Math.min(6, (entry.breakerLevel || 0) + 1);
    const waitMs = Math.min(this.breakerMaxMs, this.breakerCooldownMs * 2 ** (level - 1));
    entry.breakerLevel = level;
    entry.consecutiveFails = 0;
    entry.cooldownUntil = Math.max(entry.cooldownUntil, Date.now() + waitMs);
    // 熔断是“下一次启动必须知道”的状态，直接同步落盘；普通失败仍走防抖。
    this.saveState();
    log.warn('凭据连续失败熔断', {
      baseUrl: entry.baseUrl,
      ms: waitMs,
      level,
      threshold: this.breakerThreshold,
      message: String(message || '').slice(0, 200),
    });
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
    this.queueSave();
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
    const removedEntries = this.entries.filter((e) => e.key === k);
    this.entries = this.entries.filter((e) => e.key !== k);
    const removed = before !== this.entries.length;
    if (removed) {
      for (const e of removedEntries) this.persisted.delete(e.stateKey);
      log.info('点名剔除凭据', { baseUrl: String(k).split('||')[0] });
      this.pruneCredits();
      this.queueSave();
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
    const removedEntries = this.entries.filter((e) => e.source !== 'config.json' && !validKeys.has(e.key));
    this.entries = this.entries.filter((e) => e.source === 'config.json' || validKeys.has(e.key));
    const removed = before - this.entries.length;
    if (removed > 0) {
      for (const e of removedEntries) this.persisted.delete(e.stateKey);
      log.info('剔除失效凭据', { removed });
      this.pruneCredits();
      this.queueSave();
    }
    return removed;
  }
}

/**
 * 落盘身份键：优先用稳定的账号 id，其次 userId；都没有时才对完整指纹
 * （含 Authorization）做哈希。状态文件里绝不出现原始 token。
 */
function stateKeyOf({ accountId, userId, baseUrl, key }) {
  const stable = String(accountId || userId || '').trim();
  if (stable) return `acct:${stable}@${String(baseUrl || '').trim()}`;
  return `cred:${createHash('sha256').update(String(key || '')).digest('hex').slice(0, 24)}`;
}

/** 会话 key 可能包含用户会话 ID / 首条消息摘要；内存和落盘都只留哈希。 */
function hashSessionKey(sessionKey) {
  return createHash('sha256').update(String(sessionKey)).digest('hex').slice(0, 32);
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
