#!/usr/bin/env node
/**
 * DPAPI 解密链的回归测试（这个模块原先一个测试都没有）。
 *
 * 为什么值得单独测：它是「凭据能不能读出来」的入口 —— 解不开就当明文降级、
 * 那个账号就静默消失；而它的实现方式是**起一个 PowerShell 子进程**，
 * 中间隔着一次 base64 编解码和一次环境变量传递。任何一环写错都不会抛异常，
 * 只是少一个账号。所以这里用真实的 Windows DPAPI（当前用户作用域）生成 blob
 * 再解回来，确保往返真的对。
 *
 * 末尾故意连喂 3 个坏 blob，钉住「连续失败进冷却」的语义：
 *   · 不是一失败就永久不可用（老实现就是那个 `unavailable` 布尔值，一置再也下不来）
 *   · 也不是每次失败都无限重试（一个坏 blob 会把整条通道按住）
 * 冷却中 `readProtectedText` 直接返回 null 不再尝试，而 `dpapiUnprotect`
 * 不受冷却影响 —— 这两条路径的差别是设计的一部分，一起钉住。
 *
 *   node tools/test-dpapi.mjs
 *
 * 只在本机跑 PowerShell，不碰网络，也不摸 data/ 里的真实状态。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DPAPI_HEADER, dpapiStatus, dpapiUnprotect, readProtectedText } from '../src/dpapi.mjs';

let pass = 0;
const fails = [];
function ok(name) {
  pass += 1;
  console.log(`  ✓ ${name}`);
}
function bad(name, extra) {
  fails.push(name);
  console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const PS = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'o2a-dpapi-'));
const write = (name, text) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, text, 'utf8');
  return p;
};

/** 用真的 Windows DPAPI 保护一段文本，返回 base64 blob */
function protect(plain) {
  const script = [
    'Add-Type -AssemblyName System.Security;',
    '$b=[Text.Encoding]::UTF8.GetBytes($env:OC_PLAIN);',
    '$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,',
    '[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
    '[Console]::Out.Write([Convert]::ToBase64String($p))',
  ].join('');
  return execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, OC_PLAIN: plain },
    windowsHide: true,
    timeout: 30000,
  }).trim();
}

console.log('DPAPI 解密链');

/* ---------------------------------------------- A. 好路径：真往返 + 缓存 */
const PLAIN = '{"accessKeyId":"AK-demo","secret":"中文也要能过"}';
let blob = '';
try {
  blob = protect(PLAIN);
} catch (err) {
  bad('能生成一个真实的 DPAPI blob（测试前提）', String(err.message || err).slice(0, 90));
}
if (blob) {
  ok(`真实的 DPAPI blob 生成成功（${blob.length} 字符 base64）`);
  const t0 = Date.now();
  const first = dpapiUnprotect(blob).toString('utf8');
  const ms1 = Date.now() - t0;
  if (first === PLAIN) ok(`往返一致（起子进程解密，含中文，${ms1}ms）`);
  else bad('往返一致（起子进程解密）', `拿到 ${JSON.stringify(first.slice(0, 40))}`);

  const t1 = Date.now();
  const second = dpapiUnprotect(blob).toString('utf8');
  const ms2 = Date.now() - t1;
  if (second === PLAIN && ms2 < 50) ok(`同一 blob 第二次走缓存（${ms2}ms，不再起子进程）`);
  else bad('同一 blob 第二次走缓存', `${ms2}ms（应当远小于首次 ${ms1}ms）`);

  const st = dpapiStatus();
  if (st.cached >= 1 && st.available === true) ok(`dpapiStatus() 反映缓存与可用性（cached=${st.cached}）`);
  else bad('dpapiStatus() 反映缓存与可用性', JSON.stringify(st));

  // 成功一次会把失败计数清零 —— 后面的冷却测试依赖这条语义，先钉住
  if (st.failStreak === 0) ok('成功一次即清零失败计数（后面冷却测试的前提）');
  else bad('成功一次即清零失败计数', `failStreak=${st.failStreak}`);
}

/* ---------------------------------------------- B. 文件读取：两种格式 + 缺失 */
{
  const real = write('real.txt', `${DPAPI_HEADER}\n${blob}\n`);
  const got = readProtectedText(real);
  if (got === PLAIN) ok('readProtectedText 能读 OC-DPAPI-1 文件（含头两行格式）');
  else bad('readProtectedText 能读 OC-DPAPI-1 文件', JSON.stringify(String(got).slice(0, 40)));

  // 不是该格式 = 明文，原样返回。注意空行会被**丢掉**，这是现有语义，钉住它，
  // 免得哪天改成保留空行之后，读 JSON 的地方多出一堆换行而没人发现。
  const plain = write('plain.txt', 'line1\n\nline2\n');
  if (readProtectedText(plain) === 'line1\nline2') ok('非该格式按明文返回（空行按现有语义被丢掉）');
  else bad('非该格式按明文返回', JSON.stringify(readProtectedText(plain)));

  // 空文件 / 不存在：都给 null，不抛
  const empty = write('empty.txt', '\n\n');
  if (readProtectedText(empty) === null) ok('空文件返回 null（不抛）');
  else bad('空文件返回 null', String(readProtectedText(empty)));

  if (readProtectedText(path.join(tmp, '不存在这个文件.txt')) === null) ok('文件不存在返回 null（不抛）');
  else bad('文件不存在返回 null', '竟然返回了东西');
}

/* ---------------------------------------------- C. 坏 blob：降级 + 连续失败进冷却 */
{
  const bad1 = write('bad1.txt', `${DPAPI_HEADER}\nAAAAAAAAAAAAAAAAAAAA`);
  const r1 = readProtectedText(bad1);
  const s1 = dpapiStatus();
  if (r1 === null && s1.failStreak === 1) ok('坏 blob 返回 null 且失败计数 +1（不抛）');
  else bad('坏 blob 返回 null 且失败计数 +1', `got=${String(r1)} streak=${s1.failStreak}`);

  readProtectedText(bad1);
  readProtectedText(bad1);
  const s3 = dpapiStatus();
  if (s3.failStreak >= 3 && s3.available === false) {
    ok(`连续 3 次失败后进入冷却（available=false, streak=${s3.failStreak}）`);
  } else {
    bad('连续 3 次失败后进入冷却', JSON.stringify(s3));
  }

  // 冷却中：即使给一份**正确**的档案也不再去试（省掉注定失败的子进程）
  const fresh = `${DPAPI_HEADER}\n${blob}`;
  const during = readProtectedText(write('good-during-cooldown.txt', fresh));
  const s4 = dpapiStatus();
  if (during === null && s4.failStreak === s3.failStreak) {
    ok('冷却中不再尝试解密（正确档案也返回 null，且失败计数不再增长）');
  } else {
    bad('冷却中不再尝试解密', `got=${String(during)} streak=${s3.failStreak}→${s4.failStreak}`);
  }

  // 但 dpapiUnprotect 本身**不受冷却影响** —— 它是「直接给 blob 就解」的底层接口，
  // 冷却只用来拦住 readProtectedText 那条批量扫盘的路径。
  const NEW_PLAIN = '另一个负载，证明通道没坏';
  const newBlob = protect(NEW_PLAIN);
  const direct = dpapiUnprotect(newBlob).toString('utf8');
  const s5 = dpapiStatus();
  if (direct === NEW_PLAIN && s5.available === true) {
    ok('dpapiUnprotect 不受冷却影响（新负载解得出，且成功即解除冷却）');
  } else {
    bad('dpapiUnprotect 不受冷却影响', `got=${JSON.stringify(direct.slice(0, 24))} status=${JSON.stringify(s5)}`);
  }
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 临时目录清不掉无所谓 */
}

console.log('\n' + '='.repeat(56));
console.log(`结果：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log(`  - ${f}`);
}
process.exit(fails.length ? 1 : 0);
