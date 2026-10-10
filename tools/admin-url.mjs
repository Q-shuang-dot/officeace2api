#!/usr/bin/env node
/**
 * 算出「控制台地址」，带上面板口令 —— 给手动打开面板 / 脚本调用用。
 *
 * 为什么要这么个小东西：面板现在默认要口令（`config.mjs` 的 `ensureAdminToken`
 * 会在首次启动时生成），而 `open-panel.cmd` / `status.cmd` 原来打开的是一句
 * 写死的 `http://127.0.0.1:7864/admin` —— 没带口令就是 401，
 * **新用户第一次点「打开控制台」就会撞上**。
 *
 * 用法：
 *   node tools\admin-url.mjs            # 完整地址（带口令），人类可读
 *   node tools\admin-url.mjs --quiet    # 只打印地址，供 .cmd 直接 start
 *   node tools\admin-url.mjs --port     # 只打印端口号，供 .cmd 做健康检查
 *   node tools\admin-url.mjs --cmd      # 生成 tools\admin-url.vars.cmd
 *
 * 端口和监听地址都从 `config.json` 读（也认 `OFFICEACE2API_PORT`），
 * 所以改了配置这里跟着变，不会像写死的 .cmd 那样对不上。
 *
 * ⚠️ 为什么还要 `--cmd`（不直接让 .cmd 用 `for /f` 抓输出）：
 *    `for /f ... in ('"%NODE%" "%~dp0tools\admin-url.mjs" --quiet')` 这种写法
 *    在 node 路径含空格时会崩 —— 内层 `cmd /c` 面对两个连着的带引号参数
 *    （`"D:\...\node.exe" "D:\...\admin-url.mjs"`）会把整串当**一个**带引号的
 *    命令名，最后报 `'""' is not recognized as an internal or external command`。
 *    实测就是踩了这个（`status.cmd` / `start.cmd` 都中招）。
 *    所以改成先把结论落成一个小 .cmd，再 `call` 进来 —— 变量赋值进文件，
 *    就没有"在 for /f 里拼一条带空格的命令行"这个易错环节了。
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wantPort = process.argv.includes('--port');
const wantCmd = process.argv.includes('--cmd');
const quiet = process.argv.includes('--quiet') || wantPort || wantCmd;

let cfg = {};
const cfgPath = path.join(ROOT, 'config.json');
if (existsSync(cfgPath)) {
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`config.json 解析失败：${err.message}\n`);
  }
}

const port = Number(process.env.OFFICEACE2API_PORT || cfg.listen?.port || 7864);
const host = String(cfg.listen?.host || '127.0.0.1');

/*
 * 监听 `0.0.0.0` 时不能拿它拼地址 —— 那是"所有网卡"的记号，浏览器打不开。
 * 自己开面板一律用 127.0.0.1。
 */
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
const displayHost = loopback ? '127.0.0.1' : host;

const token = String(cfg.admin?.token || '');
const url = `http://${displayHost}:${port}/admin${token ? `?token=${encodeURIComponent(token)}` : ''}`;

if (wantCmd) {
  /*
   * 生成一个能被 `call` 的小 .cmd，里面就三行变量赋值。
   * 值里可能带 `!`、`^`、`&` 之类，所以：
   *   · 用 `set "VAR=value"` 的带引号写法（cmd 里最安全的赋值形式）
   *   · 值里不该出现裸 `"`，出现就转义成 `\"`（口令是 base64url，实际不会有）
   *
   * ⚠️ 落在 `data\` 下，不落 `tools\` 下 —— 这里有**明文面板口令**，
   *    而 `data/*` 已经被 .gitignore 整个挡住了（`tools/*.cmd` 是会被提交的）。
   *    第一版我写到 tools\admin-url.vars.cmd，`git check-ignore` 一验就发现
   *    没被忽略 —— 万一提交上去就是把面板口令连同 repo 一起发出去了。
   */
  const esc = (s) => String(s).replace(/"/g, '\\"');
  const out = [
    '@echo off',
    'rem 自动生成，别手改，也别提交 —— 由 tools\\admin-url.mjs --cmd 写入，会被覆盖。',
    `set "O2A_PORT=${esc(port)}"`,
    `set "O2A_PANEL=${esc(url)}"`,
    `set "O2A_ADMIN_TOKEN=${esc(token)}"`,
    '',
  ].join('\r\n');
  const dir = path.join(ROOT, 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, 'admin-url.vars.cmd');
  writeFileSync(dst, out, 'utf8');
  process.stdout.write(dst);
} else if (wantPort) {
  process.stdout.write(String(port));
} else if (quiet) {
  process.stdout.write(url);
} else {
  console.log(url);
  if (!token) {
    console.log('（面板口令是空的 —— 这个配置下面板不校验，只适合本机自用）');
  } else if (!loopback) {
    console.log(`（服务监听在 ${host}，别人也能连；把 127.0.0.1 换成这台机器的 IP 就是给别人用的地址）`);
  }
}
