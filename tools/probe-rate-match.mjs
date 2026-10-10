/**
 * 核对面板那套倍率匹配：把 admin.html 里的 rateFor 原样抽出来跑一遍真实模型 ID。
 *
 * 为什么单独写一个：匹配规则里「哪种分隔符算边界」这件事很容易写错，
 * 而错了不会报错、只会显示一个**看起来合理但是错的**倍率（比如 glm-5.3 蹭 glm-5）。
 * 所以这里把真实 id 列表拉出来逐个打印，一眼能看出有没有蹭错。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 从 admin.html 里把 rateFor 抠出来（不重复实现，避免"抄错了改错地方"）
const html = fs.readFileSync(path.join(ROOT, 'src', 'admin.html'), 'utf8');
const start = html.indexOf('function rateFor(id, rates) {');
if (start < 0) {
  console.error('  ✗ admin.html 里找不到 rateFor');
  process.exit(1);
}
// 按大括号配对找到函数结尾
let depth = 0;
let end = start;
for (let i = html.indexOf('{', start); i < html.length; i += 1) {
  if (html[i] === '{') depth += 1;
  else if (html[i] === '}') {
    depth -= 1;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
}
const src = html.slice(start, end);
// eslint-disable-next-line no-new-func
const rateFor = new Function(`${src}; return rateFor;`)();

// 真实的倍率表（从控制面拿的）
const res = await fetch('http://127.0.0.1:7864/admin/api/model-rates');
const ratesJson = await res.json();
const rates = {};
for (const r of ratesJson.rates || []) rates[r.model] = r;
console.log(`  倍率表里 ${Object.keys(rates).length} 个：${Object.keys(rates).join(', ')}\n`);

const state = await (await fetch('http://127.0.0.1:7864/admin/api/state')).json();
const ids = (state.models || []).map((m) => m.id).sort();

console.log('  模型 ID                      倍率      说明');
let exact = 0;
let borrowed = 0;
let none = 0;
for (const id of ids) {
  const hit = rateFor(id, rates);
  if (!hit) {
    none += 1;
    console.log(`  ${id.padEnd(28)} ${'-'.padEnd(9)} 未发布`);
  } else if (hit.exact) {
    exact += 1;
    console.log(`  ${id.padEnd(28)} ${(Number(hit.rate.coefficient).toFixed(2) + 'x').padEnd(9)} 精确命中`);
  } else {
    borrowed += 1;
    console.log(`  ${id.padEnd(28)} ${(Number(hit.rate.coefficient).toFixed(2) + 'x').padEnd(9)} 借自 ${hit.from}${hit.fuzzy ? '（异体分隔符）' : ''}`);
  }
}

console.log(`\n  合计：${exact} 精确 / ${borrowed} 借用 / ${none} 未发布  （共 ${ids.length} 个）`);

// 硬校验：绝对不能出现「跨代蹭」
const mustNotBorrow = ['glm-5.3', 'glm-5.3-test', 'glm-5.3-zx'];
let bad = 0;
for (const id of mustNotBorrow) {
  if (!ids.includes(id)) continue;
  const hit = rateFor(id, rates);
  if (hit && !hit.exact) {
    bad += 1;
    console.log(`  ✗ ${id} 蹭到了 ${hit.from} 的 ${Number(hit.rate.coefficient).toFixed(2)}x —— 跨代了，应该留 "-"`);
  }
}
console.log(bad ? `  ✗ ${bad} 个跨代误蹭` : '  ✓ 没有跨代误蹭（glm-5.3 系列没有被 glm-5 蹭走）');
process.exit(bad ? 1 : 0);
