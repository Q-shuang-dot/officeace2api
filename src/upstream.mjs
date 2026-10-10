/**
 * 上游适配层：请求构造 / SSE 解析 / 错误分类
 *
 * 上游（华为 AgentArts 模型网关）本身就是 OpenAI 兼容协议：
 *   POST {api_base}/chat/completions
 * 这里主要做三件事：
 *   1. 请求体净化（剥离该模型不支持的字段，例如 glm-5.* 不接受 thinking:disabled）；
 *   2. 提供增量 SSE 解析器（既用于流式透传旁路统计，也用于非流式聚合）；
 *   3. 把上游错误统一成 OpenAI 错误结构，并标出是否需要冷却/重试。
 */

import { trimSlash, randId } from './util.mjs';

/** 已知上游对部分参数敏感的能力表 */
export const MODEL_QUIRKS = {
  'glm-5.3': { noThinking: true },
  'glm-5.3-test': { noThinking: true },
  'glm-5.3-zx': { noThinking: true },
  'glm-5-test': { noThinking: true },
};

export function quirksFor(model) {
  return MODEL_QUIRKS[model] || {};
}

const STRIP_WHEN_UNSUPPORTED = ['thinking', 'enable_thinking', 'reasoning_effort', 'stream_options'];

/**
 * 小于这个值的 `max_tokens` 一律原样透传给上游，不追加推理预算。
 *
 * 依据：上游不按 `max_tokens` 截断正文，只要推理跑完就把整句说完。所以对
 * `max_tokens: 1` 这种精确请求，追加 1024 的"推理预算"会把正文一起放开 ——
 * 实测客户端要 1 个 token，拿回来 24 个字符。这种请求的意图太明确，
 * 不该替它改。给到 16 以上的都是"我要一段正常回答"，那时追加才是有帮助的。
 */
export const TINY_MAX_TOKENS = 16;

/**
 * 构造发送给上游的请求体
 */
export function buildUpstreamBody(body, model, options = {}) {
  const { alwaysStream = true, includeUsage = true, stripThinking = false, minMaxTokens = null, exactMaxTokens = null } = options;
  const out = { ...body };
  out.model = model;
  delete out.user_report;

  if (stripThinking) {
    for (const key of STRIP_WHEN_UNSUPPORTED) delete out[key];
  }

  /**
   * 推理模型的 token 预算保险丝。
   *
   * 上游（华为 MaaS 网关实测）把 `max_tokens` 当成**推理 + 正文的总预算**，
   * 所以这类"先想再答"的模型在预算不够时会把 token 全花在推理上：
   *
   *   max_tokens=64  → content:""          finish_reason:"length"
   *   max_tokens=1024 → content:"…"        finish_reason:"stop"
   *
   * 客户端拿到 200 + 空正文，除了以为反代坏了没法有别的想法。
   *
   * 做法是**追加"推理预算"**，而不是给客户端设一个下限：
   *
   *   max_tokens = 客户端要的 + minMaxTokens（默认 1024）
   *
   * 为什么不是 `max(客户端要的, 下限)`：客户端给 `max_tokens: 1` 时，
   * 设下限会把正文也放开，实测吐出 369 个 token；追加式给 1 + 1024，
   * 正文至少不会被放开。
   *
   * ⚠️ 但**追加也治不了 `max_tokens: 1` 这种精确请求**：上游根本不按
   *    `max_tokens` 截断正文，只要推理跑完它就把整句说完 —— 实测 1+1024
   *    拿回来的还是 24 个字符。所以给得特别小的请求干脆原样透传，
   *    让客户端拿到它自己要求的那个结果（多半是空正文 + length）。
   *    下限 `TINY_MAX_TOKENS` 就是这个分界线。
   *
   * 代价是给得小的时候模型会慢（那 1024 个推理 token 要真花时间，
   * 实测一个短问答 3~28 秒）。这是推理模型的本性，反代绕不开。
   * 不想被追加就设 `models.minMaxTokens: 0`。
   */
  let bumped = null;
  /**
   * `exactMaxTokens`：**直接指定**这一发发给上游的 `max_tokens`，跳过下面那套
   * 「加上 allowance」的推算。
   *
   * 给「正文为空」的重试用。那一路已经知道上一发烧了多少推理 token，要的是
   * 一个**算出来的具体数**，而不是"在客户端给的数上再加一档" —— 而且这时候
   * 客户端可能压根没给 `max_tokens`（那就没有"加"的基准）。
   *
   * ⚠️ 仍然守住 `< TINY_MAX_TOKENS` 的约定：客户端明确只要 1 个 token 时，
   *    连重试都不该发生（server.mjs 的 `clientMaxTokensForRetry` 已经拦了），
   *    这里再兜一道，免得哪天调用方漏了判断就把客户端的极小请求撑大。
   */
  const exact = Number(options.exactMaxTokens);
  const exactGiven = Number(out.max_tokens);
  if (Number.isFinite(exact) && exact > 0 && !(Number.isFinite(exactGiven) && exactGiven < TINY_MAX_TOKENS)) {
    out.max_tokens = Math.round(exact);
    bumped = { from: Number.isFinite(exactGiven) ? exactGiven : null, to: out.max_tokens, mode: 'retry' };
  }

  const allowance = Number(minMaxTokens) || 0;
  if (!bumped && allowance > 0) {
    const given = Number(out.max_tokens);
    // 给得特别小 → 原样透传，不越权替客户端决定"其实你想要 1000 个 token"
    if (Number.isFinite(given) && given >= TINY_MAX_TOKENS) {
      out.max_tokens = given + allowance;
      bumped = { from: given, to: out.max_tokens, mode: 'allowance' };
    }
    // 客户端没给 max_tokens → 不动它。这种情况上游会用自己的默认值（实测够用），
    // 我们凭空塞一个反而可能比上游默认还小。
  }

  if (alwaysStream) {
    out.stream = true;
    if (includeUsage && out.stream_options === undefined) {
      out.stream_options = { include_usage: true };
    }
  } else if (!out.stream) {
    delete out.stream_options;
  }

  if (typeof out.temperature === 'number') out.temperature = Math.min(2, Math.max(0, out.temperature));
  if (typeof out.top_p === 'number') out.top_p = Math.min(1, Math.max(0, out.top_p));
  // `bumped` 单独回传，不塞进 body —— 塞进去就得记得删，漏一次就发给上游了
  if (bumped) out.__o2aBumped = bumped;
  return out;
}

/** 取出 buildUpstreamBody 留下的「max_tokens 被抬升过」标记，并把标记从 body 里摘掉 */
export function takeBumpNote(body) {
  const b = body?.__o2aBumped || null;
  if (body && '__o2aBumped' in body) delete body.__o2aBumped;
  return b;
}

export function upstreamUrl(credential, suffix = '/chat/completions') {
  return `${trimSlash(credential.baseUrl)}${suffix}`;
}

export function upstreamHeaders(credential, { stream = true, extraHeaders = {} } = {}) {
  return {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'User-Agent': 'OfficeAce/1.0 (officeace2api)',
    ...credential.headers,
    ...extraHeaders,
  };
}

/** 发起上游请求；返回 { res, cleanup } */
export async function postChat(credential, body, { timeoutMs = 600000, extraHeaders = {}, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('upstream timeout')), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  try {
    const res = await fetch(upstreamUrl(credential), {
      method: 'POST',
      headers: upstreamHeaders(credential, { stream: true, extraHeaders }),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { res, cleanup: () => clearTimeout(timer) };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/** 上游错误分类 */
export function classifyUpstream(status, text) {
  let payload = null;
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('{')) {
    try {
      payload = JSON.parse(trimmed);
    } catch {
      payload = null;
    }
  }
  const errObj = payload?.error && typeof payload.error === 'object' ? payload.error : payload;
  const code = String(errObj?.code || payload?.error_code || '').trim();
  const message = String(errObj?.message || payload?.error_msg || payload?.message || trimmed || `HTTP ${status}`).trim();

  /**
   * 上游说「你这次请求**太大了**」。
   *
   *   ModelArts.81113  Invalid request body, exceeds the maximum size
   *
   * ⚠️ 它带的是 **HTTP 429**，所以以前被下面那条 `status === 429` 吞成
   * `rateLimited` —— 于是：
   *   ① 反代拿同一个 5.5MB 的 body **原样重试 3 遍**（每次都会再传一遍 5.5MB），
   *   ② 还把错误原样透传成 `429`。客户端看到 429 会认为"只是暂时忙"，
   *      于是**继续重试同一个必然失败的请求**。
   *
   * 实际上这是**确定性**的：请求不变，打一百遍一样被拒。
   * 所以必须单独识别出来，走"不重试 + 换个合适的状态码"这条路。
   *
   * ⚠️ 别把它读成"上下文太长（token 超窗口）"—— 上游原文其实自报了家门：
   *   Invalid request body, exceeds the maximum size , messages max size is: 5000.
   * 说的是 **messages 条数上限 5000 条**，跟 token 数无关：
   * 3000 条长消息能过，4990 条 "a1"/"b" 这样的短消息反而更容易撞。
   * token 窗口超了回的是**另一套错**，两者别混。
   * （是否另有一条"请求体字节数"上限尚未证实 —— 见 tools/diag-upstream-limits.mjs，
   *  它在"条数没超 5000 却仍回 81113"时会把这一点标出来。）
   *
   * 实测：塞约 5.5MB 的对话历史（7500 块 = 15000 条）就会撞到它。
   */
  const requestTooLarge =
    /81113|exceeds the maximum size|RequestEntityTooLarge|payload too large|request body is too (large|long)/i.test(
      `${code} ${message}`,
    );

  const rateLimited =
    !requestTooLarge &&
    (status === 429 ||
      /81111|81112|81114|0308|TooManyRequests|rate limit|too many requests|\bTPM\b/i.test(`${code} ${message}`));

  /**
   * 上游说「这个**模型**不行」——分两种，都是**请求级**问题，不是账号的问题：
   *   ModelArts.81004  Insufficient permission —— 这个模型你这个号没权限
   *   ModelArts.81009  Invalid model         —— 你这个模型名上游不认
   *
   * 单独识别出来，是因为以前它们被 `status === 403` 那条规则吞进 `authFailed`，
   * 于是把**整条凭据**冷却 5 分钟（`cooldownOnAuthErrorMs`）。
   * 实测代价：随手打一个模型名就能把唯一那条凭据打哑 5 分钟，
   * 期间所有正常请求都得靠 `pick()` 的兜底路径硬发。
   * 换账号也救不了 —— 名字不对/没权限，换个号一样不行。
   */
  const modelRejected =
    /81004|81009|Insufficient permission|Invalid model/i.test(`${code} ${message}`);

  const authFailed =
    !modelRejected &&
    (status === 401 ||
      status === 403 ||
      /APIG\.1009|APIG\.1001|APIG\.1002|AppKey or AppSecret is invalid|invalid api key|unauthorized/i.test(`${code} ${message}`));
  const badRequest = status === 400 || /81001|validation error|BadRequest/i.test(`${code} ${message}`);
  // 只有「这个参数我不认识」才值得剥参数重试。
  //
  // 以前这条是 /unsupported|not support|invalid.*(param|field|argument|type)/i，
  // 后面那个 invalid.*param 分支会命中「参数值不合法」那类错误 ——
  // 实测项目日志里一个 max_tokens:-5 被判成「上游拒绝扩展参数，剥离后重试」，
  // 而剥离后参数根本没变，必然再失败一次，白等 1.5s + 2.5s 退避。
  const unsupportedParam =
    /unsupported|not support|unrecognized|unknown (parameter|field|argument)|no such (parameter|field)/i.test(message);


  return {
    code,
    message,
    payload,
    rateLimited,
    requestTooLarge,
    authFailed,
    modelRejected,
    badRequest,
    unsupportedParam,
    // 请求体太大是**确定性**失败：body 不变，打一百遍一样被拒，
    // 而且每遍都要把整个 body 再传一次（实测撞到的那次是 5.5MB）。
    // 所以明确排除在可重试之外。
    retryable: !requestTooLarge && (rateLimited || authFailed || status >= 500),
    httpStatus: status,
  };
}

export function openAiError(message, { type = 'upstream_error', code = null, status = 502, param = null } = {}) {
  return {
    status,
    body: { error: { message, type, param, code: code || null } },
  };
}

/** 逐行 SSE 解码器：把上游字节流切成事件 */
export function createSseDecoder() {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let dataLines = [];

  // 按 SSE 规范组装一个事件。
  //
  // 规范里一个事件的 data: 是可以写成多行的，语义是按 \n 拼起来，
  // 空行才代表事件结束。以前是每行单独 JSON.parse，于是这种合法写法
  // 会被拆成几个解析不了的碎片、整条丢掉（实测 events=[] 且 flush() 也是 []）。
  const dispatch = () => {
    if (!dataLines.length) return null;
    const data = dataLines.join('\n');
    dataLines = [];
    if (!data) return null;
    if (data === '[DONE]') return { done: true };
    if (!data.startsWith('{')) return null;
    try {
      return { data: JSON.parse(data) };
    } catch {
      return null;
    }
  };

  const feed = (line) => {
    if (!line) return dispatch(); // 空行 = 事件结束
    if (line.startsWith(':')) return null; // 注释 / 心跳
    if (line.startsWith('data:')) {
      let v = line.slice(5);
      if (v.startsWith(' ')) v = v.slice(1); // 规范：冒号后的一个空格要去掉
      dataLines.push(v);
      return null;
    }
    // 宽容一点：有的上游直接甩一行裸 JSON，没带 data: 前缀
    if (line.startsWith('{')) {
      dataLines.push(line);
      return null;
    }
    return null; // event: / id: / retry: 我们用不上
  };

  return {
    push(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      const events = [];
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        const evt = feed(line);
        if (evt) events.push(evt);
      }
      return events;
    },
    flush() {
      const events = [];
      if (buffer) {
        let line = buffer;
        buffer = '';
        if (line.endsWith('\r')) line = line.slice(0, -1);
        const evt = feed(line);
        if (evt) events.push(evt);
      }
      // 上游可能最后一个事件没补空行就把连接关了，这里兜一把
      const last = dispatch();
      if (last) events.push(last);
      return events;
    },
  };
}

/**
 * 增量聚合器：把 SSE 事件累积成一条完整 assistant 消息
 * 同时可用于「只取 usage」的旁路统计。
 */
export function createChatAccumulator(fallbackModel = '') {
  // 兼容用的汇总字段（choice 0 的镜像）。别的地方在读 state.content / state.usage。
  const state = {
    id: null,
    created: null,
    model: fallbackModel,
    role: 'assistant',
    content: '',
    reasoning: '',
    finishReason: null,
    usage: null,
    sawDone: false,
    events: 0,
    firstDataAt: 0,
    error: null,
  };

  // 每个 choice.index 单独累积。
  //
  // 以前只取 chunk.choices[0]，客户端传 n>1 时 choice1 起全被静默丢掉，
  // 返回的 choices 永远只有一条。
  const choices = new Map();
  const choiceAt = (index) => {
    const i = Number.isFinite(index) ? index : 0;
    let c = choices.get(i);
    if (!c) {
      c = { index: i, role: 'assistant', content: '', reasoning: '', finishReason: null, toolCalls: new Map() };
      choices.set(i, c);
    }
    return c;
  };

  const apply = (chunk) => {
    if (!chunk || typeof chunk !== 'object') return;
    state.events += 1;
    if (!state.firstDataAt) state.firstDataAt = Date.now();
    if (chunk.error) {
      state.error = chunk.error;
      return;
    }
    if (chunk.id) state.id = state.id || chunk.id;
    if (chunk.created) state.created = state.created || chunk.created;
    if (chunk.model) state.model = chunk.model;
    if (chunk.usage) state.usage = chunk.usage;

    const list = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const c = choiceAt(raw.index);
      const delta = raw.delta || raw.message || {};
      if (delta.role) c.role = delta.role;
      if (typeof delta.content === 'string') c.content += delta.content;
      if (typeof delta.reasoning_content === 'string') c.reasoning += delta.reasoning_content;
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const acc = c.toolCalls.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) acc.id = tc.id;
          if (tc.type) acc.type = tc.type;
          // 函数名只在第一个分片给一次。上游若每帧重复发，累加会拼出
          // get_weatherget_weather 这种东西，所以只认第一次。
          if (tc.function?.name && !acc.function.name) acc.function.name = tc.function.name;
          if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
          c.toolCalls.set(idx, acc);
        }
      }
      if (raw.finish_reason) c.finishReason = raw.finish_reason;
    }

    const c0 = choices.get(0);
    state.content = c0 ? c0.content : '';
    state.reasoning = c0 ? c0.reasoning : '';
    state.finishReason = c0 ? c0.finishReason : null;
    // 有没有发过工具调用。上层要用它区分"正文空 = 推理把预算吃完了"
    // 和"正文空 = 这个回复本来就只有 tool_calls"。
    state.sawToolCalls = [...choices.values()].some((c) => c.toolCalls.size > 0);
  };

  return {
    state,
    push(events) {
      for (const evt of events || []) {
        if (evt.done) {
          state.sawDone = true;
          continue;
        }
        if (evt.data) apply(evt.data);
      }
    },
    build() {
      const list = [...choices.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, c]) => {
          const message = { role: c.role, content: c.content || '' };
          if (c.reasoning) message.reasoning_content = c.reasoning;
          if (c.toolCalls.size > 0) {
            message.tool_calls = [...c.toolCalls.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([, v]) => ({
                id: v.id || `call_${randId('').slice(1, 10)}`,
                type: v.type || 'function',
                function: { name: v.function.name, arguments: v.function.arguments || '{}' },
              }));
          }
          return { index, message, finish_reason: c.finishReason || 'stop', logprobs: null };
        });

      // 上游一个 choice 都没给（或者全是注释/心跳）时，仍然回一条空的，
      // 别让客户端拿到 choices: []。
      if (!list.length) {
        list.push({
          index: 0,
          message: { role: state.role, content: '' },
          finish_reason: state.finishReason || 'stop',
          logprobs: null,
        });
      }

      return {
        id: state.id || randId(),
        object: 'chat.completion',
        created: state.created || Math.floor(Date.now() / 1000),
        model: state.model || fallbackModel,
        choices: list,
        usage: state.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    },
  };
}
