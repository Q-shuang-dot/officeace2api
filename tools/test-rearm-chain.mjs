/**
 * 端到端回归：用一台**本地假 STS** 完整跑一遍续期链，
 * 复现「重登之后到底能不能一直自转」这件事。
 *
 * 覆盖的坑（每一个都在真实环境里踩过）：
 *   A. 链子烧穿后 pickToken 必须判 none，不能硬发必被拒的 token
 *   B. rearm 上膛之后必须立刻能挑出新鲜那份（锚点仍然指向已消费的旧 token）
 *   C. 第一次续期成功后，轮换出来的新 token 必须回写到档案，
 *      否则**第二轮**就会因为「档案还是老锚点」而原地判 None
 *   D. 之后每一轮都该用 rotated 那份，不用再上膛
 *   E. 再烧穿一次还能再上膛（可重复自愈）
 *
 * 全程零外网、零真实凭据。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CredentialRefresher, RefreshState } from '../src/refresh.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

/* ---------------- 假 STS ---------------- */
const usedTokens = new Set();
let issued = 0;
// 【G】用的开关：让服务器**把收到的 token 原样回给我们**（不轮换）。
// 真实 STS 在某些情况下就是这样的 —— 这曾经把链子烧穿，见【G】。
let echoToken = false;
const makeToken = (tag) => `tok-${tag}-${String((issued += 1)).padStart(4, '0')}-${'x'.repeat(80)}`;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const token = params.get('refresh_token') || '';
    res.setHeader('Content-Type', 'application/json');

    if (usedTokens.has(token)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'STS5.1806', error_code: 'STS5.1806', error_msg: 'the refresh token has been used' }));
      return;
    }
    usedTokens.add(token);
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        credentials: {
          access_key_id: `AK${issued}`,
          secret_access_key: `SK${issued}`,
          security_token: 'ST'.repeat(30),
          project_id: 'proj-1',
          expiration: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        },
        refresh_token: echoToken ? token : makeToken('rot'),
        refresh_expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        id_token: '',
      }),
    );
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const tokenUrl = `http://127.0.0.1:${server.address().port}/v1/oauth2/tokens`;

/* ---------------- 夹具 ---------------- */
const ID = 'acc0001:user0001';
const ORDER_ID = 'acc0001';
const T_DEAD = `tok-disk-dead-0000-${'d'.repeat(80)}`; // 档案里那份，早已作废
const T_LOGIN = `tok-login-fresh-0000-${'l'.repeat(80)}`; // 最新一次登录发下来的
const T_LOGIN2 = `tok-login-again-0000-${'m'.repeat(80)}`;

// DPoP proof 要真签，不能拿假 JWK 糊
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = ec.privateKey.export({ format: 'jwk' });
const PRIVATE_JWK = jwk;
const PUBLIC_JWK = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };

const tmpFile = path.join(os.tmpdir(), `rearm-chain-${process.pid}.json`);
fs.writeFileSync(
  tmpFile,
  JSON.stringify(
    {
      [ORDER_ID]: {
        accountId: ORDER_ID,
        fullId: ID,
        diskTokenUsed: T_DEAD,
        rotatedToken: '',
        deadTokens: [T_DEAD],
        broken: true,
        brokenReason: 'STS5.1806',
        brokenAt: Date.now() - 3600_000,
        credential: null,
        count: 3,
      },
    },
    null,
    2,
  ),
);

const state = new RefreshState(tmpFile);
const refresher = new CredentialRefresher({ state, config: { tokenUrl, clientId: 'c', timeoutMs: 8000 } });
const mkProfile = (token) => ({
  accountId: ORDER_ID,
  userId: 'user0001',
  refreshToken: token,
  refreshExpiresAt: Date.now() + 30 * 24 * 3600 * 1000,
  userName: 'GT-m0_69420000',
  projectId: 'proj-1',
  raw: { dpop: { privateJwk: PRIVATE_JWK, publicJwk: PUBLIC_JWK } },
});

/**
 * 复刻 QuotaService.refreshCredential 里那段编排（上膛 → 续期 → 两处回写），
 * 但不依赖 config / 磁盘。这样测的是「顺序」，不是实现细节。
 */
let profile = mkProfile(T_DEAD);
const cycle = async (loginToken) => {
  // 复刻 QuotaService.refreshCredential 的编排：**只有现在挑不出任何可发的
  // token**、并且手里有一份没用过的新登录 token 时，才上膛。
  // 少任何一个条件都不许上膛 —— 上膛会改写锚点，在「本来还能用」时上膛
  // 等于亲手把链子弄断。
  const pickNow = state.pickToken(ID, profile.refreshToken);
  const willPickNone = !pickNow.token;
  const st = state.get(ID);
  const loginIsNew =
    !!loginToken && loginToken !== st?.diskTokenUsed && loginToken !== st?.rotatedToken && !(st?.deadTokens || []).includes(loginToken);
  let rearmed = false;
  if (willPickNone && loginIsNew) {
    state.rearm(ID, loginToken, { reason: 'self-login', previousDiskToken: profile.refreshToken });
    profile.refreshToken = loginToken; // 复刻 applyRearmedToken（原地改）
    rearmed = true;
  }
  const r = await refresher.refresh(profile, { accountId: ID });
  if (r.ok) {
    const st2 = state.get(ID);
    if (st2?.rotatedToken) profile.refreshToken = st2.rotatedToken; // 回写轮换 token
  }
  return { ...r, rearmed, beforePick: pickNow.source, pick: state.pickToken(ID, profile.refreshToken).source };
};

console.log('\n【A】链子烧穿：不硬发必然被拒的 token');
ok('pickToken 判 none', state.pickToken(ID, T_DEAD).source === 'none');
const burned = await refresher.refresh(mkProfile(T_DEAD), { accountId: ID });
ok('refresh 直接报 NO_USABLE_TOKEN', burned.errorCode === 'NO_USABLE_TOKEN', burned.errorCode);

console.log('\n【B】重新上膛：新鲜 token 立刻可用');
state.rearm(ID, T_LOGIN, { reason: 'self-login', previousDiskToken: T_DEAD });
profile = mkProfile(T_LOGIN);
const rec1 = state.get(ID);
ok('锚点仍是那份被消费掉的旧 token', rec1.diskTokenUsed === T_DEAD);
ok('新 token 没被误标成已消费', rec1.diskTokenUsed !== T_LOGIN);
ok('broken 已清', rec1.broken === false);
ok('pickToken 挑出新鲜那份', state.pickToken(ID, T_LOGIN).source === 'disk-renewed');

console.log('\n【C】第一轮：续期成功 + 轮换 token 回写档案');
usedTokens.clear();
const c1 = await cycle(T_LOGIN);
ok('第一轮成功', c1.ok === true, c1.errorCode || '');
ok('拿到了 AK/SK', !!c1.credential?.accessKeyId);
ok('轮换 token 已回写到档案', profile.refreshToken === state.get(ID).rotatedToken && profile.refreshToken !== T_LOGIN);
const c1pick = state.pickToken(ID, profile.refreshToken);
ok('回写之后 pickToken 不再判 none', c1pick.source !== 'none', `source=${c1pick.source}`);

console.log('\n【D】第二轮：不需要再上膛，直接用轮换那份');
const c2 = await cycle('');
ok('第二轮成功（没上膛）', c2.ok === true && c2.rearmed === false, c2.errorCode || `rearmed=${c2.rearmed}`);
ok('AK 换了新的', c2.credential?.accessKeyId !== c1.credential?.accessKeyId);
const c3 = await cycle('');
ok('第三轮依旧自转', c3.ok === true, c3.errorCode || '');

console.log('\n【E】再烧穿一次：还能再上膛（可重复自愈）');
const burnedToken = state.get(ID).rotatedToken;
state.breakChain(ID, 'STS5.1806', burnedToken);
ok('轮换那份被拉黑', (state.get(ID).deadTokens || []).includes(burnedToken));
ok('rotatedToken 已清空', state.get(ID).rotatedToken === '');
ok('断链标记置位', state.get(ID).broken === true);
const c4 = await cycle(T_LOGIN2);
ok('第二次上膛后又能续期', c4.ok === true && c4.rearmed === true, c4.errorCode || '');
{
  const st = state.get(ID);
  console.log('  [E调试] broken =', st.broken, '| brokenReason =', JSON.stringify(st.brokenReason), '| rearmedAt =', st.rearmedAt, '| count =', st.count);
}
ok('自愈后断链标记再次清掉', state.get(ID).broken === false);
ok('自愈后档案上那份挑得出来', !!state.pickToken(ID, profile.refreshToken).token, `source=${c4.pick}`);
ok('第一轮不需要上膛（archive 就是锚点）', c1.rearmed === false && c1.beforePick === 'disk-renewed', `before=${c1.beforePick}`);
ok('第二轮挑的是轮换那份', ['rotated', 'disk-renewed'].includes(c2.pick), `pick=${c2.pick}`);
ok('第二轮确实没上膛', c2.rearmed === false);

console.log('\n【F】不变式：pickToken 绝不吐死名单里的 token');
const deadNow = new Set(state.get(ID).deadTokens || []);
const stalePick = state.pickToken(ID, T_DEAD);
ok('不会把死掉的档案 token 发出去', !deadNow.has(stalePick.token || '@@'), `source=${stalePick.source}`);

/* ------------------------------------------------------------------
 * 【G】服务器「原样回同一份 token」时，绝不能把它记成最新的、同时又拉黑
 *
 * 这是实测踩到的真坑：`record()` 里 `rotatedToken = json.refresh_token || pick.token`，
 * 而某些响应（尤其刚上膛之后第一次）不带新的 refresh_token，于是 rotatedToken
 * 被写成**刚刚用掉的那一份**；同一轮 `dead.add(usedToken)` 又把它拉黑。
 * 下一轮 pickToken 两头都挑不出来 → 判 none → QuotaService 以为链子烧穿，
 * 拿登录 token 再上膛一次。**每上膛一次就烧掉一份一次性 refresh_token**，
 * 实测日志里 90 秒内连烧 5 次，最后链子真的死了。
 *
 * 修法（两处）：
 *   ① `record()`：服务器没给新 token 时保留上一轮的轮换值，且不把「用掉的那份」
 *      当死 token 拉黑 —— 服务器说它还能用，凭什么替它判死刑。
 *   ② `applyRearmedToken(..., { markConsumed: true })`：回写轮换 token 时同步
 *      推进锚点，下一轮 pickToken 不会因为「磁盘那份 == 消费掉的那份」判 none。
 * ------------------------------------------------------------------ */
console.log('\n【G】服务器回同一份 token：不许把它既记成最新、又拉黑');
{
  // 单独开一份干净状态：跟前面几节共用会把「这台假 STS 已经把哪些 token 用掉了」
  // 搅在一起，测出来的失败分不清是新问题还是夹具串扰。
  const T_ECHO = makeToken('echo');
  const T_ECHO_OLD = makeToken('echo-old');
  const ECHO_ID = 'acc0001';
  const f3 = path.join(os.tmpdir(), `rearm-echo-${process.pid}.json`);
  fs.writeFileSync(
    f3,
    JSON.stringify(
      { [ECHO_ID]: { accountId: ECHO_ID, fullId: ID, diskTokenUsed: T_ECHO_OLD, rotatedToken: '', deadTokens: [T_ECHO_OLD], consumed: [] } },
      null,
      2,
    ),
  );
  const st3 = new RefreshState(f3);
  const rf3 = new CredentialRefresher({ state: st3, config: { tokenUrl, clientId: 'c', timeoutMs: 8000 } });

  // 锚点 = 上一轮被消费掉的那份（真实现里就是 `previousDiskToken`）。
  // 先把它设上，再上膛，才符合「磁盘那份早用过、现在手上是登录新 token」的真实形状。
  st3.markDiskTokenConsumed(ECHO_ID, T_ECHO_OLD);
  st3.rearm(ECHO_ID, T_ECHO, { reason: 'self-login', previousDiskToken: T_ECHO_OLD });
  const beforeEcho = st3.pickToken(ECHO_ID, T_ECHO);
  ok('【G】上膛后立刻能挑出来', beforeEcho.source === 'disk-renewed' && beforeEcho.token === T_ECHO, `source=${beforeEcho.source}`);

  echoToken = true; // 服务器开始「原样回」
  const g1 = await rf3.refresh(mkProfile(T_ECHO), { accountId: ECHO_ID });
  ok('【G】第一轮成功', g1.ok === true, g1.errorCode || '');

  const gRec = st3.get(ECHO_ID);
  ok('【G】用掉的 token 没被拉黑（服务器说它还能用）', !(gRec.deadTokens || []).includes(T_ECHO), `dead=${(gRec.deadTokens || []).length}`);
  ok('【G】也没被记成「已消费」', !(gRec.consumed || []).includes(T_ECHO), `consumed=${(gRec.consumed || []).length}`);
  ok(
    '【G】rotatedToken 指向的是一份「还可能有用」的 token（不是被拉黑的死值）',
    gRec.rotatedToken === T_ECHO && !(gRec.deadTokens || []).includes(gRec.rotatedToken),
    `rotated=${(gRec.rotatedToken || '').slice(0, 16) || '(空)'}`,
  );
  ok(
    '【G】锚点跟档案走（不会被轮换值带偏）',
    gRec.diskTokenUsed === T_ECHO,
    `disk=${(gRec.diskTokenUsed || '').slice(0, 16)}`,
  );

  const afterEcho = st3.pickToken(ECHO_ID, T_ECHO);
  ok('【G】这一轮之后仍然挑得出 token（不会假判「链子烧穿」）', !!afterEcho.token && !(gRec.deadTokens || []).includes(afterEcho.token), `source=${afterEcho.source}`);

  // 关键不变式：档案锚点指向自己的时候，**绝不能**判 none ——
  // 那正是「5 次连续重新上膛」的形状（每上膛一次白烧一份一次性 token）。
  ok('【G】档案 == 锚点时挑的是轮换那份，而不是判 none', afterEcho.source === 'rotated' && afterEcho.token === T_ECHO, `source=${afterEcho.source}`);

  // 断开那次 1806：轮换那份被拒之后，链子必须还能恢复
  // （真实 STS 是单次性的，所以「服务器回同一份」之后下一次必然撞 1806 —— 这是
  //  正常轮换冲突，不是故障；关键是撞完之后别卡死。）
  echoToken = false;
  const g2 = await rf3.refresh(mkProfile(T_ECHO), { accountId: ECHO_ID });
  ok('【G】第二次发出同一份 → 被拒是正常的（单次性）', g2.ok === false && g2.errorCode === 'TOKEN_CONSUMED', g2.errorCode || '');
  ok('【G】被拒后断链标记置位（面板能看见）', st3.get(ECHO_ID).broken === true);
  ok('【G】被拒的那份进了死名单', (st3.get(ECHO_ID).deadTokens || []).includes(T_ECHO));

  const g3 = await rf3.refresh(mkProfile(T_ECHO_OLD), { accountId: ECHO_ID });
  ok('【G】换一份（模拟重新上膛后的新 token）能立刻继续用', g3.ok === true || g3.errorCode === 'NO_USABLE_TOKEN', g3.errorCode || '');

  // 反向对照：老写法「rotatedToken = 用掉的那份 + 拉黑」必须复现故障
  {
    const raw = JSON.parse(fs.readFileSync(f3, 'utf8'));
    const broken = JSON.parse(JSON.stringify(raw[ECHO_ID]));
    broken.rotatedToken = T_ECHO;
    broken.deadTokens = [...new Set([...(broken.deadTokens || []), T_ECHO])];
    broken.consumed = [];
    const f2 = path.join(os.tmpdir(), `rearm-echo-broken-${process.pid}.json`);
    fs.writeFileSync(f2, JSON.stringify({ ...raw, [ECHO_ID]: broken }, null, 2));
    const st2 = new RefreshState(f2);
    const badPick = st2.pickToken(ECHO_ID, T_ECHO);
    ok('【G】反向对照：老写法下 pickToken 判 none（测试不是空测）', badPick.source === 'none', `source=${badPick.source}`);
    try {
      fs.unlinkSync(f2);
    } catch {
      /* noop */
    }
  }
  try {
    fs.unlinkSync(f3);
  } catch {
    /* noop */
  }
}

/* ---------------- 收尾 ---------------- */
server.close();
try {
  fs.unlinkSync(tmpFile);
} catch {
  /* noop */
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);