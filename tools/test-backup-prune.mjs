#!/usr/bin/env node
/**
 * 备份清理：`data/import-backup-<时间>/` 和 `accounts-backup/*.json` 不许无限堆积。
 *
 * 为什么值得一套用例：这两处的文件里都是**含凭据的副本**（长期 Basic 凭据、
 * 一次性 refresh_token、DPoP 私钥）。攒着不删，等于同一个号在盘上多躺几份，
 * 而用户永远不会记得清 —— 和日志"留 3 代"是同一类问题。清理动作本身又很危险：
 * 判错年龄就会把**刚写出来、正准备拷到新电脑的那一份**删掉。所以这里钉住的不是
 * "能删"，而是：
 *   · 不超上限时一个都不删（不许为了"干净"先清一遍）
 *   · 每次都保住刚写的那份（mtime 相同也要保）
 *   · 删的是最老的，且把删了哪些打出来
 *   · `--check` 一个字节都不写
 *
 * 全部在临时目录里跑，不读也不写真 data\。
 * 扫盘那条路用 OFFICEACE_HOME 指到空目录掐掉（src/util.mjs 的 home() 读它），
 * 免得连本机真账号一起导进临时包。
 *
 *   node tools/test-backup-prune.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { shouldRevealInExplorer } from '../src/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const SIM = fs.mkdtempSync(path.join(os.tmpdir(), 'o2a-prune-'));

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
function check(name, cond, extra) {
  if (cond) ok(name);
  else bad(name, extra);
}

// —— 搭一个"另一台机器"：只拷代码，不拷 data\、logs\、.git ——
for (const dir of ['src', 'tools', 'data', 'accounts-backup', 'empty-home']) {
  fs.mkdirSync(path.join(SIM, dir), { recursive: true });
}
for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
  fs.copyFileSync(path.join(ROOT, 'src', f), path.join(SIM, 'src', f));
}
for (const f of ['export-accounts.mjs', 'import-accounts.mjs']) {
  fs.copyFileSync(path.join(ROOT, 'tools', f), path.join(SIM, 'tools', f));
}
// 假 admin token：万一工具走了"问服务要"那条路，会直接报 token 无效 → 用例红，不会静默通过
fs.writeFileSync(
  path.join(SIM, 'config.json'),
  JSON.stringify({ listen: { host: '127.0.0.1', port: 7864 }, admin: { token: 'sim-token' }, discover: { installDirs: [] } }),
);

const now = Date.now();
const fake = {
  'fake-acct:fake-user': {
    id: 'fake-acct:fake-user',
    label: '测试号',
    accountId: 'fake-acct',
    userId: 'fake-user',
    userName: 'tester',
    baseUrl: 'https://example.invalid',
    authorization: 'Basic ZmFrZS1hazpmYWtlLXNr',
    credential: { accessKey: 'fake-ak', secretKey: 'fake-sk', expiresAt: now + 86400000 },
    refreshToken: 'fake-refresh-token',
    dpopPrivateJwk: { kty: 'EC', crv: 'P-256', d: 'fake-d' },
    dpopPublicJwk: { kty: 'EC', crv: 'P-256', x: 'fake-x', y: 'fake-y' },
    createdAt: now - 86400000,
  },
};
fs.writeFileSync(path.join(SIM, 'data', 'oauth-accounts.json'), JSON.stringify(fake));
fs.writeFileSync(
  path.join(SIM, 'data', 'accounts.json'),
  JSON.stringify({ labels: { 'fake-acct:fake-user': '测试号' }, disabled: [], ignored: [], imported: [], order: [] }),
);

// 5 份旧备份 + 5 个旧搬运包，mtime 一天一份往前推
const STAMPS = ['20260101010101', '20260202020202', '20260303030303', '20260404040404', '20260505050505'];
for (const [i, s] of STAMPS.entries()) {
  const dir = path.join(SIM, 'data', `import-backup-${s}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'oauth-accounts.json'), '{}');
  const t = new Date(now - (STAMPS.length - i) * 86400000);
  fs.utimesSync(dir, t, t);
  const file = path.join(SIM, 'accounts-backup', `officeace2api-accounts-OLD-${s.slice(0, 8)}-${s.slice(8, 12)}.json`);
  fs.writeFileSync(file, '{}');
  fs.utimesSync(file, t, t); // 注意：utimes 之后再改文件会刷新 mtime，所以写完才设
}

const dirsIn = () => fs.readdirSync(path.join(SIM, 'data')).filter((x) => x.startsWith('import-backup-'));
const filesIn = () => fs.readdirSync(path.join(SIM, 'accounts-backup')).filter((x) => x.endsWith('.json'));
const run = (file, args) =>
  execFileSync(NODE, [path.join(SIM, 'tools', file), ...args], {
    cwd: SIM,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OFFICEACE_HOME: path.join(SIM, 'empty-home') },
  });
const backupDir = path.join(SIM, 'accounts-backup');
const at = (dir, i) => path.join(SIM, 'accounts-backup', `sim-${i}.json`);

try {
  check('起点：5 个导入备份 + 5 个旧搬运包', dirsIn().length === 5 && filesIn().length === 5, `${dirsIn().length}/${filesIn().length}`);

  const out1 = run('export-accounts.mjs', ['--plain', '--out', at(backupDir, 'a')]);
  console.log(`   导出: ${(out1.match(/\[OK\] 已导出[^\n]*/) || ['(没有这行)'])[0]}`);
  check('导出成功（走离线读盘，没去问服务要）', /\[OK\] 已导出 1 个账号/.test(out1), out1.slice(0, 300));
  check('默认只列旧包、一个都不删', filesIn().length === 6, `files=${filesIn().length}`);
  check('列出的正是最老的三个', ['20260101', '20260202', '20260303'].every((d) => out1.includes(`OLD-${d}`)));
  check('提示了 --prune 这个选项', /加 --prune 重跑可顺手删掉/.test(out1));
  check('没删就不说"已删除"', !/已删除/.test(out1));

  const out2 = run('export-accounts.mjs', ['--plain', '--out', at(backupDir, 'b'), '--prune']);
  const kept = filesIn();
  check('--prune 后只剩最新 3 份', kept.length === 3, JSON.stringify(kept));
  check('刚写出来的两份都保住了（哪怕 mtime 一样）', kept.includes('sim-a.json') && kept.includes('sim-b.json'), JSON.stringify(kept));
  check('删了 4 个并说清楚是哪几个', /已删除 4 个（保留最新 3 份）/.test(out2), (out2.match(/已删除[^\n]*/) || ['(没有)'])[0]);

  const out3 = run('import-accounts.mjs', [at(backupDir, 'b'), '--check']);
  check('--check 只看不写（没多出备份）', dirsIn().length === 5, JSON.stringify(dirsIn()));
  check('--check 说清了包里有什么', /能自动续期/.test(out3));

  const out4 = run('import-accounts.mjs', [at(backupDir, 'b')]);
  const dirsAfter = dirsIn();
  const fresh = (out4.match(/import-backup-\d{14}/) || [''])[0];
  check('导入成功', /导入完成：1 个账号/.test(out4), out4.slice(0, 200));
  check('备份留最新 3 份（5 旧 + 1 新 → 删 3）', dirsAfter.length === 3, JSON.stringify(dirsAfter));
  check('刚建的那份备份留着', !!fresh && dirsAfter.includes(fresh), `${fresh} / ${JSON.stringify(dirsAfter)}`);
  check('删掉的是最老的三个', !STAMPS.slice(0, 3).some((s) => dirsAfter.includes(`import-backup-${s}`)), JSON.stringify(dirsAfter));
  check('清理动作打出来了', /清理\s+: 删掉 3 份旧备份/.test(out4), (out4.match(/清理[^\n]*/) || ['(没有)'])[0]);
  check('假账号真的写进盘了', 'fake-acct:fake-user' in JSON.parse(fs.readFileSync(path.join(SIM, 'data', 'oauth-accounts.json'), 'utf8')));

  // 真目录一个字节都不许动
  const realBefore = fs.readFileSync(path.join(ROOT, 'data', 'accounts.json'), 'utf8');
  check('本机 data/accounts.json 没被改', realBefore === fs.readFileSync(path.join(ROOT, 'data', 'accounts.json'), 'utf8'));
  check('本机 data/ 没多出 import-backup', fs.readdirSync(path.join(ROOT, 'data')).filter((x) => x.startsWith('import-backup-')).length === 0);
  check('本机 accounts-backup/ 没被创建', !fs.existsSync(path.join(ROOT, 'accounts-backup')));

  // —— 非交互环境不许弹资源管理器 ——
  // 这套用例就是在管道里跑那两个 CLI 的。第一版没管这个：export 在 Windows 上
  // 无条件 spawn 资源管理器去"选中"刚导出的文件，而用例跑完把临时目录删了，
  // 于是桌面弹一个「位置不可用」的报错框 —— 用户截图问上来"这是什么问题"。
  // 弹窗本身不影响导出，所以这里钉的是"哪些情况才该弹"。
  console.log('');
  const reveal = (o) => shouldRevealInExplorer(o);
  check('双击 .cmd（终端 + Windows）→ 弹，省得自己找路径', reveal({ platform: 'win32', isTTY: true }) === true);
  check('管道/脚本里（不是终端）→ 不弹', reveal({ platform: 'win32', isTTY: false }) === false);
  check('计划任务（没有终端的 undefined）→ 不弹', reveal({ platform: 'win32', isTTY: undefined }) === false);
  check('非 Windows → 不弹（也没有 explorer.exe）', reveal({ platform: 'linux', isTTY: true }) === false);
  check('--open 明确点名 → 管道里也弹', reveal({ platform: 'win32', isTTY: false, explicitOpen: true }) === true);
  check('--no-open 一票否决（哪怕在终端里）', reveal({ platform: 'win32', isTTY: true, explicitNo: true }) === false);
  check('O2A_NO_OPEN=1（脚本统一关）一票否决', reveal({ platform: 'win32', isTTY: true, env: { O2A_NO_OPEN: '1' } }) === false);
  check('O2A_NO_OPEN 别的值不算关', reveal({ platform: 'win32', isTTY: true, env: { O2A_NO_OPEN: '0' } }) === true);
  // CLI 得真的接上这套判断：管道里跑一遍，不许因为"不弹窗"这条路而出错
  const outSilent = run('export-accounts.mjs', ['--plain', '--out', at(backupDir, 'c'), '--no-open']);
  check('带上 --no-open 照样正常导出', /\[OK\] 已导出 1 个账号/.test(outSilent), outSilent.slice(0, 200));
  check('--no-open 是真的不弹（没去起 explorer.exe）', /explorer/i.test(outSilent) === false);
} finally {
  // 删不掉必须**说出来**：这个目录里就是（假的）凭据副本，静默吞掉等于在 %TEMP% 里留一份，
  // 而这正是本文件要防的事。第一版就是被资源管理器占着删不掉（它还顺手在桌面上弹了
  // 一个「位置不可用」的报错框），`catch {}` 一吞，谁也发现不了 —— 见技术笔记 四之二。
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let leftover = null;
  for (let i = 0; i < 3; i += 1) {
    try {
      fs.rmSync(SIM, { recursive: true, force: true });
      leftover = null;
      break;
    } catch (err) {
      leftover = err;
      sleep(250); // 句柄可能刚被释放，等一下再来
    }
  }
  if (leftover) {
    console.log(`\n[!] 临时目录没删掉（${leftover.code || leftover.message}）：${SIM}`);
    console.log('    里面是测试用的**假**凭据，但留着没意义，手动删掉即可。');
  }
}

console.log(`\n${pass} 项通过${fails.length ? `，${fails.length} 项失败：${fails.join('；')}` : ' ✅'}`);
process.exit(fails.length ? 1 : 0);