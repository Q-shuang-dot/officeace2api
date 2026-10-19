#!/usr/bin/env node
/**
 * 一键导入账号凭据（换电脑用，配合 tools/export-accounts.mjs）
 *
 *   node tools/import-accounts.mjs 文件.json              # 文件没加密
 *   node tools/import-accounts.mjs 文件.json --pass 口令    # 文件加过密
 *   node tools/import-accounts.mjs 文件.json --check        # 只看包里有什么，不写任何东西
 *
 * 服务在跑就交给服务做（它内存里那份续期状态才是权威的），没跑就直接写数据文件。
 * 两条路都会先把 `data\accounts.json` / `oauth-accounts.json` / `refresh-state.json`
 * 备份到 `data\import-backup-<时间>\`，并且**只保留最新 3 份**（里面是明文凭据，
 * 攒着没人会清）。
 *
 * ⚠️ 为什么"服务在跑却要写文件"必须被拦住：
 * `data/refresh-state.json` 是「启动时读进内存、每次 save() 整份写回」的。
 * 外部改磁盘 → 服务下一轮续期一 save 就把导入的内容**整个覆盖掉**。
 * 症状是"导入时提示成功，重启后又没了" —— 这种 bug 排查起来极费劲，所以宁可挡住。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { AccountStore } from '../src/accounts.mjs';
import { RefreshState } from '../src/refresh.mjs';
import { mergeBundle, ONE_TIME_TOKEN_WARNING, parseBundle, summarizeAccounts } from '../src/bundle.mjs';
import { maskSecret, pickStaleEntries } from '../src/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const MAX_BYTES = 64 * 1024 * 1024;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
// 拖到 .cmd 上的文件是第一个「不以 - 开头」的参数；--pass 的值不能算进去
const fileArg = (() => {
  const skip = new Set();
  for (const name of ['--pass', '--file']) {
    const i = argv.indexOf(name);
    if (i >= 0 && argv[i + 1] !== undefined) skip.add(i + 1);
  }
  return argv.find((a, i) => !a.startsWith('-') && !skip.has(i)) || opt('--file', '');
})();
const pass = opt('--pass') || process.env.O2A_BUNDLE_PASS || '';

function die(msg, code = 1) {
  console.error(`[X] ${msg}`);
  process.exit(code);
}

const config = loadConfig(path.join(ROOT, 'config.json'));
const host = config.listen?.host || '127.0.0.1';
const port = Number(config.listen?.port) || 7864;
const token = String(config.admin?.token || '');

/**
 * 端口上这个服务，是**我这个目录**起的吗？
 *
 * 只判 `/healthz` 通不通会出事：同一台机器上两份项目（或旧版还在 7864 上跑着）时，
 * 导入会被 POST 到另一个目录的服务上。实测踩过——在「模拟新机器」的空目录里跑导入，
 * 报的是一句看不懂的「管理员 token 无效」，账号包却已经发到别的实例去了。
 * 服务把代码根目录放在 `/healthz.root`，比一下就知道该不该走接口。
 */
function normDir(p) {
  return String(p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
}

async function probeService(ms = 2500) {
  try {
    const r = await fetch(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    const doc = await r.json();
    if (!doc || doc.status !== 'ok') return null;
    // 老版本服务不带 root → 当作本项目（升级一半的机器不该突然全走离线路径）
    const foreign = !!doc.root && normDir(doc.root) !== normDir(ROOT);
    return { doc, foreign, root: doc.root || '' };
  } catch {
    return null;
  }
}

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

function report(results, { legacy = false, extra = [] } = {}) {
  const added = results.filter((r) => r.action === 'added');
  const updated = results.filter((r) => r.action === 'updated');
  const skipped = results.filter((r) => r.action === 'skipped');
  const present = results.filter((r) => r.action === 'already-present');
  const kept = results.filter((r) => r.refresh === 'kept-local-chain');
  const renew = results.filter((r) => r.canRenew);
  // 「只能转发」= 导入后真的不能续期的那批（不能按 kind 判：扫描出来的号也可能带 token+DPoP，
  // 那种会被写成完整档案、能续期）
  const manual = results.filter((r) => !r.canRenew && r.action !== 'already-present');
  console.log('');
  console.log(`[OK] 导入完成：${results.length} 个账号（新增 ${added.length}，更新 ${updated.length}${skipped.length ? `，跳过 ${skipped.length}` : ''}${present.length ? `，本机已有 ${present.length}` : ''}）`);
  console.log(`     能自动续期/读积分 : ${renew.length} 个（带 refresh_token + DPoP 私钥）`);
  if (manual.length) console.log(`     只能转发           : ${manual.length} 个（缺 refresh_token，积分要重新登录一次）`);
  if (kept.length) console.log(`     保留本机续期链     : ${kept.length} 个（本机本来就有活链，没有用包里的覆盖）`);
  if (present.length) console.log(`     本机已能发现       : ${present.length} 个（没有重复登记，删起来不会变成"只能忽略"）`);
  for (const line of extra) console.log(`     ${line}`);
  if (legacy) console.log('     提示               : 这个包是老的 data/oauth-accounts.json，没带别名/启停状态。');
  if (skipped.length) {
    for (const s of skipped.slice(0, 5)) console.log(`     - 跳过 ${s.id || '(无 id)'}：${s.reason}`);
  }
  console.log('');
  console.log(`[!] ${ONE_TIME_TOKEN_WARNING}`);
  console.log('');
  console.log('下一步：');
  console.log('   ① 打开面板（双击 open-panel.cmd）看「账号池」，应该已经都在了');
  console.log('   ② 面板上点「刷新积分」，确认余额读得出来（读得出来 = 续期链是通的）');
  if (lockPid()) console.log('   ③ 服务正在跑，导入已经生效，不用重启');
  else console.log('   ③ 双击 start.cmd 启动服务即可');
}

// ---- 找文件 --------------------------------------------------------------
if (!fileArg) {
  const dir = path.join(ROOT, 'accounts-backup');
  let hint = '';
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (files.length === 1) hint = `\n    本机只找到一个：${path.join(dir, files[0])}\n    直接跑：node tools/import-accounts.mjs "${path.join(dir, files[0])}"`;
    else if (files.length > 1) hint = `\n    ${dir} 里有 ${files.length} 个，挑一个：\n${files.map((f) => `      ${path.join(dir, f)}`).join('\n')}`;
  } catch {
    /* 没这个目录 */
  }
  die(`请把导出文件拖到 import-accounts.cmd 上，或者带上文件路径：\n    node tools/import-accounts.mjs 文件.json${hint}`);
}

const file = path.resolve(fileArg);
if (!fs.existsSync(file)) die(`找不到文件：${file}`);
const size = fs.statSync(file).size;
if (size > MAX_BYTES) die(`文件太大（${(size / 1024 / 1024).toFixed(1)} MB），不像是一个搬运包`);
if (!size) die('文件是空的');

console.log('== 导入账号凭据 ==');
console.log(`   文件 : ${file}`);

let text;
try {
  text = fs.readFileSync(file, 'utf8');
} catch (err) {
  die(`读不了这个文件：${err.message}`);
}

let parsed;
try {
  parsed = parseBundle(text, { pass });
} catch (err) {
  if (err.code === 'NEED_PASS') {
    die('这个文件加过密，需要口令：\n    node tools/import-accounts.mjs 文件.json --pass 你的口令');
  }
  if (err.code === 'BAD_PASS') {
    die('口令不对（也可能文件被改动/拷坏了）。');
  }
  die(err.message);
}

const stats = parsed.stats || summarizeAccounts(parsed.accounts);
const renewable = stats.renewable !== undefined
  ? stats.renewable
  : parsed.accounts.filter((a) => a.refreshToken && a.dpopPrivateJwk).length;
console.log(`   来源 : ${parsed.source || '未知'}${parsed.createdAtText ? `（导出于 ${parsed.createdAtText}）` : ''}`);
console.log(`   内容 : ${stats.total} 个账号，${renewable} 个能自动续期（token + DPoP 都在），${stats.total - renewable} 个只能转发`);

// ---- 只看不写 ------------------------------------------------------------
if (flag('--check')) {
  console.log('');
  console.log('包里有什么（只看，不写任何东西）：');
  for (const a of parsed.accounts) {
    // 判据和 mergeBundle 一致：token + DPoP 两样都有才是「导入后能续期」
    const tag = a.refreshToken && a.dpopPrivateJwk ? '可续期' : '只能转发';
    const parts = [`${a.label || a.id}`.padEnd(28), tag.padEnd(6)];
    if (a.refreshToken) parts.push(`rt=${maskSecret(a.refreshToken)}`);
    if (a.authorization) parts.push(`auth=${maskSecret(a.authorization)}`);
    if (a.disabled) parts.push('已停用');
    console.log(`   ${parts.join('  ')}`);
  }
  console.log('\n(没有写入任何文件。去掉 --check 才会真的导入)');
  process.exit(0);
}

// ---- 服务在跑就交给服务 --------------------------------------------------
const live = await probeService();
const foreign = live && live.foreign;
if (foreign) {
  console.log(`   注意 : ${host}:${port} 上是另一个目录的服务（${live.root}）`);
  console.log('          不往它发导入，本次直接写本项目的数据文件。');
}
if (live && !foreign) {
  console.log('   方式 : 交给正在跑的服务（导入后立即生效，不用重启）');
  let r;
  try {
    r = await fetch(`http://${host}:${port}/admin/api/accounts/import-bundle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'x-admin-token': token } : {}),
      },
      body: JSON.stringify({ bundle: text, pass }),
      signal: AbortSignal.timeout(180000),
    });
  } catch (err) {
    die(`连不上服务：${err.message}`);
  }
  const bodyText = await r.text();
  let doc;
  try {
    doc = JSON.parse(bodyText);
  } catch {
    die(`服务返回的不是 JSON（HTTP ${r.status}）：${bodyText.slice(0, 200)}`);
  }
  if (!r.ok || doc.ok === false) {
    if (doc.needPass) die('这个文件加过密，需要口令：加 --pass 你的口令');
    die(doc.error?.message || `导入失败（HTTP ${r.status}）`);
  }
  report(doc.results || [], { legacy: doc.legacy });
  process.exit(0);
}

const pid = lockPid();
if (pid) {
  die(
    `服务进程还在（pid ${pid}），只是 ${host}:${port} 没响应。\n` +
      '    先在面板上停掉、或双击 stop.cmd，再导入 —— 服务在跑的时候直接改数据文件，\n' +
      '    它下一次写盘会把导入的内容整个覆盖掉。',
  );
}

// ---- 服务没跑：直接写数据文件（先备份） ----------------------------------
console.log('   方式 : 服务没在跑，直接写数据文件');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupDir = path.join(DATA, `import-backup-${stamp}`);
const store = new AccountStore({
  dataFile: path.join(DATA, 'accounts.json'),
  installDirs: config.discover?.installDirs || [],
});
store.load();
const refresh = new RefreshState(path.join(DATA, 'refresh-state.json'));

const merged = mergeBundle(parsed, {
  oauthDoc: store.readOauthDoc(),
  refreshDoc: refresh.doc,
  meta: store.meta,
  // 本机已经能发现的号不重复登记（见 src/bundle.mjs 里 manual 分支那段说明）
  knownIds: new Set(store.ids()),
});

// 先备份再动：这三份文件里有凭据和一次性 token 链，写坏了一天内就要重新登录。
fs.mkdirSync(backupDir, { recursive: true });
const backedUp = [];
for (const name of ['accounts.json', 'oauth-accounts.json', 'refresh-state.json']) {
  const from = path.join(DATA, name);
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, path.join(backupDir, name));
    backedUp.push(name);
  }
}

if (!store.writeOauthDoc(merged.oauthDoc)) die('写 data/oauth-accounts.json 失败（见日志）');
refresh.replaceDoc(merged.refreshDoc);
store.meta = merged.meta;
store.save();

report(merged.results, {
  legacy: parsed.legacy,
  extra: [`备份               : ${backupDir}${backedUp.length ? `（${backedUp.join('、')}）` : '（原来没有这些文件）'}`],
});

// 备份是**含明文凭据**的副本，攒着不删等于同一个号在盘上多躺几份，而且没人会记得清。
// 和日志滚动一个规矩：留最新 3 份，多出来的这次顺手删掉。
const staleDirs = pickStaleEntries(
  fs
    .readdirSync(DATA, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('import-backup-'))
    .map((d) => {
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(path.join(DATA, d.name)).mtimeMs;
      } catch {
        /* 读不到就当最老的处理 */
      }
      return { name: d.name, mtimeMs };
    }),
  3,
);
for (const name of staleDirs) {
  try {
    fs.rmSync(path.join(DATA, name), { recursive: true, force: true });
  } catch (err) {
    console.log(`   [!] 旧备份 ${name} 没删掉：${err.message}`);
  }
}
if (staleDirs.length) {
  console.log(`     清理               : 删掉 ${staleDirs.length} 份旧备份（只留最新 3 份）：${staleDirs.join('、')}`);
  console.log('                          （旧备份里同样是明文凭据，留着没用）');
}
