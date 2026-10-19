#!/usr/bin/env node
/**
 * 一键导出本机账号凭据（换电脑用）
 *
 *   node tools/export-accounts.mjs                    # 导出到 accounts-backup\（不加密）
 *   node tools/export-accounts.mjs --pass 我的口令     # 导出并加密（推荐）
 *   node tools/export-accounts.mjs --out D:\a.json --plain
 *
 * 服务在跑的时候走管理接口（用的是它内存里那份最新状态），服务没跑就直接读盘 ——
 * 两条路结果一样，选哪条只看服务在不在。这样"换电脑"时不需要先把服务起起来。
 *
 * 为什么要加密：里面是 `data/oauth-accounts.json` 里那些**长期有效**的 Basic 凭据、
 * 一次性 refresh_token、DPoP 私钥。明文文件一旦被微信/网盘/邮箱中转，就等于把号送人。
 * 不加口令也能导（--plain 或直接回车），但 CLI 会明确提示风险，且导出文件会
 * 立刻被收紧权限（只有当前 Windows 用户能读）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { AccountStore } from '../src/accounts.mjs';
import { RefreshState } from '../src/refresh.mjs';
import {
  buildBundle,
  bundleFileName,
  collectAccounts,
  formatTime,
  ONE_TIME_TOKEN_WARNING,
  PLAINTEXT_WARNING,
  summarizeAccounts,
} from '../src/bundle.mjs';
import { lockDownFile, writeFileAtomic } from '../src/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const pass = opt('--pass') || process.env.O2A_BUNDLE_PASS || '';

function die(msg, code = 1) {
  console.error(`[X] ${msg}`);
  process.exit(code);
}

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 端口上这个服务，是**我这个目录**起的吗？
 *
 * 只判 `/healthz` 通不通是不够的：同一台机器上可能放着两份项目（旧版还在 7864 上跑着），
 * 或者用户是在「新机器的目录」里跑导出。实测踩过——`tools/import-accounts.mjs` 把账号包
 * POST 到了另一个目录的服务上，回来的是一句看不懂的「管理员 token 无效」。
 * 服务会把代码根目录放进 `/healthz.root`，比一下就知道该不该用接口。
 */
function normDir(p) {
  return String(p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
}

/** 服务在不在？在的话直接问它要（它内存里的续期链是最新的） */
async function probeService({ host, port }, ms = 2500) {
  try {
    const r = await fetch(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    const doc = await r.json();
    if (!doc || doc.status !== 'ok') return null;
    // 老版本服务不带 root → 当作本项目（否则升级一半的用户全被降级成离线读盘）
    const foreign = !!doc.root && normDir(doc.root) !== normDir(ROOT);
    return { doc, foreign, root: doc.root || '' };
  } catch {
    return null;
  }
}

/** 服务没响应时，看看锁文件里的进程是不是还活着（防止"以为停了其实在跑"） */
function lockPid() {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(DATA, 'instance.lock'), 'utf8'));
    const pid = Number(doc?.pid) || 0;
    if (!pid) return 0;
    try {
      process.kill(pid, 0);
      return pid;
    } catch (err) {
      return err.code === 'EPERM' ? pid : 0;
    }
  } catch {
    return 0;
  }
}

const config = loadConfig(path.join(ROOT, 'config.json'));
const host = config.listen?.host || '127.0.0.1';
const port = Number(config.listen?.port) || 7864;
const token = String(config.admin?.token || '');

console.log('== 导出本机账号凭据 ==');
console.log(`   端口 : http://${host}:${port}`);

const live = await probeService({ host, port });
// 端口上活着，但那是**别的目录**起的服务（同一台机器放了两份项目）→ 不能问它要数据
const foreign = live && live.foreign;
if (foreign) {
  console.log(`   [!] ${host}:${port} 上是另一个目录的服务（${live.root}），本次直接读本项目的文件。`);
}
let text;
let source = '';

if (live && !foreign) {
  source = '服务（内存里那份最新状态）';
  const q = new URLSearchParams();
  if (pass) q.set('pass', pass);
  if (token) q.set('token', token);
  let r;
  try {
    r = await fetch(`http://${host}:${port}/admin/api/accounts/export?${q.toString()}`, {
      headers: token ? { 'x-admin-token': token } : {},
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    die(`连不上服务：${err.message}。可以先双击 stop.cmd 停掉，再导出（导出的内容一样）。`);
  }
  text = await r.text();
  let doc = null;
  try {
    doc = JSON.parse(text);
  } catch {
    die(`服务返回的不是 JSON（HTTP ${r.status}）：${text.slice(0, 200)}`);
  }
  if (doc && doc.ok === false) die(doc.error?.message || '服务拒绝了导出');
  if (!r.ok) die(`HTTP ${r.status}：${text.slice(0, 200)}`);
} else {
  const pid = lockPid();
  if (pid) {
    die(
      `服务进程还在（pid ${pid}），但 ${host}:${port} 没响应。\n` +
        '    先双击 stop.cmd 把它停干净再导出 —— 否则导出的是磁盘上的旧状态，可能少掉最新一轮续期换来的 token。',
    );
  }
  source = '本地数据文件（服务没在跑）';
  const store = new AccountStore({
    dataFile: path.join(DATA, 'accounts.json'),
    installDirs: config.discover?.installDirs || [],
  });
  store.load();
  store.scan();
  const refresh = new RefreshState(path.join(DATA, 'refresh-state.json'));
  const collected = collectAccounts({
    accounts: store.rawList(),
    oauthDoc: store.readOauthDoc(),
    refreshDoc: refresh.doc,
    meta: store.meta,
  });
  if (!collected.length) {
    die('本机没有可导出的账号。先去 OfficeAce 登录一个号，或在面板上「导入账号」，再回来导出。');
  }
  text = JSON.stringify(
    buildBundle(
      { accounts: collected, appVersion: '', host: os.hostname(), user: process.env.USERNAME || '' },
      { pass },
    ),
    null,
    pass ? 0 : 1,
  );
}

// ---- 落盘 ----------------------------------------------------------------
const outDir = opt('--dir', path.join(ROOT, 'accounts-backup'));
const outFile = opt('--out', path.join(outDir, bundleFileName({ host: os.hostname(), encrypted: !!pass })));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
writeFileAtomic(outFile, text, { mode: 0o600 });
lockDownFile(outFile); // 明文也得只有自己能读

const doc = JSON.parse(text);
const stats = doc.stats || summarizeAccounts(doc.accounts || []);
const size = fs.statSync(outFile).size;

console.log('');
console.log(`[OK] 已导出 ${stats.total} 个账号（其中 ${stats.renewable} 个能自动续期/读积分）`);
console.log(`     只能转发（缺 refresh_token）: ${stats.total - stats.renewable}`);
console.log(`     带临时 AK/SK（24h 内有效）  : ${stats.withLiveCredential}`);
console.log(`     带 DPoP 私钥                : ${stats.withDpop}`);
console.log(`     数据来源            : ${source}`);
console.log(`     导出时间            : ${formatTime(doc.createdAt || Date.now())}`);
console.log(`     加密                : ${pass ? '是（AES-256-GCM + scrypt）' : '否 —— 明文！'}`);
console.log(`     文件大小            : ${humanSize(size)}`);
console.log(`     文件位置            : ${outFile}`);
console.log('');
if (!pass) {
  // 文案跟包里那句一致（同一个常量），避免"文档说有警告、实际没有"
  console.log(`[!] ${PLAINTEXT_WARNING}`);
  console.log('    想加密就重跑一次并加 --pass 你的口令。');
  console.log('');
}
console.log(`[!] ${ONE_TIME_TOKEN_WARNING}`);
console.log('');
console.log('下一步：把这个文件拷到新电脑，双击 import-accounts.cmd（或直接把文件拖到它上面）。');
if (flag('--open') || process.platform === 'win32') {
  // 顺手在资源管理器里选中它，省得自己找路径（失败也无所谓）
  try {
    const { spawn } = await import('node:child_process');
    spawn('explorer.exe', ['/select,', outFile], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* 无所谓 */
  }
}
