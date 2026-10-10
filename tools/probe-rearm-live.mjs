/**
 * 在线诊断：把「续期链重新上膛」那条路完整重放一遍（打真实 STS），
 * 每一步都把内部状态打出来。
 *
 * 它会真的消耗一次 refresh_token —— 这正是修复本身要证明的事。
 * 跑之前请先停掉服务，避免两个进程同时改 data/refresh-state.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { AccountStore } from '../src/accounts.mjs';
import { QuotaService } from '../src/quota.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const config = loadConfig(path.join(ROOT, 'config.json'));

const store = new AccountStore({
  dataFile: path.join(ROOT, 'data', 'accounts.json'),
  installDirs: config.discover?.installDirs || [],
});
store.load();
store.scan();

const id = [...store.accounts.keys()][0];
const acc = store.get(id);
console.log('账号          :', id);
console.log('profile 有 token:', !!acc?.profile?.refreshToken, '| 有 DPoP:', !!acc?.profile?.raw?.dpop?.privateJwk);

const quota = new QuotaService({
  accounts: store,
  config: { ...(config.credits || {}), refresh: config.credits?.refresh || {} },
  historyFile: path.join(ROOT, 'data', 'quota-history.json'),
  refreshStateFile: path.join(ROOT, 'data', 'refresh-state.json'),
});

const before = quota.refreshState.get(id);
console.log('\n[上膛前] refresh-state:');
console.log('  diskTokenUsed :', before?.diskTokenUsed ? `有(${before.diskTokenUsed.length})` : '空');
console.log('  rotatedToken  :', before?.rotatedToken ? `有(${before.rotatedToken.length})` : '空');
console.log('  deadTokens    :', (before?.deadTokens || []).length, '条');
console.log('  broken        :', before?.broken);

console.log('\n[判定] _tokenChainDead =', quota._tokenChainDead(id));

const login = store.oauthRefreshToken(id);
console.log('[登录记录] 有 token:', !!login?.refreshToken);

console.log('\n== 手动走一遍 _rearmFromLogin ==');
const rearm = quota._rearmFromLogin(id);
console.log('  结果:', JSON.stringify(rearm.ok === undefined ? rearm : { ok: rearm.ok }));

const after = quota.refreshState.get(id);
console.log('[上膛后] refresh-state:');
console.log('  diskTokenUsed :', after?.diskTokenUsed ? `有(${after.diskTokenUsed.length})` : '空');
console.log('  rotatedToken  :', after?.rotatedToken ? `有(${after.rotatedToken.length})` : '空');
console.log('  deadTokens    :', (after?.deadTokens || []).length, '条');
console.log('  broken        :', after?.broken);
console.log('  档案里的 token:', store.get(id)?.profile?.refreshToken ? `有(${store.get(id).profile.refreshToken.length})` : '空');

const pick = quota.refreshState.pickToken(id, store.get(id)?.profile?.refreshToken || '');
console.log('[pickToken] =>', pick.source, pick.token ? `有(${pick.token.length})` : '空');

console.log('\n== 真实续期（打 STS）==');
const r = await quota.refreshCredential(id);
console.log('  结果:', JSON.stringify({ ok: r.ok, errorCode: r.errorCode, error: r.error, rotated: r.rotated }));
if (r.ok) {
  console.log('  新凭据 expiresAt:', r.credential?.expiresAt);
  console.log('\n== 用新凭据读一次额度 ==');
  const q = await quota.get(id, { force: true });
  console.log('  ok:', q.ok, '| 出错:', q.error || '(无)');
  if (q.ok) {
    console.log('  headline :', q.headline);
    console.log('  subline  :', q.subline);
    console.log('  剩余积分 :', q.points?.remaining, '/', q.points?.total);
  }
}
