/**
 * 凭据自动续期：用 refresh_token 换一套新的临时 AK/SK
 *
 * 为什么需要它：OfficeAce 发的临时 AK/SK 只有 24 小时寿命，过期后整个反代就哑了。
 * 但同一份档案里的 refresh_token 能活 30 天 —— 拿它去 IAM 换新的 AK/SK，
 * 就能让服务连续跑一个月不用人工重新登录。
 *
 * 链路（全部逆向自 packages/green-package/api/dist/auth/huawei-oauth.js 的 refreshPrincipal()）：
 *
 *   POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens
 *   Content-Type: application/x-www-form-urlencoded
 *   DPoP: <ES256 签名的 DPoP proof JWT>
 *
 *   client_id=pdp5_for_agentarts
 *   grant_type=refresh_token
 *   refresh_token=<档案里的 refresh_token>
 *
 *   → { credentials: { access_key_id, secret_access_key, security_token,
 *                      expiration, project_id },
 *       refresh_token: <轮换后的新 token>,
 *       id_token: <JWT> }
 *
 * DPoP proof 的结构（oauth-crypto.js 的 generateDpopJwt()）：
 *   header  = { typ:'dpop+jwt', alg:'ES256', jwk:{kty,x,y,crv} }   ← 只带公钥
 *   payload = { htm:'POST', htu:<tokenUrl>, iat:<秒>, jti:<16字节hex> }
 *   签名    = ECDSA-P256-SHA256(raw R||S 64 字节)，base64url
 *
 * ⚠️ refresh_token 是**一次性轮换**的：用掉之后旧的就废了（重放会得到
 *    STS5.1806 "the refresh token has been used"）。所以新 token 必须落盘。
 *    本模块把轮换结果存在自己的 data/refresh-state.json 里，**不改 OfficeAce 的任何文件**；
 *    同时用「上次消费的是哪个 token」来判断该信谁 —— 如果 OfficeAce 自己换成新的了，
 *    我们发现自己记的和磁盘上的不一致，就以磁盘为准（说明是 App 换的）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.mjs';
import { writeFileSecure } from './util.mjs';

const log = createLogger('refresh');

export const DEFAULT_TOKEN_URL = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens';
export const DEFAULT_CLIENT_ID = 'pdp5_for_agentarts';
/** 「the refresh token has been used」——轮换冲突的典型错误码 */
const USED_TOKEN_CODES = ['STS5.1806', 'STS5.1807'];

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/* ============================================================ DPoP */

/**
 * 用档案里的 DPoP 私钥签一个 DPoP proof JWT。
 * privateJwk 形如 { kty:'EC', crv:'P-256', x, y, d }
 */
export async function generateDpopProof(privateJwk, publicJwk, htm, htu, nowMs = Date.now()) {
  if (!privateJwk?.d || privateJwk.kty !== 'EC') {
    throw new Error('档案里没有可用的 DPoP 私钥（dpop.privateJwk 缺失）');
  }
  const key = await crypto.webcrypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: privateJwk.crv || 'P-256', x: privateJwk.x, y: privateJwk.y, d: privateJwk.d },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const pub = publicJwk || privateJwk;
  const header = {
    typ: 'dpop+jwt',
    alg: 'ES256',
    jwk: { kty: pub.kty || 'EC', x: pub.x, y: pub.y, crv: pub.crv || 'P-256' },
  };
  const payload = {
    htm,
    htu,
    iat: Math.floor(nowMs / 1000),
    jti: crypto.randomBytes(16).toString('hex'),
  };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = await crypto.webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    Buffer.from(signingInput),
  );
  return `${signingInput}.${b64u(new Uint8Array(sig))}`;
}

/** 从 id_token 里取用户名（只解 payload，不验签 —— 我们不是安全边界） */
export function idTokenClaims(idToken) {
  try {
    const parts = String(idToken || '').split('.');
    if (parts.length < 2) return {};
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return {
      sub: typeof p.sub === 'string' ? p.sub : '',
      userName: typeof p.preferred_username === 'string' ? p.preferred_username : typeof p.name === 'string' ? p.name : '',
    };
  } catch {
    return {};
  }
}

/* ============================================================ 轮换状态 */

/**
 * 记「我们自己消费过的 refresh_token 和换回来的凭据」。
 * 之所以要记：refresh_token 一次性轮换，不能每次都用磁盘上那份旧的。
 */
export class RefreshState {
  constructor(file) {
    this.file = file;
    this.doc = {};
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      if (fs.existsSync(this.file)) {
        const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (d && typeof d === 'object') {
          this.doc = d;
          this._migrate();
        }
      }
    } catch (err) {
      log.warn('读取续期状态失败，按空处理', { error: err.message });
      this.doc = {};
    }
  }

  /**
   * 把老结构（consumed 数组 + lastUsedToken）迁移成新结构
   * （diskTokenUsed + deadTokens 这两个显式值）。
   *
   * 老结构用一个 .slice(-12) 的数组去回答「磁盘那份 token 用过没有」——
   * 第 13 次续期会把答案挤出窗口，于是把早已作废的 token 当新的发上去。
   * 新结构把答案记成一个值，永远不会溢出。
   *
   * consumed[0] 是链的源头，也就是磁盘上那份 token；但老代码截断过，它可能已经
   * 不在里面了。那种情况下面 pickToken 会多试一次，失败后由 breakChain 拉黑，
   * 不会反复撞同一个坑。
   */
  _migrate() {
    let n = 0;
    for (const rec of Object.values(this.doc)) {
      if (!rec || typeof rec !== 'object') continue;
      if (rec.diskTokenUsed !== undefined || rec.deadTokens !== undefined) continue;
      const old = [
        ...new Set([...(rec.consumed || []), ...(rec.lastUsedToken ? [rec.lastUsedToken] : [])].filter(Boolean)),
      ];
      rec.deadTokens = old.slice(-40);
      rec.diskTokenUsed = old[0] || rec.lastUsedToken || '';
      delete rec.consumed;
      delete rec.lastUsedToken;
      delete rec.stale;
      rec.migratedAt = Date.now();
      n += 1;
    }
    if (n) {
      log.info('续期状态已迁移到新结构', { accounts: n });
      this.save();
    }
  }

  save() {
    if (!this.file) return;
    try {
      // 原子写 + Windows 上把权限收紧到只有当前用户。
      // 这里装的是明文 refresh_token / SK，以前的 mode: 0o600 在 Windows 上
      // 是无效的（实测同机任何用户都能读到）。
      writeFileSecure(this.file, JSON.stringify(this.doc, null, 2));
    } catch (err) {
      log.warn('保存续期状态失败', { error: err.message });
    }
  }

  /**
   * 取某个账号的轮换记录。
   * 号池的 ID 是 `<云端账号ID>:<IAM用户ID>`，但档案里的 accountId 只有前半段，
   * 所以这里先精确匹配，再退回「前缀匹配」——两种 ID 都能查到同一条记录。
   */
  get(accountId) {
    const key = String(accountId || '');
    if (!key) return null;
    if (this.doc[key]) return this.doc[key];
    const short = key.split(':')[0];
    if (this.doc[short]) return this.doc[short];
    for (const [k, v] of Object.entries(this.doc)) {
      if (key.startsWith(k) || k.startsWith(key)) return v;
    }
    return null;
  }

  /** 内部用的规范键：写的时候统一存到短 ID 上，避免同一个号存出两条 */
  _keyOf(accountId) {
    const key = String(accountId || '');
    if (this.doc[key]) return key;
    const short = key.split(':')[0];
    if (this.doc[short]) return short;
    return short || key;
  }

  /**
   * 整份替换续期状态（换电脑导入用）。
   *
   * 为什么需要专门的入口：`this.doc` 是**加载时读进内存、每次 save() 整份写回**的。
   * 外部（工具/面板导入）如果直接改磁盘上的 refresh-state.json，正在跑的服务下一次
   * save() 就会把导入的内容**整个覆盖掉** —— 表现是"导入成功了，重启后又没了"。
   * 合并逻辑在 src/bundle.mjs（纯函数），这里只负责「换掉内存 + 落盘」。
   */
  replaceDoc(doc) {
    if (!doc || typeof doc !== 'object') return false;
    this.doc = doc;
    this._migrate();
    this.save();
    return true;
  }

  /**
   * 决定这次该用哪个 refresh_token。
   *
   * 背景：磁盘上的档案是**只读**的（OfficeAce 自己不刷新它），所以那里的 token
   * 永远是最初那份 T0；而我们每换一次，云端就把上一份作废。
   *
   * 关键点：**磁盘上那一份 token 一辈子只会被我们消费一次**，就是第一次用它的
   * 时候；之后一直用轮换出来的最新那份就行。所以「磁盘 token 是不是已经旧了」
   * 这件事，只要**记住我们消费掉的那份长什么样**就够了 —— 不需要一条会溢出的
   * 消费链。
   *
   * ⚠️ 以前这里靠一个 `.slice(-12)` 的 consumed 数组回溯。第 13 次续期时，
   * 磁盘锚点 T0 被挤出窗口，于是走进下面的 disk-after-app-rotate 分支，
   * 把早已作废的 T0 当新 token 发出去 → 永久 STS5.1806，
   * 而且是不可自愈的（要重新登录）。凭据寿命只有 2 小时，一天内必然撞上。
   */
  pickToken(accountId, diskToken) {
    const rec = this.get(accountId);
    if (!rec) return { token: diskToken, source: 'disk' };

    // 两种都要排除：
    //   dead     —— 服务器明确拒过（STS5.1806），再发必拒
    //   consumed —— 我们发过、服务器认过（200）。一次性 token 重发就是
    //               「自己制造一次 1806」，所以不能再选它
    const dead = new Set(rec.deadTokens || []);
    const unusable = new Set([...dead, ...(rec.consumed || [])]);
    const diskKnown = rec.diskTokenUsed || '';

    // 1) 磁盘上这份是新鲜的
    //    - 从没记过 → 全新记录，磁盘那份没人动过
    //    - 跟我们消费过的那份不一样 → OfficeAce 自己重新登录，写了份新的
    if (diskToken && !unusable.has(diskToken)) {
      if (!diskKnown) return { token: diskToken, source: 'disk' };
      if (diskToken !== diskKnown) return { token: diskToken, source: 'disk-renewed' };
    }

    // 2) 用轮换出来的最新那份
    if (rec.rotatedToken && !unusable.has(rec.rotatedToken)) {
      return { token: rec.rotatedToken, source: 'rotated' };
    }

    // 3) 兜底：磁盘那份跟「我们记下的那份」不一样、而且没被排掉，
    //    说明它可能是新的（老记录迁移过来时 diskKnown 可能不准）。试一把 ——
    //    成了就救回来了，不成就被 breakChain 拉黑，不会反复撞。
    if (diskToken && !unusable.has(diskToken) && diskToken !== diskKnown) {
      return { token: diskToken, source: 'disk-last-resort' };
    }

    // 4) 手里一份能用的都没有了。别硬发一个必然 1806 的 token 上去 ——
    //    明确告诉上层「要重新登录」，比反复撞墙好查得多。
    if (process.env.OFFICEACE_DEBUG_PICK) {
      console.error('[pickToken] none', {
        key: String(accountId || ''),
        hasRec: !!rec,
        diskHead: diskToken ? diskToken.slice(0, 12) : '(空)',
        diskLen: diskToken ? diskToken.length : 0,
        knownHead: diskKnown ? diskKnown.slice(0, 12) : '(空)',
        knownTail: diskKnown ? diskKnown.slice(-8) : '',
        diskKnownLen: diskKnown ? diskKnown.length : 0,
        eq: diskToken === diskKnown,
        typeDisk: typeof diskToken,
        typeKnown: typeof diskKnown,
        diskDead: diskToken ? dead.has(diskToken) : null,
        rotatedLen: rec?.rotatedToken ? rec.rotatedToken.length : 0,
        deadSize: dead.size,
      });
    }
    return { token: '', source: 'none' };
  }

  /**
   * 把「磁盘 token 已经被我们消费过了」的锚点往前推一格。
   *
   * 什么时候需要：服务器刚轮换给我们一份新的 refresh_token，而这份同时被写进了
   * `profile.refreshToken`（`AccountStore.applyRearmedToken(..., { markConsumed: true })`）。
   * 不推进的话下一轮 `pickToken` 会看到 `diskToken == diskTokenUsed` → 判 `none`
   * → `QuotaService` 以为链子烧穿、拿登录 token 再上膛一次。每上膛一次就烧掉一份
   * 一次性 refresh_token，几轮之后真的把自己烧死。
   *
   * 只在「窗口里确实没有这份 token」时才推进 —— anchor 一旦指向一份还活着的 token，
   * 那份就再也挑不出来了，所以要做保护。
   */
  markDiskTokenConsumed(accountId, token) {
    const key = this._keyOf(accountId);
    const value = String(token || '');
    if (!value) return false;
    const rec = this.doc[key];
    if (!rec) return false;
    if (rec.diskTokenUsed === value) return false; // 已经是锚点，不用再推
    const dead = new Set(rec.deadTokens || []);
    if (dead.has(value)) return false; // 已作废，别拿它当锚点
    rec.diskTokenUsed = value;
    this.save();
    return true;
  }

  /**
   * 轮换结果落盘 + 开新记录。
   */
  record(accountId, { usedToken, diskToken, rotatedToken, credential, refreshExpiresAt, userName, tokenReused = false, sentDiskToken = false }) {
    const key = this._keyOf(accountId);
    const prev = this.doc[key] || {};

    // 这次发出去的 token 还算不算「已经被用掉」？
    //
    // 语义要分清：`deadTokens` = **服务器明确拒过**的（STS5.1806），绝不能重发；
    // `consumed` = 我们发过、服务器认了（200）的，**单次性的**别重发。
    //
    // ⚠️ 这里曾经用一个 `dead.add(usedToken)` 把两种都当死了，代价是：
    // 服务器若把同一份 token 原样回给我们（`tokenReused`），我们也把它拉黑 →
    // `rotatedToken` 又恰好指向它 → 下一轮 pickToken 两头都挑不出来 → 判 none →
    // 上层以为链子烧穿、拿登录 token 重新上膛一次。每上膛一次就白烧一份一次性
    // refresh_token，实测 90 秒内连烧 5 次，最后链子真死。
    const rotatedValue = String(rotatedToken || '');
    const dead = new Set(prev.deadTokens || []);
    const consumed = new Set(prev.consumed || []);
    if (usedToken && !tokenReused) consumed.add(usedToken);

    // 轮换值怎么定 —— 比「有 / 没有」分得细：
    //   · 服务器原样回同一份 → 它还活着，留着当「重开」之后的种子。
    //   · 服务器给了新的 → 用它，它就是下一轮要发的那份。
    //   · 服务器什么也没给 → 保留上一轮那份；但上一轮那份已被拉黑、或就是这次
    //     发出去的那份，就得丢掉，否则等于把死值 / 已用值留在窗口里。
    const prevRotated = String(prev.rotatedToken || '');
    const prevUsable = prevRotated && !consumed.has(prevRotated) && prevRotated !== String(usedToken || '');
    const nextRotated = tokenReused
      ? String(rotatedValue || prevRotated || '')
      : rotatedValue || (prevUsable ? prevRotated : '');

    // 「磁盘上那份 token」= 我们**真的把档案那条线的那份发出去过**的那一份。
    //
    // 语义定清楚（这条是整条链不打架的关键）：`diskTokenUsed` 只表示「档案那条线
    // 我们走到哪了」。绝不能被轮换值带偏 —— 一旦它指向轮换值，下一轮就会看到
    // 「profile == diskTokenUsed」，于是放着新鲜 token 不用、或者反过来反复重新
    // 上膛把链子烧穿。判断「这次发的是不是档案那条线的」交给调用方（`sentDisk`），
    // 别用字符串相等去猜 —— 发出去的 token 跟档案上那份相等，恰恰说明它是档案那条线的。
    const diskUsed = sentDiskToken === true ? String(diskToken || '') : String(prev.diskTokenUsed || '');

    // ⚠️ `...prev` 不能省。record() 是逐次重建整条记录的，不带上旧字段就会
    // 把别人写的东西（rearm 留下的 broken/brokenAt/rearmedReason 等）在**每一次
    // 成功续期**之后悄悄抹掉 —— 表现是「刚自愈完，面板又显示已断链」。
    this.doc[key] = {
      ...prev,
      accountId: key,
      fullId: String(accountId || prev.fullId || ''),
      diskTokenUsed: diskUsed,
      rotatedToken: nextRotated,
      deadTokens: [...dead].slice(-40),
      // 发过、服务器认过（200）的 token。单次性的别重发；但**不等于**作废 ——
      // 服务器自己把同一份回给我们时不算用掉（见 tokenReused）。
      consumed: [...consumed].slice(-40),
      // 凭据为空时保留上一份：STS 偶尔回 200 但字段缺失，
      // 不要把手里还能用的那份 AK/SK 覆盖成空的。
      credential: credential?.accessKeyId ? credential : prev.credential || null,
      refreshExpiresAt: refreshExpiresAt || prev.refreshExpiresAt || 0,
      userName: userName || prev.userName || '',
      refreshedAt: Date.now(),
      count: (prev.count || 0) + 1,
      // 这一轮真换回来了 → 链子是活的，把「已断链」标记收掉。
      // 不收的话面板会一直显示红的，哪怕后面每次续期都成功。
      broken: false,
      brokenReason: '',
      brokenAt: 0,
    };
    this.save();
  }

  /**
   * 轮换冲突（STS5.1806）：这次发出去的那份 token 已经被用过了。
   *
   * 只把**被拒的那一份**拉黑，然后清掉轮换值。
   *
   * ⚠️ 以前这里把 lastUsedToken / rotatedToken / consumed 全删了 ——
   * 而 rotatedToken 恰恰是当时唯一还可能有效的东西。删完之后 pickToken
   * 又退回磁盘上那份 T0，而 T0 正是刚被拒的那个，于是永远卡在 1806 里出不来。
   * （README 里写的「下次会退回磁盘那份重新开始」不成立。）
   */
  breakChain(accountId, reason = '', rejectedToken = '') {
    const key = this._keyOf(accountId);
    const rec = this.doc[key];
    if (!rec) return false;

    const dead = new Set(rec.deadTokens || []);
    if (rejectedToken) dead.add(rejectedToken);
    rec.deadTokens = [...dead].slice(-40);
    // 被拒的那份从 consumed 里挪到 dead 里（dead 更权威，两条都留只会让人误读）
    if (rejectedToken && Array.isArray(rec.consumed)) {
      rec.consumed = rec.consumed.filter((t) => t !== rejectedToken);
    }

    // ⚠️ 只清「确实是它被拒了」的轮换值。
    //
    // 以前这里无条件 delete rec.rotatedToken —— 可 rotatedToken 往往正是
    // 当时唯一还有效的东西（被拒的是磁盘那份）。删了就等于自断后路。
    if (rejectedToken && rec.rotatedToken === rejectedToken) rec.rotatedToken = '';

    rec.broken = true;
    rec.brokenReason = reason;
    rec.brokenAt = Date.now();
    this.save();
    return true;
  }

  /**
   * 重新给续期链上膛：拿一份**新的** refresh_token 把整条链救回来。
   *
   * 什么时候需要它：refresh_token 是单次使用的。桌面端和我们各自轮换，
   * 撞一次 STS5.1806 之后手里能用的 token 就都没了，`pickToken` 会返回
   * `source: 'none'`，从此这个号只能重新登录 —— 而「重新登录」本来就会
   * 发一份新的 refresh_token 下来（自助登录、桌面端重登都是）。
   *
   * 新 token 是**新一轮授权周期**发出的，跟旧周期里被拉黑的那串完全不同，
   * 所以这里要把「作废」标记清掉；不清的话它会被 `pickToken` 里那条
   * `dead.has(token)` 一票否决，用户会觉得「重登了还是不能用」。
   *
   * 只改我们自己的 data/refresh-state.json，不碰 OfficeAce 的任何文件。
   */
  rearm(accountId, refreshToken, { reason = 'new-login', refreshExpiresAt = 0, previousDiskToken = '' } = {}) {
    const token = String(refreshToken || '').trim();
    if (!token) return { ok: false, error: '没有可用的 refresh_token' };
    const key = this._keyOf(accountId);
    const prev = this.doc[key] || {};

    // ⚠️ 这里**不能**把新 token 写进 diskTokenUsed。
    //
    // 那个字段的语义是「磁盘上那份**已经被我们消费掉**了」，而新 token 是
    // 一次都还没用过的。firstpass 版本就是把它写进去，结果 pickToken 一看
    // 「磁盘那份 == diskTokenUsed」就认定早被消费掉了，直接判 None ——
    // 上了膛却仍然报「token 都作废了」，正是踩的这个。
    //
    // 正确做法：锚点仍然指向**上一轮被消费掉的那份**（档案里那份，通常已经
    // 在死名单里）。新 token 跟锚点不一样、又不在死名单 → pickToken 走进
    // 「disk-renewed」分支，把新鲜那份发出去。
    const anchor = String(previousDiskToken || '').trim();

    this.doc[key] = {
      ...prev,
      accountId: key,
      fullId: String(accountId || prev.fullId || ''),
      diskTokenUsed: anchor || prev.diskTokenUsed || '',
      rotatedToken: '',
      // 不清死名单（旧周期那几份确实作废了）；只保证新 token 不在上面 ——
      // 它可能在上一次失败的尝试里被误拉黑过。
      deadTokens: (prev.deadTokens || []).filter((t) => t !== token),
      // 新周期的 token 没发过，别留在「已消费」名单里
      consumed: (prev.consumed || []).filter((t) => t !== token),
      refreshExpiresAt: refreshExpiresAt || prev.refreshExpiresAt || 0,
      broken: false,
      brokenReason: '',
      brokenAt: 0,
      rearmedAt: Date.now(),
      rearmedReason: reason,
    };
    this.save();
    if (process.env.OFFICEACE_DEBUG_PICK) {
      console.error('[rearm] 写入完成', {
        key,
        tokenTail: token.slice(-12),
        previousDiskTokenTail: String(previousDiskToken || '').slice(-12),
        writtenAnchorTail: String(anchor || prev.diskTokenUsed || '').slice(-12),
      });
    }
    log.info('续期链已重新上膛', { accountId: key, reason });
    return { ok: true, token };
  }

  /** 换回来的凭据还没过期的话，直接拿来用 */
  usableCredential(accountId, { skewMs = 120000 } = {}) {
    const rec = this.get(accountId);
    if (!rec?.credential?.accessKeyId) return null;
    const exp = Date.parse(rec.credential.expiresAt || '');
    if (!Number.isFinite(exp) || exp - Date.now() <= skewMs) return null;
    return rec.credential;
  }

  history(accountId) {
    const rec = this.get(accountId);
    return rec ? [{ at: rec.refreshedAt, count: rec.count, userName: rec.userName }] : [];
  }

  /**
   * 列出所有还养着一条有效续期凭据的账号。
   *
   * 用在哪：服务重启后内存里的「已续期」标记会清空，磁盘档案又是过期的旧凭据，
   * 面板会重新喊「已过期」——但其实 state 文件里明明有一套还能用的。
   * 启动时拿这个把内存补回去。
   */
  list() {
    const out = [];
    for (const [key, rec] of Object.entries(this.doc)) {
      if (!rec || typeof rec !== 'object') continue;
      const cred = rec.credential;
      if (!cred?.accessKeyId) continue;
      const exp = Date.parse(cred.expiresAt || '');
      if (!Number.isFinite(exp) || exp <= Date.now()) continue;
      out.push({
        accountId: key,
        credential: cred,
        expiresAt: exp,
        refreshedAt: rec.refreshedAt || 0,
        count: rec.count || 0,
        stale: !!rec.stale,
      });
    }
    return out.sort((a, b) => b.refreshedAt - a.refreshedAt);
  }

  forget(accountId) {
    if (this.doc[String(accountId)]) {
      delete this.doc[String(accountId)];
      this.save();
    }
  }
}

/* ============================================================ 主流程 */

export class CredentialRefresher {
  constructor({ state, config = {} } = {}) {
    this.state = state || new RefreshState('');
    this.tokenUrl = String(config.tokenUrl || DEFAULT_TOKEN_URL).trim();
    this.clientId = String(config.clientId || DEFAULT_CLIENT_ID).trim();
    this.timeoutMs = Math.max(3000, Number(config.timeoutMs) || 25000);
    this.rejectUnauthorized = config.rejectUnauthorized !== false;
    this.lastError = '';
  }

  /**
   * 给一个账号档案换新凭据。
   * @param {object} profile accounts.mjs 归一化后的 profile（需要 raw.dpop 和 refreshToken）
   * @param {object} [opts]
   * @param {string} [opts.accountId] 号池里的完整账号 ID（`<账号ID>:<用户ID>`）。
   *        不传就退回 profile.accountId —— 但多账号时务必显式传，否则会串档。
   * @returns {Promise<{ok:boolean, credential?:object, error?:string, errorCode?:string, rotated?:boolean}>}
   */
  async refresh(profile, opts = {}) {
    const dpop = profile?.raw?.dpop || profile?.dpop;
    const accountId = String(opts.accountId || profile?.accountId || '');
    const userId = profile?.userId || '';

    if (!profile?.refreshToken) {
      return { ok: false, error: '这个号没有 refresh_token，只能重新登录授权', errorCode: 'NO_REFRESH_TOKEN' };
    }
    if (!dpop?.privateJwk) {
      return { ok: false, error: '这个号没有 DPoP 私钥，无法续期', errorCode: 'NO_DPOP_KEY' };
    }
    const exp = profile.refreshExpiresAt || 0;
    if (exp && exp <= Date.now()) {
      return { ok: false, error: 'refresh_token 本身也过期了，需要重新登录授权', errorCode: 'REFRESH_EXPIRED' };
    }

    const pick = this.state.pickToken(accountId, profile.refreshToken);
    if (!pick.token) {
      // 磁盘那份和轮换那份都已经确认作废了。再拿它们去撞只会换来一串 1806，
      // 所以直接说清楚：这个号得重新登录一次。
      return {
        ok: false,
        error: 'refresh_token 已经全部作废（磁盘那份和轮换那份都被用过了），需要重新登录一次 OfficeAce 或走一遍自助登录',
        errorCode: 'NO_USABLE_TOKEN',
      };
    }

    let dpopJwt;
    try {
      dpopJwt = await generateDpopProof(dpop.privateJwk, dpop.publicJwk, 'POST', this.tokenUrl);
    } catch (err) {
      return { ok: false, error: `签名 DPoP proof 失败：${err.message}`, errorCode: 'DPOP_FAIL' };
    }

    const body = new URLSearchParams({
      client_id: this.clientId,
      grant_type: 'refresh_token',
      refresh_token: pick.token,
    }).toString();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    let text;
    try {
      res = await fetch(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: dpopJwt },
        body,
        signal: ctrl.signal,
      });
      text = await res.text();
    } catch (err) {
      clearTimeout(timer);
      const msg = err.name === 'AbortError' ? `请求超时（${this.timeoutMs}ms）` : err.message;
      this.lastError = msg;
      return { ok: false, error: `续期请求失败：${msg}`, errorCode: 'NETWORK' };
    } finally {
      clearTimeout(timer);
    }

    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }

    if (!res.ok || !json?.credentials) {
      const code = String(json?.error_code || json?.error || res.status || '');
      const msg = String(json?.error_msg || json?.error_description || text || '').slice(0, 300);
      this.lastError = `${code} ${msg}`.trim();

      // 轮换冲突：这份 token 已经被用过了，把它拉黑，下次用别的
      if (USED_TOKEN_CODES.some((c) => code.includes(c))) {
        this.state.breakChain(accountId, code, pick.token);
        return {
          ok: false,
          error: `refresh_token 已被使用过（${code}）。已经换用下一份；如果还失败就得重新登录一次 OfficeAce`,
          errorCode: 'TOKEN_CONSUMED',
        };
      }
      return {
        ok: false,
        error: `续期被拒：${code || 'HTTP ' + res.status}${msg ? ' · ' + msg : ''}`,
        errorCode: code || 'HTTP_' + res.status,
      };
    }

    const c = json.credentials;
    const credential = {
      accessKeyId: String(c.access_key_id || ''),
      secretAccessKey: String(c.secret_access_key || ''),
      securityToken: String(c.security_token || ''),
      projectId: String(c.project_id || profile.projectId || ''),
      expiresAt: String(c.expiration || ''),
    };
    // 先把 token 轮换落盘，**再**判凭据字段完不完整。
    //
    // 顺序反了会留下一个很难查的坑：STS 明明已经轮换并作废了旧 token，
    // 而我们因为「返回里没有 AK/SK」提前 return 了，新 token 一个字节都没存 ——
    // 旧的废了、新的丢了，链子就此永久断掉。
    // （record 内部对空凭据有保护，不会把上一份好的覆盖掉。）
    const claims = idTokenClaims(json.id_token);
    // 服务器是把**同一份** token 回给我们的吗？—— 是的话它没被用掉，
    // 别进 consumed 名单（否则下次真需要它的时候又挑不出来）。
    const tokenReused = !!pick.token && (!json.refresh_token || String(json.refresh_token) === String(pick.token));
    this.state.record(accountId, {
      usedToken: pick.token,
      diskToken: profile.refreshToken,
      rotatedToken: json.refresh_token || pick.token,
      tokenReused,
      // 这次发的是**档案那条线**的那份吗？（disk-renewed / disk-last-resort 才是）
      sentDiskToken: pick.source === 'disk' || pick.source === 'disk-renewed' || pick.source === 'disk-last-resort',
      credential,
      refreshExpiresAt: json.refresh_expires_at ? Date.parse(json.refresh_expires_at) : (exp || 0),
      userName: claims.userName || profile.userName || '',
    });

    if (!credential.accessKeyId || !credential.secretAccessKey) {
      return {
        ok: false,
        error: '续期返回里没有 AK/SK（token 已经更新好了，下一轮可以接着用）',
        errorCode: 'EMPTY_CREDENTIAL',
      };
    }

    log.info('凭据续期成功', {
      accountId: accountId || userId,
      tokenSource: pick.source,
      expiresAt: credential.expiresAt,
      rotated: !!json.refresh_token && json.refresh_token !== pick.token,
    });

    return {
      ok: true,
      credential,
      rotated: !!json.refresh_token && json.refresh_token !== pick.token,
      userName: claims.userName || profile.userName || '',
      expiresAt: credential.expiresAt,
    };
  }
}

/**
 * 把续期拿到的凭据套回账号档案上，产出「等效 profile」。
 * 面板和号池看到的就是这个 —— 磁盘上的原始档案保持不动。
 */
export function overlayCredential(profile, credential) {
  if (!credential) return profile;
  const exp = Date.parse(credential.expiresAt || '');
  return {
    ...profile,
    accessKeyId: credential.accessKeyId,
    secretAccessKey: credential.secretAccessKey,
    securityToken: credential.securityToken,
    projectId: credential.projectId || profile.projectId,
    expiresAt: Number.isFinite(exp) ? exp : profile.expiresAt,
    refreshed: true,
    originalExpiresAt: profile.expiresAt,
  };
}
