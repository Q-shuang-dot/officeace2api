/**
 * 用量统计：内存 + 落盘 data/usage.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.mjs';
import { writeFileAtomic } from './util.mjs';

const log = createLogger('stats');

export class UsageStore {
  constructor({ file, flushMs = 5000 } = {}) {
    this.file = file;
    this.data = {
      since: new Date().toISOString(),
      totals: { requests: 0, ok: 0, failed: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      byModel: {},
      byApiKey: {},
      recent: [],
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
  }

  record(entry) {
    const { model, apiKey, usage, ok, latencyMs, error, credential, stream, endpoint } = entry;
    const t = this.data.totals;
    t.requests += 1;
    if (ok) t.ok += 1;
    else t.failed += 1;
    if (usage) {
      t.prompt_tokens += usage.prompt_tokens || 0;
      t.completion_tokens += usage.completion_tokens || 0;
      t.total_tokens += usage.total_tokens || 0;
    }
    const modelKey = model || 'unknown';
    const m = (this.data.byModel[modelKey] ||= {
      requests: 0,
      ok: 0,
      failed: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      avgLatencyMs: 0,
    });
    m.requests += 1;
    if (ok) m.ok += 1;
    else m.failed += 1;
    if (usage) {
      m.prompt_tokens += usage.prompt_tokens || 0;
      m.completion_tokens += usage.completion_tokens || 0;
      m.total_tokens += usage.total_tokens || 0;
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
      credential: credential || '',
      error: error || '',
    });
    if (this.data.recent.length > 200) this.data.recent.length = 200;
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
      totals: { requests: 0, ok: 0, failed: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      byModel: {},
      byApiKey: {},
      recent: [],
    };
    this.dirty = true;
    this.flush();
  }
}
