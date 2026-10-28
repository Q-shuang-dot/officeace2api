/**
 * 请求路由的纯函数：会话黏性 key、Retry-After 解析。
 *
 * 放在这里是为了可单独测试，也避免 server.mjs 里继续堆「协议细节」。
 */

import { createHash } from 'node:crypto';

/**
 * 会话黏性 key：优先用客户端显式传的会话 ID；没有就退化成
 * 「模型 + 首条 user」的哈希。
 *
 * 用首条 user 而不是最后一条：多轮对话里首条一直不变，最后一条每轮都变。
 * system prompt 不参与哈希：它常带日期/工具列表，每轮都变，算进去会让
 * 同一个会话每轮都换号。只取前 8KB，避免把 base64 图片整段哈希一遍。
 */
export function sessionAffinityKey(body, model, req) {
  const explicit = String(
    req?.headers?.['x-session-id'] ||
      req?.headers?.['x-conversation-id'] ||
      body?.session_id ||
      body?.conversation_id ||
      '',
  ).trim();
  if (explicit) return `${model}|id:${explicit.slice(0, 200)}`;

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const firstSystem = messages.find((m) => m?.role === 'system');
  const firstUser = messages.find((m) => m?.role === 'user');
  // 只取文本片段。图片是 base64，整段哈希既慢又没必要 —— 会话身份由文字决定。
  const clip = (content) => {
    if (typeof content === 'string') return content.slice(0, 4000);
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .join('\n')
        .slice(0, 4000);
    }
    return String(content ?? '').slice(0, 4000);
  };
  // 优先只用首条 user：system prompt 里常有日期/工具列表，每轮都变，
  // 把它算进哈希反而会让同一个会话每轮都换号，黏性直接失效。
  const anchor = firstUser?.content ?? firstSystem?.content;
  const basis = JSON.stringify([model, clip(anchor)]).slice(0, 8192);
  return `${model}|h:${createHash('sha1').update(basis).digest('hex').slice(0, 20)}`;
}

/** 解析上游 429 的 Retry-After（秒数或 HTTP 日期），失败返回 0。 */
export function retryAfterMsOf(headers) {
  const raw = String(headers?.get?.('retry-after') || '').trim();
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(600_000, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.min(600_000, at - Date.now())) : 0;
}
