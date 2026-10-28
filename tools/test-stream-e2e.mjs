#!/usr/bin/env node
/**
 * 流式链路 E2E：假的华为上游 + 真的 createApp，不依赖正在跑的生产服务。
 *
 * 覆盖：
 *   ① 正常 SSE：客户端拿到内容、[DONE]、X-Request-Id、Server-Timing；
 *   ② 主模型 429 → 兜底模型成功，响应带 X-Fallback-Model；
 *   ③ 客户端中途 abort：代理不崩、在途计数归还；
 *   ④ 上游 400 是请求级错误，不计入账号熔断。
 *
 * 跑：node tools/test-stream-e2e.mjs
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createApp } from '../src/server.mjs';
import { CredentialPool } from '../src/pool.mjs';
import { ModelRegistry } from '../src/models.mjs';
import { UsageStore } from '../src/stats.mjs';

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function success(res, model, { delayMs = 0 } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = () => {
    sse(res, {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    });
    sse(res, {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
    });
    sse(res, {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    });
    res.write('data: [DONE]\n\n');
    res.end();
  };
  if (delayMs > 0) setTimeout(send, delayMs);
  else send();
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'o2a-e2e-'));
let mode = 'normal';
let upstreamRequests = 0;

const upstream = http.createServer(async (req, res) => {
  upstreamRequests += 1;
  let body = {};
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    /* ignore */
  }
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"not found"}}');
    return;
  }
  if (mode === 'fallback' && body.model === 'model-a') {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
    res.end(JSON.stringify({ error: { code: 'ModelArts.81111', message: 'rate limited' } }));
    return;
  }
  if (mode === 'badrequest') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'BadRequest', message: 'invalid parameter' } }));
    return;
  }
  if (mode === 'slow') {
    // 先吐一个 chunk，让代理把 SSE 头发出去，再挂住等客户端 abort。
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    sse(res, {
      id: 'chatcmpl-slow',
      object: 'chat.completion.chunk',
      model: body.model || 'model-a',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    });
    setTimeout(() => {
      try {
        sse(res, { choices: [{ index: 0, delta: { content: 'late' }, finish_reason: 'stop' }] });
        res.write('data: [DONE]\n\n');
        res.end();
      } catch {
        /* client gone */
      }
    }, 500);
    return;
  }
  success(res, body.model || 'model-a');
});

const upstreamPort = await listen(upstream);

const config = {
  listen: { host: '127.0.0.1', port: 0 },
  apiKeys: ['sk-test'],
  admin: { token: 'test-admin' },
  upstream: {
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    maxRetries: 1,
    retryBackoffMs: 10,
    timeoutSeconds: 10,
    earlyHeaderMs: 3000,
    includeUsage: true,
  },
  models: {
    alias: {},
    hidden: [],
    extra: ['model-a', 'model-b'],
    fallback: { 'model-a': ['model-b'] },
    minMaxTokens: 0,
    maxMaxTokens: 0,
    minMaxTokensByModel: {},
    maxMaxTokensByModel: {},
    emptyRetryFloorTokens: 0,
    emptyRetryContentTokens: 0,
    reasoningModels: [],
  },
  pool: { maxInFlightPerCredential: 2, sessionTtlSeconds: 60, latencyWeightMs: 100, queueTimeoutMs: 1000 },
  quota: { credentialPerModelCooldown: true, cooldownOnRateLimitMs: 1000 },
};

const pool = new CredentialPool(config.pool);
pool.add({
  baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
  headers: { Authorization: 'Bearer test' },
  source: 'e2e',
  userId: 'user-e2e',
  accountId: 'acct-e2e',
});

const registry = new ModelRegistry({ extra: ['model-a', 'model-b'] });
const usage = new UsageStore({ file: path.join(tmp, 'usage.json'), flushMs: 60000 });
const accounts = {
  get: () => null,
  list: () => [{ id: 'acct-e2e', enabled: true, health: { state: 'ok' } }],
  status: () => ({ total: 1, enabled: 1, healthy: 1 }),
  size: () => 1,
};

const app = createApp({
  config,
  pool,
  registry,
  usage,
  accounts,
  credits: null,
  version: 'e2e',
  startedAt: Date.now(),
});
const proxyPort = await listen(app.server);
const base = `http://127.0.0.1:${proxyPort}`;

async function chat(body, { signal, headers = {} } = {}) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer sk-test',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  return { res, text };
}

try {
  console.log('【1】正常流式：内容、结束标记、请求 ID、Server-Timing');
  {
    const r = await chat({
      model: 'model-a',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    check('HTTP 200', r.res.status, 200);
    check('包含正文', r.text.includes('Hello'), true);
    check('包含 [DONE]', r.text.includes('[DONE]'), true);
    check('X-Request-Id 存在', !!r.res.headers.get('x-request-id'), true);
    check('Server-Timing 有 ttfb', /ttfb;dur=\d+/.test(r.res.headers.get('server-timing') || ''), true);
  }

  console.log('\n【2】主模型 429 → 兜底模型成功');
  {
    mode = 'fallback';
    const r = await chat({
      model: 'model-a',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    check('HTTP 200', r.res.status, 200);
    check('兜底响应头', r.res.headers.get('x-fallback-model'), 'model-b');
    check('包含兜底正文', r.text.includes('Hello'), true);
    mode = 'normal';
  }

  console.log('\n【3】客户端 abort：服务不崩、在途归还');
  {
    mode = 'slow';
    const ac = new AbortController();
    const pending = chat(
      { model: 'model-a', stream: true, messages: [{ role: 'user', content: 'abort me' }] },
      { signal: ac.signal },
    ).catch(() => null);
    setTimeout(() => ac.abort(), 120);
    await pending;
    await new Promise((r) => setTimeout(r, 300));
    check('池子在途归零', pool.list().every((c) => c.inFlight === 0), true);
    mode = 'normal';
  }

  console.log('\n【4】上游 400 是请求错误，不计入账号熔断');
  {
    const before = pool.list()[0].fail;
    const beforeStreak = pool.list()[0].consecutiveFails;
    mode = 'badrequest';
    const r = await chat({
      model: 'model-a',
      stream: true,
      messages: [{ role: 'user', content: 'bad param' }],
    });
    check('HTTP 400', r.res.status, 400);
    check('失败计数没有增加', pool.list()[0].fail, before);
    check('连败计数仍为 0', pool.list()[0].consecutiveFails, beforeStreak);
    mode = 'normal';
  }

  console.log('\n【5】非流式也带请求 ID');
  {
    const r = await chat({
      model: 'model-a',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    check('HTTP 200', r.res.status, 200);
    check('JSON 正文', r.text.includes('"object":"chat.completion"'), true);
    check('X-Request-Id 存在', !!r.res.headers.get('x-request-id'), true);
    check('Server-Timing 有 total', /total;dur=\d+/.test(r.res.headers.get('server-timing') || ''), true);
  }

  check('假上游确实被调用', upstreamRequests >= 3, true);
} finally {
  await close(app.server);
  await close(upstream);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail ? 1 : 0);
