/**
 * 极简 HTTP 客户端
 *
 * 为什么不用内置 fetch：
 *   1. 本机 OfficeAce 的 API 跑在自签证书的 https://127.0.0.1:3004 上，
 *      内置 fetch 无法关掉证书校验（没有 undici 依赖可用）；
 *   2. 需要精确控制超时、重定向、原始文本，这里用 node:https / node:http 直接做。
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { createLogger } from './logger.mjs';

const log = createLogger('http');

/**
 * @param {string} url
 * @param {{method?:string, headers?:object, body?:any, timeoutMs?:number,
 *          insecure?:boolean, redirect?:number}} opts
 * @returns {Promise<{status:number, headers:object, text:string, json:any, ok:boolean}>}
 */
export function request(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 20000,
    // ⚠️ 默认必须是 false（校验 TLS）。
    //
    // 这里以前默认 true，于是任何忘了显式传参的调用点都在裸奔 ——
    // 实测 authflow.mjs 轮询华为公网那个 /v1/claw/auth/code 就没传，
    // 等于给中间人留了读改授权码的门。
    //
    // 需要跳过校验的只有「本机 OfficeAce 自签证书」这一类，
    // 那些调用点现在都显式写了 insecure: true，别把这个默认值改回去。
    insecure = false,
    redirect = 3,
  } = opts;

  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(new Error(`URL 无效: ${url}`));
      return;
    }
    const isHttps = target.protocol === 'https:';
    const mod = isHttps ? https : http;

    let payload = null;
    const outHeaders = { ...headers };
    if (body !== undefined && body !== null) {
      payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      if (!Object.keys(outHeaders).some((k) => k.toLowerCase() === 'content-type')) {
        outHeaders['Content-Type'] = 'application/json';
      }
      outHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method,
        headers: outHeaders,
        ...(isHttps ? { rejectUnauthorized: !insecure } : {}),
      },
      (res) => {
        if (
          redirect > 0 &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          const next = new URL(res.headers.location, target);
          const nextOpts = { ...opts, method: 'GET', body: undefined, redirect: redirect - 1 };

          // 跳到别的 host 时不能把凭据带过去。
          // 以前是 {...opts} 原样传 headers，一个跳转就能把
          // Authorization: Basic base64(AK:SK) 送给第三方域名。
          if (next.host !== target.host) {
            const drop = /^(authorization|cookie|x-api-key|x-security-token|x-project-id|dpop)$/i;
            nextOpts.headers = Object.fromEntries(
              Object.entries(headers).filter(([k]) => !drop.test(k)),
            );
            log.warn('跳转到别的域名，已去掉凭据头', { from: target.host, to: next.host });
          }
          resolve(request(next.toString(), nextOpts));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* 非 JSON */
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json,
            ok: res.statusCode >= 200 && res.statusCode < 300,
          });
        });
      },
    );

    req.on('error', (err) => reject(err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时 ${timeoutMs}ms: ${url}`));
    });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** 探测一个地址是否是 OfficeAce 的本机 API（用 /api/islogin 的响应特征判断） */
export async function looksLikeOfficeAceApi(baseUrl, timeoutMs = 3000) {
  try {
    const res = await request(`${baseUrl.replace(/\/+$/, '')}/api/islogin`, {
      timeoutMs,
      insecure: true,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok || !res.json) return null;
    const j = res.json;
    if (typeof j.islogin !== 'boolean') return null;
    return {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      islogin: j.islogin,
      userId: j.userId || null,
      provider: j.provider?.id || '',
      providerName: j.provider?.displayName || '',
      loginUrl: j.loginUrl || '',
    };
  } catch (err) {
    log.debug('探测失败', { baseUrl, error: err.message });
    return null;
  }
}
