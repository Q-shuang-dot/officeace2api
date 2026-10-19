/**
 * 精确回答：「这份 data/ 能不能给别人」。
 *
 * 判据是看每个敏感字段的**真实形态**，不含糊：
 *   · JWT（三段点号分隔）        → 明文令牌
 *   · base64 且能解出 DPAPI 结构 → 机器绑定密文（换了机器/用户打不开）
 *   · 短英文串                   → 明文
 *
 * 纯读。只打印"形态"和长度，不打印秘密本身。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';

const P = 'data/oauth-accounts.json';
const raw = readFileSync(P, 'utf8');
const oauth = JSON.parse(raw);
const list = Array.isArray(oauth) ? oauth : (oauth.accounts || Object.values(oauth));

console.log('\n════ 每个敏感字段的真实形态 ════');

/** 判形态 */
function shape(v) {
  if (v === null || v === undefined) return '（无）';
  if (typeof v === 'object') return `对象(${Object.keys(v).join(',')})`;
  const s = String(v);
  if (!s) return '（空）';
  // JWT：三段 base64url，用点分隔，第一段能解出 {"alg":...
  if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(s)) {
    try {
      const head = JSON.parse(Buffer.from(s.split('.')[0], 'base64url').toString('utf8'));
      return `🔴 明文 JWT（头=${JSON.stringify(head)}）`;
    } catch { return '🟠 形状像 JWT 但头解不开'; }
  }
  // DPAPI 密文：base64 且开头像 DPAPI blob（01000000D08C9DDF...）
  if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(s)) {
    try {
      const buf = Buffer.from(s, 'base64');
      const hex = buf.subarray(0, 8).toString('hex');
      if (hex.startsWith('01000000d08c9ddf')) return `🟢 DPAPI 密文（机器绑定，头 ${hex}）`;
      return `🟡 base64 ${buf.length}B，头 ${hex}（不是标准 DPAPI 头）`;
    } catch { return '🟡 像 base64 但解不开'; }
  }
  return `🔴 明文（长度 ${s.length}，开头 ${s.slice(0, 10)}…）`;
}

const SENSITIVE = ['refreshToken', 'authorization', 'credential', 'dpopPrivateJwk', 'accessKeyId', 'appSecret', 'appSecretKey', 'secretAccessKey'];
for (let i = 0; i < list.length; i += 1) {
  const a = list[i] || {};
  console.log(`\n  ── 账号 #${i + 1}  ${a.label || a.id || ''}`);
  for (const [k, v] of Object.entries(a)) {
    const sensitive = SENSITIVE.includes(k);
    const sh = shape(v);
    const mark = sensitive ? '' : '   ';
    console.log(`     ${mark}${k.padEnd(18)} ${sh}`);
  }
}

console.log('\n════ 再看 accounts.json（控制面 AK/SK）════');
const acc = JSON.parse(readFileSync('data/accounts.json', 'utf8'));
for (const [uid, rec] of Object.entries(acc)) {
  console.log(`  ${uid.slice(0, 22)}…`);
  for (const [k, v] of Object.entries(rec || {})) {
    console.log(`     ${k.padEnd(18)} ${shape(v)}`);
  }
}

console.log('\n════ 结论 ════');
const all = JSON.stringify(oauth) + JSON.stringify(acc);
const jwtCount = (all.match(/"[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}"/g) || []).length;
const dpapiCount = (all.match(/01000000d08c9ddf/gi) || []).length;
console.log(`  明文 JWT 出现次数：${jwtCount}`);
console.log(`  DPAPI 密文出现次数：${dpapiCount}`);
console.log('');
if (jwtCount > 0 && dpapiCount === 0) {
  console.log('  🔴 **data/ 里躺着明文长效凭据，这份文件不能外发。**');
  console.log('     拿到它 = 拿到别人的号（refreshToken 能换 access_token）。');
  console.log('     换自己的机器请用 export-accounts.cmd 导出**加密的搬运包**（不是直接拷这个目录）：');
  console.log('     包本身仍然等于凭据，导完记得在旧机器上停掉这些号（refresh_token 是一次性的）。');
} else if (dpapiCount > 0) {
  console.log('  🟢 凭据是 DPAPI 密文：绑本机本用户，外发了也用不了。');
} else {
  console.log('  🟡 形态不明确，逐个字段看上面。');
}
console.log('');
console.log(`  文件权限：${existsSync(P) ? '存在' : '无'}，${statSync(P).size} B`);
