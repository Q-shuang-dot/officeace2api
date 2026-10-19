#!/usr/bin/env node
/**
 * `config.discover.enabled`（「要不要扫这台机器」总开关）的回归测试。
 *
 * 这个开关为什么存在，见 util.mjs 里 setMachineScanEnabled 的注释。要点是：
 * 原来只有 `upstream.autoDiscover: false`，而它**只关定时重扫**，启动扫描照跑 ——
 * 于是「只想当通用反代」的人，本机装过 OfficeAce 的话账号会被悄悄收进号池；
 * 写测试时临时实例也会读到本机真实账号，甚至会替它们续期（那是在动用户的真凭据）。
 *
 * 这里验 9 件事，正反两面都要有对照：
 *
 *   1. 默认是"开"的（不能悄悄改语义）
 *   2. 开着时，`<假 home>/.office-claw` 里的账号扫得出来 —— 正向对照
 *   3. 开着时 discover() 也能抠出凭据
 *   4. 关掉后，同一份磁盘 + 本机真实安装目录，一个账号都不许扫出来 —— 反向对照。
 *      这条是重点：本机真有账号，所以"0 个"是有意义的断言，不是空跑。
 *   5. 关掉后 discover() 返回空集
 *   6. 关掉后起真实实例：/healthz 说 0 个账号（证明真的没读本机）
 *   7. 同一实例的扫描接口自己承认 discoverEnabled=false（面板别装没事）
 *   8. 同一实例的手工上游照旧能转发 —— 池子空了不等于反代废了，这是最容易误伤的功能
 *   9. 把开关拨回去又能扫到（不能是单向门）
 *
 * 全程在临时目录里，不碰真实 data\，也不向任何真实上游发请求。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { AccountStore } from '../src/accounts.mjs';
import { discover } from '../src/discover.mjs';
import { setMachineScanEnabled, isMachineScanEnabled } from '../src/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ok = [];
const bad = [];
const check = (label, cond, detail = '') => {
  if (cond) {
    ok.push(label);
    console.log(`  ✓ ${label}`);
  } else {
    bad.push(`${label}${detail ? ' :: ' + detail : ''}`);
    console.log(`  ✗ ${label} ${detail}`);
  }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'o2a-disc-'));
const HOME = path.join(TMP, 'home');
const FAKE_UID = 'fakeacct0001:fakeuser0002';
const FAKE_BASE = 'https://gw.example.invalid/v2';

// 一份最小的 OfficeAce 磁盘结构：routing_state/users/<uid>/models.json
const userDir = path.join(HOME, '.office-claw', '.jiuwenclaw', 'config', 'routing_state', 'users', encodeURIComponent(FAKE_UID));
fs.mkdirSync(userDir, { recursive: true });
fs.writeFileSync(
  path.join(userDir, 'models.json'),
  JSON.stringify({
    model_list: [
      {
        model_client_config: {
          api_base: FAKE_BASE,
          custom_headers: { Authorization: 'Basic ZmFrZS1hazpmYWtlLXNr' },
          model_name: 'fake-model',
          client_provider: 'OpenAI',
        },
      },
    ],
  }, null, 2),
);

// home() 认 OFFICEACE_HOME —— 把"用户目录"指到假 home，假号才会被当成 ~/.office-claw
process.env.OFFICEACE_HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
delete process.env.OFFICEACE_INSTALL_DIR;

const scanFresh = () => {
  const store = new AccountStore({ dataFile: '', installDirs: [] });
  store.save = () => {};
  store.scan();
  return store;
};

console.log('【1. 默认语义 + 正向对照】');
check('默认是开着的（不能悄悄改默认值）', isMachineScanEnabled() === true);

setMachineScanEnabled(true);
const onStore = scanFresh();
const onIds = [...onStore.accounts.keys()];
check('开着时扫到了假 home 里那个号', onIds.some((id) => id.includes('fakeacct0001')), `扫到 ${onIds.length} 个`);
const onCreds = onStore.accounts.get(onIds.find((id) => id.includes('fakeacct0001')))?.credentials || [];
check('它的凭据（baseUrl）也读对了', onCreds.some((c) => c.baseUrl === FAKE_BASE), JSON.stringify(onCreds.map((c) => c.baseUrl)));

const onFound = discover({ installDirs: [] });
check('开着时 discover() 也抠得到凭据', onFound.credentials.some((c) => c.baseUrl === FAKE_BASE), `credentialMap=${onFound.credentials.length}`);

console.log('\n【2. 关掉之后：一个都不许扫】');
setMachineScanEnabled(false);
const offStore = scanFresh();
const offCount = offStore.accounts.size;
check('关掉后号池里 0 个账号（本机真实安装目录也没读）', offCount === 0, `扫到 ${offCount} 个：${[...offStore.accounts.keys()].slice(0, 3).join(',')}`);
const offFound = discover({ installDirs: [] });
check('关掉后 discover() 返回空集', offFound.credentials.length === 0 && offFound.catalog.length === 0, JSON.stringify({ c: offFound.credentials.length, m: offFound.catalog.length }));

console.log('\n【3. 关掉之后起真实实例】');
const freePort = () =>
  new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const UP_PORT = await freePort();
const PORT = await freePort();
const ADMIN_TOKEN = 'disc-switch-test-token';

let chatHits = 0;
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    // 只数 chat 请求：启动时还会被拉一次 /v1/models（refreshUpstreamCatalog），
    // 把那次也算进去就会得到一个"2 = 1"的假失败。
    if (String(req.url || '').includes('/chat/completions')) chatHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-fake',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'fake-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong-from-manual' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));

const proj = path.join(TMP, 'proj');
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
  const from = path.join(ROOT, 'src', f);
  if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(proj, 'src', f));
}
fs.writeFileSync(path.join(proj, 'config.json'), JSON.stringify({
  listen: { host: '127.0.0.1', port: PORT },
  admin: { token: ADMIN_TOKEN },
  apiKeys: ['sk-officeace'],
  discover: { enabled: false, installDirs: [] },
  upstream: {
    autoDiscover: false,
    baseUrl: `http://127.0.0.1:${UP_PORT}/v1`,
    authorization: 'Bearer test-upstream-key',
    refreshSeconds: 45,
  },
  credits: { enabled: false, autoRefreshCredentials: false, autoRenewCredentials: false },
}, null, 2));

const child = spawn(process.execPath, ['src/index.mjs'], {
  cwd: proj,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childOut = '';
child.stdout.on('data', (d) => (childOut += d));
child.stderr.on('data', (d) => (childOut += d));

const health = async () => {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
  }
  return null;
};

try {
  const h = await health();
  if (!h) {
    check('实例起来了', false, childOut.slice(-400));
    throw new Error('实例没起来');
  }
  check('实例起来了', true);
  check('/healthz 说 0 个账号（真的没读本机）', Number(h.accounts) === 0, `accounts=${h.accounts}`);

  const scanRes = await fetch(`http://127.0.0.1:${PORT}/admin/api/accounts/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
    body: JSON.stringify({}),
  });
  const scanDoc = await scanRes.json().catch(() => ({}));
  check('扫描接口回报 discoverEnabled=false（面板别装没事）', scanDoc.discoverEnabled === false, JSON.stringify(scanDoc).slice(0, 160));

  const chat = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-officeace' },
    body: JSON.stringify({ model: 'fake-model', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const chatText = await chat.text();
  let chatDoc = null;
  try {
    chatDoc = JSON.parse(chatText);
  } catch {
    /* 非 JSON 时下面会看到原文 */
  }
  check('手工上游照旧能转发（池子空 ≠ 反代废）', chat.status === 200 && chatDoc?.choices?.[0]?.message?.content === 'pong-from-manual', `status=${chat.status} body=${chatText.slice(0, 160)}`);
  check('请求确实打到了上游', chatHits === 1, `chatHits=${chatHits}`);
} catch (e) {
  check('实例相关断言', false, e.message);
} finally {
  child.kill();
  upstream.close();
  await new Promise((r) => setTimeout(r, 500));
}

console.log('\n【4. 拨回去要能恢复（不能是单向门）】');
setMachineScanEnabled(true);
const backStore = scanFresh();
check('再打开后又扫得到那个号', [...backStore.accounts.keys()].some((id) => id.includes('fakeacct0001')), `扫到 ${backStore.accounts.size} 个`);

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 临时目录被占用就留着，不影响断言 */
}
console.log(`\n临时目录已清理: ${!fs.existsSync(TMP)}`);
console.log(`\n结果：${ok.length} 通过 / ${bad.length} 失败`);
if (bad.length) {
  console.log('失败项:');
  for (const b of bad) console.log('  - ' + b);
}
process.exit(bad.length ? 1 : 0);
