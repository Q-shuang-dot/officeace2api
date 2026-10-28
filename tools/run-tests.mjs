#!/usr/bin/env node
/**
 * 回归测试入口（零依赖，仅 Node 内置模块）
 *
 *   node tools/run-tests.mjs [--only=<子串>] [--timeout=<秒>] [--list]
 *
 * 自动发现并执行：
 *   - tools/test-*.mjs      （回归资产）
 *   - tools/smoke-test.mjs  （端到端冒烟）
 * 按文件名排序，串行执行，逐个打印名称 / 退出码 / 耗时。
 *
 * 结果分三类：
 *   PASS    退出码 0
 *   FAIL    退出码非 0（超时也计入 FAIL）
 *   SKIP    脚本自己声明「本环境跑不了」——退出码 2，或输出里出现明确的
 *           SKIP / 跳过 标记。SKIP 会连同原因在汇总里显式列出，不会被吞掉。
 *
 * 退出码：全部 PASS 或 SKIP → 0；任一 FAIL → 1。
 *
 * 约定：脚本若因缺少真实网络 / 桌面端 / 凭据而无法运行，请用「退出码 2」或
 * 打印 `SKIP: <原因>` 声明，而不要伪装成 PASS。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(ROOT, 'tools');

const DEFAULT_TIMEOUT_SEC = 300;
const SKIP_EXIT_CODE = 2;

// 用「当前这个 node」本身去跑子脚本，而不是 PATH 里的 `node`。
// 这台机器上 PATH 的解析顺序会把 `node` 指到旧版本（nvm 的 v14），
// 于是测试会因为 .at() / ||= / fetch 缺失而假失败。process.execPath 由
// 调用方决定，天然与 npm test 使用同一个运行时。
const NODE = process.execPath;

// ── 参数解析 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name) => {
  const hit = argv.find((a) => a === name || a.startsWith(`${name}=`));
  if (hit === undefined) return undefined;
  const eq = hit.indexOf('=');
  return eq >= 0 ? hit.slice(eq + 1) : argv[argv.indexOf(hit) + 1];
};

const only = opt('--only') ?? '';
const listOnly = argv.includes('--list');
const timeoutRaw = opt('--timeout');
const timeoutSec = timeoutRaw === undefined ? DEFAULT_TIMEOUT_SEC : Number(timeoutRaw);

if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
  console.error(`--timeout 需要正数秒，收到: ${timeoutRaw}`);
  process.exit(1);
}

// ── 发现测试脚本 ────────────────────────────────────────────────────────────
function discover() {
  let entries = [];
  try {
    entries = fs.readdirSync(TOOLS, { withFileTypes: true });
  } catch (err) {
    console.error(`无法读取目录 ${TOOLS}: ${err.message}`);
    process.exit(1);
  }
  const names = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => n === 'smoke-test.mjs' || (/^test-.*\.mjs$/.test(n)))
    .filter((n) => (only ? n.includes(only) : true))
    .sort((a, b) => a.localeCompare(b, 'en'));
  return names.map((n) => ({ name: n, file: path.join(TOOLS, n) }));
}

const tests = discover();
if (tests.length === 0) {
  const suffix = only ? `（--only=${only} 未匹配到任何脚本）` : '';
  console.error(`没有发现可执行的测试脚本${suffix}`);
  process.exit(1);
}

if (listOnly) {
  for (const t of tests) console.log(t.name);
  console.log(`\n共 ${tests.length} 个`);
  process.exit(0);
}

// ── 执行单个脚本 ────────────────────────────────────────────────────────────
const SKIP_HINTS = [
  /^\s*SKIP\b/im,
  /^\s*\[SKIP\]/im,
  /\bSKIPPED\b/i,
  /跳过/,
  /已跳过/,
];

/**
 * 判定一个失败脚本是否其实属于「本环境跑不了」。
 * 只在输出明确自述缺网络 / 缺桌面端 / 缺凭据时才降级为 SKIP，避免把真失败漂白。
 */
function skipReason(exitCode, output) {
  if (exitCode === SKIP_EXIT_CODE) {
    const m = output.match(/^\s*(?:SKIP|\[SKIP\])\s*[:：-]?\s*(.+)$/im);
    return m ? m[1].trim().slice(0, 200) : '脚本以退出码 2 声明跳过';
  }
  for (const re of SKIP_HINTS) {
    if (re.test(output)) {
      const m = output.match(/^\s*(?:SKIP|\[SKIP\])\s*[:：-]?\s*(.+)$/im);
      return m ? m[1].trim().slice(0, 200) : '输出中声明了 SKIP';
    }
  }
  return null;
}

function runOne(test) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(NODE, ['--no-warnings', test.file], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' },
    });

    let out = '';
    let err = '';
    let timedOut = false;
    const cap = 400_000; // 防止超大输出吃内存
    child.stdout.on('data', (d) => {
      if (out.length < cap) out += d.toString();
    });
    child.stderr.on('data', (d) => {
      if (err.length < cap) err += d.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }, Math.round(timeoutSec * 1000));

    const settle = (exitCode) => {
      clearTimeout(timer);
      const combined = `${out}\n${err}`;
      const seconds = (Date.now() - started) / 1000;
      if (timedOut) {
        resolve({ status: 'FAIL', exitCode, seconds, reason: `超时 ${timeoutSec}s 已终止`, output: combined });
        return;
      }
      if (exitCode === 0) {
        resolve({ status: 'PASS', exitCode, seconds, output: combined });
        return;
      }
      const reason = skipReason(exitCode, combined);
      resolve({
        status: reason ? 'SKIP' : 'FAIL',
        exitCode,
        seconds,
        reason,
        output: combined,
      });
    };

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        status: 'FAIL',
        exitCode: -1,
        seconds: (Date.now() - started) / 1000,
        reason: `无法启动子进程: ${e.message}`,
        output: String(e.stack || e.message),
      });
    });
    child.on('close', (code) => settle(code === null ? -1 : code));
  });
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n, ' ');

console.log('回归测试开始');
console.log(`项目根目录: ${ROOT}`);
console.log(`发现 ${tests.length} 个脚本，超时 ${timeoutSec}s` + (only ? `，过滤 --only=${only}` : ''));
console.log('-'.repeat(72));

const results = [];
for (const test of tests) {
  process.stdout.write(`… ${test.name} `);
  const r = await runOne(test);
  results.push({ ...test, ...r });
  const secs = r.seconds.toFixed(2);
  process.stdout.write(`\r${pad(r.status, 7)} ${pad(test.name, 34)} exit=${pad(r.exitCode, 4)} ${secs}s\n`);
  const tail = r.output.trim().split('\n').slice(-1)[0];
  if (r.status !== 'PASS' && tail) console.log(`        └ ${tail.slice(0, 160)}`);
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.status === 'PASS');
const fail = results.filter((r) => r.status === 'FAIL');
const skip = results.filter((r) => r.status === 'SKIP');

console.log('-'.repeat(72));
console.log(`总计 ${results.length}  PASS ${pass.length}  FAIL ${fail.length}  SKIP ${skip.length}`);

if (skip.length) {
  console.log('\nSKIP 明细（本环境未执行 / 未通过）:');
  for (const r of skip) console.log(`  SKIP  ${r.name}  exit=${r.exitCode}  ${r.seconds.toFixed(2)}s  — ${r.reason || '未说明原因'}`);
}

if (fail.length) {
  console.log('\nFAIL 明细:');
  for (const r of fail) console.log(`  FAIL  ${r.name}  exit=${r.exitCode}  ${r.seconds.toFixed(2)}s  — ${r.reason || '非零退出'}`);
}

const exitCode = fail.length === 0 ? 0 : 1;
console.log(`\n结果: ${exitCode === 0 ? 'PASS（无 FAIL）' : 'FAIL'}  退出码 ${exitCode}`);
process.exit(exitCode);