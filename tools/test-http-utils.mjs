#!/usr/bin/env node
/** HTTP 小工具：SSE 头 / JSON 头 / 请求 ID。 */

import { nextRequestId, sendJson, writeSseHead } from '../src/http-utils.mjs';

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  if (Object.is(actual, expected)) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function fakeRes() {
  return {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(status, headers) {
      this.status = status;
      for (const [k, v] of Object.entries(headers || {})) this.headers[k.toLowerCase()] = v;
      this.headersSent = true;
    },
    flushHeaders() {},
    end(body = '') { this.body += body; this.writableEnded = true; },
  };
}

console.log('【1】SSE 头：默认不带假的 Server-Timing');
{
  const res = fakeRes();
  writeSseHead(res);
  check('没有 Server-Timing', res.headers['server-timing'], undefined);
  check('状态 200', res.status, 200);
  check('暴露 X-Request-Id', /X-Request-Id/.test(res.headers['access-control-expose-headers']), true);
}

console.log('\n【2】SSE 头：有 ttfb 才写');
{
  const res = fakeRes();
  writeSseHead(res, { ttfbMs: 123 });
  check('ttfb=123', res.headers['server-timing'], 'ttfb;dur=123');
}

console.log('\n【3】JSON 头与请求 ID');
{
  const res = fakeRes();
  sendJson(res, 200, { ok: true });
  check('JSON Content-Type', res.headers['content-type'], 'application/json; charset=utf-8');
  check('暴露请求 ID', /X-Request-Id/.test(res.headers['access-control-expose-headers']), true);
  check('两个 ID 不重复', nextRequestId() === nextRequestId(), false);
}

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail ? 1 : 0);
