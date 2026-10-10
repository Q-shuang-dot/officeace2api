/**
 * HTTP 服务层：OpenAI 兼容路由 + 重试编排 + 管理面板
 */

import http from 'node:http';
import { clearRecentLogs, configureLogger, createLogger, getRecentLogs } from './logger.mjs';
import { adminHtml } from './admin.mjs';
import { saveConfig } from './config.mjs';
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

const log = createLogger('server');
const MAX_BODY = 64 * 1024 * 1024;
// 请求地址（含 query）上限。超过就答 414，别交给 new URL() 慢慢啃。
const MAX_URL_LENGTH = 8 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendJson(res, status, payload) {
  if (res.writableEnded || res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        const e = new Error('请求体过大 (>64MB)');
        e.status = 413;
        e.code = 'BODY_TOO_LARGE';
        reject(e);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    const e = new Error(`JSON 解析失败: ${err.message}`);
    e.status = 400;
    e.code = 'BAD_JSON';
    throw e;
  }
  // JSON.parse 还认 null / 数字 / 字符串 / 数组，但下面每个调用点都当对象用，
  // 于是 `JSON.parse("null")` 会让 body.id 抛 TypeError → 500。
  // 这里统一归一成 {}，等价于「没带参数」，所有调用点就都安全了。
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
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
async function relayPrimed(primed, res, { model }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const acc = createChatAccumulator(model);
  acc.push(primed.events);

  for (const buf of primed.raw) {
    if (res.writableEnded) break;
    res.write(buf);
  }
  if (typeof res.flush === 'function') res.flush();

  let clientGone = false;
  let upstreamError = '';

  try {
    for (;;) {
      const { done, value } = await primed.reader.read();
      if (done) break;
      if (res.writableEnded) {
        clientGone = true; // 客户端自己走了，不是上游的问题
        break;
      }
      res.write(value);
      acc.push(primed.decoder.push(value));
      if (typeof res.flush === 'function') res.flush();
    }
    acc.push(primed.decoder.flush());
  } catch (err) {
    // 上游把连接掐了（RST / socket destroyed）。
    //
    // 这里刻意不让异常往外抛：抛出去的话调用方的 handle.cleanup()、池子记账、
    // usage 记录全被跳过 —— 一条断掉的流会被记成成功。现在把它转成返回值，
    // 让调用方能照实记一笔失败。
    upstreamError = String(err?.message || err);
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
      log.info('上游模型列表已更新', { count: list.length });
      // 目录变了 → 「模型不行」的旧结论作废（见 pool.clearModelRejections 的注释）
      if (registry.ids().join(',') !== before) {
        pool.clearModelRejections((n) => log.info('模型目录变了，已清掉旧的「模型不行」标记', { cleared: n, reason: 'upstream-catalog' }));
      }
      return true;
    } catch (err) {
      log.warn('拉取上游模型列表异常', { error: String(err?.message || err) });
      return false;
    }
  }

  async function runCompletion({ res, body, model, wantStream, apiKey, endpoint, abortSignal }) {
    const startedAt = Date.now();
    const maxAttempts = Math.max(1, Number(config.upstream.maxRetries) || 1);
    const timeoutMs = Math.max(30, Number(config.upstream.timeoutSeconds) || 600) * 1000;
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

    while (attemptsLeft > 0) {
      attemptsLeft -= 1;
      const attemptNo = attempts.length + 1;
      const cred = pool.pick(model);
      if (!cred) {
        return openAiError(
          '凭据池为空：打开控制台「号池」页点「换个账号登录」即可（不需要 OfficeAce 桌面端）；' +
          '也可以在 config.json 里手工填写 upstream.baseUrl / upstream.authorization',
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
        // 重试那一发用抬高后的预算（否则就是原样重发一遍，见 emptyRetryMaxTokens 的注释）
        exactMaxTokens: emptyRetryMaxTokens,
      });
      // 标记要当场摘掉 —— 留在 body 里会被原样发给上游
      const bumpNote = takeBumpNote(upstreamBody);
      if (bumpNote && !bumpWarned.has(model)) {
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
        pool.markFailed(cred, message);
        lastError = message;
        lastStatus = 502;
        attempts.push({ attempt: attemptNo, cred: cred.baseUrl, error: message });
        log.warn('上游连接失败', { model, error: message });
        await sleep(backoffMs(Number(config.upstream.retryBackoffMs) || 1000, attemptNo));
        continue;
      }

      const upstreamRes = handle.res;

      if (!upstreamRes.ok) {
        const text = await upstreamRes.text().catch(() => '');
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
          pool.markRateLimited(cred, model, info.message);
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

      const primed = await primeUpstream(upstreamRes, { timeoutMs: Math.min(timeoutMs, 90000) });

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
        const result = await relayPrimed(primed, res, { model });
        handle.cleanup();

        if (result.error) {
          // 字节已经透传出去了（客户端能看见那个 error 帧），没法再重试；
          // 但池子和统计必须按失败记，否则这个正在限流的凭据不会冷却，
          // 下一个请求还会挑到它，然后继续报同样的错。
          const info = classifyUpstream(200, JSON.stringify({ error: result.error }));
          if (info.rateLimited) pool.markRateLimited(cred, model, info.message);
          else pool.markFailed(cred, info.message);
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
          log.warn('上游中途断流', { model, error: msg, tokens: result.tokens });
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
        log.info('流式完成', {
          model,
          attempt: attemptNo,
          ttftMs: result.firstDataAt ? result.firstDataAt - startedAt : null,
          totalMs: Date.now() - startedAt,
          tokens: result.usage?.total_tokens ?? null,
        });
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
        else pool.markFailed(cred, info.message);
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
      log.info('非流式完成', {
        model,
        attempt: attemptNo,
        totalMs: Date.now() - startedAt,
        tokens: payload.usage?.total_tokens ?? null,
      });
      return { status: 200, body: payload };
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
    return err;
  }

  const server = http.createServer({ maxHeaderSize: 64 * 1024 }, async (req, res) => {
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
      // 口令从**两个地方**认：`x-admin-token` 头（面板 JS 里每条 XHR 都带），
      // 以及 URL 上的 `?token=`（人第一次打开面板时只能这么传）。
      //
      // 只认头是个真踩到的坑：启动横幅和下面那条 401 的提示都写着
      // 「/admin?token=你的口令」，可服务端当时只比对请求头 ——
      // 于是**按提示走的人反而进不去**，浏览器地址栏里带着 token 也是 401。
      // 提示文案和实际行为不一致，比没有提示更坑。
      const isAdminRoute = pathname === '/' || pathname === '/admin' || pathname.startsWith('/admin/');
      if (isAdminRoute && config.admin?.token) {
        const fromQuery = query.get('token') || '';
        const fromHeader = String(req.headers['x-admin-token'] || '');
        if (fromQuery !== config.admin.token && fromHeader !== config.admin.token) {
          sendJson(res, 401, {
            error: {
              message: '管理员 token 无效。请在面板地址后加 ?token=你的口令',
              type: 'authentication_error',
            },
          });
          return;
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
        sendJson(res, 200, {
          health: {
            uptimeMs: Date.now() - ctx.startedAt,
            baseUrl: creds[0]?.baseUrl || config.upstream.baseUrl || '',
            defaultModel: registry.defaultModel(),
            version: ctx.version,
            startedAt: new Date(ctx.startedAt).toISOString(),
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
          models: registry.detailed(),
          usage: usage.snapshot(),
          recent: usage.snapshot().recent,
          logs: getRecentLogs(),
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

      if (pathname === '/admin/api/config' && req.method === 'POST') {
        const patch = await readJson(req);
        const restartRequired = [];
        const prevListen = { ...config.listen };

        for (const key of ['listen', 'upstream', 'quota', 'log', 'models', 'admin', 'discover', 'credits']) {
          if (patch[key] && typeof patch[key] === 'object') {
            config[key] = { ...config[key], ...patch[key] };
          }
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
        sendJson(res, 200, { upstream, discovered, models: registry.ids().length });
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
        const targetIds = body.id ? [String(body.id)] : ctx.accounts.ids().filter((i) => ctx.accounts.get(i)?.enabled);
        const r = body.id
          ? await ctx.credits.claimBonus(String(body.id), { force: body.force === true })
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
        const ids = body.id ? [String(body.id)] : ctx.accounts.ids();
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
        const result = await runCompletion({
          res,
          body,
          model,
          wantStream,
          apiKey: auth.key,
          endpoint: pathname,
          abortSignal: abortController.signal,
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
        const result = await runCompletion({
          res,
          body: chatBody,
          model,
          wantStream: body.stream === true,
          apiKey: auth.key,
          endpoint: pathname,
          abortSignal: abortController.signal,
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
        log.error('请求处理异常', { pathname, error: String(err?.stack || err) });
      } else {
        log.warn('请求参数有问题', { pathname, status, error: String(err?.message || err) });
      }
      sendJson(res, status, {
        error: {
          message: String(err?.message || err),
          type: status >= 500 ? 'internal_error' : 'invalid_request_error',
          ...(err?.code ? { code: err.code } : {}),
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
