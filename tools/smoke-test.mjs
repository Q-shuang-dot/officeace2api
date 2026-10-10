#!/usr/bin/env node
/**
 * 端到端自测：对本服务发起一次真实请求
 *   node tools/smoke-test.mjs [--base http://127.0.0.1:7864] [--key sk-officeace] [--model glm-5.2] [--stream]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
} catch {
  /* ignore */
}

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};

const base = opt('--base', `http://${config.listen?.host || '127.0.0.1'}:${config.listen?.port || 7864}`);
const key = opt('--key', config.apiKeys?.[0] || 'sk-officeace');
const model = opt('--model', '');
const wantStream = argv.includes('--stream');

const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };

async function listModels() {
  const res = await fetch(`${base}/v1/models`, { headers });
  if (!res.ok) throw new Error(`/v1/models -> HTTP ${res.status}`);
  const doc = await res.json();
  console.log(`/v1/models  正常，共 ${doc.data.length} 个模型`);
  return doc.data.map((m) => m.id);
}

async function chat(modelId, stream) {
  const started = Date.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: '用一句话介绍你自己，并说出你的模型名。' }],
      max_tokens: 200,
      stream,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/v1/chat/completions -> HTTP ${res.status}\n${text.slice(0, 600)}`);
  }
  if (!stream) {
    const doc = await res.json();
    console.log(`\n[${modelId}] 非流式 ${Date.now() - started}ms`);
    console.log('  ' + (doc.choices?.[0]?.message?.content || '').trim().slice(0, 300));
    console.log('  usage:', JSON.stringify(doc.usage));
    return;
  }
  let first = 0;
  let content = '';
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const obj = JSON.parse(data);
        const delta = obj.choices?.[0]?.delta?.content;
        if (delta) {
          if (!first) first = Date.now();
          content += delta;
        }
      } catch {
        /* ignore */
      }
    }
  }
  console.log(`\n[${modelId}] 流式 首字节 ${first - started}ms 总耗时 ${Date.now() - started}ms`);
  console.log('  ' + content.trim().slice(0, 300));
}

const ids = await listModels();
const target = model || ids.find((id) => /glm-5\.2$/.test(id)) || ids[0];
if (!target) {
  console.error('没有可用模型');
  process.exit(1);
}
await chat(target, false);
await chat(target, true);
console.log('\n自测通过 ✅');
