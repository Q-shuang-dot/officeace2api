#!/usr/bin/env node
/**
 * 列出当前服务暴露的模型
 *   node tools/list-models.mjs [--base http://127.0.0.1:7864] [--key sk-officeace] [--json]
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

try {
  const res = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const doc = await res.json();
  if (argv.includes('--json')) {
    console.log(JSON.stringify(doc, null, 2));
  } else {
    console.log(`共 ${doc.data.length} 个模型`);
    for (const m of doc.data) {
      const tags = [m.developer, m.context_window, m.alias_of ? `→ ${m.alias_of}` : ''].filter(Boolean).join('  ');
      console.log(`  ${String(m.id).padEnd(30)} ${tags}`);
    }
  }
} catch (err) {
  console.log(`  读取失败: ${err.message}（服务没启动？先执行 start.cmd）`);
  process.exitCode = 1;
}
