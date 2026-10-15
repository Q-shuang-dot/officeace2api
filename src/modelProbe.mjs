/**
 * 模型可用性探测：把"目录里列着、实际打不通"的模型找出来。
 *
 * 为什么需要它：
 *   上游网关的目录（`/v2/models`）会列出 28~34 个模型，但**实测两个号只有 11 个
 *   真的能打通**，其余回 `81004`（没权限）/ `81009`（名字不认）。
 *   以前这些模型照原样列在 `/v1/models` 里，客户端看到一个试一个、试一个错一个。
 *
 *   学习式的（"谁被打过就记下来"）不管用：开机时那个清单是空的，
 *   而客户端恰恰是在开机后第一次打开下拉框时才看列表。所以必须**主动探一遍**。
 *
 * 为什么用 `max_tokens: 1`：
 *   探测只要"上游认不认这个模型"这一个 bit，不需要它真回答。
 *   `max_tokens: 1` 会被 `TINY_MAX_TOKENS` 原样透传，上游花 1 个 token 就回
 *   `finish_reason: length`（正文为空，那是它应有的样子）—— 成本几乎为零。
 *   实测用这个值分辨 11 个能用的 / 11 个不能用的，**22/22 全对**。
 *
 *   代价是慢的那些模型要等它把推理跑完（`glm-5.1` / `glm-5.2` 各 10~14 秒），
 *   所以探测并发跑，并且结果落盘 —— 开机先读盘，盘上没有才全量探。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 小时
const DEFAULT_CONCURRENCY = 4;

/** 探测用的请求体：只要一个 bit，成本最低 */
const PROBE_BODY = (model) => ({
  model,
  max_tokens: 1,
  messages: [{ role: 'user', content: 'x' }],
});

export class ModelProbe {
  /**
   * @param {object} opts
   * @param {string} opts.dataFile   缓存文件路径（相对 process.cwd()）
   * @param {object} opts.config     `config.models` 那一段
   * @param {object} opts.pool       凭据池（用来挑一条凭据发请求）
   * @param {object} opts.registry   模型目录（拿要探的模型名）
   * @param {object} opts.log        日志器
   * @param {object} opts.usage      用量记录器（可选，探测量也记账）
   * @param {function} opts.fetchImpl 注入用（测试）
   */
  constructor({ dataFile = 'data/model-probe.json', config = {}, pool, registry, log, usage, fetchImpl } = {}) {
    this.file = dataFile;
    this.config = config;
    this.pool = pool;
    this.registry = registry;
    this.log = log || { info() {}, warn() {} };
    this.usage = usage || null;
    this.fetchImpl = fetchImpl || globalThis.fetch;

    /** @type {Set<string>} 探出来打不通的模型名 */
    this.unavailable = new Set();
    /** @type {Map<string, {ok:boolean,status:number,code:string,at:number}>} 每个模型最近一次探测结果 */
    this.results = new Map();
    this.lastProbeAt = 0;
    this.probing = false;
    /** 探测时的凭据 ID —— 号池变了（加号/删号）就得重探 */
    this.probedWithCredentials = '';
    this.load();
  }

  /* ---------------------------------------------------------------- 落盘 */

  load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw?.unavailable)) this.unavailable = new Set(raw.unavailable);
      if (raw?.results && typeof raw.results === 'object') {
        for (const [k, v] of Object.entries(raw.results)) this.results.set(k, v);
      }
      this.lastProbeAt = Number(raw?.lastProbeAt) || 0;
      this.probedWithCredentials = String(raw?.probedWithCredentials || '');
      if (this.unavailable.size) {
        this.log.info('已从磁盘读回模型可用性探测结果', {
          unavailable: this.unavailable.size,
          at: this.lastProbeAt ? new Date(this.lastProbeAt).toISOString() : null,
        });
      }
    } catch {
      /* 第一次跑，没有缓存文件是正常的 */
    }
  }

  save() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(
        this.file,
        JSON.stringify(
          {
            lastProbeAt: this.lastProbeAt,
            probedWithCredentials: this.probedWithCredentials,
            unavailable: [...this.unavailable],
            results: Object.fromEntries(this.results),
          },
          null,
          2,
        ),
      );
    } catch (err) {
      this.log.warn('模型可用性探测结果写盘失败', { error: String(err?.message || err) });
    }
  }

  /**
   * 丢掉"已不在目录里"的旧结论。
   *
   * 探测结论是**跨重启存活**的（写在 data/model-probe.json 里），所以目录里
   * 删掉一个模型、或者用户改过别名之后，旧结论会变成没人管的垃圾 —— 更糟的是
   * 如果那个名字以后**被重新用上**（别名先指 A 后指 B 就是这种情况），
   * 旧结论会一上来就把新名字判死。
   *
   * @param {string[]} liveIds 当前目录里真实存在的模型名
   * @returns {number} 清掉了几条
   */
  prune(liveIds) {
    const live = new Set(liveIds || []);
    if (!live.size) return 0;
    let removed = 0;
    for (const m of [...this.unavailable]) {
      if (!live.has(m)) {
        this.unavailable.delete(m);
        this.results.delete(m);
        removed += 1;
      }
    }
    if (removed) {
      this.save();
      this.log.info('模型可用性结论里有名字已经不在目录里了，已丢掉', { removed });
    }
    return removed;
  }

  /* ---------------------------------------------------------------- 查询 */

  /** 这个模型现在是不是"打不通"。探测没覆盖到的模型一律算可用（不能凭空藏东西）。 */
  isUnavailable(model) {
    return this.unavailable.has(model);
  }

  /** 池子在学习过程中又发现打不通的模型，也并进来 */
  noteLearned(models) {
    let added = 0;
    for (const m of models || []) {
      if (!this.unavailable.has(m)) {
        this.unavailable.add(m);
        added += 1;
      }
    }
    if (added) this.save();
    return added;
  }

  /** 「某条凭据其实能用这个模型」时撤销黑名单 —— 权限是活的，不能永久拉黑 */
  clear(model) {
    if (this.unavailable.delete(model)) {
      this.save();
      return true;
    }
    return false;
  }

  stats() {
    return {
      unavailable: [...this.unavailable],
      lastProbeAt: this.lastProbeAt,
      probing: this.probing,
      probed: this.results.size,
    };
  }

  /* ---------------------------------------------------------------- 探测 */

  /**
   * 探一遍。
   *
   * @param {object} [opts]
   * @param {boolean} [opts.force]    忽略 TTL 和「号池没变」两个跳过条件
   * @param {string[]} [opts.models]  只探这些（默认探 registry 里的全部）
   * @returns {Promise<{probed:number, unavailable:string[], skipped:boolean}>}
   */
  async probe({ force = false, models = null } = {}) {
    if (this.probing) return { probed: 0, unavailable: [...this.unavailable], skipped: true, reason: '已在探测中' };

    const list = models || this.registry?.toOpenAiList?.().map((m) => m.id) || [];
    if (!list.length) return { probed: 0, unavailable: [...this.unavailable], skipped: true, reason: '模型目录是空的' };

    /**
     * 别名（`gpt-4o` → `glm-5.2`）**不参与探测**。
     *
     * 别名是用户随手写的一句映射，它本身不是一个上游模型 —— 探测它没有任何意义：
     *   - 探测直接发 `POST /chat/completions`，上游**不认识别名**，一律 81009；
     *   - 于是别名会被记进"打不通"名单，而这份名单是从 `data/model-probe.json`
     *     读回来、**跨重启存活**的；
     *   - 结果就是用户下次再起同一个别名时，它一上来就是"打不通"，
     *     哪怕指向的是个好模型。
     *
     * 真踩过：测试里临时写过 `gpt-4o` / `claude-sonnet-4` 两个别名，探测正好
     * 撞上，把这两个名字永久写进了黑名单；之后不改 `data/model-probe.json`
     * 就再也见不到它们。
     */
    const aliasNames = new Set(Object.keys(this.registry?.alias || {}));
    let targets = list.filter((m) => !aliasNames.has(m));
    if (!targets.length) {
      return { probed: 0, unavailable: [...this.unavailable], skipped: true, reason: '目录里全是别名，没有真要探的模型' };
    }

    const ttl = Number(this.config.probeTtlMs) || DEFAULT_TTL_MS;
    const creds = (this.pool?.list?.() || []).map((e) => String(e.userId ?? e.index ?? '')).join(',');
    // 池子是空的就别探（探不了），而且**不能把结论清空** ——
    // 清了会让好模型被当成"没探过"从而全部列出来，等于白探一场。
    if (!creds) return { probed: 0, unavailable: [...this.unavailable], skipped: true, reason: '凭据池是空的，等有号了再探' };
    // 只复核一部分时为 true：日志和返回值跟着区分
    let partial = false;
    if (!force) {
      // TTL 是"多久允许打上游一次"的额度，所以它对**任何**重探都生效。
      // 号池变了也只是"TTL 过了之后值得再探一次"的理由，不是绕过 TTL 的理由 ——
      // 否则用户加号/删号几次就能把 34 次上游请求反复打出去。
      if (this.lastProbeAt && Date.now() - this.lastProbeAt < ttl) {
        return { probed: 0, unavailable: [...this.unavailable], skipped: true, reason: '还没到下次探测时间' };
      }
      if (this.lastProbeAt && this.probedWithCredentials && creds === this.probedWithCredentials) {
        // 号池没变：判为**可用**的那批不必重探（它们很贵 —— 实测 glm-5.2 一次 15.7 秒，
        // 是在真花积分做一次推理），判为**不可用**的那批必须复核：
        // 上游给这个账号开权限、模型改名、上游临时故障恢复，都不会改我们的号池，
        // 可它们恰恰会把一个模型从"不可用"变成能用。而这类复核几乎不花钱 ——
        // 不可用的模型是在上游门口被拒的（实测 86~332ms）。
        //
        // 以前这里整批跳过，于是 lastProbeAt 不前进、这个分支**永远**成立：
        // 一个被误判、或者上游后来开了权限的模型会一直留在 unavailable 里，
        // 又因为 hideUnavailable 默认开着，它会直接从 /v1/models 消失，
        // 只认手动点「重探一遍」这一条出路。
        const again = targets.filter((m) => this.unavailable.has(m));
        if (!again.length) {
          return { probed: 0, unavailable: [...this.unavailable], skipped: true, reason: '号池没变，也没有待复核的模型' };
        }
        targets = again;
        partial = true;
      }
    }

    this.probing = true;
    const startedAt = Date.now();
    const found = [];
    const concurrency = Math.max(1, Number(this.config.probeConcurrency) || DEFAULT_CONCURRENCY);
    let cursor = 0;

    const worker = async () => {
      for (;;) {
        const i = cursor;
        cursor += 1;
        if (i >= targets.length) return;
        const model = targets[i];
        /**
         * 探测要拿**目标模型**去问上游，不能拿别名自己。
         *
         * `gpt-4o → glm-5.2` 这种：上游网关只认 `glm-5.2`，把 `gpt-4o` 打上去
         * 必然回「名字不认识」，于是别名被打成"打不通"、又被 hideUnavailable
         * 从 /v1/models 里删掉 —— 用户配别名就是为了让客户端能叫这个名字，
         * 结果一配就消失（实测踩过：配了 2 个别名，重探一次全没了）。
         *
         * 顺带：号池里根本没有别名这个键，`pick(别名)` 会返回空，
         * 而下面那个 `if (!cred) return` 会**直接结束整个 worker**，
         * 等于一个别名能让一个并发位提前收工。所以两处都得用 target。
         */
        const target = this.registry?.resolve?.(model) || model;
        const cred = this.pool?.pick(target);
        if (!cred) {
          // 池子是空的：探测没法进行，保留旧结论
          return;
        }
        const t0 = Date.now();
        let row;
        try {
          const res = await this.fetchImpl(`${String(cred.baseUrl).replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...cred.headers },
            body: JSON.stringify(PROBE_BODY(target)),
            signal: AbortSignal.timeout(60000),
          });
          let code = '';
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            code = text.match(/"code"\s*:\s*"([^"]+)"/)?.[1] || `HTTP_${res.status}`;
          } else {
            // 200 也要读掉 body，否则连接不释放
            await res.text().catch(() => '');
          }
          row = { ok: res.ok, status: res.status, code, at: Date.now(), ms: Date.now() - t0 };
        } catch (err) {
          row = { ok: false, status: 0, code: `FETCH_${String(err?.name || 'ERROR')}`, at: Date.now(), ms: Date.now() - t0 };
        }
        this.results.set(model, row);
        if (!row.ok) {
          found.push(model);
          // 探测本身也算一次请求，但不该把一个好号判成坏号 —— 只要不是鉴权类的错误，
          // 就把它标成功（否则探 30 个模型会把号打到限流冷却里）
          if (!/APIG\.100|401|403/.test(row.code)) this.pool?.markOk?.(cred, target);
        } else {
          this.pool?.markOk?.(cred, target);
        }
        this.usage?.record?.({
          model,
          usage: null,
          ok: row.ok,
          stream: false,
          endpoint: '/admin/api/models/probe',
          credential: cred.baseUrl,
          latencyMs: row.ms,
          error: row.ok ? '' : row.code,
        });
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
    } finally {
      this.probing = false;
    }

    this.unavailable = new Set(found);
    this.lastProbeAt = Date.now();
    this.probedWithCredentials = creds;
    // 顺手丢掉"名字已经不在目录里"的旧结论（别名改过就会留下这种垃圾）
    this.prune(list);
    this.save();

    this.log.info(partial ? '复核打不通的模型' : '模型可用性探测完成', {
      probed: targets.length,
      usable: targets.length - found.length,
      unavailable: found.length,
      seconds: Math.round((Date.now() - startedAt) / 1000),
    });
    if (partial) {
      const recovered = targets.filter((m) => !found.includes(m));
      // 这条日志值得留着：模型"自己回来"了是件需要解释的事，不然用户只会觉得列表在变
      if (recovered.length) this.log.info('上游后来开通了这些模型，已放回 /v1/models', { models: recovered });
    } else if (found.length) {
      this.log.info('这些模型打不通，已从 /v1/models 里去掉', { models: found });
    }

    return { probed: targets.length, unavailable: found, skipped: false, partial };
  }
}
