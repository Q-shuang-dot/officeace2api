/**
 * 纯 HTTP 小工具：请求 ID、SSE 头、JSON 响应、请求体读取、背压等待。
 *
 * 抽出来的目的不是「为了分层好看」，而是让 server.mjs 里那几条最容易被
 * 复制粘贴走样的协议细节只有一个实现：CORS 暴露头、Content-Length、
 * `res.write() === false` 的 drain 等待、请求体 64MB 上限。
 */

const MAX_BODY = 64 * 1024 * 1024;

let requestSeq = 0;

/** 给客户端和日志共用的请求 ID。进程重启后靠时间戳仍然不会撞。 */
export function nextRequestId() {
  requestSeq = (requestSeq + 1) % 1_000_000;
  return `o2a-${Date.now().toString(36)}-${requestSeq.toString(36).padStart(2, '0')}`;
}

/**
 * SSE 响应头。两个入口会发它：
 *   1. 正常路径：上游吐了第一帧，`relayPrimed` 开始透传；
 *   2. 慢首包路径：`runCompletion` 的 earlyHeaderMs 到点还没等到首帧，
 *      先发 200 + 头、用 `: ping` 注释帧续命。
 *
 * @returns {boolean} 真的发出去了才 true；已经发过（或响应已结束/断开）返回 false。
 */
export function writeSseHead(res, { ttfbMs = null } = {}) {
  if (res.headersSent || res.writableEnded || res.destroyed) return false;
  if (ttfbMs !== null && ttfbMs !== undefined && Number.isFinite(Number(ttfbMs)) && Number(ttfbMs) >= 0) {
    // 一旦把 200 头发出去，Server-Timing 就改不了了。
    res.setHeader('Server-Timing', `ttfb;dur=${Math.round(Number(ttfbMs))}`);
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'X-Request-Id, X-Fallback-Model, Server-Timing',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  return true;
}

/**
 * 等 `res` 把缓冲区写出去。
 *
 * `res.write()` 返回 false 表示「先别写了」，继续写只会把数据堆在 Node
 * 的用户态缓冲里。慢客户端 / 大输出时这不是理论问题，是实打实的内存增长。
 * 同时监听 close：客户端中途走了就别等 drain 了，那个事件永远不会来。
 */
function waitDrain(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
    if (res.destroyed || res.writableEnded) done();
  });
}

export async function writeChunk(res, chunk) {
  try {
    if (res.write(chunk)) return;
  } catch {
    // 客户端已经断了：让调用方在下一轮检查 res.destroyed 并结束。
    return;
  }
  await waitDrain(res);
}

export function sendJson(res, status, payload) {
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
    'Access-Control-Expose-Headers': 'X-Request-Id, X-Fallback-Model, Server-Timing',
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

export async function readJson(req) {
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
  // JSON.parse 还认 null / 数字 / 字符串 / 数组，但调用点都当对象用。
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
}
