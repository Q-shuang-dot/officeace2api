/**
 * 用量统计：内存 + 落盘 data/usage.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.mjs';
import { writeFileAtomic } from './util.mjs';

const log = createLogger('stats');

/** 本机时区的 YYYY-MM-DD。用 toISOString() 会在东八区把 0~8 点的请求算到前一天。 */
export function usageDayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 把上游五花八门的错误归成几类，面板上才能回答「到底为什么失败」。
 * 只做展示用的粗分类，不改变原有 error 文本。
 */
export function classifyUsageError(message = '') {
  const s = String(message || '').toLowerCase();
  if (!s) return '未知';
  if (s.includes('timeout') || s.includes('timed out') || s.includes('超时') || s.includes('etimedout')) return '超时';
  if (s.includes('abort') || s.includes('取消')) return '客户端取消';
  if (s.includes('429') || s.includes('rate limit') || s.includes('ratelimit') || s.includes('too many') || s.includes('限流')) return '限流 429';
  if (s.includes('401') || s.includes('unauthorized') || s.includes('invalid api key') || s.includes('鉴权')) return '鉴权失败';
  if (s.includes('81004') || s.includes('模型没权限') || s.includes('model not authorized')) return '模型无权限';
  if (s.includes('403') || s.includes('forbidden') || s.includes('权限')) return '无权限 403';
  if (s.includes('81001') || s.includes('bad request') || s.includes('invalid request') || s.includes('参数')) return '请求参数';
  if (s.includes('502') || s.includes('503') || s.includes('504') || s.includes('bad gateway') || s.includes('unavailable')) return '上游 5xx';
  if (s.includes('econn') || s.includes('fetch failed') || s.includes('network') || s.includes('socket') || s.includes('dns')) return '网络错误';
  return '其他';
}

export class UsageStore {
  constructor({ file, flushMs = 5000 } = {}) {
    this.file = file;
    this.data = {
      since: new Date().toISOString(),
      totals: { requests: 0, ok: 0, failed: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 },
      byModel: {},
      byApiKey: {},
      recent: [],
      daily: {},
      errors: {},
    };
    this.dirty = false;
    this.load();
    this.timer = setInterval(() => this.flush(), flushMs);
    this.timer.unref?.();
  }

  load() {
    try {
      if (!this.file) return;
      const doc = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (doc && typeof doc === 'object') this.data = { ...this.data, ...doc };
    } catch {
      /* first run */
    }
    // 旧版 usage.json 没有这两块；补上空对象，后面 record() 才能直接写。
    if (!this.data.daily || typeof this.data.daily !== 'object') this.data.daily = {};
    if (!this.data.errors || typeof this.data.errors !== 'object') this.data.errors = {};
  }

  record(entry) {
    const { model, apiKey, usage, ok, latencyMs, error, credential, stream, endpoint } = entry;
    // 上游各家字段名不一样：OpenAI 标准是 prompt_tokens_details.cached_tokens，
    // 也有直接给 usage.cached_tokens 的。拿不到就当 0，不影响原有统计。
    const cachedTokens = Number(
      usage?.prompt_tokens_details?.cached_tokens ??
      usage?.cached_tokens ??
      0,
    ) || 0;
    const t = this.data.totals;
    t.requests += 1;
    if (ok) t.ok += 1;
    else t.failed += 1;
    if (usage) {
      t.prompt_tokens += usage.prompt_tokens || 0;
      t.completion_tokens += usage.completion_tokens || 0;
      t.total_tokens += usage.total_tokens || 0;
      t.cached_tokens = (Number(t.cached_tokens) || 0) + cachedTokens;
    }
    const modelKey = model || 'unknown';
    const m = (this.data.byModel[modelKey] ||= {
      requests: 0,
      ok: 0,
      failed: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cached_tokens: 0,
      avgLatencyMs: 0,
    });
    m.requests += 1;
    if (ok) m.ok += 1;
    else m.failed += 1;
    if (usage) {
      m.prompt_tokens += usage.prompt_tokens || 0;
      m.completion_tokens += usage.completion_tokens || 0;
      m.total_tokens += usage.total_tokens || 0;
      m.cached_tokens = (m.cached_tokens || 0) + cachedTokens;
    }
    m.avgLatencyMs = Math.round((m.avgLatencyMs * (m.requests - 1) + (latencyMs || 0)) / m.requests);

    if (apiKey) {
      const k = (this.data.byApiKey[apiKey] ||= { requests: 0, total_tokens: 0 });
      k.requests += 1;
      k.total_tokens += usage?.total_tokens || 0;
    }

    this.data.recent.unshift({
      ts: new Date().toISOString(),
      model: modelKey,
      ok: !!ok,
      stream: !!stream,
      endpoint: endpoint || '/v1/chat/completions',
      latencyMs: latencyMs || 0,
      prompt_tokens: usage?.prompt_tokens ?? null,
      completion_tokens: usage?.completion_tokens ?? null,
      cached_tokens: cachedTokens,
      credential: credential || '',
      error: error || '',
    });
    if (this.data.recent.length > 200) this.data.recent.length = 200;

    // 按天桶：用量页要画 7 天走势，不能只给一个「自启动以来」的累计值。
    const day = usageDayKey();
    const d = (this.data.daily[day] ||= {
      requests: 0, ok: 0, failed: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    });
    d.requests += 1;
    if (ok) d.ok += 1;
    else d.failed += 1;
    d.prompt_tokens += usage?.prompt_tokens || 0;
    d.completion_tokens += usage?.completion_tokens || 0;
    d.total_tokens += usage?.total_tokens || 0;
    // 只留最近 30 天，避免这个文件随年月无限长。
    const dayKeys = Object.keys(this.data.daily).sort();
    while (dayKeys.length > 30) delete this.data.daily[dayKeys.shift()];

    if (!ok) {
      const kind = classifyUsageError(error);
      this.data.errors[kind] = (this.data.errors[kind] || 0) + 1;
    }

    this.dirty = true;
  }

  flush() {
    if (!this.dirty || !this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // 原子写：以前是原地截断再写，进程被 watchdog 掐掉 / 断电时留下的
      // 半截 JSON 会被读取方当成「没有历史」，下一轮 flush 直接覆盖掉。
      writeFileAtomic(this.file, JSON.stringify(this.data, null, 2), { mode: 0o644 });
      this.dirty = false;
    } catch (err) {
      log.warn('统计落盘失败', { error: String(err?.message || err) });
    }
  }

  snapshot() {
    return this.data;
  }

  reset() {
    this.data = {
      since: new Date().toISOString(),
      totals: { requests: 0, ok: 0, failed: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 },
      byModel: {},
      byApiKey: {},
      recent: [],
      daily: {},
      errors: {},
    };
    this.dirty = true;
    this.flush();
  }
}
