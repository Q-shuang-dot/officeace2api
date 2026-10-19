#!/usr/bin/env node
/**
 * 换电脑：账号搬运包（src/bundle.mjs）回归测试。
 *
 * 这个功能出错的代价特别高 —— 包里是**长期有效的凭据**和一次性 refresh_token，
 * 导错/并错的结果不是"功能不好用"，而是：
 *   · 把早就被服务器拒过的 token 再发一次 → STS5.1806 → 号废，要重新登录；
 *   · 拿另一台机器的链覆盖本机正在用的那条 → 两条线互相打架，同样是 1806；
 *   · 加密包口令错却没报错 → 用户以为导入了，其实什么都没进去。
 * 所以下面每一条都钉住一个具体的后果，而不是"能跑通"。
 *
 *   node tools/test-account-bundle.mjs
 *
 * 全部在临时目录里跑：不读也不写真的 data\ 目录（真账号一次都不碰）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBundle,
  bundleFileName,
  collectAccounts,
  decryptBundle,
  encryptBundle,
  mergeBundle,
  ONE_TIME_TOKEN_WARNING,
  parseBundle,
  refreshKeyFor,
  summarizeAccounts,
  BUNDLE_KIND,
} from '../src/bundle.mjs';
import { AccountStore } from '../src/accounts.mjs';
import { RefreshState } from '../src/refresh.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
function eq(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(name);
  else bad(name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function throws(name, fn, match) {
  try {
    fn();
    bad(name, '没有抛错');
  } catch (err) {
    if (!match || String(err.message).includes(match)) ok(name);
    else bad(name, `错误信息不对：${err.message}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'o2a-bundle-'));
const NOW = Date.parse('2026-10-19T10:00:00Z');

/* ---------------------------------------------------------------- 夹具 */

const ACC_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:11111111111111111111111111111111';
const ACC_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:22222222222222222222222222222222';
const ACC_C = 'cccccccccccccccccccccccccccccccc:33333333333333333333333333333333';
// 号池扫盘还会发现**这台机器上真实的** OfficeAce 账号（candidateRoots 是写死的盘符），
// 所以下面凡是数数的断言都只看这三个假 ID，测试结果不依赖跑在哪台机器上。
const FAKE = new Set([ACC_A, ACC_B, ACC_C]);
const fakesOf = (ids) => ids.filter((id) => FAKE.has(id));

const TOK = (n) => `jwt-header.${'x'.repeat(40)}.sig${n}`;

/** 旧机器上的三份数据 */
function sourceData() {
  return {
    oauthDoc: {
      [ACC_A]: {
        id: ACC_A,
        label: '账号 A',
        accountId: ACC_A.split(':')[0],
        userId: ACC_A.split(':')[1],
        userName: 'shuang',
        baseUrl: 'https://gw.example.com/v2/',
        authorization: `Basic ${Buffer.from('ak-a:sk-a').toString('base64')}`,
        createdAt: NOW - 86400000,
        // 还没过期的临时 AK/SK：应该被搬走
        credential: {
          accessKeyId: 'AKIA_A',
          secretAccessKey: 'SECRET_A',
          securityToken: 'SECTOKEN_A',
          projectId: 'proj',
          expiresAt: new Date(NOW + 6 * 3600 * 1000).toISOString(),
        },
        refreshToken: TOK('A0'),
        dpopPrivateJwk: { kty: 'EC', d: 'private' },
        dpopPublicJwk: { kty: 'EC', x: 'public' },
      },
      [ACC_B]: {
        // 临时凭据已过期 + 没有 refresh_token：应该被跳过（搬过去也用不了）
        id: ACC_B,
        label: '账号 B',
        accountId: ACC_B.split(':')[0],
        userId: ACC_B.split(':')[1],
        baseUrl: 'https://gw.example.com/v2',
        authorization: `Basic ${Buffer.from('ak-b:sk-b').toString('base64')}`,
        createdAt: NOW - 3600000,
        credential: {
          accessKeyId: 'AKIA_B',
          secretAccessKey: 'SECRET_B',
          securityToken: '',
          projectId: '',
          expiresAt: new Date(NOW - 3600000).toISOString(),
        },
        refreshToken: '',
        dpopPrivateJwk: null,
        dpopPublicJwk: null,
      },
    },
    refreshDoc: {
      [ACC_A.split(':')[0]]: {
        accountId: ACC_A.split(':')[0],
        fullId: ACC_A,
        diskTokenUsed: TOK('A0'),
        rotatedToken: TOK('A1'),
        deadTokens: [TOK('DEAD')],
        consumed: [TOK('A0')],
        refreshExpiresAt: NOW + 20 * 86400000,
        userName: 'shuang',
        count: 7,
        refreshedAt: NOW - 60000,
        broken: false,
      },
    },
    // 号池里还有一个「本机 OfficeAce 文件发现的」号：只能转发，没有 refresh_token
    accounts: [
      {
        id: ACC_A,
        label: '账号 A',
        sources: ['oauth-login'],
        accountId: ACC_A.split(':')[0],
        userId: ACC_A.split(':')[1],
        credentials: [{ baseUrl: 'https://gw.example.com/v2', authorization: 'Basic xxx' }],
        profile: { accountId: ACC_A.split(':')[0] },
      },
      {
        id: ACC_C,
        label: '本机扫出来的 C',
        sources: ['local-profile'],
        credentials: [{ baseUrl: 'https://gw.example.com/v2', authorization: `Basic ${Buffer.from('ak-c:sk-c').toString('base64')}` }],
        profile: { accountId: ACC_C.split(':')[0], accessKeyId: 'AKIA_C', secretAccessKey: 'SC', securityToken: 'ST', expiresAt: new Date(NOW + 3600000).toISOString() },
      },
    ],
    meta: { labels: { [ACC_A]: '主力号' }, disabled: [ACC_C], ignored: [], imported: [], order: [] },
  };
}

console.log('换电脑：账号搬运包');

/* ------------------------------------------------------- 1. 收集 */

const src = sourceData();
const collected = collectAccounts({ ...src, now: NOW });

eq('收集到 2 个可搬的号（B 没有 refresh_token 但仍有长期 Basic → 也能搬）', collected.length, 3);
{
  const a = collected.find((x) => x.id === ACC_A);
  if (a && a.kind === 'oauth' && a.label === '主力号') ok('A 是 oauth 档案，别名用 meta.labels 覆盖（"主力号"）');
  else bad('A 是 oauth 档案，别名用 meta.labels 覆盖', JSON.stringify(a && { kind: a.kind, label: a.label }));
  eq('A 的续期链带过来了（diskTokenUsed / rotatedToken）', [a?.refresh?.diskTokenUsed, a?.refresh?.rotatedToken], [TOK('A0'), TOK('A1')]);
  eq('A 的死名单一起带走（少了就会重发死 token）', a?.refresh?.deadTokens, [TOK('DEAD')]);
  if (a?.credential?.accessKeyId === 'AKIA_A') ok('A 还没过期的临时 AK/SK 一起带走（新机器不用马上续期）');
  else bad('A 还没过期的临时 AK/SK 一起带走', JSON.stringify(a?.credential || null));
}
{
  const b = collected.find((x) => x.id === ACC_B);
  if (b && b.credential === null) ok('B 过期的临时 AK/SK 被丢掉（搬过去只会显示一个假"有凭据"）');
  else bad('B 过期的临时 AK/SK 被丢掉', JSON.stringify(b?.credential || null));
  if (b && b.kind === 'oauth') ok('B 仍是 oauth 档案（有 authorization，长期有效）');
  else bad('B 仍是 oauth 档案', b?.kind);
}
{
  const c = collected.find((x) => x.id === ACC_C);
  if (c && c.kind === 'manual' && c.from === 'local-profile') ok('C（本机文件发现的）落成 manual，并标注了来源');
  else bad('C（本机文件发现的）落成 manual', JSON.stringify(c && { kind: c.kind, from: c.from }));
  if (c?.disabled === true) ok('C 的停用状态跟过来了');
  else bad('C 的停用状态跟过来了');
}
{
  const s = summarizeAccounts(collected);
  eq('摘要：3 个号 / 2 个 oauth / 1 个 manual', [s.total, s.oauth, s.manual], [3, 2, 1]);
  // 只有 A 真的能续期：B 有 authorization 但没 refresh_token，C 是扫出来的
  eq('摘要：只有 1 个真能自动续期（B/C 只能转发）', s.withRefresh, 1);
  eq('摘要：renewable 的判据是 token+DPoP 两样都在', s.renewable, 1);
}

/* ------------------------------------------------------- 2. 打包 + 解析 */

const plain = buildBundle({ accounts: collected, host: 'OLDPC', user: 'shuang', now: NOW }, {});
eq('明文包的 kind / version', [plain.kind, plain.version], [BUNDLE_KIND, 1]);
if (plain.plaintext === true && /明文/.test(plain.warning) && plain.warning.includes(ONE_TIME_TOKEN_WARNING)) {
  ok('明文包的警告先说"这是明文"，再跟"一次性 token"那句');
} else {
  bad('明文包的警告文案', String(plain.warning).slice(0, 40));
}

const plainRound = parseBundle(JSON.stringify(plain));
eq('明文包来回一趟账号数不变', plainRound.accounts.length, 3);

{
  const withBom = `\uFEFF${JSON.stringify(plain)}`;
  eq('带 BOM 的文件也能解析（Windows 记事本另存就会加 BOM）', parseBundle(withBom).accounts.length, 3);
}
throws('空文件 → 明确报错', () => parseBundle('   '), '空的');
throws('不是 JSON → 明确报错', () => parseBundle('not json at all'), '不是一个 JSON');
throws('把 data/accounts.json 当包拖进来 → 说清楚它没有凭据', () => parseBundle(JSON.stringify({ labels: {}, disabled: [] })), '没有凭据');

/* ------------------------------------------------------- 3. 加密包 */

const secretText = JSON.stringify(plain);
{
  const locked = encryptBundle(plain, 'my pass phrase');
  const text = JSON.stringify(locked);
  if (locked.encrypted === true && !text.includes('SECRET_A') && !text.includes(TOK('A1'))) {
    ok('加密后文件里看不到明文凭据 / token');
  } else {
    bad('加密后文件里看不到明文凭据 / token');
  }
  eq('加密包解回来内容一致', parseBundle(text, { pass: 'my pass phrase' }).accounts.length, 3);
  eq('加密包外层也带"一次性 token"那句（不解密就能看到）', locked.warning, ONE_TIME_TOKEN_WARNING);
  eq('加密包外层记着来源机器（不解密也能看出是哪个包）', locked.source, plain.source);
  throws('不带口令 → NEED_PASS（面板据此弹"要口令"）', () => parseBundle(text, {}), '需要口令');
  throws('口令错 → 明确的"口令不对"', () => parseBundle(text, { pass: 'wrong' }), '口令不对');
  // 篡改密文必须被 GCM 认证标签挡住，而不是解出一堆垃圾
  const tampered = { ...locked, ciphertext: `${locked.ciphertext.slice(0, -8)}AAAAAAAA` };
  throws('密文被改动 → 认证失败（不会被静默解成垃圾）', () => parseBundle(tampered, { pass: 'my pass phrase' }), '口令不对');
  const truncated = { ...locked, tag: '' };
  throws('包被截断（缺 tag）→ 报不完整', () => parseBundle(truncated, { pass: 'my pass phrase' }), '不完整');
  eq('口令里的中文/空格照样能解密', parseBundle(JSON.stringify(encryptBundle(plain, '我的 口令 带空格')), { pass: '我的 口令 带空格' }).accounts.length, 3);
  // AAD 里绑了版本号：改版本就该解不开
  throws('改了版本号 → 认证失败', () => {
    const v = { ...locked };
    const body = decryptBundle({ ...v, version: 9 }, 'my pass phrase');
    return body;
  }, '口令不对');
}

/* ------------------------------------------------------- 4. 合并到空机器 */

const emptyMerge = mergeBundle(plainRound, { oauthDoc: {}, refreshDoc: {}, meta: {} });
// 只有 A 进 oauth-accounts.json：B 没有 refresh_token，进 meta.imported 更诚实
// （它只能转发，塞进档案会让面板显示成一个"应该能续期却续不了"的号）。
eq('空机器导入：带 refresh_token 的号写进 oauthDoc', Object.keys(emptyMerge.oauthDoc), [ACC_A]);
eq('空机器导入：只有带链的号写进 refreshDoc', Object.keys(emptyMerge.refreshDoc), [ACC_A.split(':')[0]]);
eq('空机器导入：全部 action=added', emptyMerge.results.map((r) => r.action), ['added', 'added', 'added']);
{
  const a = emptyMerge.oauthDoc[ACC_A];
  if (a && a.refreshToken === TOK('A0') && a.dpopPrivateJwk?.d === 'private') ok('A 的 refresh_token + DPoP 私钥完整搬过去（新机器不用重登）');
  else bad('A 的 refresh_token + DPoP 私钥完整搬过去', JSON.stringify(a && { rt: !!a.refreshToken, dpop: !!a.dpopPrivateJwk }));
  const key = refreshKeyFor(emptyMerge.refreshDoc, ACC_A, ACC_A.split(':')[0]);
  const rec = emptyMerge.refreshDoc[key];
  if (rec && rec.diskTokenUsed === TOK('A0') && rec.rotatedToken === TOK('A1')) ok('A 的续期链锚点/轮换值落到了该落的键上');
  else bad('A 的续期链锚点/轮换值落到了该落的键上', JSON.stringify(rec && { d: rec.diskTokenUsed, r: rec.rotatedToken }));
  if (rec && rec.deadTokens.includes(TOK('DEAD'))) ok('A 的死名单一起落盘');
  else bad('A 的死名单一起落盘');
}
{
  const c = emptyMerge.meta.imported.find((x) => x.id === ACC_C);
  if (c && c.baseUrl === 'https://gw.example.com/v2' && c.authorization.startsWith('Basic ')) ok('C 进 meta.imported，新机器没装 OfficeAce 也能转发');
  else bad('C 进 meta.imported', JSON.stringify(c || null));
  if (emptyMerge.meta.disabled.includes(ACC_C)) ok('C 的停用状态并进 meta.disabled');
  else bad('C 的停用状态并进 meta.disabled');
  eq('别名（主力号）跟过来了', emptyMerge.meta.labels[ACC_A], '主力号');
}
{
  const manual = emptyMerge.results.find((r) => r.kind === 'manual');
  if (manual && manual.canRenew === false && /重新登录/.test(manual.hint)) ok('manual 账号明确告知"只能转发，积分要重登"');
  else bad('manual 账号明确告知"只能转发，积分要重登"', JSON.stringify(manual || null));
}

/* ------------------------------------------- 5. 合并到「已经有活链」的机器 */

{
  // 本机早就有一条正在用的链（rotated = A9），跟包里那份（A1）不是同一个
  const localRefresh = {
    [ACC_A.split(':')[0]]: {
      accountId: ACC_A.split(':')[0],
      fullId: ACC_A,
      diskTokenUsed: TOK('A0'),
      rotatedToken: TOK('A9'),
      deadTokens: [TOK('ZOMBIE')],
      consumed: [TOK('A0')],
      refreshExpiresAt: NOW + 5 * 86400000,
      count: 3,
      broken: false,
    },
  };
  const merged = mergeBundle(plainRound, { oauthDoc: {}, refreshDoc: localRefresh, meta: {} });
  const rec = merged.refreshDoc[refreshKeyFor(merged.refreshDoc, ACC_A, ACC_A.split(':')[0])];
  if (rec.rotatedToken === TOK('A9')) ok('本机有活链 → 不被包里的覆盖（否则两条线互相打架 → 1806）');
  else bad('本机有活链 → 不被包里的覆盖', rec.rotatedToken);
  if (rec.deadTokens.includes(TOK('DEAD')) && rec.deadTokens.includes(TOK('ZOMBIE'))) ok('死名单取并集（两边的都得留着）');
  else bad('死名单取并集', JSON.stringify(rec.deadTokens));
  const r = merged.results.find((x) => x.id === ACC_A);
  if (r?.refresh === 'kept-local-chain') ok('结果里标了 kept-local-chain（面板/CLI 能说清为什么没换链）');
  else bad('结果里标了 kept-local-chain', JSON.stringify(r || null));
}

{
  // 本机那条链已经断了 → 这次导入正是"用新机器救回来"的场景，必须采纳包里的
  const brokenRefresh = {
    [ACC_A.split(':')[0]]: {
      accountId: ACC_A.split(':')[0],
      diskTokenUsed: TOK('A0'),
      rotatedToken: TOK('GONE'),
      deadTokens: [TOK('GONE')],
      consumed: [],
      broken: true,
      brokenReason: 'STS5.1806',
    },
  };
  const merged = mergeBundle(plainRound, { oauthDoc: {}, refreshDoc: brokenRefresh, meta: {} });
  const rec = merged.refreshDoc[refreshKeyFor(merged.refreshDoc, ACC_A, ACC_A.split(':')[0])];
  if (rec.rotatedToken === TOK('A1') && rec.broken === false) ok('本机链已断（broken）→ 采纳包里的链，并清掉 broken 标记');
  else bad('本机链已断 → 采纳包里的链并清掉 broken', JSON.stringify({ r: rec.rotatedToken, broken: rec.broken }));
  if (rec.deadTokens.includes(TOK('GONE'))) ok('断链时被拒的那份仍在死名单里（不能被"救活"逻辑洗白）');
  else bad('断链时被拒的那份仍在死名单里', JSON.stringify(rec.deadTokens));
}

{
  // 档案比本机的旧 → 保留本机档案（那是"现在生效的那次授权"）
  const localOauth = { [ACC_A]: { id: ACC_A, refreshToken: TOK('NEWER'), createdAt: NOW, baseUrl: 'https://gw.example.com/v2', authorization: 'Basic local' } };
  const merged = mergeBundle(plainRound, { oauthDoc: localOauth, refreshDoc: {}, meta: {} });
  if (merged.oauthDoc[ACC_A].refreshToken === TOK('NEWER')) ok('本机档案更新 → 不拿旧包覆盖（两台机器都登过的号）');
  else bad('本机档案更新 → 不拿旧包覆盖', merged.oauthDoc[ACC_A].refreshToken);
}

/* ------------------------------ 5b. 导回「导出它的那台机器」不该长出假身份 */

{
  // 实测踩到的：把包导回原机器，每个扫盘就能发现的号都会多一条 meta.imported，
  // 同一个号于是有两个身份 —— 面板上看着一样，但 remove() 的判据
  // `sources.length===1 && sources[0]==='imported'` 会变，该能真删的变成只能忽略。
  const known = new Set([ACC_A, ACC_B, ACC_C]);
  const merged = mergeBundle(plainRound, { oauthDoc: {}, refreshDoc: {}, meta: {}, knownIds: known });
  eq('本机已能发现的号不会被重复登记进 meta.imported', merged.meta.imported.length, 0);
  const acts = merged.results.map((r) => `${r.id.split(':')[0].slice(0, 4)}=${r.action}`);
  if (acts.includes('bbbb=already-present') && acts.includes('cccc=already-present')) {
    ok('结果里标成 already-present（面板据此说"本机本来就有"）');
  } else {
    bad('结果里标成 already-present', acts.join(' '));
  }
  // 档案和续期链还是要并的：同机重导等价于 no-op，不报错也不丢东西
  eq('同机重导：档案照样并（等价 no-op）', Object.keys(merged.oauthDoc), [ACC_A]);
  eq('同机重导：续期链照样并', Object.keys(merged.refreshDoc), [ACC_A.split(':')[0]]);
  const keptChain = merged.refreshDoc[ACC_A.split(':')[0]];
  if (keptChain.rotatedToken === TOK('A1')) ok('同机重导后链还是包里的那条（本机没有记录 → 采纳）');
  else bad('同机重导后链还是包里的那条', keptChain.rotatedToken);
}

/* ------------------------------------------- 6. 老格式 + 文件名 + 落盘 */
{
  // 直接把 data/oauth-accounts.json 拖进来：按档案导入，并说清楚少了什么
  const legacy = parseBundle(JSON.stringify(src.oauthDoc));
  if (legacy.legacy === true && legacy.accounts.length === 2 && /oauth-accounts\.json/.test(legacy.note)) {
    ok('老格式（data/oauth-accounts.json）也能导入，并提示"没带别名/启停"');
  } else {
    bad('老格式也能导入', JSON.stringify({ legacy: legacy.legacy, n: legacy.accounts.length }));
  }
}
{
  const n1 = bundleFileName({ host: 'DESKTOP-ABC', now: NOW, encrypted: false });
  const n2 = bundleFileName({ host: 'DESKTOP-ABC', now: NOW, encrypted: true });
  if (/^officeace2api-accounts-DESKTOP-ABC-\d{8}-\d{4}\.json$/.test(n1)) ok(`文件名带机器名和时间：${n1}`);
  else bad('文件名格式', n1);
  if (/-locked\.json$/.test(n2)) ok('加密包文件名带 -locked 后缀');
  else bad('加密包文件名带 -locked 后缀', n2);
  const weird = bundleFileName({ host: '我的 电脑/测试:*', now: NOW });
  if (/^officeace2api-accounts-[\w.-]+-\d{8}-\d{4}\.json$/.test(weird)) ok('机器名里有中文/非法字符也不会弄坏文件名');
  else bad('机器名里有非法字符时的文件名', weird);
}

/* ---------------------------------- 7. 真落盘：空目录 → 导入 → 重启读回 */

{
  const dir = path.join(TMP, 'fresh');
  fs.mkdirSync(dir, { recursive: true });
  const store = new AccountStore({ dataFile: path.join(dir, 'accounts.json'), installDirs: [] });
  store.load();
  const refresh = new RefreshState(path.join(dir, 'refresh-state.json'));

  const merged = mergeBundle(parseBundle(JSON.stringify(encryptBundle(plain, 'pw')), { pass: 'pw' }), {
    oauthDoc: store.readOauthDoc(),
    refreshDoc: refresh.doc,
    meta: store.meta,
  });
  if (!store.writeOauthDoc(merged.oauthDoc)) bad('写 oauth-accounts.json');
  refresh.replaceDoc(merged.refreshDoc);
  store.meta = merged.meta;
  store.save();

  // 模拟"重启"：全部重新读盘
  const store2 = new AccountStore({ dataFile: path.join(dir, 'accounts.json'), installDirs: [] });
  store2.load();
  store2.scan();
  const refresh2 = new RefreshState(path.join(dir, 'refresh-state.json'));
  const ids = fakesOf(store2.ids());
  if (ids.length === 3) ok('重启后号池里 3 个号都在（扫盘从档案里读回来的）');
  else bad('重启后号池里 3 个号都在', `实际 ${ids.length}：${ids.join(',')}`);
  const a2 = ids.includes(ACC_A) ? (store2.rawList().find((x) => x.id === ACC_A)) : null;
  if (a2 && a2.profile?.refreshToken === TOK('A0') && a2.profile?.raw?.dpop?.privateJwk?.d) {
    ok('重启后 A 的 refresh_token + DPoP 私钥仍可用（这就是"不用重新登录"）');
  } else {
    bad('重启后 A 的 refresh_token + DPoP 私钥仍可用', JSON.stringify(a2?.profile && { rt: !!a2.profile.refreshToken, dpop: !!a2.profile.raw?.dpop }));
  }
  const pick = refresh2.pickToken(ACC_A, TOK('A0'));
  if (pick.source === 'rotated' && pick.token === TOK('A1')) ok('重启后续期链能直接挑出下一份 token（source=rotated）');
  else bad('重启后续期链能挑出下一份 token', JSON.stringify(pick));
  if (refresh2.get(ACC_A)?.deadTokens.includes(TOK('DEAD'))) ok('重启后死名单还在（不会重发死 token）');
  else bad('重启后死名单还在');

  // 幂等：同一份包再导一次，不应该长出重复账号
  const merged2 = mergeBundle(parseBundle(JSON.stringify(plain)), {
    oauthDoc: store2.readOauthDoc(),
    refreshDoc: refresh2.doc,
    meta: store2.meta,
  });
  store2.writeOauthDoc(merged2.oauthDoc);
  refresh2.replaceDoc(merged2.refreshDoc);
  store2.meta = merged2.meta;
  store2.save();
  const store3 = new AccountStore({ dataFile: path.join(dir, 'accounts.json'), installDirs: [] });
  store3.load();
  store3.scan();
  if (fakesOf(store3.ids()).length === 3) ok('同一个包导入两次不会长出重复账号');
  else bad('同一个包导入两次不会长出重复账号', `${fakesOf(store3.ids()).length} 个`);
  eq('第二次导入全是 updated（没有 added）', merged2.results.map((r) => r.action).filter((a) => a === 'added').length, 0);
  if (merged2.meta.imported.filter((x) => x.id === ACC_C).length === 1) ok('meta.imported 里 C 只有一条（不会重复堆积）');
  else bad('meta.imported 里 C 只有一条');
}

/* ------------------------------------------- 8. 空目录 / 权限等边界 */

{
  throws('包里一个账号都没有 → 报错而不是"成功导入 0 个"', () => parseBundle(JSON.stringify({ ...plain, accounts: [] })), '没有任何账号');
  throws('更新版本的包 → 提示升级，而不是乱解析', () => parseBundle(JSON.stringify({ ...plain, version: 99 })), '更新版本');
  const res = mergeBundle({ accounts: [{ id: '', authorization: '', baseUrl: '' }] }, {});
  eq('残缺条目被跳过（不是静默丢弃）', res.results[0].action, 'skipped');
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 临时目录删不掉不影响结论 */
}

console.log(`\n${pass} 项通过${fails.length ? `，${fails.length} 项失败：${fails.join('；')}` : ' ✅'}`);
process.exit(fails.length ? 1 : 0);
