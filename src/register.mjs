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
 *     fixed  —— 固定码（本地联调/自建环境用）
 */

import { createLogger } from './logger.mjs';
import { request } from './http.mjs';

const log = createLogger('register');

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
   *          onDone?:(task:object)=>void}} opts
   */
  constructor({ getConfig, authFlow, accounts, onDone } = {}) {
    this.getConfig = getConfig || (() => ({}));
    this.authFlow = authFlow;
    this.accounts = accounts;
    this.onDone = onDone || (() => {});
    this.tasks = new Map();
    this.order = [];
    this.seq = 0;
    this.running = false;
    this.paused = false;
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
              throw new Error(`一键授权未完成：${view.error || view.status}`);
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
            throw new Error(`一键授权失败：${view.error || view.status}`);
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

  remove(id) {
    const key = String(id || '');
    const t = this.tasks.get(key);
    if (!t) return false;
    if (!['done', 'failed'].includes(t.status)) throw new Error('只能删除已完成或失败的任务');
    this.tasks.delete(key);
    this.order = this.order.filter((x) => x !== key);
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
    return this.view(t);
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
