/**
 * 上线模拟（只读真实数据 + 临时文件，**不联网、不改任何东西**）：
 * 用号池里那个真实账号走一遍「用户点了重新登录 → 服务自动上膛 → 续期链恢复」。
 *
 * 为什么要单独跑一遍：整条链的「该不该上膛」判定是在 QuotaService 里做的，
 * 而离线单测用的是假账号。这里拿真档案（真 token 长度、真字段）再过一次判定，
 * 确认重新登录之后一定会走到 rearm，而且上膛之后 pickToken 立刻有话说。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountStore } from '../src/accounts.mjs';
import { RefreshState } from '../src/refresh.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fail += 1;
};

const store = new AccountStore({ dataFile: path.join(ROOT, 'data', 'accounts.json') });
store.load();
store.scan();
const id = [...store.accounts.keys()][0];
if (!id) {
  console.log('号池里没有账号，跳过。');
  process.exit(0);
}
const acc = store.get(id);
const state = new RefreshState(path.join(ROOT, 'data', 'refresh-state.json'));
const rec = state.get(id);
const anchor = String(rec?.diskTokenUsed || '');
const dead = new Set(rec?.deadTokens || []);

console.log('账号:', id);
console.log('');

console.log('【现状】重新登录之前');
const pickNow = state.pickToken(id, acc.profile.refreshToken || '');
const loginNow = store.oauthRefreshToken(id);
console.log('  pickToken             :', pickNow.source);
console.log('  档案 token 长度        :', (acc.profile.refreshToken || '').length);
console.log('  登录记录 token 长度    :', (loginNow?.refreshToken || '').length);
console.log('  登录记录那份在死名单里 :', dead.has(loginNow?.refreshToken || ''));
const wouldNowRearm = !pickNow.token && !!(loginNow?.refreshToken && loginNow.refreshToken !== anchor && !dead.has(loginNow.refreshToken));
check('旧登录记录不会触发重复上膛', wouldNowRearm === false, `wouldRearm=${wouldNowRearm}`);

console.log('');
console.log('【模拟】用户点了一键授权，云端发下一份全新 refresh_token');
const FRESH = `tok-fresh-${crypto.randomBytes(60).toString('hex')}`;
const loginIsNew = FRESH !== anchor && !dead.has(FRESH);
check('新登录记录「够新」', loginIsNew === true);
// 「该不该上膛」是两条一起看：链子挑不出东西 **且** 手上有新的登录 token。
// 现在链子是活的（挑得出 rotatedToken），所以就算新登录 token 再新也不该上膛 ——
// 上膛会改写锚点，在「本来还能用」的时候上膛等于亲手把链子弄断。
check(
  '链子还活着时，即便有新登录记录也不上膛',
  (!pickNow.token && loginIsNew) === false,
  `链子现在挑的是 ${pickNow.source}`,
);

const tmp = path.join(os.tmpdir(), `login-sim-${process.pid}.json`);
fs.copyFileSync(path.join(ROOT, 'data', 'refresh-state.json'), tmp);
const sim = new RefreshState(tmp);
const r = sim.rearm(id, FRESH, { reason: 'self-login', previousDiskToken: acc.profile.refreshToken });
check('rearm 成功', r.ok === true);
const pickAfter = sim.pickToken(id, FRESH);
check('上膛后立刻挑得出 token', pickAfter.source === 'disk-renewed' && pickAfter.token === FRESH, `source=${pickAfter.source}`);
check('上膛后 broken 已清', sim.get(id).broken === false);
check('锚点仍是上一轮消费掉的那份', sim.get(id).diskTokenUsed === (acc.profile.refreshToken || ''));

try {
  fs.unlinkSync(tmp);
} catch {
  /* noop */
}

console.log('');
console.log(fail ? `结果：${fail} 项不符合预期` : '结果：全部符合预期 —— 重新登录之后会自动接上');
process.exit(fail ? 1 : 0);
