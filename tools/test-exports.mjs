#!/usr/bin/env node
/**
 * 源码卫生：**导出面 = 承诺**。
 *
 * `src/*.mjs` 里每个 `export` 都应该有人消费：别的文件 `import { x }`、
 * `import * as ns` 之后 `ns.x`、或者 `const { x } = await import('...')` 解构。
 * 一个"导出了但没人用"的名字，会让下一个读代码的人以为它有外部消费者 ——
 * 改它、删它之前都要先去确认一遍。而这类腐化是**静默**的：删掉最后一个消费者时，
 * 没有任何东西会提醒你。
 *
 * 判定标准是「**谁 import 了我**」，不是「这个名字有没有被提到」。
 * 后者会双向出错：
 *   · 漏判 —— 别处的同名局部变量、注释、字符串里出现同一个词，都被算成"有人用"
 *   · 错杀 —— 文档里提过一次，不等于代码里有人在用
 * 上一轮的审计用的就是名字匹配，所以看着 28 个多余导出只能"留着"；
 * 改成按 import 判定之后一次清干净（见 docs/技术笔记.md「七之三之十四」）。
 *
 * 用法：node tools/test-exports.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 用 fileURLToPath 而不是 new URL(...).pathname：后者不做百分号解码，
// 项目路径里有中文（<带中文的目录>\...）时会被编码成 %E4%B8%AA... 然后 ENOENT
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const TOOLS = path.join(ROOT, 'tools');

let pass = 0;
let fail = 0;
const ok = (m, extra = '') => {
  pass += 1;
  console.log(`  ✓ ${m}${extra ? `  ${extra}` : ''}`);
};
const bad = (m, extra = '') => {
  fail += 1;
  console.log(`  ✗ ${m}${extra ? `  ${extra}` : ''}`);
};

/* ---------------------------------------------- 解析：src 里导出了什么 */
function exportedNames(text) {
  const names = new Set();
  // export function foo / export async function foo / export const foo / export let foo / export class Foo
  for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  // export { a, b as c }
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      names.add(t.split(/\s+as\s+/).pop().trim());
    }
  }
  return names;
}

const srcFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.mjs'));
const toolFiles = fs.readdirSync(TOOLS).filter((f) => f.endsWith('.mjs'));
const consumersOf = new Map(); // 名字 -> Set(消费者文件)
const namespaceImports = []; // [消费者, 命名空间名, 目标文件, 全文]

const note = (name, by) => {
  if (!consumersOf.has(name)) consumersOf.set(name, new Set());
  consumersOf.get(name).add(by);
};

for (const [dir, list] of [
  [SRC, srcFiles],
  [TOOLS, toolFiles],
]) {
  for (const f of list) {
    const label = `${path.basename(dir)}/${f}`;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*['"]/g)) {
      for (const part of m[1].split(',')) {
        const t = part.trim();
        if (t) note(t.split(/\s+as\s+/)[1]?.trim() || t.split(/\s+as\s+/)[0].trim(), label);
      }
    }
    for (const m of text.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"]/g)) {
      namespaceImports.push([label, m[1], path.basename(m[2]), text]);
    }
    for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\s*\(\s*['"][^'"]+['"]/g)) {
      for (const part of m[1].split(',')) {
        const t = part.trim();
        if (t) note(t.split(/\s+as\s+/)[1]?.trim() || t.split(/\s+as\s+/)[0].trim(), label);
      }
    }
  }
}

/** 有没有别的文件在消费这个名字（定义它的文件自己不算） */
function hasConsumer(defFile, name) {
  const owners = consumersOf.get(name);
  if (owners) {
    for (const o of owners) if (o !== `src/${defFile}`) return `import by ${o}`;
  }
  for (const [label, ns, target, text] of namespaceImports) {
    if (target === defFile && new RegExp(`\\b${ns}\\.${name}\\b`).test(text)) return `${label} 的 ${ns}.${name}`;
  }
  return null;
}

/* ---------------------------------------------- 先自检：解析器不能悄悄坏掉 */
console.log('════ 源码卫生：导出面 ════\n');
console.log('【0】先确认这套判定本身是活的（避免"解析器坏了 → 空集合 → 全体通过"）');
{
  const total = [...srcFiles].reduce((n, f) => n + exportedNames(fs.readFileSync(path.join(SRC, f), 'utf8')).size, 0);
  if (total >= 60 && total <= 200) ok(`解析到 ${total} 个导出名（在合理区间内）`);
  else bad('导出名数量异常，解析器可能坏了', String(total));

  if (consumersOf.size >= 30) ok(`解析到 ${consumersOf.size} 个被 import 的名字`);
  else bad('消费者索引太小，解析器可能坏了', String(consumersOf.size));

  // 反向对照：这两种一定有人 import，判定必须说"有"
  for (const [file, name] of [
    ['register.mjs', 'RegisterQueue'],
    ['modelProbe.mjs', 'ModelProbe'],
  ]) {
    const hit = hasConsumer(file, name);
    if (hit) ok(`${file} 的 ${name} 判定为有消费者`, hit);
    else bad(`${name} 该有消费者却判定为没有（假阴性，这套检查就废了）`);
  }
  // 多行 import 的对照：upstream.mjs 这几个名字只在 server.mjs 那个
  // `import {\n  buildUpstreamBody,\n  …\n} from './upstream.mjs'` 里被用到。
  // （`[^}]*` 在 JS 正则里跨行匹配，所以多行写法本来就读得到 —— 但这点最容易被
  // 怀疑，所以留一个具名对照钉住它。）
  for (const name of ['quirksFor', 'TINY_MAX_TOKENS']) {
    const hit = hasConsumer('upstream.mjs', name);
    if (hit) ok(`多行 import 里的 ${name} 判定为有消费者`, hit);
    else bad(`${name}（写在多行 import 里）判定为没有 —— 解析器漏读多行 import`);
  }
  // 正向对照：编造的名字必须判定为"没有"
  if (!hasConsumer('register.mjs', '这个导出肯定不存在')) ok('编造的名字判定为没有消费者（不会一律放行）');
  else bad('编造的名字被判成有消费者（判定太松）');
}

/* ---------------------------------------------- 真断言 */
console.log('\n【1】src 里每个导出都必须有消费者');
{
  const violations = [];
  const usedByToolsOnly = [];
  for (const f of srcFiles) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const name of exportedNames(text)) {
      const hit = hasConsumer(f, name);
      if (!hit) violations.push(`src/${f} 的 ${name}`);
      else if (hit.startsWith('import by tools/')) usedByToolsOnly.push(`${name}（${hit}）`);
    }
  }

  if (violations.length === 0) ok('没有「导出了但没人用」的名字');
  else {
    bad(`有 ${violations.length} 个导出没人用`, '');
    for (const v of violations) console.log(`      · ${v}`);
    console.log('      处置：只在本文件用 → 去掉 export 前缀；连本文件也不用 → 整个删掉。');
  }

  // 只有测试用的导出是合法的（测试也是消费者），但要能一眼看见，别哪天被当成"死代码"删掉
  ok(`其中 ${usedByToolsOnly.length} 个只有 tools/ 里的脚本在用（合法，测试也是消费者）`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);