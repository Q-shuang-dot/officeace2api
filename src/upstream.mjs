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
 * 构造发送给上游的请求体
 */
export function buildUpstreamBody(body, model, options = {}) {
  const { alwaysStream = true, includeUsage = true, stripThinking = false, minMaxTokens = null } = options;
  const out = { ...body };
  out.model = model;
  delete out.user_report;

  if (stripThinking) {
    for (const key of STRIP_WHEN_UNSUPPORTED) delete out[key];
  }

  /**
   * 推理模型的 token 预算保险丝。
   *
   * `deepseek-v4.1-flash` 这类模型会**先**花掉几十到几百 token 推理，
   * 再吐正文。客户端按老习惯给 `max_tokens: 64` 的话，预算全烧在推理上，
   * 返回的是 `content: ""` + `finish_reason: "length"` —— 客户端拿到 200 和空正文，
   * 除了以为反代坏了没法有别的想法。
   *
   * 实测（tools/probe-model-deep41.mjs）：`max_tokens` ≤300 时正文基本是空的，
   * 800 才稳定有正文，而一次推理本身就要 180~350 token。
   *
   * 这里做**下限抬升**：客户端给的比 `minMaxTokens` 还小就抬到下限。
   * 只抬不降 —— 客户端要更长的输出照样给。
   * 不想被改写就设 `models.minMaxTokens: 0`。
   */
  let bumped = null;
  const min = Number(minMaxTokens) || 0;
  if (min > 0) {
    const given = Number(out.max_tokens);
    if (!Number.isFinite(given)) {
      // 客户端压根没给 → 也要给个下限，否则等于让上游按自己的默认来（对推理模型同样会空）
      out.max_tokens = min;
      bumped = { from: null, to: min };
    } else if (given < min) {
      out.max_tokens = min;
      bumped = { from: given, to: min };
    }
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

  const rateLimited =
    status === 429 ||
    /81111|81112|81113|81114|0308|TooManyRequests|rate limit|too many requests|\bTPM\b/i.test(`${code} ${message}`);

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
    authFailed,
    modelRejected,
    badRequest,
    unsupportedParam,
    retryable: rateLimited || authFailed || status >= 500,
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
