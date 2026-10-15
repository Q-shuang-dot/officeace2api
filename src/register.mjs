/**
 * 批量注册 / 开通
 *
 * 说明白这条链路的真实边界：
 *
 *   华为云注册（reg.huaweicloud.com/registerui/register.html）必须过「图形验证码 +
 *   短信验证码」，图形验证码是服务端下发的，没有稳定可复用的自动化通道。所以本模块
 *   把注册做成「队列 + 状态机 + 可插拔接码」，把能自动的全自动，剩下的人工只需两步：
 *   填一次图形验证码、点一次提交。
 *
 *   注册成功之后的环节全部自动：
 *     1. 检测新账号出现（扫号池）
 *     2. 触发一键授权（复用 AuthFlow，走本机 OfficeAce）
 *     3. 兑换邀请码开通免费额度（POST <本机API>/api/login/invitation）
 *
 *   短信验证码来源可插拔：
 *     manual —— 面板里手工填（最省事，一个号填一次）
 *     http   —— 接码平台，配置 URL 模板 + 响应里取码的 JSON 路径
 */

import { createLogger } from './logger.mjs';
import { request } from './http.mjs';
import { readJson, writeFileSecure } from './util.mjs';

const log = createLogger('register');

/** 终态任务最多留这么多条（在途任务永远留着），见 trimHistory() */
const HISTORY_LIMIT = 60;

/** 读盘时把值收敛成数字：**合法的 0 要留着**，只有缺失/不是数才用默认值 */
function num(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export const DEFAULT_REGISTER_URL = 'https://reg.huaweicloud.com/registerui/register.html';

/** 邀请码错误码 -> 中文（来自 huawei-oauth.js 的 PROMOTION_CODE_ERROR_MESSAGES） */
export const PROMOTION_ERRORS = {
  'AgentArts.00000104': '您的权限不足，请配置对应的权限',
  'AgentArts.11000008': '邀请码无效，请重新输入',
  'AgentArts.11000009': '邀请码不存在或者今日邀请码配额已用完',
  'common.01010003': '当前用户缺少 admin 权限，请联系主账号添加权限',
  'common.01010004': '请确认账号状态：是否已实名认证或非欠费状态',
  'AgentArts.11000006': '该账号已被封禁',
};

export const TASK_STATES = {
  pending: '待处理',
  opening: '已打开注册页',
  needcode: '等待短信验证码',
  submitted: '已提交，等待账号生效',
  awaiting_auth: '等待一键授权',
  activating: '正在兑换邀请码',
  done: '完成',
  failed: '失败',
  skipped: '已跳过',
};

export class RegisterQueue {
  /**
   * @param {{getConfig:()=>object,
   *          authFlow: import('./authflow.mjs').AuthFlow,
   *          accounts: import('./accounts.mjs').AccountStore,
   *          dataFile?: string,
   *          onDone?:(task:object)=>void}} opts
   */
  constructor({ getConfig, authFlow, accounts, onDone, dataFile } = {}) {
    this.getConfig = getConfig || (() => ({}));
    this.authFlow = authFlow;
    this.accounts = accounts;
    this.onDone = onDone || (() => {});
    this.dataFile = dataFile || ''; // 空 = 纯内存（自测里大量这么用）
    this.tasks = new Map();
    this.order = [];
    this.seq = 0;
    this.running = false;
    this.paused = false;
    this.load();
  }

  /* ------------------------------------------------- 落盘与恢复（重启不丢任务） */

  /**
   * 从 `data/register-tasks.json` 把任务读回来。
   *
   * ⚠️ 在途任务（还没走到 done/failed 的）**一律标成中断**，不假装还在跑。
   * 原因：这条链的后半段靠的是**本进程内的活状态** —— `authTaskId` 指向 AuthFlow
   * 内存里的那条授权任务、`submittedAt` 是在等刚才那次提交、短信码本身分钟级有效。
   * 进程一重启这些全都失效了，接着跑只会卡在 `awaiting_auth` 上反复问一条不存在
   * 的授权任务。所以恢复时如实写成「失败 + 中断在哪一步」，人看得到，也能点重试重来。
   *
   * 不落盘的两样（都只为了少存一份没用的敏感数据）：
   *   · `password` —— 全仓库没有任何地方读它（注册是人在浏览器里做的），存了纯白担风险
   *   · `smsCode`  —— 分钟级有效、重启后也用不上
   *
   * 文件里手机号是明文（否则重启后没法接着注册），所以走 writeFileSecure：
   * 原子写 + icacls 只留当前用户，和 data/accounts.json 一个待遇。
   */
  load() {
    if (!this.dataFile) return 0;
    const doc = readJson(this.dataFile);
    if (!doc || !Array.isArray(doc.tasks)) return 0;
    let restored = 0;
    let interrupted = 0;
    for (const raw of doc.tasks) {
      if (!raw || typeof raw !== 'object') continue;
      const id = String(raw.id || '');
      const phone = String(raw.phone || '');
      if (!id || !phone) continue;
      const task = {
        id,
        phone,
        label: String(raw.label || ''),
        promotionCode: String(raw.promotionCode || ''),
        status: String(raw.status || 'pending'),
        // ⚠️ 这里不能用 `Number(x) || Date.now()`：合法的 0 会被当成「缺失」。
        // 这个坑真的踩到了 —— 历史裁剪按 `finishedAt || updatedAt || createdAt` 排序，
        // 时间戳 0 被替换成「现在」之后，最老的那条任务反而排到了最前面、躲过了裁剪。
        createdAt: num(raw.createdAt, Date.now()),
        updatedAt: num(raw.updatedAt, Date.now()),
        submittedAt: num(raw.submittedAt),
        finishedAt: num(raw.finishedAt),
        attempts: num(raw.attempts),
        smsCode: '',
        authTaskId: String(raw.authTaskId || ''),
        accountId: String(raw.accountId || ''),
        error: String(raw.error || ''),
        events: Array.isArray(raw.events) ? raw.events.slice(-30) : [],
        registerUrl: String(raw.registerUrl || ''),
        activation: raw.activation || null,
      };
      if (!['done', 'failed', 'skipped'].includes(task.status)) {
        const was = TASK_STATES[task.status] || task.status;
        task.status = 'failed';
        task.finishedAt = Date.now();
        task.error = `服务重启，流程中断在「${was}」（可点「重试」重来）`;
        this._event(task, task.error);
        interrupted += 1;
      }
      this.tasks.set(task.id, task);
      this.order.push(task.id);
      restored += 1;
    }
    this.seq = Math.max(Number(doc.seq) || 0, 0);
    this.trimHistory();
    if (restored) {
      log.info('读回注册任务', { restored, interrupted });
    }
    return restored;
  }

  /**
   * 落盘。`dataFile` 为空时是纯内存模式，直接返回 false（自测大量走这条路）。
   * 写失败只 warn 不抛：任务队列是「顺带记一笔」，不该因为它写不进去就打断注册流程。
   */
  save() {
    if (!this.dataFile) return false;
    this.trimHistory();
    const doc = {
      seq: this.seq,
      savedAt: new Date().toISOString(),
      tasks: this.order
        .map((id) => this.tasks.get(id))
        .filter(Boolean)
        .map((t) => ({
          id: t.id,
          phone: t.phone,
          label: t.label,
          promotionCode: t.promotionCode,
          status: t.status,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          submittedAt: t.submittedAt || 0,
          finishedAt: t.finishedAt || 0,
          attempts: t.attempts,
          authTaskId: t.authTaskId,
          accountId: t.accountId,
          error: t.error,
          events: t.events.slice(-10),
          registerUrl: t.registerUrl || '',
          activation: t.activation || null,
        })),
    };
    try {
      writeFileSecure(this.dataFile, JSON.stringify(doc, null, 2));
      return true;
    } catch (err) {
      log.warn('注册任务落盘失败', { error: String(err.message || err) });
      return false;
    }
  }

  /**
   * 历史裁剪：在途任务永远留着，终态任务只留最近 HISTORY_LIMIT 条。
   * 不然「注册一批、清一批」跑上几个月，这个文件会慢慢长成一本流水账。
   */
  trimHistory() {
    const keep = new Set();
    const terminal = [];
    for (const id of this.order) {
      const t = this.tasks.get(id);
      if (!t) continue;
      if (['done', 'failed', 'skipped'].includes(t.status)) terminal.push(id);
      else keep.add(id);
    }
    const when = (id) => {
      const t = this.tasks.get(id);
      return t.finishedAt || t.updatedAt || t.createdAt || 0;
    };
    terminal.sort((a, b) => when(b) - when(a));
    for (const id of terminal.slice(0, HISTORY_LIMIT)) keep.add(id);
    const dropped = this.order.filter((id) => !keep.has(id));
    if (dropped.length) {
      for (const id of dropped) this.tasks.delete(id);
      this.order = this.order.filter((id) => keep.has(id));
    }
    return dropped.length;
  }

  cfg() {
    const c = this.getConfig() || {};
    return {
      registerUrl: c.registerUrl || DEFAULT_REGISTER_URL,
      concurrency: Math.max(1, Math.min(5, Number(c.concurrency) || 1)),
      sms: c.sms || { provider: 'manual' },
      activation: c.activation || { autoActivate: true, promotionCodes: [] },
      autoAuth: c.autoAuth !== false,
    };
  }

  /* ------------------------------------------------------------ 建任务 */

  /**
   * 批量入队
   * @param {{phones?: string[], items?: Array<{phone:string,label?:string,password?:string}>,
   *          promotionCode?: string, autoStart?: boolean}} input
   */
  enqueue(input = {}) {
    const list = [];
    if (Array.isArray(input.items)) list.push(...input.items);
    if (Array.isArray(input.phones)) {
      for (const raw of input.phones) {
        const phone = String(raw || '').trim();
        if (phone) list.push({ phone });
      }
    }

    const created = [];
    for (const item of list) {
      const phone = String(item.phone || '').trim();
      if (!phone) continue;
      if ([...this.tasks.values()].some((t) => t.phone === phone && t.status !== 'failed' && t.status !== 'done')) {
        continue; // 同号已有在途任务
      }
      const task = {
        id: `reg-${++this.seq}-${Date.now().toString(36)}`,
        phone,
        label: String(item.label || '').trim(),
        password: String(item.password || '').trim(),
        promotionCode: String(item.promotionCode || input.promotionCode || '').trim(),
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attempts: 0,
        smsCode: '',
        authTaskId: '',
        accountId: '',
        error: '',
        events: [],
      };
      this._event(task, '已加入注册队列');
      this.tasks.set(task.id, task);
      this.order.push(task.id);
      created.push(task);
    }

    log.info('注册任务入队', { created: created.length, total: this.tasks.size });
    this.save();
    if (input.autoStart !== false && created.length) this.kick();
    return created.map((t) => this.view(t));
  }

  /* ---------------------------------------------------------- 状态推进 */

  /** 取一条待处理任务并推进它 */
  async step() {
    const task = [...this.tasks.values()]
      .filter((t) => ['pending', 'opening', 'needcode', 'submitted', 'awaiting_auth', 'activating'].includes(t.status))
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!task) return null;

    const c = this.cfg();
    try {
      switch (task.status) {
        case 'pending':
          task.status = 'opening';
          task.registerUrl = buildRegisterUrl(c.registerUrl, task);
          this._event(task, '已生成注册链接，请在浏览器完成「手机号 → 图形验证码 → 短信验证码」');
          // 需要验证码才有意义继续；短信通道是 http 时先自动取码
          if (c.sms.provider === 'http') await this.fetchSmsCode(task, c);
          else task.status = 'needcode';
          break;

        case 'opening':
          task.status = 'needcode';
          this._event(task, '等待短信验证码');
          break;

        case 'needcode':
          if (!task.smsCode) {
            task.status = 'needcode';
            break;
          }
          task.status = 'submitted';
          task.submittedAt = Date.now();
          this._event(task, `已收到短信验证码（${maskCode(task.smsCode)}），请在注册页完成提交`);
          break;

        case 'submitted':
          // 等账号在华为侧生效，再触发一键授权
          if (Date.now() - (task.submittedAt || 0) < (c.activation?.waitBeforeAuthMs ?? 8000)) break;
          if (c.autoAuth && this.authFlow) {
            if (!task.authTaskId) {
              const auth = await this.authFlow.start({ label: task.label || `注册号 ${maskPhone(task.phone)}` });
              task.authTaskId = auth.id;
              this._event(task, `已发起一键授权（state=${auth.state}），请在浏览器用刚注册的账号登录`);
            }
            const view = await this.authFlow.check(task.authTaskId);
            if (view.status === 'bound') {
              task.accountId = view.newAccountId || '';
              task.status = c.activation?.autoActivate !== false ? 'activating' : 'done';
              this._event(task, `授权完成，账号 ${task.accountId || view.newUserId} 已入池`);
            } else if (view.status === 'expired' || view.status === 'failed') {
              // 链接过期**不等于**这个号没戏 —— 10 分钟是给人点击的窗口，超时是常态
              // （人不在电脑前、还没注册完、手慢一点都会超）。
              // 所以退回去重新发起一条**新的**授权链接，次数由 maxAttempts 兜住，
              // 而不是当场把这个号判死。
              this._restartAuth(task, `一键授权未完成：${view.error || view.status}`);
            } else {
              task.status = 'awaiting_auth';
            }
          } else {
            task.status = 'done';
            task.finishedAt = Date.now();
            this._event(task, '未启用自动授权，注册流程到此结束');
          }
          break;

        case 'awaiting_auth': {
          const view = await this.authFlow.check(task.authTaskId);
          if (view.status === 'bound') {
            task.accountId = view.newAccountId || '';
            task.status = c.activation?.autoActivate !== false ? 'activating' : 'done';
            this._event(task, '授权完成，账号已入池');
          } else if (view.status === 'expired' || view.status === 'failed') {
            // 同上：换一条新链接重来，不把一个还在等的号直接判死
            this._restartAuth(task, `一键授权失败：${view.error || view.status}`);
          }
          break;
        }

        case 'activating': {
          const code = task.promotionCode || pickPromotionCode(c);
          if (!code) {
            task.status = 'done';
            task.finishedAt = Date.now();
            this._event(task, '没配置邀请码，跳过激活');
            break;
          }
          const r = await this.redeem(code);
          if (r.ok) {
            task.status = 'done';
            task.finishedAt = Date.now();
            task.activation = { code, ok: true };
            this._event(task, `邀请码 ${code} 兑换成功`);
          } else if (r.needCode) {
            task.status = 'done';
            task.finishedAt = Date.now();
            task.activation = { code, ok: false, needCode: true, message: r.message };
            this._event(task, `需要补填邀请码：${r.message}`);
          } else {
            throw new Error(`邀请码兑换失败：${r.message}`);
          }
          break;
        }

        default:
          break;
      }
      task.updatedAt = Date.now();
      if (task.status === 'done') {
        try {
          await this.onDone(task);
        } catch (err) {
          log.warn('onDone 钩子失败', { error: err.message });
        }
      }
      return this.view(task);
    } catch (err) {
      task.attempts += 1;
      task.error = err.message;
      this._event(task, `出错：${err.message}`);
      const max = Number(this.cfg().maxAttempts) || 3;
      if (task.attempts >= max) {
        task.status = 'failed';
        task.finishedAt = Date.now();
        log.warn('注册任务失败', { phone: maskPhone(task.phone), error: err.message });
      } else {
        task.status = task.authTaskId ? 'awaiting_auth' : 'needcode';
      }
      task.updatedAt = Date.now();
      return this.view(task);
    } finally {
      // 每次推进都落一次盘：一步状态机跨几秒到几分钟，重启丢一步就得从头来
      this.save();
    }
  }

  /** 跑一轮队列（并发受配置限制） */
  async kick() {
    if (this.running || this.paused) return { ran: 0 };
    const c = this.cfg();
    this.running = true;
    let ran = 0;
    try {
      for (let i = 0; i < c.concurrency; i += 1) {
        const r = await this.step();
        if (!r) break;
        ran += 1;
      }
    } finally {
      this.running = false;
    }
    return { ran, pending: this.pendingCount() };
  }

  /* -------------------------------------------------------------- 短信码 */

  /** 面板填码 */
  setSmsCode(id, code) {
    const task = this.tasks.get(String(id || ''));
    if (!task) throw new Error('任务不存在');
    task.smsCode = String(code || '').trim();
    this._event(task, `已录入短信验证码（${maskCode(task.smsCode)}）`);
    task.updatedAt = Date.now();
    this.save();
    return this.view(task);
  }

  /** 从接码平台取码 */
  async fetchSmsCode(task, c) {
    const sms = c.sms || {};
    const httpCfg = sms.http || {};
    if (!httpCfg.urlTemplate) {
      task.status = 'needcode';
      this._event(task, '接了 http 接码但没配 urlTemplate，改为手工填码');
      return;
    }
    const url = String(httpCfg.urlTemplate)
      .replaceAll('{phone}', encodeURIComponent(task.phone))
      .replaceAll('{project}', encodeURIComponent(httpCfg.project || ''));
    try {
      const res = await request(url, {
        method: httpCfg.method || 'GET',
        headers: httpCfg.headers || {},
        body: httpCfg.method === 'POST' ? { phone: task.phone } : undefined,
        timeoutMs: Number(httpCfg.timeoutMs) || 20000,
        insecure: false,
      });
      const code = pickPath(res.json ?? safeJson(res.text), httpCfg.codePath || 'data.code');
      if (!code) throw new Error(`接码平台没返回码：${res.text.slice(0, 160)}`);
      task.smsCode = String(code).trim();
      this._event(task, `接码平台返回验证码（${maskCode(task.smsCode)}）`);
      task.status = 'submitted';
    } catch (err) {
      task.status = 'needcode';
      this._event(task, `接码失败，改为手工填码：${err.message}`);
    }
  }

  /* -------------------------------------------------------------- 激活 */

  /** 兑换邀请码：走本机 OfficeAce 的 /api/login/invitation */
  async redeem(code) {
    const app = this.authFlow ? await this.authFlow.detectApp({ force: true }) : null;
    if (!app) return { ok: false, needCode: false, message: '本机 OfficeAce 未运行，无法兑换邀请码' };
    try {
      const res = await request(`${app.baseUrl}/api/login/invitation`, {
        method: 'POST',
        body: { promotionCode: code },
        headers: { Accept: 'application/json' },
        timeoutMs: 25000,
        insecure: true,
      });
      const j = res.json || {};
      if (res.ok && j.success !== false) return { ok: true, message: '兑换成功' };
      const errCode = j.errorCode || j.error_code || j.code || '';
      const msg = PROMOTION_ERRORS[errCode] || j.message || j.error || `HTTP ${res.status}`;
      return { ok: false, needCode: !!j.needCode, message: msg, errorCode: errCode };
    } catch (err) {
      return { ok: false, needCode: false, message: err.message };
    }
  }

  /* -------------------------------------------------------------- 视图 */

  pendingCount() {
    return [...this.tasks.values()].filter(
      (t) => !['done', 'failed', 'skipped'].includes(t.status),
    ).length;
  }

  stats() {
    const all = [...this.tasks.values()];
    const by = {};
    for (const t of all) by[t.status] = (by[t.status] || 0) + 1;
    return {
      total: all.length,
      pending: this.pendingCount(),
      byState: by,
      paused: this.paused,
      running: this.running,
      concurrency: this.cfg().concurrency,
      smsProvider: this.cfg().sms.provider,
    };
  }

  list() {
    return this.order
      .map((id) => this.tasks.get(id))
      .filter(Boolean)
      .map((t) => this.view(t))
      .reverse();
  }

  get(id) {
    const t = this.tasks.get(String(id || ''));
    return t ? this.view(t) : null;
  }

  /**
   * 删掉一条任务。
   *
   * 原来的规则是「只能删已完成或失败」，本意是护住在途任务。但它把另一种情况也堵死了：
   * **一条卡在「等待短信验证码」上的任务**（人不打算继续了、或者号填错了）在面板上
   * 删不掉 —— 面板每行都给「删除」按钮，点下去只报错；唯一的出路竟然是重启服务
   * （重启才会把它变成「失败」）。自测踩的是同一个坑：它跑完会删自己造的号，
   * 但删除一直失败、返回值又没人看，于是**每跑一次就在真队列里留两条垃圾**
   * （以前重启能冲掉，落了盘之后就永久留着了）。
   *
   * 删在途任务本身是安全的：`step()` 是拿着快照推进的，`save()` 只按 `this.order`
   * 写盘 —— 被删掉的任务不在 order 里，最多是它最后那一步的改动没人再看见。
   * 但删在途任务值得留一条日志：那是「人主动放弃」，不是流程自己走完的。
   */
  remove(id) {
    const key = String(id || '');
    const t = this.tasks.get(key);
    if (!t) return false;
    const was = TASK_STATES[t.status] || t.status;
    const inFlight = !['done', 'failed', 'skipped'].includes(t.status);
    this.tasks.delete(key);
    this.order = this.order.filter((x) => x !== key);
    this.save();
    if (inFlight) log.info('删掉一条还没跑完的注册任务', { phone: maskPhone(t.phone), at: was });
    return true;
  }

  clearDone() {
    let n = 0;
    for (const [id, t] of this.tasks) {
      if (['done', 'failed'].includes(t.status)) {
        this.tasks.delete(id);
        n += 1;
      }
    }
    this.order = this.order.filter((id) => this.tasks.has(id));
    this.save();
    return n;
  }

  setPaused(paused) {
    this.paused = !!paused;
    return this.paused;
  }

  retry(id) {
    const t = this.tasks.get(String(id || ''));
    if (!t) throw new Error('任务不存在');
    t.status = 'pending';
    t.error = '';
    t.attempts = 0;
    t.authTaskId = '';
    t.updatedAt = Date.now();
    this._event(t, '手动重试');
    this.save();
    return this.view(t);
  }

  /**
   * 授权链接过期/失败之后，重新发起一条。
   *
   * 为什么重来而不是判死：10 分钟是**给人点击**的窗口，超时是常态 ——
   * 人不在电脑前、注册页还没走完、手慢一点都会超。旧代码在这里直接 throw
   * 成失败，于是「用户去接杯水回来」就变成一个失败任务。
   *
   * 退回 `submitted`：等过 `waitBeforeAuthMs` 会重新 `authFlow.start()` 拿一条
   * **新链接**（新的 state）。新链接会自动出现在面板「授权任务」列表里
   * （带「打开登录页」按钮），label 里带手机号，认得出是哪个号。
   * 次数由 `maxAttempts` 兜住，不会无限重来。
   *
   * 仍然 throw：让 attempts 计数和 UI 上的错误信息都留着 —— 用户要看得见
   * 「这条链接过期了，已经给你换了一条」。
   */
  _restartAuth(task, reason) {
    task.authTaskId = '';
    task.status = 'submitted';
    task.submittedAt = Date.now();
    task.authRestarts = (task.authRestarts || 0) + 1;
    throw new Error(`${reason}（已换一条新的授权链接，第 ${task.authRestarts} 次）`);
  }

  view(task) {
    return {
      id: task.id,
      phone: task.phone,
      phoneMasked: maskPhone(task.phone),
      label: task.label,
      status: task.status,
      statusText: TASK_STATES[task.status] || task.status,
      accountId: task.accountId,
      authTaskId: task.authTaskId,
      smsCodeSet: !!task.smsCode,
      smsCodeMasked: task.smsCode ? maskCode(task.smsCode) : '',
      promotionCode: task.promotionCode,
      activation: task.activation || null,
      registerUrl: task.registerUrl || buildRegisterUrl(this.cfg().registerUrl, task),
      attempts: task.attempts,
      error: task.error,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      events: task.events,
    };
  }

  _event(task, message) {
    task.events.push({ at: Date.now(), message });
    if (task.events.length > 30) task.events.shift();
    log.debug('reg flow', { phone: maskPhone(task.phone), message });
  }
}

/* ------------------------------------------------------------------ 工具 */

export function buildRegisterUrl(base, task) {
  try {
    const u = new URL(base || DEFAULT_REGISTER_URL);
    if (task?.phone) u.searchParams.set('phone', task.phone);
    return u.toString();
  } catch {
    return base || DEFAULT_REGISTER_URL;
  }
}

export function maskPhone(phone) {
  const s = String(phone || '');
  if (s.length <= 4) return s ? '****' : '';
  return `${s.slice(0, 3)}****${s.slice(-2)}`;
}

function maskCode(code) {
  const s = String(code || '');
  return s ? `${s.slice(0, 1)}***${s.slice(-1)}` : '';
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从对象里按 "a.b.c" 取路径 */
export function pickPath(obj, path) {
  if (!obj || !path) return undefined;
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function pickPromotionCode(cfg) {
  const list = cfg.activation?.promotionCodes;
  if (!Array.isArray(list) || !list.length) return '';
  const code = String(list[0] || '').trim();
  return code || '';
}
