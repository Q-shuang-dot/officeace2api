/**
 * HTTP 服务层：OpenAI 兼容路由 + 重试编排 + 管理面板
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearRecentLogs, configureLogger, createLogger, getLogSeq, getLogsSince, getRecentLogs } from './logger.mjs';
import { adminHtml } from './admin.mjs';
import { saveConfig } from './config.mjs';
import {
  buildBundle,
  bundleFileName,
  collectAccounts,
  mergeBundle,
  ONE_TIME_TOKEN_WARNING,
  parseBundle,
  summarizeAccounts,
} from './bundle.mjs';
import {
  buildUpstreamBody,
  classifyUpstream,
  createChatAccumulator,
  createSseDecoder,
  openAiError,
  postChat,
  quirksFor,
  takeBumpNote,
  TINY_MAX_TOKENS,
} from './upstream.mjs';
import { trimSlash } from './util.mjs';
import { formatChatLine } from './logfmt.mjs';
import { nextRequestId, readJson, sendJson, writeChunk, writeSseHead } from './http-utils.mjs';
import { retryAfterMsOf, sessionAffinityKey } from './routing.mjs';

const log = createLogger('server');

/**
 * 下游客户端在响应写完之前断开时，请求入口用这个 message abort（见 `res.on('close')`）。
 *
 * ⚠️ 只有它代表「客户端走了」。上游自己的超时是 `upstream timeout`，上游 RST 是
 * `terminated` / `other side closed` —— 三者混在一起，日志就会把「客户端取消」
 * 写成「上游断流」，让人以为号池出问题了。
 */
const CLIENT_DISCONNECTED = 'client disconnected';

function isClientDisconnect(err) {
  return String(err?.message || err || '') === CLIENT_DISCONNECTED;
}

/**
 * 代码根目录。`/healthz` 会把它带出去，作用是**认亲**：
 * `tools/export-accounts.mjs` / `tools/import-accounts.mjs` 先看端口上这个服务是不是
 * 「我这个目录里的代码起的」。否则同一台机器上放两份项目（或旧版还在跑），
 * 导入就会 POST 到另一个目录的服务上 —— 实测踩过：报一句"管理员 token 无效"，
 * 但其实账号包已经被发到别的实例去了。
 */
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 生成速度：**输出 token / 秒**（日志里的 `tps`）。
 *
 * 三个刻意的取舍，改之前先看清楚：
 *
 *  1. 分子只用 `completion_tokens`，不用 `total_tokens`。后者把提示词也算进去，
 *     长上下文时能把速度虚高好几倍 —— 那不是"生成快"，是"读得快"。
 *     拿不到 `completion_tokens` 就返回 null，别拿 total 顶（宁可没有，也别给假数）。
 *  2. 分母从「第一个数据块」算起，不从请求开始算。`ttftMs` 里那几秒（选号、排队、
 *     上游冷启动、重试退避）跟生成速度无关，算进去会把慢请求的 tps 拉得莫名其妙。
 *  3. 观测窗口短于 200ms 就不算。非流式请求、或者上游一次吐完一整块时，
 *     分子分母都是毛刺，算出来动辄几千上万 tps，纯误导。给 null 表示"这次无意义"。
 *
 * @param {{completion_tokens?: number}|null|undefined} usage 上游回的 usage
 * @param {number} startedAt  请求进入时的 Date.now()
 * @param {number} firstDataAt 第一个数据块到达的 Date.now()（0/未流式则退回 startedAt）
 * @param {number} endedAt    结束时的 Date.now()
 * @returns {number|null} 四舍五入的 tps，算不出来给 null
 */
export function calcTps(usage, startedAt, firstDataAt, endedAt) {
  const out = Number(usage?.completion_tokens ?? 0);
  if (!(out > 0)) return null;
  const from = Number(firstDataAt) > 0 ? Number(firstDataAt) : Number(startedAt);
  const span = Number(endedAt) - from;
  if (!(span >= 200)) return null;
  return Math.round((out / span) * 1000);
}

/**
 * 这个请求是不是从本机来的？
 * `remoteAddress` 在 Windows 上会是 `::ffff:127.0.0.1` 这种映射形式，所以要一起认。
 * 拿不到地址（比如某些自建代理 socket）时按"不是本机"处理 —— 宁可少给字段。
 */
/**
 * 进程内请求序号，只用于日志里的 `#N`。
 * 重启归零是有意的：这个号和日志文件的生命周期对齐，不会出现"日志里没有 #900 却从 #905 开始"。
 */
/**
 * `/admin/api/state` 一次带回多少条日志。
 *
 * 60 条大概就是面板「运行日志」一屏能显示的量，再多的靠 `?since=` 增量补
 * （`/admin/api/logs`）。这个数字调大有代价：它乘以每 3 秒一次的轮询频率。
 */
const STATE_LOG_TAIL = 60;

let chatSeq = 0;

function isLoopbackRequest(req) {
  const remote = String(req?.socket?.remoteAddress || '');
  if (!remote) return false;
  const v4 = remote.replace(/^::ffff:/i, '');
  return remote === '::1' || v4.startsWith('127.');
}
// 请求地址（含 query）上限。超过就答 414，别交给 new URL() 慢慢啃。
const MAX_URL_LENGTH = 8 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 面板口令的 Cookie 名（见下面管理路由那段） */
const ADMIN_COOKIE = 'o2a_admin';

/**
 * 从 `Cookie:` 头里取一个键。只为这一件事写十几行，不引依赖。
 * 取不到返回 ''，解不出百分号编码就按原样返回 —— 口令本身的比对在调用方。
 */
function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    const raw = part.slice(i + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return '';
}


/**
 * 模型名校验。通过返回 null，否则返回要发回客户端的 {status, body}。
 *
 * 为什么要校验：实测过一个拼错的模型名会被当成可重试错误，连打上游 3 次
 * 再回 502 —— 又慢又白耗上游 TPM 额度（整个号共享的那份），
 * 客户端拿到的还是一句看不懂的上游错误。
 *
 * 注册表为空时直接放行：那说明上游模型列表还没拉回来，
 * 这种时候宁可放行，也不能把正常模型误杀。
 */
function checkModel(registry, requested) {
  const name = String(requested || '').trim();
  if (!name) return null;
  const known = registry.ids();
  if (!known.length) return null;
  if (known.includes(registry.resolve(name))) return null;
  return {
    status: 404,
    body: {
      error: {
        message: `没有这个模型：${name}`,
        type: 'invalid_request_error',
        code: 'model_not_found',
        param: 'model',
        hint: `可用模型见 GET /v1/models，例如 ${known.slice(0, 3).join(' / ')}`,
      },
    },
  };
}

function extractApiKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  try {
    return new URL(req.url, 'http://localhost').searchParams.get('api_key') || '';
  } catch {
    return '';
  }
}

function checkAuth(req, config) {
  const keys = config.apiKeys || [];
  const provided = extractApiKey(req);
  if (keys.length === 0) return { ok: true, key: '' };
  return { ok: keys.includes(provided), key: provided };
}

function backoffMs(base, attempt) {
  const raw = base * Math.pow(1.8, Math.max(0, attempt - 1));
  return Math.min(15000, Math.round(raw + Math.random() * 300));
}

/**
 * 预读上游首个事件：既避免「HTTP 200 但内容是错误 JSON」被当成正常流，
 * 也保证后续重试逻辑能生效。
 */
async function primeUpstream(upstreamRes, { timeoutMs }) {
  const reader = upstreamRes.body.getReader();
  const decoder = createSseDecoder();
  const raw = [];
  const events = [];
  let bytes = 0;
  const deadline = Date.now() + timeoutMs;

  const failFast = (payload) => {
    try {
      reader.cancel();
    } catch {
      /* noop */
    }
    return { kind: 'error', payload, reader, raw, events, decoder };
  };

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const raced = await Promise.race([
      reader.read().then((v) => ({ value: v })),
      sleep(remaining).then(() => ({ timeout: true })),
    ]);
    if (raced.timeout) {
      // 上游 HTTP 200 了但一直不吐数据帧。
      //
      // 以前这里是 break，然后落到函数末尾 return { kind: 'stream' } —— 和
      // 「真的读到帧了」同一个形状，于是上层当成正常流：不重试、不报错，
      // 直接回一个空的 200 让客户端干等（实测能挂到 90 秒才无声断流）。
      // 现在明确当失败，走上层的重试/报错分支。
      return failFast({
        error: {
          code: 'UPSTREAM_NO_DATA',
          message: `上游 ${Math.round(timeoutMs / 1000)}s 内没有吐出任何数据帧`,
        },
      });
    }
    const { done, value } = raced.value;
    if (done) return { kind: 'closed', reader, raw, events, decoder };
    raw.push(value);
    bytes += value.length;

    // ⚠️ 这一批事件必须整个收完再判断。
    //
    // decoder.push() 一次能吐出好几个事件（上游常把 role/content/usage/[DONE]
    // 塞在同一个 TCP 包里）。以前是在循环里「遇到第一个有数据的帧就 return」，
    // 同批剩下的帧既没进 events、也已经从 decoder 的内部缓冲切走了 —— 永久丢失。
    // 后果很隐蔽：非流式请求返回 200 + content:""，usage 全 0，还记成功。
    const batch = decoder.push(value);
    for (const evt of batch) events.push(evt);

    const bad = batch.find((e) => e.data?.error);
    if (bad) return failFast(bad.data);
    if (batch.some((e) => e.data || e.done)) {
      return { kind: 'stream', reader, raw, events, decoder };
    }

    // 预读了一大坨还没见到一个正常数据帧，不正常（正常第一帧只有几十字节）。
    // 同样是显式失败，别悄悄放过去变成空 200。
    if (bytes > 512 * 1024) {
      return failFast({
        error: { code: 'UPSTREAM_NO_DATA', message: '上游连续 512KB 都不是数据帧' },
      });
    }
  }
  return { kind: 'stream', reader, raw, events, decoder };
}

/** 流式透传：把上游字节原样写给客户端，同时旁路统计 */
async function relayPrimed(primed, res, { model, signal, startedAt } = {}) {
  // 慢首包时头可能已经由 earlyHeaderMs 的看门狗发出去了，不能再 writeHead。
  // 正常路径这里正好是「首帧已经到了」的时刻，顺手给客户端一个 Server-Timing。
  writeSseHead(res, { ttfbMs: startedAt ? Date.now() - startedAt : null });

  // 客户端在预读期间已经走了：别往一个 destroy 掉的 socket 上写。
  if (res.destroyed) {
    return {
      usage: null,
      firstDataAt: 0,
      tokens: 0,
      contentChars: 0,
      reasoningChars: 0,
      finishReason: null,
      sawToolCalls: false,
      error: null,
      truncated: false,
      upstreamError: '',
      clientGone: true,
    };
  }

  const acc = createChatAccumulator(model);
  acc.push(primed.events);

  for (const buf of primed.raw) {
    if (res.writableEnded || res.destroyed) break;
    await writeChunk(res, buf);
  }
  if (typeof res.flush === 'function') res.flush();

  let clientGone = false;
  let upstreamError = '';

  try {
    for (;;) {
      const { done, value } = await primed.reader.read();
      if (done) break;
      if (res.writableEnded || res.destroyed) {
        clientGone = true; // 客户端自己走了，不是上游的问题
        break;
      }
      await writeChunk(res, value);
      acc.push(primed.decoder.push(value));
      if (typeof res.flush === 'function') res.flush();
    }
    acc.push(primed.decoder.flush());
  } catch (err) {
    // 先分清是谁掐的：
    //   · 下游客户端走了（signal.reason / 错误 message 是 client disconnected）
    //     → 不是上游的锅，不能记断流，更不能拿它去 markFailed 罚凭据；
    //   · 其余才是上游把连接掐了（RST / socket destroyed）。
    if (isClientDisconnect(err) || isClientDisconnect(signal?.reason) || res.destroyed) {
      clientGone = true;
    } else {
      // 这里刻意不让异常往外抛：抛出去的话调用方的 handle.cleanup()、池子记账、
      // usage 记录全被跳过 —— 一条断掉的流会被记成成功。现在把它转成返回值，
      // 让调用方能照实记一笔失败。
      upstreamError = String(err?.message || err);
    }
  } finally {
    // 「残流」= 客户端还在、但既没读到 [DONE] 也没见过任何 finish_reason。
    //
    // 两个条件都要，是因为有些上游本来就不补 [DONE]：只要它给过
    // finish_reason，内容就是完整的，报错反而会误伤。
    // 真的中途断了的话，客户端手里只有半截 SSE 且没有结束标记，
    // 会一直转圈到超时 —— 所以补一个错误帧 + [DONE]。
    const incomplete = !clientGone && !acc.state.sawDone && !acc.state.finishReason;
    if (incomplete && !res.writableEnded) {
      try {
        res.write(
          `data: ${JSON.stringify({
            error: {
              message: '上游连接中途断开，这条回复不完整',
              type: 'upstream_error',
              code: 'UPSTREAM_TRUNCATED',
            },
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
      } catch {
        /* 客户端已经走了 */
      }
    }
    try {
      primed.reader.releaseLock();
    } catch {
      /* noop */
    }
    if (!res.writableEnded) res.end();
  }
  return {
    usage: acc.state.usage,
    firstDataAt: acc.state.firstDataAt,
    tokens: acc.state.content.length,
    // 流式已经往客户端写了字节，发现空正文也没法重打（不像非流式那样可以重试），
    // 所以把两个长度带出去，上层至少能记一条日志告诉用户"为什么回复是空的"。
    contentChars: acc.state.content.length,
    reasoningChars: acc.state.reasoning.length,
    finishReason: acc.state.finishReason,
    sawToolCalls: !!acc.state.sawToolCalls,
    // 中途出现在 error 帧里的失败（伪 200 的第二种形态）：
    // 客户端能看见，但池子和统计也要按失败算，否则限流的凭据不会冷却。
    error: acc.state.error,
    // 流没读到 [DONE]、也没见过 finish_reason = 上游那边真断了。
    // 排除「客户端自己走的」那种，那不是上游的锅。
    truncated: !clientGone && !acc.state.sawDone && !acc.state.finishReason,
    upstreamError,
    clientGone,
  };
}

/** 非流式：把上游 SSE 聚合成一条 chat.completion */
async function aggregatePrimed(primed, { model }) {
  const acc = createChatAccumulator(model);
  acc.push(primed.events);
  let upstreamError = '';
  try {
    for (;;) {
      const { done, value } = await primed.reader.read();
      if (done) break;
      acc.push(primed.decoder.push(value));
    }
    acc.push(primed.decoder.flush());
  } catch (err) {
    // 同 relayPrimed：别把上游断流抛成 500，转成返回值让上层能照实记账
    upstreamError = String(err?.message || err);
  } finally {
    try {
      primed.reader.releaseLock();
    } catch {
      /* noop */
    }
  }
  // 把 error 一起带出去：build() 里只会组装正文，不看 state.error。
  // 不看的话，「第一帧正常、第二帧才是错误体」的伪 200 会被聚合成
  // 一条 content:"" + finish_reason:"stop" 的空回复，正好是 README 里
  // 承诺不会出现的那种。
  return {
    payload: acc.build(),
    error: acc.state.error,
    upstreamError,
    truncated: !acc.state.sawDone && !acc.state.finishReason,
  };
}

export function createApp(ctx) {
  const { config, pool, registry, usage } = ctx;

  /**
   * 一次「max_tokens 被抬升」每个模型只提示一次，别把日志刷满。
   * 客户端是轮询式的（每轮都带 64），不记的话一条对话能刷出几百行。
   */
  const bumpWarned = new Set();
  /** 同上，夹上限的提示也只提醒一次。 */
  const clampWarned = new Set();

  /**
   * 这个模型要额外追加多少「推理预算」token。
   *
   * 实测 34 个模型的结论：**能用的 9 个全是推理模型**，包括名字里毫无提示的
   * `glm-5.2`（给 max_tokens:64，completion_tokens 干到 474，多的一次 8460）。
   * 所以名单留空的默认值是"全都算"—— 编名单的做法在这里注定漏。
   *
   * 想精确控制就填 `config.models.reasoningModels`：匹配时忽略大小写和 `._-`，
   * 前缀命中即可（填 `deepseek-v4-flash` 会顺带覆盖 `deepseek-v4-flash-0731`）。
   */
  function isReasoningModel(model) {
    const cfg = config.models || {};
    const list = Array.isArray(cfg.reasoningModels) ? cfg.reasoningModels.filter(Boolean) : [];
    if (!list.length) return true;
    if (list.some((m) => String(m).trim() === '*')) return true;
    const norm = (s) => String(s || '').toLowerCase().replace(/[._\s-]/g, '');
    const target = norm(model);
    return list.some((m) => {
      const n = norm(m);
      return n && (target === n || target.startsWith(n));
    });
  }

  /**
   * 这个模型的推理预算（追加多少 token）。
   *
   * ⚠️ 这条防线**不保证**正文不为空：实测同一个问题，1024 预算空 0/12，
   *    2048 反而空 1/12 —— 推理开销是随机的，任何固定预算都会偶发踩空。
   *    真正兜底的是非流式那条"空正文自动重试"。
   */
  function bumpMaxTokensFor(model) {
    const cfg = config.models || {};
    const perModel = cfg.minMaxTokensByModel || {};
    // 优先看按模型的覆盖项（同样是忽略大小写和 ._-
    const norm = (s) => String(s || '').toLowerCase().replace(/[._\s-]/g, '');
    for (const [k, v] of Object.entries(perModel)) {
      if (norm(k) === norm(model)) return Math.max(0, Number(v) || 0);
    }
    const allowance = cfg.minMaxTokens === undefined ? 1024 : Math.max(0, Number(cfg.minMaxTokens) || 0);
    return allowance > 0 && isReasoningModel(model) ? allowance : 0;
  }

  /**
   * 这个模型发给上游的 `max_tokens` 硬上限（0 = 不夹）。
   *
   * 上游自己也有范围，而且**各家不一样**（实测原文见 upstream.mjs 的 maxMaxTokens）：
   *
   *   glm-5.x    → 限制数值范围 [1, 131072]
   *   qwen3-32b  → 上下文 131072 就是上限，且 max_tokens 和提示词**一起**算，
   *                所以给它留余量（这里配 65536），别按上下文满编
   *   deepseek / kimi → 393216 以内都收
   *
   * 为什么需要：`bumpMaxTokensFor` 那套「追加推理预算」是加法，客户端给到上限时
   * 会被顶出去（393216 + 1024 = 394240 → 上游 400 ModelArts.81001，确定性失败）。
   * 所以追加之后再夹一道，见 upstream.mjs。
   *
   * 匹配规则：忽略大小写和 `._-`，**前缀命中**（填 `glm-5` 就覆盖 glm-5.1/5.2/5.3），
   * 多个键都命中时取**最长**的那个（更精确的赢）。没命中就回落到全局 `maxMaxTokens`。
   */
  function maxTokensCeilingFor(model) {
    const cfg = config.models || {};
    const perModel = cfg.maxMaxTokensByModel || {};
    const norm = (s) => String(s || '').toLowerCase().replace(/[._\s-]/g, '');
    const target = norm(model);
    let best = null;
    for (const [k, v] of Object.entries(perModel)) {
      const n = norm(k);
      if (!n || !(target === n || target.startsWith(n))) continue;
      const value = Math.max(0, Number(v) || 0);
      if (!best || n.length > best.len) best = { len: n.length, value };
    }
    if (best) return best.value;
    return cfg.maxMaxTokens === undefined ? 0 : Math.max(0, Number(cfg.maxMaxTokens) || 0);
  }

  /**
   * 「目录里有、但打不通」的完整清单。
   *
   * 探测结果和池子的学习记录合并去重 —— 只报探测结果的话，运行期新发现的
   * 打不通模型要等下次探测才可见；只报学习记录的话，开机那一刻是空的
   * （而客户端恰恰是那时候读列表）。
   */
  function listUnavailableModels() {
    const set = new Set(pool.unavailableModels());
    for (const m of ctx.modelProbe?.unavailable || []) set.add(m);
    return [...set].sort();
  }

  /**
   * 一次成功的请求 = 这个模型确实能用。
   *
   * 权限是活的（运营可能刚给这个号开了某个模型），所以探测出来的黑名单
   * 必须能被一次真实成功撤销 —— 否则探测那一刻没权限的模型就永远列不出来了。
   */
  function markModelUsable(cred, model) {
    pool.markOk(cred, model);
    if (ctx.modelProbe?.clear(model)) {
      log.info('这个模型这次打成功了，已从"打不通"名单里撤掉', { model });
    }
  }

  async function refreshUpstreamCatalog() {
    const cred = pool.pick(null);
    if (!cred) return false;
    try {
      const res = await fetch(`${trimSlash(cred.baseUrl)}/models`, {
        headers: { ...cred.headers, Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const info = classifyUpstream(res.status, text);
        if (info.authFailed) pool.markAuthFailed(cred, info.message);
        log.warn('拉取上游模型列表失败', { status: res.status, code: info.code });
        return false;
      }
      const doc = await res.json();
      const list = Array.isArray(doc?.data) ? doc.data : Array.isArray(doc) ? doc : [];
      const before = registry.ids().join(',');
      registry.setUpstream(list);
      /*
       * 只在目录**真的变了**的时候说一声。
       *
       * 原来这行是无条件的，而这里是 45 秒一轮的定时刷新 —— 内容一字不差也照打。
       * 实测面板那 300 行日志里它占了 22 行（7%），全是噪音；`before` 这个变量本来
       * 就在手边、下面几行就在用它比较，只是没顺手拿来管这一行。
       */
      const changed = registry.ids().join(',') !== before;
      if (changed) log.info('上游模型列表已更新', { count: list.length });
      // 目录变了 → 「模型不行」的旧结论作废（见 pool.clearModelRejections 的注释）
      if (changed) {
        pool.clearModelRejections((n) => log.info('模型目录变了，已清掉旧的「模型不行」标记', { cleared: n, reason: 'upstream-catalog' }));
      }
      return true;
    } catch (err) {
      log.warn('拉取上游模型列表异常', { error: String(err?.message || err) });
      return false;
    }
  }

  async function runCompletion({ res, body, model, wantStream, apiKey, endpoint, abortSignal, req, requestId = '' }) {
    const startedAt = Date.now();
    const seq = ++chatSeq;
    const rid = requestId || nextRequestId();
    // 同一会话尽量固定到同一个号，命中上游 prefix cache（几万 token 的上下文
    // 换号等于每轮从零 prefill）。没有会话 ID 时按首条消息哈希兜底。
    const sessionKey = sessionAffinityKey(body, model, req);
    /*
     * 日志要用的客户端信息，在这里一次性取好。
     *
     * `req` 是可选参数：只为了日志里的 `src=` / `ua=`。将来若有内部调用（比如探测）不走 HTTP，
     * 传不进来也不影响主流程，照样打 `-`。
     *
     * `effort` 只认请求里带的那个值（`reasoning_effort`），不猜、不从配置里补 ——
     * 日志的作用是记录"客户端要了什么"，补出来的值会让人误判是谁设的。
     */
    const clientSrc = req?.socket?.remoteAddress || '';
    const clientUa = req?.headers?.['user-agent'] || '';
    const requestedEffort = String(body?.reasoning_effort ?? body?.effort ?? '').trim();
    const maxAttempts = Math.max(1, Number(config.upstream.maxRetries) || 1);
    const timeoutMs = Math.max(30, Number(config.upstream.timeoutSeconds) || 600) * 1000;

    /**
     * 下游是不是已经走了。
     *
     * 请求入口只在 `res` 关闭且响应没写完时 abort，reason 固定是 CLIENT_DISCONNECTED；
     * 上游超时用的是 postChat 自己的 controller（reason = `upstream timeout`），
     * 不会把这里的判断污染成"客户端跑了"。
     */
    const clientIsGone = () => !!abortSignal?.aborted && isClientDisconnect(abortSignal.reason);

    /**
     * 慢首包保活（只对流式生效）。
     *
     * 现状：`primeUpstream` 要等上游第一帧才让 `relayPrimed` 发 HTTP 头。上游
     * 首字 p50 3.4s、p90 7.5s，客户端在这段时间里只能干等一个没有响应头的连接；
     * 等不及就断，日志里就是 0 token 的 `client disconnected`。
     *
     * 这里到点先把 200 + SSE 头发出去，再每 10s 补一个 `: ping` 注释帧。
     * 注释帧是合法 SSE，OpenAI 客户端会忽略。此时内部重试照旧可以做 —— 客户端
     * 只是看到连接活着，真正的错误最后会以 `data: {"error":...}` + `[DONE]` 收尾。
     *
     * 设 0 = 关闭（保持旧行为：等首帧再发头）。
     */
    const earlyHeaderMs = Math.max(0, Number(config.upstream.earlyHeaderMs ?? 3000) || 0);
    let heartbeatTimer = null;
    let pingTimer = null;
    const stopHeartbeat = () => {
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
    };
    if (wantStream && earlyHeaderMs > 0) {
      heartbeatTimer = setTimeout(() => {
        heartbeatTimer = null;
        if (res.headersSent || res.writableEnded || res.destroyed) return;
        writeSseHead(res);
        try {
          res.write(': ping\n\n');
        } catch {
          /* 客户端已经走了 */
        }
        pingTimer = setInterval(() => {
          if (res.writableEnded || res.destroyed) {
            stopHeartbeat();
            return;
          }
          try {
            res.write(': ping\n\n');
          } catch {
            stopHeartbeat();
          }
        }, 10000);
        pingTimer.unref?.();
      }, earlyHeaderMs);
      heartbeatTimer.unref?.();
      res.once('close', stopHeartbeat);
      res.once('finish', stopHeartbeat);
    }

    const attempts = [];
    let attemptsLeft = maxAttempts;
    let stripThinking = !!quirksFor(model).noThinking;
    let stripUsed = stripThinking;
    let lastError = null;
    let lastStatus = 502;
    /**
     * 推理模型偶尔会把整个 max_tokens 烧在推理上，正文一个 token 都不剩。
     *
     * ⚠️ **这条重试以前是无效的**：它原样重发**同一个** `max_tokens`，而推理
     *    开销是**随机**的 —— 只要这次的需求超过预算，第二次照样超。
     *    实测（`tools/diag-empty-window.mjs`）：`max_tokens=16/64/256` 三档
     *    各打 12 次，**每档都有 4 次空正文、共 12/36**，而且失败的是**固定的
     *    两个问题**（第 3、5 个 prompt）—— 说明那不是"偶发"，是这些问题的
     *    推理开销稳定地超过预算。日志里能直接看到：
     *    `clientAsked:64, sentToUpstream:1088` → `reasoningTokens:1080` → 正文空。
     *
     *    所以重试必须**把预算真的抬高**，见下面的 `emptyRetryMaxTokens`。
     */
    let emptyRetryUsed = false;
    /**
     * 重试那一发单独用的 `max_tokens`（null = 没触发过重试，按平时的规则算）。
     *
     * 算法：已知这一发用了多少推理 token，留出正文的空间，再和一个地板取大。
     * 取大是为了兜住"第二次推理比第一次还贪"的情况 —— 就算还是被截断，
     * 至少能拿到**部分正文**，而不是继续返回空字符串。
     */
    let emptyRetryMaxTokens = null;
    /**
     * 客户端自己给的 `max_tokens`（没给就是 null）。
     *
     * 用来判断"空正文是不是客户端要的东西"：给 <16 的请求本来就会被原样透传
     * （见 upstream.mjs 的 TINY_MAX_TOKENS），上游把预算全花在推理上、正文为空
     * 是**每一次都这样**的稳定行为，重试纯属浪费。实测漏了这个判断之后，
     * 日志里会刷出一堆"重打一次"却什么都没变的 WARN。
     */
    const rawMax = Number(body.max_tokens);
    const clientMaxTokensForRetry = Number.isFinite(rawMax) && rawMax < TINY_MAX_TOKENS ? rawMax : null;
    // 重试时的两个数：地板（保底）和留给正文的余量（在已知推理开销之上再加）
    const retryFloor = Math.max(0, Number(config.models?.emptyRetryFloorTokens) || 2048);
    const retryContentRoom = Math.max(0, Number(config.models?.emptyRetryContentTokens) || 512);

    /**
     * 当前这一发占着哪个号。
     *
     * 每一轮开头先还上一发的在途计数；整个循环外面再包一层 finally，
     * 保证「客户端断开 / 模型不可用 / 直接 return」这些提前退出也不会漏还。
     */
    let currentCred = null;
    try {
      while (attemptsLeft > 0) {
      if (currentCred) {
        pool.release(currentCred);
        currentCred = null;
      }
      attemptsLeft -= 1;
      const attemptNo = attempts.length + 1;
      const cred = await pool.acquire(model, { sessionKey, trackInFlight: true });
      currentCred = cred;
      if (!cred) {
        return openAiError(
          '凭据池为空：打开控制台「号池」页点「换个账号登录」即可（不需要 OfficeAce 桌面端）；' +
          '也可以「导入账号」贴一份 baseUrl + Authorization，或在 config.json 里手工填 upstream.baseUrl / upstream.authorization',
          { status: 503, type: 'no_credential', code: 'no_credential' },
        );
      }

      const upstreamBody = buildUpstreamBody(body, model, {
        alwaysStream: true,
        includeUsage: config.upstream.includeUsage !== false,
        stripThinking,
        // 推理模型的下限抬升。全局一个数就够用：不给下限的话，客户端按
        // 老习惯给的 max_tokens:64 会被推理全吃掉，正文是空的（见 upstream.mjs 注释）。
        minMaxTokens: bumpMaxTokensFor(model),
        // 追加完再夹一道上游上限。缺了这行，客户端给 max_tokens=393216（就是上游
        // 上限）时会被加 1024 顶成 394240，上游直接 400，而且是确定性失败。
        maxMaxTokens: maxTokensCeilingFor(model),
        // 重试那一发用抬高后的预算（否则就是原样重发一遍，见 emptyRetryMaxTokens 的注释）
        exactMaxTokens: emptyRetryMaxTokens,
      });
      // 标记要当场摘掉 —— 留在 body 里会被原样发给上游
      const bumpNote = takeBumpNote(upstreamBody);
      if (bumpNote?.clamped) {
        // 夹上限和"抬下限"是两回事，分开记账，别让下面那条日志说谎
        if (!clampWarned.has(model)) {
          clampWarned.add(model);
          log.info('客户端要的 max_tokens 超过上游上限，已夹到上限', {
            model,
            clientAsked: bumpNote.from,
            sentToUpstream: bumpNote.to,
          });
        }
      } else if (bumpNote && !bumpWarned.has(model)) {
        bumpWarned.add(model);
        log.info('这个模型会先推理再作答，已把过小的 max_tokens 抬到下限', {
          model,
          clientAsked: bumpNote.from,
          sentToUpstream: bumpNote.to,
        });
      }

      let handle;
      try {
        handle = await postChat(cred, upstreamBody, {
          timeoutMs,
          extraHeaders: config.upstream.extraHeaders || {},
          signal: abortSignal,
        });
      } catch (err) {
        const message = String(err?.message || err);
        // 客户端自己断的：不是上游连接失败，别罚凭据、别打 WARN、更别重试。
        if (isClientDisconnect(err) || clientIsGone()) {
          stopHeartbeat();
          log.info('客户端已断开，取消上游请求（不是上游故障）', {
            seq,
            rid,
            model,
            stage: 'connect',
            elapsedMs: Date.now() - startedAt,
            src: clientSrc,
            ua: clientUa,
          });
          return null;
        }
        pool.markFailed(cred, message);
        lastError = message;
        lastStatus = 502;
        attempts.push({ attempt: attemptNo, cred: cred.baseUrl, error: message });
        log.warn('上游连接失败', {
          seq,
          rid,
          model,
          error: message,
          elapsedMs: Date.now() - startedAt,
          src: clientSrc,
          ua: clientUa,
        });
        await sleep(backoffMs(Number(config.upstream.retryBackoffMs) || 1000, attemptNo));
        continue;
      }

      const upstreamRes = handle.res;

      if (!upstreamRes.ok) {
        const text = await upstreamRes.text().catch(() => '');
        const retryAfterMs = retryAfterMsOf(upstreamRes.headers);
        handle.cleanup();
        const info = classifyUpstream(upstreamRes.status, text);
        lastError = info.message;
        lastStatus = info.requestTooLarge
          ? 413
          : info.rateLimited
            ? 429
            : info.authFailed
              ? 401
              : info.badRequest
                ? 400
                : 502;
        attempts.push({
          attempt: attemptNo,
          cred: cred.baseUrl,
          status: upstreamRes.status,
          code: info.code,
          error: info.message,
        });

        if (info.modelRejected) {
          // 「上游不认这个模型」：只冷却这一对组合，**不碰整条凭据**。
          // 换号也救不了（名字不对 / 没权限是账号级的现实），所以如果池里
          // 每个号都已经拒绝过它，就直接收工，别再花重试配额。
          const av = pool.markModelRejected(cred, model, info.message);
          if (av.modelUnavailable) {
            const hint =
              av.cooled > 1
                ? `池里 ${av.cooled} 条凭据都拒绝过这个模型`
                : '上游拒绝了这个模型';
            log.warn('这个模型在当前号池里没有可用的凭据', { model, cooled: av.cooled });
            return openAiError(`${hint}：${info.message}`, {
              status: 400,
              type: 'invalid_request_error',
              code: 'model_not_available',
              param: 'model',
            });
          }
          // 别的号可能没拒绝过 → 换一条再试
          continue;
        }

        if (info.authFailed) {
          pool.markAuthFailed(cred, info.message);
          ctx.requestRediscover('auth_failed');
        } else if (info.requestTooLarge) {
          // 请求体太大是**确定性**的：body 不变，换个号、换个时间都一样被拒。
          // 而且重试要把整个 body 再传一遍（实测那次 5.5MB），纯属烧带宽。
          // 连"记一笔失败"都不做 —— 这不是凭据的错。
          log.warn('请求超过上游上限（messages 条数太多），直接回给客户端，不再重试', {
            model,
            code: info.code,
            message: info.message,
          });
          return openAiError(
            `${info.message}（这个请求的对话历史太长了：上游对 messages 条数有上限` +
              '（实测 5000 条，跟 token 数无关）。把历史清短一些 —— 是减少消息条数，' +
              '光把每条改短没用 —— 再试。）',
            { status: 413, type: 'invalid_request_error', code: 'request_too_large' },
          );
        } else if (info.rateLimited) {
          pool.markRateLimited(cred, model, info.message, retryAfterMs);
        } else if (info.badRequest) {
          // 400 是请求级错误：同样的 body 换号也过不了，不能拿它罚账号。
          // 尤其 `unsupportedParam` 的剥离重试：一次坏参数不该攒进熔断计数。
          log.info('上游 4xx 请求错误，不计入账号熔断', { model, code: info.code, message: info.message });
        } else {
          pool.markFailed(cred, info.message);
        }

        if (info.badRequest && info.unsupportedParam && !stripUsed) {
          stripThinking = true;
          stripUsed = true;
          attemptsLeft += 1;
          log.info('上游拒绝扩展参数，剥离后重试', { model, message: info.message });
          continue;
        }

        // 400 类是确定性失败：请求体每次一模一样，换个凭据再打也不会变。
        //
        // 以前这里会老老实实退避重试满 3 次 —— 实测一个 n=2 / max_tokens=-5
        // 这种必败请求要白打上游 3 遍、多等 1.5s+2.5s，烧的还是这个号共享的
        // TPM 额度。现在直接把上游的原话回给客户端。
        if (info.badRequest) {
          log.warn('上游明确拒绝这个请求，不再重试', { model, code: info.code, message: info.message });
          break;
        }

        await sleep(backoffMs(Number(config.upstream.retryBackoffMs) || 1000, attemptNo));
        continue;
      }

      let primed;
      try {
        primed = await primeUpstream(upstreamRes, { timeoutMs: Math.min(timeoutMs, 90000) });
      } catch (err) {
        handle.cleanup();
        if (isClientDisconnect(err) || clientIsGone()) {
          stopHeartbeat();
          log.info('客户端已断开，停止等待首包（不是上游故障）', {
            seq,
            rid,
            model,
            stage: 'prime',
            elapsedMs: Date.now() - startedAt,
            src: clientSrc,
            ua: clientUa,
          });
          return null;
        }
        const message = String(err?.message || err);
        pool.markFailed(cred, message);
        lastError = message;
        lastStatus = 502;
        attempts.push({ attempt: attemptNo, cred: cred.baseUrl, error: message });
        log.warn('上游首包读取失败', {
          seq,
          rid,
          model,
          error: message,
          elapsedMs: Date.now() - startedAt,
          src: clientSrc,
          ua: clientUa,
        });
        await sleep(backoffMs(Number(config.upstream.retryBackoffMs) || 1000, attemptNo));
        continue;
      }

      if (primed.kind === 'error') {
        handle.cleanup();
        const info = classifyUpstream(info_statusOf(primed.payload), JSON.stringify(primed.payload));
        lastError = info.message;
        // 请求体太大是确定性的，重试只会把整个 body 再传一遍（实测 5.5MB），
        // 所以这一档也不重试 —— 状态码给 413，让客户端知道该清历史了。
        lastStatus = info.requestTooLarge ? 413 : info.rateLimited ? 429 : 502;
        attempts.push({ attempt: attemptNo, cred: cred.baseUrl, code: info.code, error: info.message });
        if (info.requestTooLarge) {
          // 上游有时会用 HTTP 200 包着错误体回（这一段就是兜这种情况）。
          // 请求体太大是确定性的，重试只会再传一遍整个 body。
          log.warn('请求超过上游上限（以 200 包错误体返回），不再重试', { model, code: info.code });
          break;
        }
        if (info.badRequest) {
          log.warn('上游明确拒绝这个请求，不再重试', { model, code: info.code, message: info.message });
          break;
        }
        if (info.rateLimited) pool.markRateLimited(cred, model, info.message);
        else pool.markFailed(cred, info.message);
        log.warn('上游以 200 返回错误体', { model, code: info.code, message: info.message });
        await sleep(backoffMs(Number(config.upstream.retryBackoffMs) || 1000, attemptNo));
        continue;
      }

      if (wantStream) {
        // 已经有数据了，不用再发心跳；relayPrimed 会接着往同一个响应写。
        stopHeartbeat();
        const result = await relayPrimed(primed, res, { model, signal: abortSignal, startedAt });
        handle.cleanup();
        // 首包时间只在这一发真的拿到字节时才有意义；客户端秒断传 0，别污染 EWMA。
        pool.release(cred, result.firstDataAt ? result.firstDataAt - startedAt : 0, model);
        currentCred = null;

        if (result.clientGone || clientIsGone()) {
          // 客户端自己走了：不 markFailed、不记 usage 失败，也不打 WARN。
          log.info('客户端已断开，停止转发（不是上游故障）', {
            seq,
            rid,
            model,
            stage: 'stream',
            tokens: result.tokens,
            elapsedMs: Date.now() - startedAt,
            src: clientSrc,
            ua: clientUa,
          });
          return null;
        }

        if (result.error) {
          // 字节已经透传出去了（客户端能看见那个 error 帧），没法再重试；
          // 但池子和统计必须按失败记，否则这个正在限流的凭据不会冷却，
          // 下一个请求还会挑到它，然后继续报同样的错。
          const info = classifyUpstream(200, JSON.stringify({ error: result.error }));
          if (info.rateLimited) pool.markRateLimited(cred, model, info.message);
          else if (!info.badRequest) pool.markFailed(cred, info.message);
          else log.info('流内 4xx 请求错误，不计入账号熔断', { model, code: info.code, message: info.message });
          usage.record({
            model,
            apiKey,
            usage: result.usage,
            ok: false,
            error: info.message,
            latencyMs: Date.now() - startedAt,
            stream: true,
            endpoint,
            credential: cred.baseUrl,
          });
          log.warn('流式过程中上游返回错误体', {
            model,
            code: info.code,
            message: info.message,
            rateLimited: info.rateLimited,
          });
          return null;
        }

        if (result.truncated || result.upstreamError) {
          // 上游把连接掐了。客户端那边已经收到补的错误帧 + [DONE]，
          // 但池子和统计不能记成功 —— 一条断掉的流记成 ok，
          // 会让这个其实不健康的凭据一直被认为可用。
          const msg = result.upstreamError || '上游连接中途断开，这条回复不完整';
          pool.markFailed(cred, msg);
          usage.record({
            model,
            apiKey,
            usage: result.usage,
            ok: false,
            error: msg,
            latencyMs: Date.now() - startedAt,
            stream: true,
            endpoint,
            credential: cred.baseUrl,
          });
          log.warn('上游中途断流', {
            seq,
            rid,
            model,
            error: msg,
            tokens: result.tokens,
            elapsedMs: Date.now() - startedAt,
            src: clientSrc,
            ua: clientUa,
          });
          return null;
        }

        markModelUsable(cred, model);
        usage.record({
          model,
          apiKey,
          usage: result.usage,
          ok: true,
          latencyMs: Date.now() - startedAt,
          stream: true,
          endpoint,
          credential: cred.baseUrl,
        });
        const endedAt = Date.now();
        log.info(
          formatChatLine({
            seq,
            rid,
            startedAt,
            model,
            stream: true,
            status: 200,
            label: ctx.accounts.get(cred.accountId)?.label || '',
            accountId: cred.accountId,
            ttfbMs: result.firstDataAt ? result.firstDataAt - startedAt : null,
            outTokens: result.usage?.completion_tokens ?? null,
            tps: calcTps(result.usage, startedAt, result.firstDataAt, endedAt),
            effort: requestedEffort,
            totalMs: endedAt - startedAt,
            src: clientSrc,
            ua: clientUa,
            attempt: attemptNo,
          }),
        );
        // 推理模型把预算全烧在推理上时，流里只有 reasoning_content、正文一个字都没有。
        // 客户端那边就是"转完圈什么都没显示"。这里记一条，让日志能解释这个现象。
        if (
          isReasoningModel(model) &&
          !result.contentChars &&
          !result.sawToolCalls &&
          result.finishReason === 'length'
        ) {
          log.warn('流式回复正文是空的（推理把 token 用完了）', {
            model,
            reasoningChars: result.reasoningChars,
            tokens: result.usage?.total_tokens ?? null,
            hint: '让客户端把 max_tokens 调大，或把 config.models.minMaxTokens 调大',
          });
        }
        return null;
      }

      const agg = await aggregatePrimed(primed, { model });
      handle.cleanup();
      pool.release(cred, 0, model);
      currentCred = null;

      // 客户端在等整段聚合时断开：不是上游失败，别重试、别罚凭据。
      if (clientIsGone() || isClientDisconnect(agg.upstreamError)) {
        stopHeartbeat();
        log.info('客户端已断开，放弃非流式请求（不是上游故障）', {
          seq,
          rid,
          model,
          stage: 'aggregate',
          elapsedMs: Date.now() - startedAt,
          src: clientSrc,
          ua: clientUa,
        });
        return null;
      }

      // 上游在流中间失败，有三种形态：
      //   1) 中途回了个 error 帧（伪 200 的第二种形态）
      //   2) 连接被掐断（read 抛错）
      //   3) 既没 [DONE] 也没 finish_reason 就结束了
      // 三种都不能当成正常回复 —— 以前只看第 1 种的影子都不看，
      // 于是返回一条 content:"" + finish_reason:"stop" 的空回复还记成功。
      const aggFailure = agg.error
        ? { error: agg.error }
        : agg.upstreamError || agg.truncated
          ? {
              error: {
                code: 'UPSTREAM_TRUNCATED',
                message: agg.upstreamError || '上游连接中途断开，这条回复不完整',
              },
            }
          : null;

      if (aggFailure) {
        // 非流式还没往外写任何东西，所以可以照常重试。
        const info = classifyUpstream(200, JSON.stringify(aggFailure));
        lastError = info.message;
        lastStatus = info.rateLimited ? 429 : 502;
        attempts.push({ attempt: attemptNo, cred: cred.baseUrl, code: info.code, error: info.message });
        if (info.rateLimited) pool.markRateLimited(cred, model, info.message);
        else if (!info.badRequest) pool.markFailed(cred, info.message);
        else log.info('上游流内 4xx 请求错误，不计入账号熔断', { model, code: info.code, message: info.message });
        log.warn('上游流中途以 200 返回错误体', {
          model,
          code: info.code,
          message: info.message,
          rateLimited: info.rateLimited,
        });
        await sleep(backoffMs(Number(config.upstream.retryBackoffMs) || 1000, attemptNo));
        continue;
      }

      const payload = agg.payload;

      /**
       * 重试也救不回来的那种：第二次仍然把新预算全烧在推理上。
       *
       * 单独记一条 WARN —— 否则客户端拿到 200 + 空正文，日志里只有一条
       * "重打一次"，看不出最后到底成没成。实测（`tools/diag-empty-window.mjs`，
       * 48 次要撞到 1 次）失败的那一发推理字符数到 13500，就算把重试预算
       * 再翻一倍也未必兜得住，而代价是每次正常请求都得等更久。
       * 所以这里选择**记下来**而不是继续无脑加预算。
       */
      if (
        emptyRetryUsed &&
        !String(payload.choices?.[0]?.message?.content || '').length &&
        !payload.choices?.[0]?.message?.tool_calls &&
        payload.choices?.[0]?.finish_reason === 'length' &&
        (payload.usage?.completion_tokens_details?.reasoning_tokens || 0) > 0
      ) {
        log.warn('重试还是被推理吃光了预算，正文依旧是空的（这一发只能这样了）', {
          model,
          reasoningTokens: payload.usage.completion_tokens_details.reasoning_tokens,
          maxTokens: emptyRetryMaxTokens || Number(body.max_tokens),
          hint: '可以调大 config.models.emptyRetryFloorTokens 试试；或者让客户端把 max_tokens 给大一点',
        });
      }

      /**
       * 推理模型把预算全烧在推理上时，正文是空的、finish_reason 是 length。
       * 客户端拿到 200 + 空正文，除了以为反代坏了没法有别的想法 —— 而换一次
       * 通常就好了（推理长度是随机的）。
       *
       * 判据写得很具体，只认这一种情况：
       *   · 正文一个字符都没有
       *   · 也没有 tool_calls（只有 tool_calls、没正文是**正常**的回复）
       *   · finish_reason 是 length（是被预算截断的，不是正常收尾）
       *   · 而且确实产生了推理 token（证明预算真的花在推理上了）
       * 四条同时成立才重试，所以不会吃掉客户端真的要的短回答
       * （真短回答 finish_reason 是 stop）。
       *
       * 整个请求只重试一次，免得客户端卡在里面反复等。
       */
      if (
        !emptyRetryUsed &&
        // 客户端要的就是"极小输出"（<16 个 token）时不重试 —— 那多半正是它想要的结果，
        // 而且重试也没用：不追加推理预算的话上游每次都把预算全花在推理上（实测
        // max_tokens=1/2/5/15 输出就是 1/2/5/15 个推理 token、正文为空，非常稳定）。
        // 之前漏了这一条，日志里刷出一堆"重打一次"却毫无效果的 WARN。
        clientMaxTokensForRetry === null &&
        !String(payload.choices?.[0]?.message?.content || '').length &&
        !payload.choices?.[0]?.message?.tool_calls &&
        payload.choices?.[0]?.finish_reason === 'length' &&
        (payload.usage?.completion_tokens_details?.reasoning_tokens || 0) > 0
      ) {
        emptyRetryUsed = true;
        const rt = payload.usage.completion_tokens_details.reasoning_tokens;
        // 真的抬高预算再打 —— 原样重发是无效的，原因见 emptyRetryMaxTokens 的注释
        const sentBefore = emptyRetryMaxTokens || bumpMaxTokensFor(model) + (Number(body.max_tokens) || 0);
        emptyRetryMaxTokens = Math.max(retryFloor, rt + retryContentRoom);
        log.warn('这个模型把 token 全用在推理上了，正文为空，抬高预算重打一次', {
          model,
          reasoningTokens: rt,
          completionTokens: payload.usage?.completion_tokens,
          maxTokensBefore: sentBefore,
          maxTokensRetry: emptyRetryMaxTokens,
        });
        attempts.push({ attempt: attemptNo, cred: cred.baseUrl, code: 'EMPTY_CONTENT_RETRY', error: `推理用掉 ${rt} token，没留下正文` });
        // 不算这条凭据的错，标记 ok。
        // ⚠️ 这里**不能**用 markModelUsable：这次是"空正文"，它只证明
        // 凭据没坏，不证明模型列得出来（探测黑名单不该被它撤销）。
        pool.markOk(cred, model);
        await sleep(backoffMs(Number(config.upstream.retryBackoffMs) || 1000, attemptNo));
        // 把这一次的配额还回去：重试是替客户端兜底，不该多扣它的重试次数
        attemptsLeft += 1;
        continue;
      }

      markModelUsable(cred, model);
      usage.record({
        model,
        apiKey,
        usage: payload.usage,
        ok: true,
        latencyMs: Date.now() - startedAt,
        stream: false,
        endpoint,
        credential: cred.baseUrl,
      });
      log.info(
        formatChatLine({
          seq,
          rid,
          startedAt,
          model,
          stream: false,
          status: 200,
          label: ctx.accounts.get(cred.accountId)?.label || '',
          accountId: cred.accountId,
          // 非流式没有"首字"这个概念，整段一次到齐 → TTFB 留 `-`，tps 也留 `-`
          //（拿墙钟当分母算出来的是"含排队+首字的速率"，不是生成速度）
          ttfbMs: null,
          outTokens: payload.usage?.completion_tokens ?? null,
          tps: null,
          effort: requestedEffort,
          totalMs: Date.now() - startedAt,
          src: clientSrc,
          ua: clientUa,
          attempt: attemptNo,
        }),
      );
      if (!res.headersSent) {
        res.setHeader('Server-Timing', `total;dur=${Date.now() - startedAt}`);
      }
      return { status: 200, body: payload };
      }
    } finally {
      if (currentCred) pool.release(currentCred);
    }

    stopHeartbeat();

    // 重试都打完了，但客户端早就走了：没有可写的地方，也別记一条假失败。
    if (clientIsGone()) {
      log.info('客户端已断开，放弃本次请求（不是上游故障）', {
        seq,
        rid,
        model,
        stage: 'final',
        elapsedMs: Date.now() - startedAt,
        src: clientSrc,
        ua: clientUa,
      });
      return null;
    }

    usage.record({
      model,
      apiKey,
      usage: null,
      ok: false,
      latencyMs: Date.now() - startedAt,
      stream: wantStream,
      endpoint,
      error: lastError || 'all attempts failed',
    });

    const type =
      lastStatus === 429 ? 'rate_limit_error'
      : lastStatus === 401 ? 'authentication_error'
      : lastStatus === 413 ? 'invalid_request_error'
      : 'upstream_error';
    // 只打了一次的话就别写「已尝试 1 次」了 —— 那会让客户端以为还有别的原因，
    // 其实上游已经把话说得很清楚了。
    const tried = attempts.length > 1 ? `（已尝试 ${attempts.length} 次）` : '';
    const err = openAiError(`上游请求失败${tried}: ${lastError || '未知错误'}`, {
      status: lastStatus,
      type,
      code:
        lastStatus === 400 ? 'invalid_request_error'
        : lastStatus === 413 ? 'request_too_large'
        : 'upstream_failed',
    });
    err.body.attempts = attempts;
    err.body.request_id = rid;

    /*
     * 慢首包看门狗已经把 `200 + SSE 头` 发出去了，状态码改不了：
     * 只能按 SSE 的规矩补一个错误帧 + [DONE]，别让客户端拿着半截流干等。
     */
    if (res.headersSent) {
      try {
        res.write(`data: ${JSON.stringify(err.body)}\n\ndata: [DONE]\n\n`);
      } catch {
        /* 客户端已经走了 */
      }
      if (!res.writableEnded) res.end();
      return null;
    }

    return err;
  }

  /**
   * 主模型失败后的兜底。只在响应尚未开始时重跑，避免和已经发出的
   * SSE 头/半截正文打架。默认关闭：`models.fallback` 为空就不做任何事。
   */
  async function runWithFallback(args) {
    const first = await runCompletion(args);
    if (!first) return null;

    const status = Number(first.status);
    if (![429, 500, 502, 503].includes(status) || args.fallbackDepth) return first;
    if (args.res?.headersSent) return first;

    const requested = String(args.requestedModel || args.model || '');
    const chain = config.models?.fallback?.[requested] ?? config.models?.fallback?.[args.model] ?? [];
    if (!Array.isArray(chain) || !chain.length) return first;

    const known = new Set(registry.ids());
    for (const candidate of chain) {
      const next = registry.resolve(candidate);
      if (!next || next === args.model || !known.has(next)) continue;
      log.info('主模型失败，尝试兜底模型', {
        from: args.model,
        to: next,
        status,
        requestId: args.requestId,
      });
      args.res?.setHeader('X-Fallback-Model', next);
      return runCompletion({ ...args, model: next, fallbackDepth: 1 });
    }
    return first;
  }

  const server = http.createServer({ maxHeaderSize: 64 * 1024 }, async (req, res) => {
    // 请求 ID 从一开始就定下来：客户端报错时把这行响应头贴过来，
    // 就能在日志里精确找到这一次请求（seq 进程重启会归零，rid 不会）。
    const rid = nextRequestId();
    res.setHeader('X-Request-Id', rid);

    // 超长 URL 直接 414 收场。
    //
    // `new URL()` 对几 MB 的 URL 既慢又吃内存，而且 request-line 已经超过
    // Node 自己的 maxHeaderSize（默认 16KB）——那种情况连接会被直接掐断，
    // 客户端只看到 ECONNRESET，完全不知道为什么。这里主动答一个 JSON 错误，
    // 把「为什么失败」说清楚。8KB 是宽松上限，正常请求（含 query 里的长 prompt）
    // 都远达不到。
    if (typeof req.url === 'string' && req.url.length > MAX_URL_LENGTH && req.url.length < 15 * 1024) {
      sendJson(res, 414, {
        error: {
          message: `请求地址太长（${req.url.length} 字节，上限 ${MAX_URL_LENGTH}）。请把参数放到请求体里。`,
          type: 'invalid_request_error',
          code: 'uri_too_long',
        },
      });
      return;
    }

    let pathname = '/';
    // 顺手把 query 也留下：面板要用 URL 上的 `?token=` 认人（见下面管理面板那段）。
    // 以前这里只取了 `pathname`，query 直接丢掉 —— 于是 `/admin?token=xxx`
    // 解析出来的 pathname 是 `/admin`，token 却没人看得到，必然 401。
    let query = new URLSearchParams();
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      pathname = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
      query = parsed.searchParams;
    } catch {
      pathname = '/';
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      res.end();
      return;
    }

    try {
      // —— 管理面板 ——
      //
      // 口令从**三个地方**认：`x-admin-token` 头（面板 JS 里每条 XHR 都带）、
      // URL 上的 `?token=`（人第一次打开面板时只能这么传）、以及 Cookie。
      //
      // 只认头是个真踩到的坑：启动横幅和下面那条 401 的提示都写着
      // 「/admin?token=你的口令」，可服务端当时只比对请求头 ——
      // 于是**按提示走的人反而进不去**，浏览器地址栏里带着 token 也是 401。
      // 提示文案和实际行为不一致，比没有提示更坑。
      //
      // Cookie 是后加的：`?token=` 会留在浏览器历史里、也会出现在截图里。
      // 所以第一次用 `?token=` 进来时顺手种一个 HttpOnly 的 Cookie，
      // 之后直接开 /admin/ 就能进；地址栏那一份由面板自己用 replaceState 抹掉
      // （见 admin.html 里的 `history.replaceState`）。
      const isAdminRoute = pathname === '/' || pathname === '/admin' || pathname.startsWith('/admin/');
      if (isAdminRoute && config.admin?.token) {
        const fromQuery = query.get('token') || '';
        const fromHeader = String(req.headers['x-admin-token'] || '');
        const fromCookie = cookieValue(req.headers.cookie, ADMIN_COOKIE);
        const pass =
          fromQuery === config.admin.token ||
          fromHeader === config.admin.token ||
          fromCookie === config.admin.token;
        if (!pass) {
          sendJson(res, 401, {
            error: {
              message: '管理员 token 无效。请在面板地址后加 ?token=你的口令（成功进一次之后浏览器会记住）',
              type: 'authentication_error',
            },
          });
          return;
        }
        // 用 URL 口令进来的这一次，把它换成 Cookie。HttpOnly 是故意的：
        // 面板 JS 读不到，也就不可能被脚本顺手发到别处去。
        if (fromQuery === config.admin.token && fromCookie !== config.admin.token) {
          res.setHeader(
            'Set-Cookie',
            `${ADMIN_COOKIE}=${encodeURIComponent(config.admin.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
          );
        }
      }

      if (config.admin?.enabled !== false && (pathname === '/' || pathname === '/admin' || pathname === '/admin/')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(adminHtml());
        return;
      }

      if (pathname === '/admin/api/state') {
        const creds = pool.list();
        const accountsView = ctx.accounts.list();
        /*
         * 快照只取一次。
         *
         * 原来这里写着 `usage.snapshot()` 两遍（一次给 `usage`、一次取 `.recent`），
         * 每次都要深拷贝 200 条调用记录 —— 面板每 3 秒来一次，等于白白多干一倍的活。
         *
         * 更要紧的是**同一份数据被装了两遍**：`usage.recent`（上限 200 条）和顶层
         * `recent`（面板真正用的那个）内容几乎一样，实测这份重复占了 115KB 载荷的 26%。
         * 面板从头到尾只读顶层 `recent`（见 admin.html 的 renderCalls / renderOverview），
         * `usage.recent` 一次都没用过，所以这里直接摘掉。
         */
        const snap = usage.snapshot();
        const { recent: recentRows, ...usageSlim } = snap;
        sendJson(res, 200, {
          health: {
            uptimeMs: Date.now() - ctx.startedAt,
            baseUrl: creds[0]?.baseUrl || config.upstream.baseUrl || '',
            defaultModel: registry.defaultModel(),
            version: ctx.version,
            startedAt: new Date(ctx.startedAt).toISOString(),
            // 面板据此判断能不能一次提交多个 id（旧版服务端只认单个 id / 全部）
            batchActions: true,
            // 目录里有、但打不通的模型。两个来源合并：
            //   ① 主动探测（开机后台跑一遍，写进 data/model-probe.json）
            //   ② 学习到的（某条模型被池里所有凭据拒过）
            // 面板拿它来提醒用户「这些别试了」，见 admin.html 的 #mdlUnavail。
            modelsUnavailable: listUnavailableModels(),
            // 探测本身的状态，面板用来显示「上次探测于 …」
            modelProbe: ctx.modelProbe?.stats?.() || null,
          },
          config,
          pool: creds,
          poolStats: pool.stats(),
          models: registry.detailed(),
          usage: usageSlim,
          recent: recentRows,
          /*
           * 日志只给尾部 60 条 + 序号，剩下的靠 `/admin/api/logs?since=` 增量补。
           *
           * 整包搬 300 行的年代，`logs` 单独占了载荷的 30%（34KB，满载能到 62KB），
           * 而面板一次只看得见一屏、绝大多数轮询期间一行都不会变。
           */
          logs: getRecentLogs(STATE_LOG_TAIL),
          logSeq: getLogSeq(),
          accounts: accountsView,
          accountsStatus: ctx.accounts.status(),
          credits: ctx.credits ? ctx.credits.view() : null,
          auth: {
            app: ctx.authFlow.appStatus(),
            tasks: ctx.authFlow.list(),
          },
          register: {
            stats: ctx.register.stats(),
            tasks: ctx.register.list(),
          },
        });
        return;
      }

      /*
       * 日志增量：`GET /admin/api/logs?since=<序号>`
       *
       * 面板每 3 秒轮询时先看 state 里的 `logSeq`，比手里的序号大才来这儿要新增的那几条。
       * 稳态下这个响应通常只有几百字节到一两 KB（一行式格式之后更小），
       * 对比过去每次整包搬 300 行 —— 那是面板载荷的三成。
       */
      if (pathname === '/admin/api/logs') {
        const since = new URL(req.url, 'http://localhost').searchParams.get('since');
        sendJson(res, 200, getLogsSince(since, 300));
        return;
      }

      if (pathname === '/admin/api/config' && req.method === 'POST') {
        const patch = await readJson(req);
        const restartRequired = [];
        const prevListen = { ...config.listen };

        for (const key of ['listen', 'upstream', 'quota', 'log', 'models', 'admin', 'discover', 'credits']) {
          if (patch[key] && typeof patch[key] === 'object') {
            config[key] = { ...config[key], ...patch[key] };
          }
        }
        // `discover.enabled` 要立刻生效：扫盘每 45 秒跑一轮，晚一步就等于"刚关掉又被扫了一轮"。
        if (patch.discover && typeof ctx.setMachineScanEnabled === 'function') {
          ctx.setMachineScanEnabled(config.discover?.enabled !== false);
          log.info('本机扫描开关已更新', { enabled: config.discover?.enabled !== false });
        }
        // ⚠️ 别让配置接口把 API Key 列表写成空数组。
        //
        // `apiKeys: []` 在 checkAuth 里是「不校验」的意思，看着好像更宽松；
        // 但它**同时**意味着接下来任何一次 `saveConfig(config)` 都会把
        // config.json 里的 key 列表**永久清空**。而空列表还有个更坏的效应：
        // 面板/截图脚本"先加一个测试 key、再清空输入框"这类操作一旦撞上，
        // 线上用的那个 key 就再也对不上了（实测遇到过同一把 key 间歇性 401）。
        // 想关掉鉴权请显式写 `admin.disableAuth`，不要靠清空列表。
        if (Array.isArray(patch.apiKeys)) {
          const next = patch.apiKeys.map((s) => String(s).trim()).filter(Boolean);
          if (!next.length && (config.apiKeys || []).length) {
            log.warn('拒绝把 apiKeys 清空（会连带写进 config.json），已保持原值', {
              kept: config.apiKeys.length,
            });
          } else if (next.join(',') !== (config.apiKeys || []).join(',')) {
            log.info('API Key 列表已变更', { before: (config.apiKeys || []).length, after: next.length });
            config.apiKeys = next;
          }
        }

        if (config.listen.host !== prevListen.host || config.listen.port !== prevListen.port) {
          restartRequired.push('监听地址/端口');
        }
        if (patch.upstream && ('baseUrl' in patch.upstream || 'authorization' in patch.upstream)) {
          ctx.requestRediscover('config_change');
        }
        if (patch.quota) pool.setCooldowns(config.quota);
        if (patch.pool) pool.setBreakerPolicy(config.pool);
        if (patch.models) registry.apply(config.models);
        if (patch.log?.level) configureLogger({ level: config.log.level, keepRecent: config.log.keepRecent, file: ctx.logFile });

        try {
          saveConfig(config);
        } catch (err) {
          sendJson(res, 500, { error: { message: `写入 config.json 失败: ${err.message}`, type: 'internal_error' } });
          return;
        }
        log.info('配置已更新', { keys: Object.keys(patch), restartRequired });
        sendJson(res, 200, { ok: true, restartRequired, config });
        return;
      }

      /**
       * 手动重探模型可用性。
       *
       * 面板上「模型管理」里那个"重探一遍"按钮用。会真的打上游（每个模型
       * max_tokens:1，成本几乎为零），但慢的模型要等它推理完，所以要 1~2 分钟。
       * 用 `?force=1` 忽略 TTL 与"号池没变"两个跳过条件。
       */
      if (pathname === '/admin/api/models/probe' && req.method === 'POST') {
        if (!ctx.modelProbe) {
          sendJson(res, 503, { error: { message: '模型探测没启用（config.models.probeOnStartup: false）', type: 'not_available' } });
          return;
        }
        const force = new URL(req.url, 'http://x').searchParams.get('force') === '1';
        const r = await ctx.modelProbe.probe({ force: force || req.method === 'POST' });
        sendJson(res, 200, {
          ok: true,
          ...r,
          stats: ctx.modelProbe.stats(),
        });
        return;
      }

      if (pathname === '/admin/api/models' && req.method === 'POST') {
        const body = await readJson(req);
        const idsBefore = registry.ids().join(',');
        registry.apply({
          alias: body.alias && typeof body.alias === 'object' ? body.alias : config.models.alias,
          hidden: Array.isArray(body.hidden) ? body.hidden : config.models.hidden,
          extra: Array.isArray(body.extra) ? body.extra : config.models.extra,
        });
        /**
         * 别名/目录改了 → 「模型不行」的旧结论作废。
         *
         * 这是个**真踩到的坑**：`gpt-4o` 先指向一个打不通的模型（比如 `glm-5.3-zx`），
         * 于是 `gpt-4o` 被打上"不行"的标记；之后把别名改指向能用的 `glm-5.2` ——
         * 标记还留着，`gpt-4o` 照样从 `/v1/models` 里消失，而它明明是好的。
         * 名字被重新定义之后，基于旧定义得出的结论必须作废。
         */
        if (registry.ids().join(',') !== idsBefore) {
          pool.clearModelRejections((n) =>
            log.info('模型别名改过了，已清掉旧的「模型不行」标记', { cleared: n, reason: 'alias-edit' }),
          );
        }
        // ⚠️ 必须用展开把**其它键原样带回去**。
        //
        // 这里以前写的是 `config.models = { alias, hidden, extra }` —— 于是每次在
        // 面板上改一次模型设置，就把 config.models 里别的键（`hideUnavailable`、
        // `minMaxTokens`、`reasoningModels`、`probeOnStartup`…）全抹掉了，
        // 而且**立刻写进 config.json**（下面有 saveConfig）。表现就是
        // "改了次别名，推理预算的功能就没了"，且没有任何报错。
        config.models = {
          ...config.models,
          alias: { ...registry.alias },
          hidden: [...registry.hidden],
          extra: [...registry.extra],
        };
        try {
          saveConfig(config);
        } catch (err) {
          sendJson(res, 500, { error: { message: `写入 config.json 失败: ${err.message}`, type: 'internal_error' } });
          return;
        }
        log.info('模型配置已更新', {
          alias: Object.keys(config.models.alias).length,
          hidden: config.models.hidden.length,
        });
        sendJson(res, 200, { ok: true, models: registry.detailed() });
        return;
      }

      if (pathname === '/admin/api/refresh' && req.method === 'POST') {
        const upstream = await refreshUpstreamCatalog();
        const discovered = ctx.requestRediscover('panel');
        sendJson(res, 200, {
          upstream,
          discovered,
          models: registry.ids().length,
          discoverEnabled: ctx.isMachineScanEnabled ? ctx.isMachineScanEnabled() !== false : true,
        });
        return;
      }

      /**
       * 每个模型的使用倍率（就是「官方客户端里那个 0.30x」）。
       *
       * 数据来自控制面 `GET {网关}/v1/model-token-rates`，`cost_coefficient` 就是倍率。
       * 那个接口要签名（临时 AK/SK），所以不能在浏览器里直连 —— 走这里代理一发。
       *
       * 平时不用单独调：积分刷新时已经把 `rates` 顺手带回来了
       * （见 `quota.mjs` 的 `summary.rates`），面板优先用它。这里是缓存还没热起来
       * （服务刚起、或积分接口刚好失败）时的兜底，保证倍率列不会一片空。
       */
      if (pathname === '/admin/api/model-rates' && req.method === 'GET') {
        const wantId = new URL(req.url, 'http://localhost').searchParams.get('id');
        const ids = wantId ? [String(wantId)] : ctx.accounts.ids();
        const seen = new Map();
        const errors = [];
        for (const id of ids) {
          try {
            const q = await ctx.credits?.get?.(id, { force: false });
            for (const r of q?.rates || []) {
              if (r?.model && !seen.has(r.model)) seen.set(r.model, r);
            }
          } catch (err) {
            errors.push({ id, error: err.message });
          }
        }
        sendJson(res, 200, {
          ok: seen.size > 0,
          count: seen.size,
          rates: [...seen.values()],
          errors,
        });
        return;
      }

      if (pathname === '/admin/api/usage/reset' && req.method === 'POST') {
        usage.reset();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/admin/api/logs/clear' && req.method === 'POST') {
        const cleared = clearRecentLogs();
        sendJson(res, 200, { ok: true, cleared });
        return;
      }

      /* ==================================================== 号池 账号管理 */

      if (pathname === '/admin/api/accounts' && req.method === 'GET') {
        sendJson(res, 200, {
          status: ctx.accounts.status(),
          accounts: ctx.accounts.list(),
        });
        return;
      }

      if (pathname === '/admin/api/accounts/scan' && req.method === 'POST') {
        const accounts = ctx.accounts.scan();
        const added = ctx.requestRediscover('panel-accounts');
        if (ctx.credits) {
          for (const id of ctx.accounts.ids()) {
            if (!ctx.credits.cache.has(id)) ctx.credits.get(id, { force: true }).catch(() => {});
          }
        }
        sendJson(res, 200, {
          ok: true,
          accounts,
          added,
          // 扫描本机被 `discover.enabled: false` 关掉时，面板要能说清"扫了但是没扫本机"，
          // 否则用户看到「0 个账号」会以为是坏了。
          discoverEnabled: ctx.isMachineScanEnabled ? ctx.isMachineScanEnabled() !== false : true,
          status: ctx.accounts.status(),
          credits: ctx.credits ? ctx.credits.view() : null,
        });
        return;
      }

      /* ==================================================== 积分额度 */

      if (pathname === '/admin/api/credits' && req.method === 'GET') {
        if (!ctx.credits) return sendJson(res, 200, { ok: false, error: '积分模块未启用' });
        sendJson(res, 200, { ok: true, ...ctx.credits.view() });
        return;
      }

      // 刷新：{ id } 刷一个，{ ids:[...] } 刷几个，都不传 = 刷全部
      if (pathname === '/admin/api/credits/refresh' && req.method === 'POST') {
        if (!ctx.credits) return sendJson(res, 200, { ok: false, error: '积分模块未启用' });
        const body = await readJson(req).catch(() => ({}));
        const ids = body.id ? [String(body.id)] : Array.isArray(body.ids) && body.ids.length ? body.ids.map(String) : null;
        const results = await ctx.credits.refresh(ids, { force: true });
        const failed = Object.values(results).filter((r) => !r.ok);
        sendJson(res, 200, {
          ok: failed.length === 0,
          refreshed: Object.keys(results).length,
          failed: failed.map((r) => ({ id: r.accountId, error: r.error })),
          ...ctx.credits.view(),
        });
        return;
      }

      // 单个账号的完整快照（含奖励明细、近 30 天用量、费率表）
      if (pathname === '/admin/api/credits/detail' && req.method === 'GET') {
        if (!ctx.credits) return sendJson(res, 200, { ok: false, error: '积分模块未启用' });
        const id = new URL(req.url, 'http://localhost').searchParams.get('id');
        if (!id) return sendJson(res, 400, { error: { message: '缺少 id' } });
        const force = new URL(req.url, 'http://localhost').searchParams.get('force') === '1';
        const data = await ctx.credits.get(id, { force });
        const history = ctx.credits.historyOf(id);
        const claims = ctx.credits.claimHistory(id);
        sendJson(res, 200, { ok: true, account: data, history, claims });
        return;
      }

      /* ==================================================== 签到 / 凭据续期 */

      // 签到领积分：{ id } 签一个，不传 = 全部启用账号
      if (pathname === '/admin/api/credits/claim' && req.method === 'POST') {
        if (!ctx.credits) return sendJson(res, 200, { ok: false, error: '积分模块未启用' });
        const body = await readJson(req).catch(() => ({}));
        const ids = body.id ? [String(body.id)] : Array.isArray(body.ids) && body.ids.length ? body.ids.map(String) : null;
        const targetIds = ids || ctx.accounts.ids().filter((i) => ctx.accounts.get(i)?.enabled);
        const r = body.id
          ? await ctx.credits.claimBonus(String(body.id), { force: body.force === true })
          : ids
            ? await ctx.credits.claimMany(ids, { force: body.force === true })
            : await ctx.credits.claimAll({ force: body.force === true });
        // 签到把缓存清了，这里补刷一次，否则返回的汇总全是 0
        await ctx.credits.refresh(targetIds, { force: true }).catch(() => {});
        sendJson(res, 200, { ...r, ...ctx.credits.view() });
        return;
      }

      // 手动续期某账号的临时凭据（refresh_token → 新 AK/SK）
      if (pathname === '/admin/api/credits/refresh-credential' && req.method === 'POST') {
        if (!ctx.credits) return sendJson(res, 200, { ok: false, error: '积分模块未启用' });
        const body = await readJson(req).catch(() => ({}));
        const force = body.force === true;
        const ids = body.id
          ? [String(body.id)]
          : Array.isArray(body.ids) && body.ids.length
            ? body.ids.map(String)
            : ctx.accounts.ids();
        const results = [];
        for (const id of ids) {
          const acc = ctx.accounts.get(id);
          if (!acc?.profile?.refreshToken) {
            results.push({ id, label: acc?.label || '', ok: false, error: '这个号没有 refresh_token，只能重新登录授权' });
            continue;
          }
          // refresh_token 是一次性的，能不用就不用：现在这套凭据还够用就跳过
          const live = ctx.credits.refreshState.usableCredential(id, { skewMs: 10 * 60 * 1000 });
          if (live && !force) {
            results.push({
              id,
              label: acc.label || '',
              ok: true,
              skipped: true,
              reason: '当前凭据还能用，没必要消耗一次 refresh_token',
              expiresAt: live.expiresAt,
            });
            continue;
          }
          const r = await ctx.credits.refreshCredential(id);
          await ctx.credits.get(id, { force: true }).catch(() => {});
          results.push({ id, label: acc.label || '', ...r });
        }
        sendJson(res, 200, {
          ok: results.some((r) => r.ok),
          results,
          ...ctx.credits.view(),
        });
        return;
      }

      // 签到历史
      if (pathname === '/admin/api/credits/claims' && req.method === 'GET') {
        if (!ctx.credits) return sendJson(res, 200, { ok: false, error: '积分模块未启用' });
        const id = new URL(req.url, 'http://localhost').searchParams.get('id');
        if (id) return sendJson(res, 200, { ok: true, id, ...ctx.credits.claimHistory(id) });
        sendJson(res, 200, {
          ok: true,
          all: ctx.accounts.ids().map((i) => ({ id: i, label: ctx.accounts.get(i)?.label || '', ...ctx.credits.claimHistory(i) })),
        });
        return;
      }

      if (pathname === '/admin/api/accounts/label' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body.id) return sendJson(res, 400, { error: { message: '缺少 id' } });
        // setLabel 现在会挡「形态不像账号」和「号池里不存在」两种 id。
        // 以前不看返回值，于是改一个不存在的号会返回 200「成功」，前端以为改好了。
        if (!ctx.accounts.setLabel(body.id, body.label || '')) {
          return sendJson(res, 404, {
            error: {
              message: '号池里没有这个账号，别名没改（可能是它已经被删掉了）',
              code: 'account_not_found',
            },
          });
        }
        ctx.accounts.save();
        sendJson(res, 200, { ok: true, accounts: ctx.accounts.list() });
        return;
      }

      if (pathname === '/admin/api/accounts/enable' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body.id) return sendJson(res, 400, { error: { message: '缺少 id' } });
        ctx.accounts.setEnabled(body.id, body.enabled !== false);
        // 启停账号会改变可用凭据集合，立刻重算连接池
        const added = ctx.requestRediscover('account-toggle');
        sendJson(res, 200, { ok: true, added, status: ctx.accounts.status(), accounts: ctx.accounts.list() });
        return;
      }

      if (pathname === '/admin/api/accounts/import' && req.method === 'POST') {
        const body = await readJson(req);
        try {
          const id = ctx.accounts.importManual(body);
          ctx.requestRediscover('account-import');
          sendJson(res, 200, { ok: true, id, accounts: ctx.accounts.list() });
        } catch (err) {
          sendJson(res, 400, { error: { message: err.message } });
        }
        return;
      }

      /* ---------------------------------------- 换电脑：整个号池导出 / 导入 */

      // 导出：把本机所有能搬的账号打成包（?pass= 给了就整包加密）。
      //
      // 为什么要一次导出全部而不是逐号导：换电脑时人只会点一次。包里同时带
      // 档案（refresh_token + DPoP 私钥）+ 续期链状态 + 别名/启停，缺一样新机器就得重登。
      // 详见 src/bundle.mjs 顶部那段说明。
      if (pathname === '/admin/api/accounts/export' && req.method === 'GET') {
        const q = new URL(req.url, 'http://localhost').searchParams;
        const pass = String(q.get('pass') || '');
        try {
          const collected = collectAccounts({
            // rawList 是带明文的内部记录；面板那份 list() 是脱敏的，导不出凭据
            accounts: ctx.accounts.rawList(),
            oauthDoc: ctx.accounts.readOauthDoc(),
            refreshDoc: ctx.accounts.refreshState?.doc || {},
            meta: ctx.accounts.meta,
          });
          if (!collected.length) {
            return sendJson(res, 200, {
              ok: false,
              empty: true,
              error: {
                message:
                  '本机没有可导出的账号。先去 OfficeAce 登录一个号，或在面板上「导入账号」，再回来导出。',
              },
            });
          }
          const bundle = buildBundle(
            { accounts: collected, appVersion: ctx.version, host: os.hostname(), user: process.env.USERNAME || '' },
            { pass },
          );
          const body = JSON.stringify(bundle, null, pass ? 0 : 1);
          const name = bundleFileName({ host: os.hostname(), encrypted: !!pass });
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
            // 浏览器会按这个名字存盘；中文名在这里不做（HTTP 头只放 ASCII 更稳）
            'Content-Disposition': `attachment; filename="${name}"`,
            'Cache-Control': 'no-store',
            // 这个响应体里是明文凭据，别让任何中间层缓存
            Pragma: 'no-cache',
          });
          res.end(body);
          log.info('已导出账号搬运包', {
            accounts: collected.length,
            encrypted: !!pass,
            file: name,
            stats: summarizeAccounts(collected),
          });
        } catch (err) {
          log.warn('导出账号搬运包失败', { error: String(err?.message || err) });
          sendJson(res, 500, { error: { message: `导出失败：${err?.message || err}` } });
        }
        return;
      }

      // 导入：body = { bundle: <JSON 文本或对象>, pass?: '口令' }
      //
      // 必须走服务端而不是让工具直接改文件：`data/refresh-state.json` 是
      // 「加载进内存、每次 save() 整份写回」的，外部改了磁盘会被下一轮 save 覆盖掉
      // （表现是"导入成功，重启后没了"）。这里改的是内存里那份，再由它落盘。
      if (pathname === '/admin/api/accounts/import-bundle' && req.method === 'POST') {
        const body = await readJson(req);
        let parsed;
        try {
          parsed = parseBundle(body.bundle === undefined ? body : body.bundle, { pass: String(body.pass || '') });
        } catch (err) {
          return sendJson(res, 400, {
            ok: false,
            needPass: err.code === 'NEED_PASS',
            error: { message: String(err?.message || err) },
          });
        }
        try {
          const merged = mergeBundle(parsed, {
            oauthDoc: ctx.accounts.readOauthDoc(),
            refreshDoc: ctx.accounts.refreshState?.doc || {},
            meta: ctx.accounts.meta,
            // 本机已经能发现的号不重复登记（见 mergeBundle 里 manual 分支那段说明）
            knownIds: new Set(ctx.accounts.ids()),
          });
          if (!ctx.accounts.writeOauthDoc(merged.oauthDoc)) {
            return sendJson(res, 500, { error: { message: '写账号档案失败，见 logs\\server.log' } });
          }
          if (ctx.accounts.refreshState) ctx.accounts.refreshState.replaceDoc(merged.refreshDoc);
          ctx.accounts.meta = merged.meta;
          ctx.accounts.save();
          const accounts = ctx.accounts.scan();
          const added = ctx.requestRediscover('account-import-bundle');
          // 新机器上积分缓存是空的：立刻问一遍，面板不用等下一轮刷新
          if (ctx.credits) {
            for (const r of merged.results) ctx.credits.get(r.id, { force: true }).catch(() => {});
          }
          log.info('已导入账号搬运包', {
            from: parsed.source || '',
            total: merged.results.length,
            added: merged.results.filter((r) => r.action === 'added').length,
            keptLocalChain: merged.results.filter((r) => r.refresh === 'kept-local-chain').length,
          });
          sendJson(res, 200, {
            ok: true,
            results: merged.results,
            stats: parsed.stats || null,
            legacy: parsed.legacy === true,
            warning: ONE_TIME_TOKEN_WARNING,
            added,
            accounts,
            status: ctx.accounts.status(),
          });
        } catch (err) {
          log.warn('导入账号搬运包失败', { error: String(err?.message || err) });
          sendJson(res, 500, { error: { message: `导入失败：${err?.message || err}` } });
        }
        return;
      }

      if (pathname === '/admin/api/accounts/remove' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body.id) return sendJson(res, 400, { error: { message: '缺少 id' } });
        const r = ctx.accounts.remove(body.id);
        if (r.notFound) return sendJson(res, 404, { error: { message: '号池里没有这个账号，可能已经被移除过了' } });
        ctx.requestRediscover('account-remove');
        sendJson(res, 200, {
          ok: true,
          ...r, // 含 removable / ignored:true
          note: r.removable
            ? '已删除'
            : '该账号来自本机 OfficeAce 的文件。本服务不写 OfficeAce 的任何文件，所以做法是把它记进忽略名单：\n' +
              '以后扫盘直接跳过，面板上也不会再出现。想找回来去「配置」页最下面的「已忽略的账号」点恢复。',
          // 注意别叫 ignored —— 上面 ...r 里已经有一个同名的布尔值，
          // 用同名键会把它覆盖掉（踩过一次）。
          ignoredAccounts: ctx.accounts.ignoredList(),
          accounts: ctx.accounts.list(),
        });
        return;
      }

      if (pathname === '/admin/api/accounts/ignored' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, ignored: ctx.accounts.ignoredList() });
        return;
      }

      if (pathname === '/admin/api/accounts/restore' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body.id) return sendJson(res, 400, { error: { message: '缺少 id' } });
        const okRestore = ctx.accounts.restore(body.id, { enable: body.enable !== false });
        if (!okRestore) return sendJson(res, 404, { error: { message: '这个账号不在忽略名单里' } });
        // 立刻重扫一遍，让号马上就回到列表上，不用等 45 秒那一轮
        ctx.requestRediscover('account-restore');
        sendJson(res, 200, {
          ok: true,
          note: '已恢复，正在重新扫描；几秒后就会出现在账号列表里',
          ignoredAccounts: ctx.accounts.ignoredList(),
          accounts: ctx.accounts.list(),
        });
        return;
      }

      if (pathname === '/admin/api/accounts/test' && req.method === 'POST') {
        const body = await readJson(req);
        const acc = ctx.accounts.get(body.id);
        if (!acc) return sendJson(res, 404, { error: { message: '账号不存在' } });
        const cred = acc.credentials[0];
        if (!cred) return sendJson(res, 400, { error: { message: '该账号还没有凭据' } });
        const model = body.model || registry.defaultModel();
        const started = Date.now();
        let cleanup = () => {};
        try {
          const { res: up, cleanup: cl } = await postChat(
            { baseUrl: cred.baseUrl, headers: { Authorization: cred.authorization } },
            {
              model,
              messages: [{ role: 'user', content: '只回复两个字：在线' }],
              max_tokens: 16,
              stream: true,
            },
            { timeoutMs: 45000 },
          );
          cleanup = cl;
          const text = await up.text();
          const latencyMs = Date.now() - started;
          const verdict = classifyUpstream(up.status, text);
          // classifyUpstream 返回的是 {code,message,payload,rateLimited,authFailed,
          // badRequest,unsupportedParam,retryable,httpStatus} —— 没有 kind 这个键。
          // 以前这里判 verdict.kind !== 'error'，恒为 undefined，条件恒真：
          // 一个回错误体的凭据会被报成「在线」并记 healthy。
          // 现在按几个真实标志位合成一个 kind。
          const kind = verdict.rateLimited
            ? 'rate_limited'
            : verdict.authFailed
              ? 'auth_failed'
              : verdict.badRequest
                ? 'bad_request'
                : 'ok';
          const okFlag = up.status >= 200 && up.status < 300 && kind === 'ok';
          ctx.accounts.markResult(acc.id, okFlag);
          sendJson(res, 200, {
            ok: okFlag,
            accountId: acc.id,
            model,
            status: up.status,
            kind,
            code: verdict.code || '',
            message: verdict.message ? String(verdict.message).slice(0, 300) : '',
            latencyMs,
            preview: String(text || '').slice(0, 400),
          });
        } catch (err) {
          ctx.accounts.markResult(acc.id, false);
          sendJson(res, 200, {
            ok: false,
            accountId: acc.id,
            model,
            status: 0,
            kind: 'exception',
            latencyMs: Date.now() - started,
            error: String(err?.message || err).slice(0, 300),
          });
        } finally {
          cleanup();
        }
        return;
      }

      /* ==================================================== 一键授权 */

      if (pathname === '/admin/api/auth/app' && req.method === 'GET') {
        const force = new URL(req.url, 'http://localhost').searchParams.get('force') === '1';
        await ctx.authFlow.detectApp({ force });
        sendJson(res, 200, ctx.authFlow.appStatus());
        return;
      }

      if (pathname === '/admin/api/auth/start' && req.method === 'POST') {
        const body = await readJson(req);
        try {
          const task = await ctx.authFlow.start({ label: body.label || '' });
          sendJson(res, 200, task);
        } catch (err) {
          sendJson(res, 400, { error: { message: err.message, code: err.code || '' } });
        }
        return;
      }

      if (pathname === '/admin/api/auth/check' && req.method === 'POST') {
        const body = await readJson(req);
        try {
          const task = await ctx.authFlow.check(body.id);
          if (task.status === 'bound') ctx.requestRediscover('auth-bound');
          sendJson(res, 200, task);
        } catch (err) {
          sendJson(res, 400, { error: { message: err.message } });
        }
        return;
      }

      if (pathname === '/admin/api/auth/cancel' && req.method === 'POST') {
        const body = await readJson(req);
        ctx.authFlow.cancel(body.id);
        sendJson(res, 200, { ok: true, tasks: ctx.authFlow.list() });
        return;
      }

      if (pathname === '/admin/api/auth/clear' && req.method === 'POST') {
        sendJson(res, 200, { ok: true, cleared: ctx.authFlow.clear() });
        return;
      }

      /* ==================================================== 自助登录 */

      // 和「一键授权」的区别：那条路要本机 OfficeAce 桌面端在跑，
      // 这条路自己完成整个 OAuth，桌面端开不开都行。

      if (pathname === '/admin/api/login/status' && req.method === 'GET') {
        sendJson(res, 200, {
          accounts: ctx.loginFlow.list(),
          sessions: ctx.loginFlow.sessions.list().map((s) => ctx.loginFlow.view(s)),
        });
        return;
      }

      if (pathname === '/admin/api/login/start' && req.method === 'POST') {
        const body = await readJson(req);
        try {
          const session = await ctx.loginFlow.start({
            label: body.label || '',
            // 「换一个账号」：先登出华为云会话再授权。不传就是老行为（有会话就直接复用）
            forceLogin: body.forceLogin === true,
          });
          sendJson(res, 200, session);
        } catch (err) {
          // err.status 让 loginFlow 能用 429 表达「同时开太多了」，别一律压成 400
          sendJson(res, err.status || 400, { error: { message: err.message, code: err.code || '' } });
        }
        return;
      }

      if (pathname === '/admin/api/login/poll' && req.method === 'GET') {
        const id = new URL(req.url, 'http://localhost').searchParams.get('id') || '';
        const session = ctx.loginFlow.get(id);
        if (!session) {
          sendJson(res, 404, { error: { message: '这个登录会话不存在或已经清理掉了' } });
          return;
        }
        // 登录成功那一刻把连接池和号池都刷一遍，前端随后拉到的一定是新数据
        if (session.done) ctx.requestRediscover('oauth-login');
        sendJson(res, 200, session);
        return;
      }

      if (pathname === '/admin/api/login/cancel' && req.method === 'POST') {
        const body = await readJson(req);
        const ok = ctx.loginFlow.cancel(body.id);
        sendJson(res, 200, { ok, session: ctx.loginFlow.get(body.id) });
        return;
      }

      if (pathname === '/admin/api/login/clear' && req.method === 'POST') {
        sendJson(res, 200, { ok: true, cleared: ctx.loginFlow.clear() });
        return;
      }

      /* ==================================================== 批量注册 */

      if (pathname === '/admin/api/register' && req.method === 'GET') {
        sendJson(res, 200, { stats: ctx.register.stats(), tasks: ctx.register.list() });
        return;
      }

      if (pathname === '/admin/api/register/enqueue' && req.method === 'POST') {
        const body = await readJson(req);
        const created = ctx.register.enqueue(body);
        sendJson(res, 200, { ok: true, created, stats: ctx.register.stats(), tasks: ctx.register.list() });
        return;
      }

      if (pathname === '/admin/api/register/step' && req.method === 'POST') {
        const r = await ctx.register.kick();
        sendJson(res, 200, { ok: true, ...r, stats: ctx.register.stats(), tasks: ctx.register.list() });
        return;
      }

      if (pathname === '/admin/api/register/sms' && req.method === 'POST') {
        const body = await readJson(req);
        try {
          const t = ctx.register.setSmsCode(body.id, body.code);
          sendJson(res, 200, { ok: true, task: t });
        } catch (err) {
          sendJson(res, 400, { error: { message: err.message } });
        }
        return;
      }

      if (pathname === '/admin/api/register/pause' && req.method === 'POST') {
        const body = await readJson(req);
        sendJson(res, 200, { ok: true, paused: ctx.register.setPaused(body.paused) });
        return;
      }

      if (pathname === '/admin/api/register/retry' && req.method === 'POST') {
        const body = await readJson(req);
        try {
          const t = ctx.register.retry(body.id);
          await ctx.register.kick();
          sendJson(res, 200, { ok: true, task: t, tasks: ctx.register.list() });
        } catch (err) {
          sendJson(res, 400, { error: { message: err.message } });
        }
        return;
      }

      if (pathname === '/admin/api/register/remove' && req.method === 'POST') {
        const body = await readJson(req);
        try {
          const okFlag = ctx.register.remove(body.id);
          sendJson(res, 200, { ok: okFlag, tasks: ctx.register.list() });
        } catch (err) {
          sendJson(res, 400, { error: { message: err.message } });
        }
        return;
      }

      if (pathname === '/admin/api/register/clear' && req.method === 'POST') {
        sendJson(res, 200, { ok: true, cleared: ctx.register.clearDone(), tasks: ctx.register.list() });
        return;
      }

      if (pathname === '/admin/api/register/redeem' && req.method === 'POST') {
        const body = await readJson(req);
        const r = await ctx.register.redeem(String(body.code || '').trim());
        sendJson(res, 200, r);
        return;
      }

      if (pathname === '/healthz' || pathname === '/health') {
        const cv = ctx.credits ? ctx.credits.view().summary : null;
        const ast = ctx.accounts.status();
        /**
         * 这几个数以前会一起骗人：`accounts: 2, accountsEnabled: 2, creditsAccounts: "2/2"`
         * 摆在一起，谁都会读成「两个号都能用、额度加起来能用」。
         * 实际可能是：只有 1 条凭据在池子里，另一个号连网关 key 都没有。
         *
         * 所以拆开、每个数说清楚自己是什么，并补一个真正有区分度的 `status`：
         * 只有「有凭据」**且**「启用账号里至少有一个是健康的」才算 ok。
         */
        // ⚠️ `status().healthy` 是**全量**口径（含停用的号），拿它当"可用账号数"
        //    会在停用一个坏号之后仍然报一个虚高的数字。这里自己按「启用 + 健康」数。
        const usableAccounts = ctx.accounts
          .list()
          .filter((a) => a.enabled && a.health?.state === 'ok').length;
        const credsOk = pool.size > 0;
        const degraded = !credsOk || (ast.enabled > 0 && usableAccounts === 0);
        sendJson(res, 200, {
          status: degraded ? 'degraded' : 'ok',
          /*
           * 版本号（来自 package.json）。
           *
           * 放在 /healthz 里，是为了让"报问题时先确认你跑的是哪版"变成一次 curl 就能回答的事
           * —— 面板底部虽然也显示，但那要先打得开面板、还得找到。
           */
          version: ctx.version,
          // 池子里真正能被调度去转发的凭据条数（这才是"能用几个号"）
          credentials: pool.size,
          models: registry.ids().length,
          // 号池账号数（含没凭据、含停用），下面两个才是关键
          accounts: ctx.accounts.size(),
          accountsEnabled: ast.enabled,
          // 启用的号里，健康状态为 ok 的个数（"真正能用"的账号数）
          accountsUsable: usableAccounts,
          // 读得到积分的号 vs 账号总数 —— 它**不代表**这些号能转发
          creditsAccounts: cv ? `${cv.ok}/${cv.accounts}` : null,
          creditsRemaining: cv ? cv.remaining : null,
          // 只算「启用且读到额度」的号，才是真正能花的额度
          creditsRemainingEnabled: cv ? cv.remainingEnabled : null,
          // ⚠️ 目录里有、但一个号都用不了/打不通的模型（上游 81009 名字不认 / 81004 没权限）。
          //    实测过 34 个里有 23 个是这种 —— 它们默认不出现在 /v1/models 里，
          //    这个字段就是"到底藏了什么"的账本。
          modelsUnavailable: listUnavailableModels(),
          uptimeMs: Date.now() - ctx.startedAt,
          // 认亲用（见文件顶部 APP_ROOT 的注释）：搬账号的 CLI 靠它确认没找错服务。
          // 只在**本机**访问时给：安装路径 + pid is 不该被公网上的探针顺手拿走的信息。
          ...(isLoopbackRequest(req) ? { root: APP_ROOT, pid: process.pid } : {}),
        });
        return;
      }

      // —— 需要本地 API Key ——
      const auth = checkAuth(req, config);
      if (!auth.ok) {
        sendJson(res, 401, {
          error: {
            message: 'API Key 无效。请带上请求头 Authorization: Bearer <config.json 中的 apiKeys>',
            type: 'authentication_error',
            code: 'invalid_api_key',
          },
        });
        return;
      }

      if (pathname === '/v1/models' && req.method === 'GET') {
        /**
         * 默认把「打不通」的模型从列表里去掉。
         *
         * 两个来源合并：
         *   ① 主动探测（tools/probe-reasoning-models.mjs 用的同一招，开机后台跑一遍）
         *      —— 覆盖"开机后第一次打开下拉框"这个场景，那会儿还没有任何学习记录
         *   ② 学习到的（某个模型被所有凭据都拒过）
         *
         * 实测两个号：目录 34 个里只有 11 个真的能打通。
         * 以前它们照原样列出来，客户端照着一个一个试、试一个错一个。
         */
        const list = registry.toOpenAiList();
        const hidden = new Set();
        if (config.models?.hideUnavailable !== false) {
          if (ctx.modelProbe) {
            for (const m of ctx.modelProbe.unavailable) hidden.add(m);
            // 池子学习到的新结论也并进来，免得要等下次探测
            ctx.modelProbe.noteLearned(pool.unavailableModels());
          }
          for (const m of pool.unavailableModels()) hidden.add(m);
        }        const hiddenList = [...hidden].filter((m) => list.some((x) => x.id === m));
        sendJson(res, 200, {
          object: 'list',
          data: hiddenList.length ? list.filter((m) => !hidden.has(m.id)) : list,
          ...(hiddenList.length ? { x_hidden_unavailable: hiddenList } : {}),
          ...(hiddenList.length ? { x_hidden_note: '这些模型上游对本服务的账号没有权限；想让客户端也看到全量就设 config.models.hideUnavailable: false' } : {}),
        });
        return;
      }

      const modelMatch = pathname.match(/^\/v1\/models\/(.+)$/);
      if (modelMatch && req.method === 'GET') {
        const id = decodeURIComponent(modelMatch[1]);
        // 这里**不**过滤：藏掉只是别让它出现在下拉框里，
        // 直接按名字查还是要能查到，不然排障的时候两眼一抹黑。
        const found = registry.toOpenAiList().find((m) => m.id === id);
        if (!found) {
          sendJson(res, 404, {
            error: { message: `未找到模型 ${id}`, type: 'invalid_request_error', code: 'model_not_found' },
          });
          return;
        }
        sendJson(res, 200, found);
        return;
      }

      if (pathname === '/v1/usage' && req.method === 'GET') {
        sendJson(res, 200, usage.snapshot());
        return;
      }

      if (pathname === '/v1/refresh' && req.method === 'POST') {
        const ok = await refreshUpstreamCatalog();
        const discovered = ctx.requestRediscover('manual');
        sendJson(res, 200, { upstream: ok, discovered, models: registry.ids().length });
        return;
      }

      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        let body;
        try {
          body = await readJson(req);
        } catch (err) {
          sendJson(res, 400, { error: { message: err.message, type: 'invalid_request_error' } });
          return;
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: { message: '请求体必须是 JSON 对象', type: 'invalid_request_error' } });
          return;
        }
        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          sendJson(res, 400, {
            error: { message: 'messages 不能为空', type: 'invalid_request_error', param: 'messages' },
          });
          return;
        }
        const badModel = checkModel(registry, body.model);
        if (badModel) {
          sendJson(res, badModel.status, badModel.body);
          return;
        }
        const model = registry.resolve(body.model || registry.defaultModel());
        const wantStream = body.stream === true;
        const abortController = new AbortController();
        // 挂 res 而不是 req。
        //
        // req 是「请求体读完」那一刻就 emit close 的（Node 会自动销毁），
        // 而这行在 await readJson 之后才执行 —— 监听器挂上去时那个事件早过去了，
        // 而 close 只 emit 一次，于是它永远不会触发：用户点「停止」只断了自己那头，
        // 代理照样把上游 SSE 读完（最长 600s），白烧这个号的 TPM 和积分。
        //
        // 也不能提前挂到 req 上：req 早发 close 时 res.writableEnded 还是 false，
        // 会把每一个健康请求都 abort 掉。res 的 close 才是对的信号。
        res.on('close', () => {
          if (!res.writableEnded) abortController.abort(new Error('client disconnected'));
        });
        const result = await runWithFallback({
          res,
          req,
          body,
          model,
          requestedModel: body.model || model,
          wantStream,
          apiKey: auth.key,
          endpoint: pathname,
          abortSignal: abortController.signal,
          requestId: rid,
        });
        if (result) sendJson(res, result.status, result.body);
        return;
      }

      if (pathname === '/v1/completions' && req.method === 'POST') {
        let body;
        try {
          body = await readJson(req);
        } catch (err) {
          sendJson(res, 400, { error: { message: err.message, type: 'invalid_request_error' } });
          return;
        }
        const prompt =
          typeof body.prompt === 'string' ? body.prompt : Array.isArray(body.prompt) ? body.prompt.join('\n') : '';
        const chatBody = { ...body, messages: [{ role: 'user', content: prompt }] };
        delete chatBody.prompt;
        const badModel = checkModel(registry, body.model);
        if (badModel) {
          sendJson(res, badModel.status, badModel.body);
          return;
        }
        const model = registry.resolve(body.model || registry.defaultModel());
        const abortController = new AbortController();
        // 挂 res 而不是 req。
        //
        // req 是「请求体读完」那一刻就 emit close 的（Node 会自动销毁），
        // 而这行在 await readJson 之后才执行 —— 监听器挂上去时那个事件早过去了，
        // 而 close 只 emit 一次，于是它永远不会触发：用户点「停止」只断了自己那头，
        // 代理照样把上游 SSE 读完（最长 600s），白烧这个号的 TPM 和积分。
        //
        // 也不能提前挂到 req 上：req 早发 close 时 res.writableEnded 还是 false，
        // 会把每一个健康请求都 abort 掉。res 的 close 才是对的信号。
        res.on('close', () => {
          if (!res.writableEnded) abortController.abort(new Error('client disconnected'));
        });
        const result = await runWithFallback({
          res,
          req,
          body: chatBody,
          model,
          requestedModel: body.model || model,
          wantStream: body.stream === true,
          apiKey: auth.key,
          endpoint: pathname,
          abortSignal: abortController.signal,
          requestId: rid,
        });
        if (result) sendJson(res, result.status, result.body);
        return;
      }

      if (pathname === '/v1/embeddings' && req.method === 'POST') {
        let body;
        try {
          body = await readJson(req);
        } catch (err) {
          sendJson(res, 400, { error: { message: err.message, type: 'invalid_request_error' } });
          return;
        }
        const cred = pool.pick(body.model || null);
        if (!cred) {
          sendJson(res, 503, { error: { message: '凭据池为空', type: 'no_credential' } });
          return;
        }
        try {
          const up = await fetch(`${trimSlash(cred.baseUrl)}/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...cred.headers },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120000),
          });
          const text = await up.text();
          res.writeHead(up.status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'X-Request-Id',
          });
          res.end(text);
        } catch (err) {
          sendJson(res, 502, { error: { message: String(err?.message || err), type: 'upstream_error' } });
        }
        return;
      }

      sendJson(res, 404, {
        error: {
          message: `未知路径 ${pathname}`,
          type: 'invalid_request_error',
          hint: '可用: GET /v1/models · POST /v1/chat/completions · POST /v1/completions · GET /healthz · GET /admin',
        },
      });
    } catch (err) {
      // 带 status 的是「请求方的问题」（坏 JSON、参数不对），别一律报 500。
      // 一律 500 会让客户端以为服务挂了然后重试，日志里也全是假警报。
      const status = Number(err?.status) || 500;
      if (status >= 500) {
        log.error('请求处理异常', { requestId: rid, pathname, error: String(err?.stack || err) });
      } else {
        log.warn('请求参数有问题', { requestId: rid, pathname, status, error: String(err?.message || err) });
      }
      sendJson(res, status, {
        error: {
          message: String(err?.message || err),
          type: status >= 500 ? 'internal_error' : 'invalid_request_error',
          ...(err?.code ? { code: err.code } : {}),
          request_id: rid,
        },
      });
    }
  });

  server.keepAliveTimeout = 120000;
  server.headersTimeout = 180000;
  server.requestTimeout = 0;

  return { server, refreshUpstreamCatalog };
}

function info_statusOf(payload) {
  const code = String(payload?.error?.code || payload?.error_code || '');
  if (/81111|81112|81113|81114|0308/.test(code)) return 429;
  if (/1009|1001|1002/.test(code)) return 401;
  if (/81001/.test(code)) return 400;
  return 502;
}
