/**
 * 账号凭据搬运包（换电脑用）
 *
 * 目标：换一台电脑时不用挨个重新登录 —— 在旧机器上导出一个文件，拷到新机器导入即可。
 *
 * 这件事能成立的关键，是搞清楚「一个号到底是靠什么活着的」。号在磁盘上散落在几处：
 *
 *   ① `data/oauth-accounts.json`   自助登录落盘的档案：baseUrl + Authorization（Basic，
 *                                  长期有效）+ refresh_token（一次性，用于续期）
 *                                  + DPoP 私钥（续期时签 proof，缺了就只能重登）
 *   ② `data/refresh-state.json`    续期链状态：token 一次性轮换，这里记着「哪一份发过了
 *                                  （consumed/deadTokens）、下一份该发哪个（rotatedToken）」，
 *                                  还有换回来的临时 AK/SK
 *   ③ `data/accounts.json`         只是元数据：别名 / 停用 / 忽略名单
 *   ④ 本机 OfficeAce 安装目录里的文件 —— **别人的文件**，只读；里面是同一套东西
 *
 * 所以搬运包必须同时带走 ①②③。只搬 Authorization 的话，新机器能转发、但读不到积分
 * （积分要临时 AK/SK，而 AK/SK 要 refresh_token 去换）；只搬 refresh_token 的话，
 * 新机器不认这条链（diskTokenUsed 锚点不在），会拿已经用过的那份去撞 1806。
 *
 * ⚠️ 一次性 token 的硬约束（这是本功能唯一真正的坑）：
 *   refresh_token 是单次使用 + 轮换的。导出 = 把「当前这条链」复制一份给新机器。
 *   两台机器同时跑，谁先续期谁就把那份 token 用掉了，另一个下次必撞 STS5.1806
 *   （面板上显示「已断链」），而且**两边都会退化成需要重新登录**。
 *   所以正确用法是：导出之后把旧机器上的这个号停掉（或整机 stop.cmd），
 *   让它别再去续期。这条警告在 CLI、面板、文档里都要出现。
 *
 * 本模块只做纯逻辑（不读写文件、不联网），读写与权限交给调用方 —— 这样
 * `tools/test-account-bundle.mjs` 能把它整条链路测干净。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { trimSlash } from './util.mjs';

export const BUNDLE_KIND = 'officeace2api/accounts-bundle';
// 只在文件内用（导出会给 tools/test-exports.mjs 判成"没人用的导出"，那条守卫是真有用的）
const BUNDLE_VERSION = 1;

/** 一次性 token 的警告，CLI / 面板 / 文档共用同一句话，避免说法不一致 */
export const ONE_TIME_TOKEN_WARNING =
  'refresh_token 是一次性的：导入新机器后，旧机器请别再让它续期（停掉这个号或整机 stop.cmd），' +
  '否则两台机器抢同一份 token 会撞 STS5.1806，两边都得重新登录。';

/* ------------------------------------------------------------------ 收集 */

/**
 * 临时 AK/SK 只有 24 小时。已经过期（或只剩几分钟）的就别搬了 ——
 * 搬过去也用不上，反而会让面板显示一个"看起来有凭据"的号。
 */
function liveCredential(cred, now) {
  if (!cred || !cred.accessKeyId) return null;
  const exp = Date.parse(cred.expiresAt || '') || 0;
  if (exp && exp - now < 5 * 60 * 1000) return null;
  return {
    accessKeyId: cred.accessKeyId,
    secretAccessKey: cred.secretAccessKey || '',
    securityToken: cred.securityToken || '',
    projectId: cred.projectId || '',
    expiresAt: cred.expiresAt || '',
  };
}

/** 从 refresh-state.json 里挑出这个号那条链（键可能是短 ID，也可能是全 ID） */
function pickRefresh(refreshDoc, accountId, fullId) {
  if (!refreshDoc) return null;
  const keys = [accountId, fullId].filter(Boolean).map(String);
  let rec = null;
  for (const k of keys) {
    if (refreshDoc[k]) {
      rec = refreshDoc[k];
      break;
    }
  }
  if (!rec) {
    const short = String(accountId || '').split(':')[0];
    for (const [k, v] of Object.entries(refreshDoc)) {
      if (k === short || k.startsWith(`${short}:`) || String(fullId || '').startsWith(k)) {
        rec = v;
        break;
      }
    }
  }
  if (!rec) return null;
  return {
    diskTokenUsed: String(rec.diskTokenUsed || ''),
    rotatedToken: String(rec.rotatedToken || ''),
    // 死名单 / 已用名单是"安全集合"，只能变大不能变小 —— 搬过去必须一起带上，
    // 否则新机器会把一份早就被服务器拒过的 token 再发一次。
    deadTokens: Array.isArray(rec.deadTokens) ? rec.deadTokens.slice(-40) : [],
    consumed: Array.isArray(rec.consumed) ? rec.consumed.slice(-40) : [],
    // 这条链是不是已经判死了（服务器拒过、只能重新登录）。
    // 导出的取舍要用到它：档案里那份死了、扫盘却有份活的，就该带上活的那份。
    broken: rec.broken === true,
    refreshExpiresAt: Number(rec.refreshExpiresAt) || 0,
    userName: rec.userName || '',
    count: Number(rec.count) || 0,
    refreshedAt: Number(rec.refreshedAt) || 0,
    broken: rec.broken === true,
  };
}

/**
 * 把「这台机器上所有能搬的号」整理成一个数组。
 *
 * @param {object}   p
 * @param {Array}    p.accounts     号池记录（AccountStore.list() 的结果，已扫描）
 * @param {object}   p.oauthDoc     data/oauth-accounts.json 的内容
 * @param {object}   p.refreshDoc   data/refresh-state.json 的内容
 * @param {object}   p.meta         data/accounts.json 的内容（disabled / labels）
 * @param {number}   p.now
 */
export function collectAccounts({ accounts = [], oauthDoc = {}, refreshDoc = {}, meta = {}, now = Date.now() } = {}) {
  const disabled = new Set(meta.disabled || []);
  const labels = meta.labels || {};
  const out = new Map();

  // ① 自助登录的档案优先：它是**唯一**带 refresh_token + DPoP 私钥的来源，
  //    也就是"新机器完全不用重登"这件事的全部依据。
  for (const [id, rec] of Object.entries(oauthDoc || {})) {
    if (!rec || typeof rec !== 'object') continue;
    const authorization = String(rec.authorization || '');
    const baseUrl = trimSlash(rec.baseUrl || '');
    if (!authorization || !baseUrl) continue; // 半截档案，搬过去也用不了
    out.set(id, {
      id,
      kind: 'oauth',
      label: labels[id] || rec.label || rec.userName || '',
      userName: rec.userName || '',
      accountId: rec.accountId || String(id).split(':')[0] || '',
      userId: rec.userId || String(id).split(':')[1] || '',
      baseUrl,
      authorization,
      createdAt: Number(rec.createdAt) || 0,
      refreshToken: String(rec.refreshToken || ''),
      dpopPrivateJwk: rec.dpopPrivateJwk || null,
      dpopPublicJwk: rec.dpopPublicJwk || null,
      credential: liveCredential(rec.credential, now),
      refresh: pickRefresh(refreshDoc, rec.accountId, id),
      disabled: disabled.has(id),
    });
  }

  // ② 号池里剩下的：手工导入的（meta.imported 会在这里出现）、以及本机 OfficeAce
  //    文件里发现的号。它们没有 refresh_token，但 baseUrl + Authorization 是长期有效的
  //    （Basic 鉴权，不会过期），所以搬过去至少能**直接转发**，只是积分/续期得重新登录。
  for (const acc of accounts || []) {
    if (!acc || !acc.id) continue;
    if (out.has(acc.id)) {
      // 档案里已经有这个号：只补别名/停用状态，别用池子里的临时凭据覆盖档案
      const e = out.get(acc.id);
      if (!e.label) e.label = labels[acc.id] || acc.label || '';
      e.disabled = e.disabled || disabled.has(acc.id);
      // 但 `refresh_token` 有一条例外：档案里那份**已经作废**、而扫盘（OfficeAce 自己的
      // 存储）手里还有一份我们从没见过、也没作废过的 —— 就用它的。
      //
      // 为什么会这样：OfficeAce 客户端和本服务会抢同一条链（一次性 token，谁先用谁赢）。
      // 客户端赢了之后，它自己那份是活的，我们档案里那份进了黑名单。
      // 这时候导出如果照抄档案，包到新机器上必然续不上 —— 用户白重登一次，而这正是
      // 「换电脑」要消灭的事。实测踩到过：某个号的档案 token 已 1806 作废，
      // profile 里那份却是好的，导出的包会带着死的那条。
      const live = String(acc.profile?.refreshToken || '');
      if (e.refreshToken && live && live !== e.refreshToken) {
        const r = e.refresh || {};
        const bad = new Set([...(r.deadTokens || []), ...(r.consumed || [])]);
        const ours = new Set([r.diskTokenUsed, r.rotatedToken].filter(Boolean));
        // **只在本机这条链彻底没救时**才换，两个前提缺一不可：
        //   ① broken === true 且手里没有下一份（rotatedToken）—— 自己还能续，就别去动客户的链；
        //   ② 扫盘那份既不在死名单、也不是我们用过的（否则换过去照样 1806）。
        // 收紧到这里是因为放宽版会误伤："档案 token 虽然在 consumed 里，但我们手里还有
        // 一份没用的 rotatedToken"，这时候它本来就能续，换客户端的 token 反而会去烧客户端的链。
        const hopeLost = r.broken === true && !r.rotatedToken && !ours.has(live);
        const archiveUnusable = bad.has(e.refreshToken) || r.broken === true;
        if (hopeLost && archiveUnusable && !bad.has(live)) {
          e.refreshToken = live;
          e.refreshTokenFrom = 'profile'; // 排查用：这条是从扫盘那份捡回来的
          if (!e.dpopPrivateJwk) e.dpopPrivateJwk = acc.profile?.raw?.dpop?.privateJwk || null;
          if (!e.dpopPublicJwk) e.dpopPublicJwk = acc.profile?.raw?.dpop?.publicJwk || null;
        }
      }
      continue;
    }
    const cred = (acc.credentials || []).find((c) => c && c.authorization && c.baseUrl);
    if (!cred) continue;
    out.set(acc.id, {
      id: acc.id,
      kind: 'manual',
      label: labels[acc.id] || acc.label || '',
      userName: acc.userName || acc.profile?.userName || '',
      accountId: acc.accountId || acc.profile?.accountId || String(acc.id).split(':')[0] || '',
      userId: acc.userId || acc.profile?.userId || String(acc.id).split(':')[1] || '',
      baseUrl: trimSlash(cred.baseUrl),
      authorization: String(cred.authorization),
      createdAt: Number(acc.lastSeenAt) || 0,
      refreshToken: String(acc.profile?.refreshToken || ''),
      dpopPrivateJwk: acc.profile?.raw?.dpop?.privateJwk || null,
      dpopPublicJwk: acc.profile?.raw?.dpop?.publicJwk || null,
      credential: liveCredential(acc.profile, now) || null,
      refresh: pickRefresh(refreshDoc, acc.accountId || acc.profile?.accountId, acc.id),
      disabled: disabled.has(acc.id),
      // 说明这条是从哪儿来的，导入端可以据此提示"只能转发，积分要重新登录"
      from: (acc.sources || []).join('+') || 'unknown',
    });
  }

  return [...out.values()];
}

/** 给 CLI / 面板看的摘要（不打印任何密钥） */
export function summarizeAccounts(accounts) {
  const oauth = accounts.filter((a) => a.kind === 'oauth').length;
  return {
    total: accounts.length,
    oauth,
    manual: accounts.length - oauth,
    withRefresh: accounts.filter((a) => a.refreshToken || a.refresh).length,
    withDpop: accounts.filter((a) => a.dpopPrivateJwk).length,
    withLiveCredential: accounts.filter((a) => a.credential).length,
    // 导入后真的能自动续期/读积分的：需要 token + DPoP 两样都在（判据同 mergeBundle）
    renewable: accounts.filter((a) => a.refreshToken && a.dpopPrivateJwk).length,
  };
}

/* ------------------------------------------------------------------ 打包 */

/** 明文包额外要顶上来的那句警告（加密包里看不到，因为整个 body 都在密文里） */
export const PLAINTEXT_WARNING =
  '这个文件是**明文**：长期 Basic 鉴权 + 一次性 refresh_token + DPoP 私钥都在里面，' +
  '等同于账号本身。别发群、别进仓库，导入完就删掉。';

/**
 * 组装搬运包。`pass` 给了就整包加密（推荐：里面有长期有效的 Basic 凭据和一次性 token）。
 */
export function buildBundle({ accounts, appVersion = '', host = '', user = '', now = Date.now() } = {}, { pass = '' } = {}) {
  const list = Array.isArray(accounts) ? accounts : [];
  const body = {
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    createdAt: now,
    createdAtText: formatTime(now),
    app: String(appVersion || ''),
    host: String(host || ''),
    user: String(user || ''),
    source: `${host || 'this-pc'}${user ? `\\${user}` : ''}`,
    stats: summarizeAccounts(list),
    // 明文包里把"这是明文"顶在最前面；加密包外层只留一句"已加密"
    warning: pass ? ONE_TIME_TOKEN_WARNING : `${PLAINTEXT_WARNING}\n${ONE_TIME_TOKEN_WARNING}`,
    plaintext: !pass,
    accounts: list,
  };
  if (!pass) return body;
  return encryptBundle(body, pass);
}

export function formatTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ------------------------------------------------------- 加密 / 解密 */

// scrypt 参数：N=2^15 约 32MB 内存、本机 ~100ms。口令是给人手输的，
// 所以宁可慢一点，也别让拷贝出去的文件被离线爆破。
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

function deriveKey(pass, salt, kdf = SCRYPT) {
  return scryptSync(String(pass), salt, 32, {
    N: Number(kdf.N) || SCRYPT.N,
    r: Number(kdf.r) || SCRYPT.r,
    p: Number(kdf.p) || SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
}

// AAD 把「这是哪个格式、第几版」绑进认证标签：改了版本号（或换了用途）解密就失败。
// 版本号取自**外层信封**，所以它也在保护范围内 —— 一个被改成 v99 的包不会解出一堆
// 半截数据，而是直接报认证失败。
const aad = (version = BUNDLE_VERSION) => Buffer.from(`${BUNDLE_KIND}/${Number(version) || BUNDLE_VERSION}`, 'utf8');

export function encryptBundle(obj, pass) {
  if (!pass) throw new Error('加密需要一个口令');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(pass, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  // AAD 把「这是哪个格式、第几版」绑进认证标签：改了版本号或换了格式解密就失败，
  // 免得一串同口令的密文在别的用途里被拿来当本包用。
  cipher.setAAD(aad());
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj), 'utf8')), cipher.final()]);
  return {
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    encrypted: true,
    cipher: 'aes-256-gcm',
    kdf: { name: 'scrypt', salt: salt.toString('base64'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ct.toString('base64'),
    createdAt: obj?.createdAt || Date.now(),
    createdAtText: obj?.createdAtText || formatTime(Date.now()),
    source: obj?.source || '',
    stats: obj?.stats || null,
    // 外层已经写着 encrypted:true，就别再挂着"这是明文"那句 —— 只留一次性 token 的提醒
    warning: obj?.plaintext ? ONE_TIME_TOKEN_WARNING : obj?.warning || ONE_TIME_TOKEN_WARNING,
  };
}

export function decryptBundle(doc, pass) {
  if (!doc || doc.encrypted !== true) return doc;
  if (!pass) {
    const err = new Error('这个文件加了密，需要口令');
    err.code = 'NEED_PASS';
    throw err;
  }
  let key;
  try {
    key = deriveKey(pass, Buffer.from(String(doc.kdf?.salt || ''), 'base64'), doc.kdf || SCRYPT);
  } catch {
    const err = new Error('口令参数损坏（kdf 段读不出来）');
    err.code = 'BAD_KDF';
    throw err;
  }
  const iv = Buffer.from(String(doc.iv || ''), 'base64');
  const tag = Buffer.from(String(doc.tag || ''), 'base64');
  const ct = Buffer.from(String(doc.ciphertext || ''), 'base64');
  if (iv.length !== 12 || tag.length !== 16 || !ct.length) {
    const err = new Error('文件不完整（iv / tag / 密文有一项缺失）');
    err.code = 'TRUNCATED';
    throw err;
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad(doc.version));
  decipher.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // GCM 校验失败只有两种可能：口令错，或者文件被改过。两者对用户是同一句话。
    const err = new Error('口令不对（或者这个文件被改动过）');
    err.code = 'BAD_PASS';
    throw err;
  }
  return JSON.parse(plain);
}

/* ------------------------------------------------------------------ 解析 */

/**
 * 解析一个搬运包。支持三种输入：
 *   ① 本服务导出的包（明文 / 加密）
 *   ② 直接拖进来的 `data/oauth-accounts.json`（用户很容易顺手拷这个）
 *   ③ 直接拖进来的 `data/accounts.json`（只有元数据，没有凭据 → 明确报错，别假装成功）
 */
export function parseBundle(input, { pass = '' } = {}) {
  let doc = input;
  if (typeof input === 'string') {
    const text = input.replace(/^\uFEFF/, '').trim();
    if (!text) throw new Error('文件是空的');
    try {
      doc = JSON.parse(text);
    } catch {
      throw new Error('这不是一个 JSON 文件（可能拷坏了，或者拿错了文件）');
    }
  }
  if (!doc || typeof doc !== 'object') throw new Error('文件内容不是一个对象');

  if (doc.encrypted === true) {
    if (doc.kind && doc.kind !== BUNDLE_KIND) {
      throw new Error(`不认识的加密文件（kind=${String(doc.kind).slice(0, 40)}）`);
    }
    // 版本先判：新版本导出的包，用旧程序解会是"认证失败"（AAD 里带版本号），
    // 那句话对用户毫无信息量。先给出能看懂的结论。
    if (Number(doc.version) > BUNDLE_VERSION) {
      throw new Error(`这个包是更新版本导出的（v${doc.version}），当前程序只认到 v${BUNDLE_VERSION}，请升级`);
    }
    doc = decryptBundle(doc, pass);
  }

  if (doc.kind === BUNDLE_KIND) {
    if (Number(doc.version) > BUNDLE_VERSION) {
      throw new Error(`这个包是更新版本导出的（v${doc.version}），当前程序只认到 v${BUNDLE_VERSION}，请升级`);
    }
    const accounts = Array.isArray(doc.accounts) ? doc.accounts : [];
    if (!accounts.length) throw new Error('包里没有任何账号');
    return { ...doc, accounts, legacy: false };
  }

  // ② 老格式兜底：直接是 {id: record} 的 oauth-accounts.json
  const values = Object.values(doc);
  const looksOauth =
    values.length > 0 &&
    values.every((v) => v && typeof v === 'object' && !Array.isArray(v)) &&
    values.some((v) => v.refreshToken || v.authorization);
  if (looksOauth) {
    const accounts = collectAccounts({ oauthDoc: doc });
    if (!accounts.length) throw new Error('这个文件里没有可用的凭据（缺 authorization / baseUrl）');
    return {
      kind: BUNDLE_KIND,
      version: BUNDLE_VERSION,
      createdAt: Date.now(),
      createdAtText: formatTime(Date.now()),
      legacy: true,
      note: '这是直接拷来的 data/oauth-accounts.json，已经按账号档案导入（不带别名/停用状态）。',
      accounts,
      stats: summarizeAccounts(accounts),
    };
  }

  if (doc.labels || doc.disabled || doc.imported) {
    throw new Error('这是 data/accounts.json（只有别名和启停状态，没有凭据）。换电脑要导的是导出文件，不是它');
  }
  throw new Error('认不出这个文件。请选择本服务导出的 officeace2api-accounts-*.json');
}

/* ------------------------------------------------------------------ 合并 */

/**
 * 把包里的账号并进目标机的三份数据（纯函数，调用方负责落盘）。
 *
 * 续期链的合并规则（唯一容易搞错的地方）：
 *   · `deadTokens` / `consumed` 取**并集** —— 它们是安全集合，少了就会重发死 token。
 *   · `diskTokenUsed` / `rotatedToken`：**本机已有活链就不动它**。
 *     本机的链是"正在用"的那条；被导入的那条是另一台机器上的副本，通常是同一份
 *     token 的兄弟副本。用导入值覆盖会让本机两条线互相打架（就是 STS5.1806 的来源）。
 *     只有本机那条已经断了（broken / 两份都没有 / 全在死名单里）时才采纳导入的链
 *     —— 这正是"旧机器上救不回来，新机器上接着用"的场景。
 */
export function mergeBundle(bundle, { oauthDoc = {}, refreshDoc = {}, meta = {}, knownIds = null } = {}) {
  const nextOauth = { ...(oauthDoc || {}) };
  const nextRefresh = { ...(refreshDoc || {}) };
  const nextMeta = {
    labels: { ...(meta.labels || {}) },
    disabled: Array.isArray(meta.disabled) ? [...meta.disabled] : [],
    ignored: Array.isArray(meta.ignored) ? [...meta.ignored] : [],
    imported: Array.isArray(meta.imported) ? [...meta.imported] : [],
    order: Array.isArray(meta.order) ? [...meta.order] : [],
  };
  const disabled = new Set(nextMeta.disabled);
  const results = [];

  for (const e of bundle.accounts || []) {
    if (!e || !e.id || !e.authorization || !e.baseUrl) {
      results.push({ id: e?.id || '', action: 'skipped', reason: '缺 id / baseUrl / authorization' });
      continue;
    }
    const id = String(e.id);
    const existed = !!nextOauth[id] || nextMeta.imported.some((x) => x && x.id === id);
    let actionOverride = '';

    // 能不能写成「完整档案」= 能不能续期：需要 refresh_token（发出去）+ DPoP 私钥（签 proof）。
    // ⚠️ 判据是能力，不是 `kind`。扫盘发现的号也可能带着这两样（凭据来自本机安装文件），
    // 那种号在新机器上就该是完整档案，而不是降级成"只能转发"。
    const canArchive = !!(e.refreshToken && e.dpopPrivateJwk);

    if (canArchive) {
      // 档案：本机已有的那份如果自带更新的 createdAt，保留本机的 —— 两台机器都登过的号，
      // 时间更新的那份才是"现在生效的那次授权"。
      const prev = nextOauth[id];
      const prevAt = Number(prev?.createdAt) || 0;
      const incomingAt = Number(e.createdAt) || 0;
      const takeIncoming = !prev || incomingAt >= prevAt || !prev.refreshToken;
      if (takeIncoming) {
        nextOauth[id] = {
          id,
          label: e.label || prev?.label || '',
          accountId: e.accountId || String(id).split(':')[0] || '',
          userId: e.userId || String(id).split(':')[1] || '',
          userName: e.userName || '',
          baseUrl: trimSlash(e.baseUrl),
          authorization: String(e.authorization),
          createdAt: incomingAt || Date.now(),
          credential: e.credential || null,
          refreshToken: String(e.refreshToken),
          dpopPrivateJwk: e.dpopPrivateJwk || null,
          dpopPublicJwk: e.dpopPublicJwk || null,
        };
      }
    } else {
      // 不能续期的号（缺 refresh_token 或 DPoP 私钥）：并进 meta.imported，
      // 这样即使新机器上没装 OfficeAce，也能直接转发。
      //
      // ⚠️ 但"本机本来就能发现这个号"的时候不要登记 —— 实测把包导回导出它的那台机器，
      // 每个扫出来的号都会多一条 imported 记录，同一个号就有了两个身份：
      // 面板上看着一样，`remove()` 里 `sources.length===1 && sources[0]==='imported'`
      // 的判据却会因此改变（该能真删的变成只能忽略）。所以先问 knownIds。
      const inImported = nextMeta.imported.some((x) => x && x.id === id);
      const knownHere = !!(knownIds && typeof knownIds.has === 'function' && knownIds.has(id));
      if (knownHere && !inImported) {
        // 本机扫盘就能发现它：不登记，只标记成 already-present（续期链照样往下并）
        actionOverride = 'already-present';
      } else {
        const rec = {
          id,
          label: e.label || '',
          baseUrl: trimSlash(e.baseUrl),
          authorization: String(e.authorization),
          expiresAt: 0,
        };
        const idx = nextMeta.imported.findIndex((x) => x && x.id === id);
        if (idx >= 0) nextMeta.imported[idx] = { ...nextMeta.imported[idx], ...rec };
        else nextMeta.imported.push(rec);
      }
    }

    if (e.label) nextMeta.labels[id] = e.label;

    // 停用状态：导入的停用要认，但本机手动启用的不因为包里是停用就再停一次
    if (e.disabled === true) disabled.add(id);

    // 续期链
    let refreshNote = '';
    if (e.refresh && (e.refresh.rotatedToken || e.refresh.diskTokenUsed)) {
      const key = refreshKeyFor(nextRefresh, id, e.accountId);
      const prev = nextRefresh[key];
      const dead = new Set([...(prev?.deadTokens || []), ...(e.refresh.deadTokens || [])]);
      const consumed = new Set([...(prev?.consumed || []), ...(e.refresh.consumed || [])]);
      // 本机那条链是不是「还活着」：有轮换值、没被拉黑、也没被标成断了。
      // 只有这一种情况才拒绝采纳导入的锚点 —— 见上面的合并规则（diskTokenUsed 那段）。
      const prevRotated = String(prev?.rotatedToken || '');
      const localAlive = !!prev && prev.broken !== true && !!prevRotated && !dead.has(prevRotated);
      const next = {
        ...(prev || {}),
        accountId: prev?.accountId || String(e.accountId || id.split(':')[0]),
        fullId: prev?.fullId || id,
        deadTokens: [...dead].slice(-40),
        consumed: [...consumed].slice(-40),
        // 只有本机没有活链时才采纳导入的锚点 / 轮换值
        diskTokenUsed: localAlive ? String(prev?.diskTokenUsed || '') : String(e.refresh.diskTokenUsed || ''),
        rotatedToken: localAlive ? String(prev?.rotatedToken || '') : String(e.refresh.rotatedToken || ''),
        refreshExpiresAt: Math.max(Number(prev?.refreshExpiresAt) || 0, Number(e.refresh.refreshExpiresAt) || 0),
        userName: prev?.userName || e.refresh.userName || e.userName || '',
        refreshedAt: Math.max(Number(prev?.refreshedAt) || 0, Number(e.refresh.refreshedAt) || 0),
        count: Math.max(Number(prev?.count) || 0, Number(e.refresh.count) || 0),
        // 本机那条要是断的，导入把它救活了 —— 标记要一起收掉
        broken: localAlive ? prev?.broken === true : false,
        brokenReason: localAlive ? prev?.brokenReason || '' : '',
        brokenAt: localAlive ? Number(prev?.brokenAt) || 0 : 0,
      };
      if (localAlive) refreshNote = 'kept-local-chain';
      nextRefresh[key] = next;
    } else if (e.refreshToken && !nextRefresh[refreshKeyFor(nextRefresh, id, e.accountId)]) {
      // 档案里有 token，但包里没带链（老版本导出的）：至少把 token 记成"磁盘那份"，
      // 让新机器第一次续期时有个起点，而不是直接判 none 去重新登录。
      nextRefresh[refreshKeyFor(nextRefresh, id, e.accountId)] = {
        accountId: String(e.accountId || id.split(':')[0]),
        fullId: id,
        diskTokenUsed: '',
        rotatedToken: '',
        deadTokens: [],
        consumed: [],
        refreshExpiresAt: 0,
        userName: e.userName || '',
        refreshedAt: 0,
        count: 0,
        broken: false,
        importedAt: Date.now(),
      };
      refreshNote = 'seeded';
    }

    results.push({
      id,
      label: e.label || '',
      kind: e.kind === 'oauth' ? 'oauth' : 'manual',
      // 'already-present' = 本机能发现这个号，所以没有重复登记（见上面 manual 分支）
      action: actionOverride || (existed ? 'updated' : 'added'),
      refresh: refreshNote,
      // 导入之后真的能不能自动续期：取决于它是不是进了完整档案
      canRenew: canArchive,
      hint: actionOverride === 'already-present'
        ? '本机本来就能发现这个号，没有重复登记'
        : canArchive ? '' : '只能转发；积分/续期需要在这个号上重新登录一次',
    });
  }

  nextMeta.disabled = [...disabled];
  return { oauthDoc: nextOauth, refreshDoc: nextRefresh, meta: nextMeta, results };
}

/** 找到这个号在 refresh-state 里该用的键（保持和 RefreshState._keyOf 一致的语义） */
export function refreshKeyFor(refreshDoc, fullId, accountId) {
  const full = String(fullId || '');
  const short = String(accountId || full.split(':')[0] || '');
  if (full && refreshDoc[full]) return full;
  if (short && refreshDoc[short]) return short;
  // 已经有以短 ID 为前缀的记录 → 沿用它，别为同一个号存出第二条
  for (const k of Object.keys(refreshDoc)) {
    if (full && (full.startsWith(k) || k.startsWith(full))) return k;
  }
  return short || full;
}

/* ------------------------------------------------------------------ 文件名 */

/** `officeace2api-accounts-DESKTOP-1234-20261019-1120.json` */
export function bundleFileName({ host = '', now = Date.now(), encrypted = false, prefix = 'officeace2api-accounts' } = {}) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const safeHost = String(host || 'this-pc').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 24) || 'this-pc';
  return `${prefix}-${safeHost}-${stamp}${encrypted ? '-locked' : ''}.json`;
}
