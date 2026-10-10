/**
 * 续期 token 链的回归测试。
 *
 * 背景：refresh_token 是一次性轮换的 —— 每续期一次，服务端就把上一份作废。
 * 而 OfficeAce 写在磁盘上的档案是只读的，里面那份 token 永远是最初那份 T0，
 * 所以我们得自己维护「现在哪一份还能用」。
 *
 * 这里用一个「用掉就作废」的假服务端，连续跑 30 次续期，断言一次都不该失败。
 *
 * 老实现（一个 .slice(-12) 的 consumed 数组）会在第 14 次把磁盘锚点 T0 挤出窗口，
 * 然后把它当成没用过的新 token 发上去，换来永久 STS5.1806、不可自愈。
 * 凭据寿命实测只有 2 小时，所以这个坑约一天内必然会踩到 —— 本文件就是为它写的。
 * 文件末尾还跑一遍老逻辑做对照，确认老实现确实会挂（不然这个测试就是假的）。
 *
 *   node tools/test-refresh-chain.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RefreshState } from '../src/refresh.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const fails = [];

const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    fails.push(`${name} ${extra}`.trim());
    console.log(`  \u2717 ${name} ${extra}`);
  }
};

/* ------------------------------------------------------------------ 假服务端 */
/**
 * 一次性轮换的 refresh_token 服务端：
 *   - 只有「当前有效」的那一份能用
 *   - 用掉之后立刻换一份新的，并把旧的记进「已作废」
 *   - 收到已作废的 → STS5.1806（就是真实服务端那个码）
 */
class FakeSts {
  constructor() {
    this.live = 'T0';
    this.n = 0;
    this.consumed = new Set();
    this.callLog = [];
  }

  refresh(sent) {
    this.callLog.push(sent);
    if (sent === this.live) {
      this.consumed.add(sent);
      this.n += 1;
      this.live = `T${this.n}`;
      return { ok: true, rotated: this.live };
    }
    if (this.consumed.has(sent)) {
      return { ok: false, code: 'STS5.1806', msg: 'refresh_token 已经被使用过' };
    }
    return { ok: false, code: 'STS5.1802', msg: 'refresh_token 无效' };
  }
}

const tmp = (tag) => path.join(os.tmpdir(), `officeace-refresh-${tag}-${process.pid}.json`);

/* ------------------------------------------------------------------ 1. 新版 */
const DISK = 'T0'; // 磁盘上永远是这份，OfficeAce 不会去更新它
const ROUNDS = 30;

console.log(`\n[1] 新实现：连续 ${ROUNDS} 次续期（磁盘 token 恒定不变）`);
{
  const file = tmp('new');
  try {
    fs.unlinkSync(file);
  } catch {
    /* 本来就不在 */
  }
  const sts = new FakeSts();
  const st = new RefreshState(file);

  let brokeAt = 0;
  let lastSource = '';
  for (let i = 1; i <= ROUNDS; i++) {
    const pick = st.pickToken('acct', DISK);
    if (!pick.token) {
      brokeAt = i;
      console.log(`      第 ${i} 次：没有可用 token 了（source=${pick.source}）`);
      break;
    }
    lastSource = pick.source;
    const r = sts.refresh(pick.token);
    if (!r.ok) {
      st.breakChain('acct', r.code, pick.token);
      brokeAt = i;
      console.log(`      第 ${i} 次：发出 ${pick.token}（来自 ${pick.source}）→ ${r.code} ${r.msg}`);
      break;
    }
    st.record('acct', {
      usedToken: pick.token,
      diskToken: DISK,
      rotatedToken: r.rotated,
      // 复刻 CredentialRefresher：这次发的是不是「档案那条线」的那一份
      sentDiskToken: pick.source === 'disk' || pick.source === 'disk-renewed' || pick.source === 'disk-last-resort',
      credential: { accessKeyId: `AK${i}`, secretAccessKey: `SK${i}`, expiresAt: '' },
      refreshExpiresAt: Date.now() + 86400000,
    });
  }

  ok(`${ROUNDS} 次续期全部成功`, brokeAt === 0, brokeAt ? `第 ${brokeAt} 次断了` : '');
  ok('服务端一共只收到 30 次请求（没有无效重放）', sts.callLog.length === ROUNDS, `实际 ${sts.callLog.length}`);
  ok(
    '每次发的都是当时有效的那一份',
    sts.callLog.every((t, i) => t === `T${i}`),
    `实际序列 ${sts.callLog.slice(0, 5).join(',')}…`,
  );
  ok('第 2 次起走的都是轮换值而不是磁盘值', lastSource === 'rotated', `最后来源 ${lastSource}`);

  const rec = st.get('acct');
  ok('记录里用的是新结构（diskTokenUsed/deadTokens）', !!rec.diskTokenUsed && Array.isArray(rec.deadTokens));
  // `consumed` 现在跟 `deadTokens` 分工：dead = 服务器明确拒过的；consumed = 发过、
  // 服务器认过（200）的单次性 token。**关键区别**：diskTokenUsed 只跟「档案那条线」
  // 走，绝不会被轮换值带偏 —— 它一旦指向轮换值，下一轮 pickToken 就会看到
  // 「档案 == 锚点」而放着新鲜 token 不用（这是「反复重新上膛、把链子烧穿」的成因）。
  ok('consumed 是新语义（数组、只记发过的）', Array.isArray(rec.consumed) && rec.consumed.length <= ROUNDS, `长度 ${rec.consumed?.length}`);
  ok('diskTokenUsed 只跟着档案那条线走，没被轮换值带偏', rec.diskTokenUsed === DISK, `diskTokenUsed=${rec.diskTokenUsed}`);
  ok('发出去过的那份都进了 consumed', (rec.consumed || []).includes('T0'), JSON.stringify(rec.consumed));
  fs.unlinkSync(file);
}

/* ------------------------------------------------------------------ 2. 断链恢复 */
console.log('\n[2] 轮换值被别处用掉（模拟 OfficeAce 自己也登了一次）之后还能恢复');
{
  const file = tmp('recover');
  try {
    fs.unlinkSync(file);
  } catch {
    /* 不存在 */
  }
  const sts = new FakeSts();
  const st = new RefreshState(file);

  // 先正常续两次：T0 → T1 → T2
  for (let i = 0; i < 2; i++) {
    const p = st.pickToken('acct', DISK);
    const r = sts.refresh(p.token);
    st.record('acct', {
      usedToken: p.token,
      diskToken: DISK,
      rotatedToken: r.rotated,
      sentDiskToken: p.source === 'disk' || p.source === 'disk-renewed' || p.source === 'disk-last-resort',
      credential: { accessKeyId: 'AK', secretAccessKey: 'SK' },
      refreshExpiresAt: Date.now() + 86400000,
    });
  }

  // 现在「OfficeAce 自己」把 T2 用掉了（我们不知道），换成了 T3
  sts.consumed.add(sts.live);
  sts.n += 1;
  sts.live = `T${sts.n}`;

  const p1 = st.pickToken('acct', DISK);
  const r1 = sts.refresh(p1.token);
  ok('第一次撞上作废值（预期）', !r1.ok && r1.code === 'STS5.1806', `实际 ${r1.code || 'ok'}`);
  st.breakChain('acct', r1.code, p1.token);

  const p2 = st.pickToken('acct', DISK);
  ok('把作废的那份拉黑之后，不再重复发它', p2.token !== p1.token, `还是 ${p2.token}`);

  // 关键：模拟 OfficeAce 重新登录，磁盘上出现一份全新的 token
  const fresh = sts.live;
  const p3 = st.pickToken('acct', fresh);
  ok('磁盘上出现新版 token 时能被认出来', p3.token === fresh, `拿到的是 ${p3.token}（来自 ${p3.source}）`);
  ok('来源标成 disk-renewed', p3.source === 'disk-renewed', `实际 ${p3.source}`);
  fs.unlinkSync(file);
}

/* ------------------------------------------------------------------ 3. breakChain 不能再自断后路 */
console.log('\n[3] breakChain 只该拉黑被拒的那一份');
{
  const file = tmp('break');
  try {
    fs.unlinkSync(file);
  } catch {
    /* 不存在 */
  }
  const st = new RefreshState(file);
  st.record('acct', {
    usedToken: 'T0',
    diskToken: 'T0',
    rotatedToken: 'T1',
    credential: { accessKeyId: 'AK', secretAccessKey: 'SK' },
    refreshExpiresAt: Date.now() + 86400000,
  });
  // 被拒的是磁盘那份 T0，而 T1 还是好的
  st.breakChain('acct', 'STS5.1806', 'T0');
  const rec = st.get('acct');
  ok('轮换值 T1 没有被连带删掉', rec.rotatedToken === 'T1', `实际 ${JSON.stringify(rec.rotatedToken)}`);
  const p = st.pickToken('acct', 'T0');
  ok('接下来会用 T1 而不是再去撞 T0', p.token === 'T1', `实际 ${p.token}（${p.source}）`);
  fs.unlinkSync(file);
}

/* ------------------------------------------------------------------ 4. 老记录迁移 */
console.log('\n[4] 老结构（consumed 数组）能迁移过来');
{
  const file = tmp('migrate');
  // 手工造一份老格式的记录：消费链是 T0,T1,T2，磁盘上还是 T0
  fs.writeFileSync(
    file,
    JSON.stringify({
      acct: {
        accountId: 'acct',
        lastUsedToken: 'T2',
        rotatedToken: 'T3',
        consumed: ['T0', 'T1', 'T2'],
        credential: { accessKeyId: 'AK', secretAccessKey: 'SK' },
      },
    }),
  );
  const st = new RefreshState(file);
  const rec = st.get('acct');
  ok('diskTokenUsed 从老链头推出来', rec.diskTokenUsed === 'T0', `实际 ${JSON.stringify(rec.diskTokenUsed)}`);
  ok('deadTokens 带过来了', Array.isArray(rec.deadTokens) && rec.deadTokens.includes('T1'));
  ok('老字段清掉了', rec.consumed === undefined && rec.lastUsedToken === undefined);
  const p = st.pickToken('acct', 'T0');
  ok('磁盘那份 T0 被正确认成旧的，改用 T3', p.token === 'T3', `实际 ${p.token}（${p.source}）`);
  fs.unlinkSync(file);
}

/* ------------------------------------------------------------------ 5. 老实现对照 */
console.log('\n[5] 对照：把老逻辑原样跑一遍，确认它确实会在第 14 次断（证明上面不是空测）');
{
  // 老 pickToken 一字不改地搬过来
  const oldPick = (rec, diskToken) => {
    if (!rec) return { token: diskToken, source: 'disk' };
    const consumed = new Set(rec.consumed || []);
    if (rec.lastUsedToken) consumed.add(rec.lastUsedToken);
    if (diskToken && consumed.has(diskToken)) {
      if (rec.rotatedToken && !consumed.has(rec.rotatedToken)) {
        return { token: rec.rotatedToken, source: 'rotated', generation: consumed.size };
      }
      return { token: rec.rotatedToken || diskToken, source: 'rotated-stale', generation: consumed.size };
    }
    if (diskToken && rec.rotatedToken && !consumed.has(rec.rotatedToken)) {
      return { token: diskToken, source: 'disk-after-app-rotate' };
    }
    return { token: diskToken, source: 'disk' };
  };
  // 老 record 也一字不改
  const oldRecord = (prev, { usedToken, rotatedToken }) => {
    const consumed = [
      ...new Set([...(prev.consumed || []), ...(prev.lastUsedToken ? [prev.lastUsedToken] : []), usedToken].filter(Boolean)),
    ].slice(-12);
    return {
      lastUsedToken: usedToken,
      rotatedToken: rotatedToken || usedToken,
      consumed,
    };
  };

  const sts = new FakeSts();
  let rec = null;
  let brokeAt = 0;
  let lastBad = '';
  for (let i = 1; i <= ROUNDS; i++) {
    const pick = oldPick(rec, DISK);
    const r = sts.refresh(pick.token);
    if (!r.ok) {
      brokeAt = i;
      lastBad = `发出 ${pick.token}（来自 ${pick.source}）→ ${r.code}`;
      break;
    }
    rec = oldRecord(rec || {}, { usedToken: pick.token, rotatedToken: r.rotated });
  }
  ok(
    '老实现确实会断链（所以新实现的价值是真的）',
    brokeAt > 0,
    brokeAt ? `第 ${brokeAt} 次：${lastBad}` : '老实现居然全过了 —— 这个对照失效了，请检查',
  );
  if (brokeAt) console.log(`      （老实现在第 ${brokeAt} 次断：${lastBad}）`);
}

/* ------------------------------------------------------------------ 结果 */
console.log('\n' + '='.repeat(56));
console.log(`结果：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log(`  - ${f}`);
}
console.log(`\n提示：这个文件只用假的 STS，不碰网络，也不碰 data/ 里的真实状态。`);
process.exit(fails.length ? 1 : 0);
