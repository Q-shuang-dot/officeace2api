#!/usr/bin/env node
/**
 * 启动前的端口占用清理（tools/free-port.ps1）回归测试。
 *
 * 起因：端口被占时 node 会**立刻** EADDRINUSE 退出，而 start.cmd 还要空等 30×2 秒
 * 做健康检查，最后只丢一句 "health check timeout"。对双击了没反应的新用户就是黑洞。
 * 于是启动前先清一次端口 —— 但这件事有两条相反的硬要求，写错哪一条都会出事故：
 *
 *   A. 端口上是**没退干净的本服务实例**（占着端口、/healthz 不通）→ 必须清掉，
 *      否则起不来；
 *   B. 端口上是一个**健康的本服务**（/healthz 返回 {"status":"ok"}）→ 一个字节都
 *      不能动。早期 watchog 的 Clear-Port 是无条件杀的，结果两个守护轮流杀对方的
 *      服务，表现成「服务每隔几分钟掉一次又自己回来」。
 *
 * 还有两条是这次真跑出来的：
 *   C. Windows 的「保留端口范围」（Hyper-V / Docker 的 WinNAT 预留）在系统里表现为
 *      **pid 4 (System) 在 LISTEN** —— 没有进程可杀，必须认出这种情况并解释清楚，
 *      而不是教用户去任务管理器结束 pid 4；
 *   D. 探活必须快。占着端口却不应答的东西会一路卡到超时，慢探针表现成「双击
 *      start.cmd 之后发呆二十秒」。
 *
 * 这里用**真的进程**验证 A/B/C，共 8 项：
 *   1. 端口空着                → 退出码 0
 *   2. 死占用（裸 TCP 监听）   → 退出码 0，且那个进程真的被清掉
 *   3. 清完之后端口真的能绑     → true
 *   4. 死占用的识别要够快       → < 15s（D）
 *   5. 别的程序的 HTTP 200     → 退出码 0，进程被清掉（不是本服务就按普通占用处理）
 *   6. 健康的本服务（status:ok）→ 退出码 0，但**进程必须还活着**（B）
 *   7. 每次动作都落盘          → logs/port-clean.log 有新增行
 *   8. 保留端口范围            → 有 netsh 保留段时：退出码非 0 且打印「保留端口范围」；
 *                                没有这种段则跳过（不把结论钉死在这台机器上）
 *
 *   node tools/test-free-port.mjs
 *
 * 注意：假进程的脚本写在系统临时目录里，**不写进仓库**。free-port 会看占用者的
 * 命令行里有没有本项目路径来判断「是不是我们自己的实例」，脚本要是放在仓库里，
 * 这几条用例就会走进"清掉自己人"的分支，把一个无关的守护进程杀掉。
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FREE_PORT = path.join(ROOT, 'tools', 'free-port.ps1');
const LOG = path.join(ROOT, 'logs', 'port-clean.log');

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

// Windows 上必须用 powershell.exe（5.1）跑，因为调用方就是它，
// 而 free-port.ps1 是存成 UTF-8 带 BOM 给 5.1 读的。
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** 跑一次 free-port.ps1，返回 { code, out } */
function runFreePort(port, extraArgs = []) {
  const started = Date.now();
  const r = spawnSync(
    PS,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', FREE_PORT, '-Port', String(port), ...extraArgs],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 },
  );
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, ms: Date.now() - started };
}

/** 找一块空端口：绑 0 拿系统分给我们的那个，然后立刻放掉 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function bindable(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** 假占用者的脚本放临时目录，别放仓库（见文件头那段说明） */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'o2a-free-port-'));
const deadScript = path.join(TMP, 'dead-holder.mjs');
fs.writeFileSync(
  deadScript,
  [
    "import net from 'node:net';",
    'const port = Number(process.argv[2]);',
    'net.createServer(() => {}).listen(port, "127.0.0.1");',
    'console.log("listening " + port);',
    'setTimeout(() => process.exit(0), 120000);',
  ].join('\n'),
  'utf8',
);
const foreignScript = path.join(TMP, 'foreign-http.mjs');
fs.writeFileSync(
  foreignScript,
  [
    "import http from 'node:http';",
    'const port = Number(process.argv[2]);',
    'http.createServer((req, res) => { res.writeHead(200, {"content-type": "text/plain"}); res.end("not officeace2api"); })',
    '  .listen(port, "127.0.0.1");',
    'setTimeout(() => process.exit(0), 120000);',
  ].join('\n'),
  'utf8',
);
const oursScript = path.join(TMP, 'healthy-mimic.mjs');
fs.writeFileSync(
  oursScript,
  [
    "import http from 'node:http';",
    'const port = Number(process.argv[2]);',
    // 只要响应体里带 "status":"ok"，free-port 就判定成"本服务的健康实例"
    'http.createServer((req, res) => { res.writeHead(200, {"content-type": "application/json"}); res.end(JSON.stringify({ status: "ok", credentials: 0 })); })',
    '  .listen(port, "127.0.0.1");',
    'setTimeout(() => process.exit(0), 120000);',
  ].join('\n'),
  'utf8',
);

function startHolder(script, port) {
  const child = spawn(process.execPath, [script, String(port)], { stdio: 'ignore', windowsHide: true });
  return child;
}

async function waitListening(port, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await bindable(port))) return true; // 已经有人占着 = 起来了
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

function killQuiet(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* 已经没了 */
  }
}

console.log('端口占用清理（tools/free-port.ps1）');

if (!fs.existsSync(FREE_PORT)) {
  bad('tools/free-port.ps1 存在');
  console.log(`\n${pass} 项通过，${fails.length} 项失败`);
  process.exit(1);
}
if (!fs.existsSync(PS)) {
  bad(`Windows PowerShell 存在（${PS}）`);
  console.log(`\n${pass} 项通过，${fails.length} 项失败`);
  process.exit(1);
}

const logSizeBefore = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;

// ---- 1. 空端口 -------------------------------------------------------------
{
  const port = await freePort();
  const r = runFreePort(port);
  if (r.code === 0) ok(`端口 ${port} 空着 → 退出码 0`);
  else bad(`端口 ${port} 空着 → 退出码 0`, `got ${r.code} ${r.out.trim().slice(0, 200)}`);
}

// ---- 2/3/4. 死占用：裸 TCP 监听 --------------------------------------------
let deadPort = 0;
{
  deadPort = await freePort();
  const child = startHolder(deadScript, deadPort);
  const up = await waitListening(deadPort);
  if (!up) {
    bad(`死占用（pid ${child.pid}）先起来`);
  } else {
    const r = runFreePort(deadPort);
    await new Promise((res) => setTimeout(res, 400));
    const stillThere = alive(child.pid);
    if (r.code === 0 && !stillThere) ok('死占用：退出码 0 且占用者已被清掉');
    else bad('死占用：退出码 0 且占用者已被清掉', `code=${r.code} alive=${stillThere} ${r.out.trim().slice(0, 200)}`);

    const canBind = await bindable(deadPort);
    if (canBind) ok('清完之后端口真的可以绑定');
    else bad('清完之后端口真的可以绑定');

    if (r.ms < 15000) ok(`识别 + 清理够快（${r.ms} ms < 15000 ms）`);
    else bad('识别 + 清理够快', `${r.ms} ms`);
    killQuiet(child.pid);
  }
}

// ---- 5. 别的程序占着（会应答 HTTP 200，但不是本服务） ----------------------
{
  const port = await freePort();
  const child = startHolder(foreignScript, port);
  const up = await waitListening(port);
  if (!up) {
    bad('别的程序（HTTP 200）先起来');
  } else {
    await new Promise((res) => setTimeout(res, 300));
    const r = runFreePort(port);
    await new Promise((res) => setTimeout(res, 400));
    if (r.code === 0 && !alive(child.pid)) ok('别的程序占着 → 也按占用者清掉');
    else bad('别的程序占着 → 也按占用者清掉', `code=${r.code} alive=${alive(child.pid)} ${r.out.trim().slice(0, 200)}`);
    killQuiet(child.pid);
  }
}

// ---- 6. 健康的本服务：一个字节都不许动 --------------------------------------
{
  const port = await freePort();
  const child = startHolder(oursScript, port);
  const up = await waitListening(port);
  if (!up) {
    bad('健康实例（status:ok）先起来');
  } else {
    await new Promise((res) => setTimeout(res, 300));
    const r = runFreePort(port);
    await new Promise((res) => setTimeout(res, 400));
    if (r.code === 0 && alive(child.pid)) ok('健康的本服务 → 不动它（进程还在）');
    else bad('健康的本服务 → 不动它（进程还在）', `code=${r.code} alive=${alive(child.pid)} ${r.out.trim().slice(0, 200)}`);
    killQuiet(child.pid);
  }
}

// ---- 7. 动作落盘 ------------------------------------------------------------
{
  const logSizeAfter = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
  if (logSizeAfter > logSizeBefore) ok('每次动作都写进 logs/port-clean.log');
  else bad('每次动作都写进 logs/port-clean.log', `${logSizeBefore} -> ${logSizeAfter}`);
}

// ---- 8. 保留端口范围（Hyper-V / Docker 的 WinNAT 预留） ---------------------
{
  const netsh = spawnSync('netsh', ['interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
  const ranges = [];
  for (const line of String(netsh.stdout || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(\d{1,5})\s+(\d{1,5})(\s+\*)?\s*$/);
    if (m) ranges.push({ start: Number(m[1]), end: Number(m[2]) });
  }
  if (!ranges.length) {
    console.log('  - 本机没有保留端口范围，跳过这一项');
  } else {
    const port = ranges[0].start;
    // Windows 的 excludedportrange 在不同 build / 网络栈下语义并不完全一致：
    // 有的机器上落在段内仍然 bind 得动（本案就是这样）。这种环境没法用
    // 「绑定失败」来验证保留段分支，跳过比硬造一个失败更诚实。
    if (await bindable(port)) {
      console.log(`  - 保留段 ${port} 在当前系统仍可绑定，跳过这一项`);
    } else {
    const r = runFreePort(port);
    // 断言只用 ASCII 标记：powershell.exe 的中文输出走的是控制台代码页（936/437…），
    // 跨机器按 UTF-8 解码会变成乱码，拿中文原文断言等于在测这台机器的区域设置。
    // "winnat" 只出现在「保留端口范围」那一条分支里，config.json 是它给的第二个办法。
      const explained = /net stop winnat/.test(r.out) && /config\.json/.test(r.out);
      if (r.code !== 0 && explained) ok(`保留端口范围（${port}）→ 不杀进程，而是解释清楚`);
      else bad(`保留端口范围（${port}）→ 不杀进程，而是解释清楚`, `code=${r.code} explained=${explained} ${r.out.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    }
  }
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 临时目录删不掉不影响结论 */
}

console.log(`\n${pass} 项通过${fails.length ? `，${fails.length} 项失败：${fails.join('；')}` : ' ✅'}`);
process.exit(fails.length ? 1 : 0);