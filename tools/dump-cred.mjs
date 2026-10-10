#!/usr/bin/env node
/**
 * 排障工具：打印本机发现到的 OfficeAce 凭据与模型目录
 *   node tools/dump-cred.mjs
 */

import { discover } from '../src/discover.mjs';
import { maskSecret } from '../src/util.mjs';

const result = discover();

console.log('== 上游凭据 ==');
if (result.credentials.length === 0) {
  console.log('  (无) 请先登录并运行一次 OfficeAce 桌面端');
}
for (const cred of result.credentials) {
  const auth = Object.entries(cred.headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1] || '';
  console.log(`  baseUrl     : ${cred.baseUrl}`);
  console.log(`  Authorization: ${maskSecret(auth)}`);
  if (auth.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const [id, secret] = decoded.split(':');
      console.log(`  AK/SK       : ${maskSecret(id)} / ${maskSecret(secret)}`);
    } catch {
      /* ignore */
    }
  }
  console.log(`  账号        : ${cred.userId || '-'}`);
  console.log(`  来源文件    : ${cred.source}`);
  console.log(`  携带模型    : ${cred.models.length} 个`);
  console.log('  ---');
}

console.log('\n== 本机模型目录 ==');
for (const item of result.catalog) {
  console.log(`  ${item.id.padEnd(28)} ${item.account.padEnd(14)} ${item.baseUrl}`);
}
console.log(`\n共 ${result.catalog.length} 个模型条目。`);
