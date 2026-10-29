/**
 * 号池：把本机（以及手工导入的）OfficeAce / 华为云账号聚合成一等公民
 *
 * 一个账号在磁盘上散落在三处，这里把它们拼成一条记录：
 *   1. <root>/.jiuwenclaw/config/routing_state/users/<账号ID>/models.json
 *        → 上游网关地址 + Authorization（Basic base64(AK:SK)）
 *   2. <install>/packages/api/.config/secure-config-nodejs/oauth-<账号ID>.json
 *        → 加密的 OAuth 档案：临时 AK/SK/security_token/过期时间/区域
 *          （用 .oauth-profile-encryption-key 解密，链路见 huawei-oauth.js）
 *   3. <root>/users/<账号ID>/model.json
 *        → 该账号能用的模型目录
 *
 * 账号 ID 是「<主账号ID>:<子用户ID>」URL 编码后的目录名，解开就是身份。
 *
 * 面板可编辑的元数据（别名 / 启用开关 / 手工导入项）单独存 data/accounts.json，
 * 不动 OfficeAce 自己的文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLogger } from './logger.mjs';
import { listDirs, readJson, trimSlash, maskSecret, home, writeFileAtomic, lockDownFile, isMachineScanEnabled } from './util.mjs';
import { readProtectedText, dpapiStatus } from './dpapi.mjs';

const log = createLogger('accounts');

const SECURE_DIR = path.join('packages', 'api', '.config', 'secure-config-nodejs');

// 同一秒里的重复扫描合并掉。见 scan() 里的说明。
const SCAN_COALESCE_MS = 1000;

// 「扫完什么都没有变」这件事最多隔这么久往 DEBUG 里留一条心跳，
// 免得面板「全部」档被同一句话糊住。真要看出扫描还活着，看 lastScanAt 更直接
// （/admin/api/state 里就有）。
const SCAN_HEARTBEAT_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------ 工具 */

function decodeUserId(dirName) {
  try {
    return decodeURIComponent(dirName);
  } catch {
    return dirName;
  }
}

function shortId(id) {
  const s = String(id || '');
  const first = s.split(':')[0] || s;
  return first.slice(0, 8);
}

/** 时间戳统一成毫秒；OfficeAce 有的写 ISO 有的写秒 */
function toMs(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest();
}

function authOf(headers) {
  if (!headers || typeof headers !== 'object') return '';
  const hit = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization');
  return hit ? String(hit[1]) : '';
}

/** Basic base64(AK:SK) 拆成 AK/SK */
function parseBasicAuthorization(value) {
  const m = /^Basic\s+(.+)$/i.exec(String(value || '').trim());
  if (!m) return null;
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!/^[\x20-\x7e]+$/.test(decoded)) return null;
  const idx = decoded.indexOf(':');
  if (idx <= 0) return null;
  return { ak: decoded.slice(0, idx), sk: decoded.slice(idx + 1) };
}

/* -------------------------------------------------- 加密的 OAuth 档案解密 */

/**
 * 复刻 huawei-oauth.js 的 decryptJson：
 *   key   = sha256(installSecret)
 *   alg   = aes-256-gcm，iv/tag/data 都是 base64url
 */
function decryptOauthProfile(installSecret, payload) {
  if (!payload || payload.version !== 1 || payload.alg !== 'aes-256-gcm') return null;
  const key = sha256(installSecret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64url'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString('utf8'));
}

/**
 * 把解开的 providerState 归一化。
 *
 * 真实结构（来自 green-package/api/dist/auth/huawei-oauth.js 的
 * buildProviderStateFromToken / toPrincipal）：
 *   {
 *     authType: 'huawei-oauth',
 *     accountId, userName, principalUrn, user_id,
 *     credential: { access, secret, sts_token, project_id,
 *                   expires_at, refresh_token, refresh_expires_at },
 *     dpop: {...}
 *   }
 * 其中 accountId 是华为云账号 ID、user_id 是 IAM 用户 ID，
 * 目录名 "<accountId>:<user_id>" 就是这么拼出来的。
 */
function normalizeProfile(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const cred = obj.credential && typeof obj.credential === 'object' ? obj.credential : {};
  const str = (...vals) => {
    for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
    return '';
  };
  const dpop = obj.dpop && typeof obj.dpop === 'object' ? obj.dpop : null;
  return {
    authType: str(obj.authType),
    accountId: str(obj.accountId),
    userId: str(obj.user_id, obj.userId),
    userName: str(obj.userName, obj.displayName),
    principalUrn: str(obj.principalUrn),
    // 临时凭据
    accessKeyId: str(cred.access, obj.accessKeyId),
    secretAccessKey: str(cred.secret, obj.secretAccessKey),
    securityToken: str(cred.sts_token, cred.securityToken, obj.securityToken),
    projectId: str(cred.project_id, obj.projectId),
    region: str(cred.project_id) ? '' : str(obj.region),
    expiresAt: toMs(cred.expires_at || obj.expiresAt),
    refreshToken: str(cred.refresh_token, obj.refreshToken),
    refreshExpiresAt: toMs(cred.refresh_expires_at),
    hasDpop: !!dpop,
    raw: obj,
  };
}

/* ------------------------------------------------------------ 安装根目录 */

function installRoots(installDirs = []) {
  // `config.discover.enabled: false` = 用户不想让本服务去碰这台机器上的 OfficeAce。
  // 这里返回空列表，下面所有扫盘（routing_state、加密 OAuth 档案、users/<id>/model.json）
  // 自然全部跳过；而 `data/oauth-accounts.json` 里自己登进来的账号不经过这里，照旧加载。
  if (!isMachineScanEnabled()) return [];
  const out = new Set();
  for (const d of installDirs) if (d) out.add(path.resolve(d));
  if (process.env.OFFICEACE_INSTALL_DIR) out.add(path.resolve(process.env.OFFICEACE_INSTALL_DIR));
  for (const drive of ['C', 'D', 'E', 'F']) {
    for (const mid of ['软件', 'Program Files', 'Program Files (x86)', 'Apps']) {
      const p = path.join(`${drive}:\\`, mid, 'OfficeAce');
      try {
        if (fs.existsSync(p)) out.add(p);
      } catch {
        /* 驱动器不存在 */
      }
    }
  }
  return [...out];
}

function dataRoots(installDirs = []) {
  // 同上：扫描本机被关掉时连 `~/.office-claw` 也不读（`OFFICEACE_HOME` 只是换位置，
  // 不是开关——两回事）。要的是"账号来源完全由 data/ 和我手工加的说了算"。
  if (!isMachineScanEnabled()) return [];
  const out = new Set([path.join(home(), '.office-claw')]);
  for (const r of installRoots(installDirs)) out.add(path.join(r, '.office-claw'));
  return [...out];
}

/* ------------------------------------------------------------ 自助登录账号 */

/**
 * 读 src/oauth.mjs 落盘的「自己登进来的账号」。
 * 文件里有 refresh_token 和 DPoP 私钥，所以只读不写；写由 oauth.mjs 负责。
 */
function loadOauthAccounts(file) {
  if (!file) return {};
  const doc = readJson(file);
  return doc && typeof doc === 'object' ? doc : {};
}

/**
 * 把一条自助登录记录转成号池认的账号结构。
 *
 * 这里是自助登录能不能融进现有体系的关键：只要 profile 填对，
 * 额度查询（quota.mjs）、自动续期（refresh.mjs）、连接池调度都不用为它开特例。
 * 特别是 profile.raw.dpop —— 续期要用它签 DPoP proof，缺了就只能重新登录。
 */
export function toAccountRecord(rec) {
  const expMs = Date.parse(rec?.credential?.expiresAt || '');
  const id = String(rec?.id || '').trim();
  const authorization = String(rec?.authorization || '');
  const baseUrl = trimSlash(rec?.baseUrl || '');
  return {
    id,
    short: shortId(id),
    label: rec?.label || rec?.userName || id,
    userName: rec?.userName || '',
    accountId: rec?.accountId || id.split(':')[0] || '',
    userId: rec?.userId || id.split(':')[1] || '',
    sources: ['oauth-login'],
    lastSeenAt: rec?.createdAt || 0,
    credentials: authorization && baseUrl
      ? [{
        id: `oauth-${rec?.accountId || shortId(id)}`,
        baseUrl,
        authorization,
        authPreview: maskSecret(authorization),
        akPreview: `${authorization.replace(/^Basic\s+/, '').slice(0, 8)}…`,
        models: [],
        provider: 'oauth-login',
        source: 'data/oauth-accounts.json',
        fingerprint: `${baseUrl}||${authorization}`,
      }]
      : [],
    catalog: [],
    files: { oauth: 'data/oauth-accounts.json' },
    profile: {
      accountId: rec?.accountId || '',
      userId: rec?.userId || '',
      userName: rec?.userName || '',
      region: rec?.region || 'cn-southwest-2',
      accessKeyId: rec?.credential?.accessKeyId || '',
      secretAccessKey: rec?.credential?.secretAccessKey || '',
      securityToken: rec?.credential?.securityToken || '',
      projectId: rec?.credential?.projectId || '',
      expiresAt: Number.isFinite(expMs) ? expMs : 0,
      refreshToken: rec?.refreshToken || '',
      raw: {
        dpop: rec?.dpopPrivateJwk
          ? { privateJwk: rec.dpopPrivateJwk, publicJwk: rec.dpopPublicJwk }
          : undefined,
      },
    },
    oauthLogin: true,
  };
}

/* ------------------------------------------------------------ 账号存储 */

export class AccountStore {
  constructor({ dataFile, installDirs = [] }) {
    this.dataFile = dataFile;
    this.installDirs = installDirs;
    this.accounts = new Map(); // id -> record
    // 续期链状态（src/refresh.mjs）。不是构造参数，由 src/index.mjs 在两边都
    // 建好之后接上；`applyRearmedToken(..., { markConsumed: true })` 要靠它推进
    // 「磁盘 token 已经被消费掉」的锚点。没有它也能跑，只是少一层保险。
    this.refreshState = null;
    // ignored：用户在面板上点「删除」的、由本机 OfficeAce 文件发现的账号。
    //
    // 这类账号删不掉 —— 它们来自磁盘上三处只读文件，抹掉内存记录之后
    // 下一次 scan()（45 秒一轮）又会把它们原样捡回来。所以「删除」的正确语义
    // 是：记进这份名单，以后扫盘直接跳过，面板上也不再出现。
    // 想找回来就在面板上「取消忽略」，因为本服务从不写 OfficeAce 的文件。
    this.meta = { labels: {}, disabled: [], ignored: [], imported: [], order: [] };
    this.lastScanAt = 0;
    // 上一次扫描的「有几个号、几条凭据」，用来判断这次扫描有没有变化。
    // 号池扫描的日志只认变化，见 _logScan()。
    this._scanSummary = null;
    this._scanBeatAt = 0;
    this.warnings = [];
    // id -> 续期换回来的凭据。只在内存里，scan() 后重新盖上（磁盘那份永远只读）
    this.refreshed = new Map();
    // 自助登录（src/oauth.mjs）落盘的账号。和号池里的号走同一套逻辑，
    // 这样额度查询 / 自动续期 / 连接池调度都不需要为它开特例。
    this.oauthFile = dataFile ? path.join(path.dirname(dataFile), 'oauth-accounts.json') : '';
  }

  /* ---- 面板可编辑元数据 ---- */

  load() {
    const doc = readJson(this.dataFile);
    if (doc && typeof doc === 'object') {
      this.meta = {
        labels: doc.labels && typeof doc.labels === 'object' ? doc.labels : {},
        disabled: Array.isArray(doc.disabled) ? doc.disabled : [],
        ignored: Array.isArray(doc.ignored) ? doc.ignored : [],
        imported: Array.isArray(doc.imported) ? doc.imported : [],
        order: Array.isArray(doc.order) ? doc.order : [],
      };
    }
    return this.meta;
  }

  save() {
    // 没配 dataFile = 纯内存模式（自测里大量用 `dataFile: ''`）。
    // 以前这里会一路走到 writeFileAtomic('')，在仓库根造一个孤儿临时文件、
    // 抛 ENOENT，还打一行 ERROR 日志 —— 自测输出里就混着这么一条
    // 「保存 accounts.json 失败 {"error":"ENOENT: ... rename '..32716.tmp' -> ''"}」，
    // 看着像真 bug，其实是"本来就不该写盘"。
    if (!this.dataFile) return;
    try {
      fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
      // 原子写：这份文件存着「哪些号被删了（忽略名单）」，半截写坏就等于
      // 删除状态全丢，下一轮扫描把删掉的号全放回来。见 util.writeFileAtomic。
      writeFileAtomic(this.dataFile, JSON.stringify(this.meta, null, 2), { mode: 0o600 });
      lockDownFile(this.dataFile);
    } catch (err) {
      log.error('保存 accounts.json 失败', { error: err.message });
    }
  }

  /* ---- 扫盘 ---- */

  scan({ cached = false } = {}) {
    // 同一次扫描的合并：只有**轮询方**能省这一步（见下面的 cached）。
    //
    // 为什么：这个函数是全量扫盘（每个安装目录 readdir + 逐个文件读、解密），
    // 而轮询的周期都很短 —— 一键授权每 3 秒问一次云端、周期刷新 45 秒一轮。
    // 它们撞在一起就是同一秒里连扫两三遍，结果一模一样。实测日志 400 行里有
    // 274 行是这件事刷出来的（都是同一句"号池扫描完成"）。
    //
    // 为什么是调用方显式要求、而不是自己偷偷缓存：
    //   面板的「重新扫描」按钮 —— 用户点了就要看到此刻的真实状态
    //   删除 / 恢复 / 导入之后 —— 刚改完池子，不能拿改之前的结果
    //   tools/test-admin.mjs —— 它测的正是"改完立刻扫"
    // 这些调用方一律走默认的 fresh 扫描。轮询方（`cached: true`）最多慢一秒，
    // 而它本来每 3 秒就会再问一次，一秒的延迟对收敛没有任何影响。
    if (cached && this.lastScanAt && Date.now() - this.lastScanAt < SCAN_COALESCE_MS) return this.list();
    this.warnings = [];
    const map = new Map();
    const ignored = new Set(this.meta.ignored || []);
    const ensure = (id) => {
      const key = String(id || '').trim();
      if (!key) return null;
      // 用户明确删掉的号：当作磁盘上不存在。返回 null 让每个调用点
      // 用自己的 `if (!acc) continue;` 跳过 —— 那 5 处本来就都写了这个判断。
      if (ignored.has(key)) return null;
      if (!map.has(key)) {
        map.set(key, {
          id: key,
          short: shortId(key),
          sources: [],
          credentials: [],
          catalog: [],
          profile: null,
          files: {},
          lastSeenAt: 0,
        });
      }
      return map.get(key);
    };

    // 1) routing_state/users/<uid>/models.json → 凭据
    const seenCred = new Set();
    for (const root of dataRoots(this.installDirs)) {
      const routingBase = path.join(root, '.jiuwenclaw', 'config', 'routing_state', 'users');
      for (const dir of listDirs(routingBase)) {
        const file = path.join(dir, 'models.json');
        const doc = readJson(file);
        if (!doc) continue;
        const uid = decodeUserId(path.basename(dir));
        const acc = ensure(uid);
        if (!acc) continue;
        if (!acc.sources.includes('routing-state')) acc.sources.push('routing-state');
        acc.files.models = file;
        acc.lastSeenAt = Math.max(acc.lastSeenAt, mtimeOf(file));

        for (const list of collectModelLists(doc)) {
          for (const entry of list) {
            const cfg = entry?.model_client_config || entry?.modelClientConfig || entry;
            const baseUrl = trimSlash(cfg?.api_base || cfg?.baseUrl || cfg?.base_url || '');
            const authorization = authOf(cfg?.custom_headers || cfg?.customHeaders || cfg?.headers);
            if (!baseUrl || !authorization) continue;
            const fp = `${baseUrl}||${authorization}`;
            if (seenCred.has(fp)) {
              const dup = acc.credentials.find((c) => c.fingerprint === fp);
              const modelName = cfg?.model_name || '';
              if (dup && modelName && !dup.models.includes(modelName)) dup.models.push(modelName);
              continue;
            }
            seenCred.add(fp);
            const basic = parseBasicAuthorization(authorization);
            acc.credentials.push({
              id: `cred-${seenCred.size}`,
              baseUrl,
              authorization,
              authPreview: maskSecret(authorization),
              akPreview: basic ? `${basic.ak.slice(0, 8)}…` : '',
              ak: basic ? basic.ak : '',
              models: cfg?.model_name ? [cfg.model_name] : [],
              provider: cfg?.client_provider || 'OpenAI',
              source: file,
              fingerprint: fp,
            });
          }
        }
      }
    }

    // 2) 安装目录下的加密 OAuth 档案 → 临时 AK/SK、过期时间
    for (const root of installRoots(this.installDirs)) {
      const secureDir = path.join(root, SECURE_DIR);
      if (!fs.existsSync(secureDir)) continue;
      let keyText = null;
      const keyFile = path.join(secureDir, '.oauth-profile-encryption-key');
      if (fs.existsSync(keyFile)) {
        keyText = readProtectedText(keyFile);
        if (!keyText) this.warnings.push('安装密钥解密失败，账号过期时间等字段留空');
      }
      let names;
      try {
        names = fs.readdirSync(secureDir);
      } catch {
        continue;
      }
      for (const name of names) {
        const m = /^oauth-(.+)\.json$/.exec(name);
        if (!m) continue;
        const uid = decodeUserId(m[1]);
        const acc = ensure(uid);
        if (!acc) continue;
        if (!acc.sources.includes('oauth-profile')) acc.sources.push('oauth-profile');
        const file = path.join(secureDir, name);
        acc.files.profile = file;
        acc.lastSeenAt = Math.max(acc.lastSeenAt, mtimeOf(file));
        if (!keyText) continue;
        const payload = readJson(file);
        if (!payload) continue;
        try {
          acc.profile = normalizeProfile(decryptOauthProfile(keyText, payload));
        } catch (err) {
          log.debug('档案解密失败', { file: name, error: err.message });
        }
      }
    }

    // 3) users/<uid>/model.json → 模型目录
    for (const root of dataRoots(this.installDirs)) {
      const usersBase = path.join(root, 'users');
      for (const dir of listDirs(usersBase)) {
        const file = path.join(dir, 'model.json');
        const doc = readJson(file);
        if (!doc) continue;
        const uid = decodeUserId(path.basename(dir));
        const acc = ensure(uid);
        if (!acc) continue;
        if (!acc.sources.includes('user-dir')) acc.sources.push('user-dir');
        acc.files.catalog = file;
        acc.lastSeenAt = Math.max(acc.lastSeenAt, mtimeOf(file));
        for (const [account, models] of Object.entries(doc)) {
          if (!Array.isArray(models)) continue;
          for (const item of models) {
            const id = item?.id || item?.name;
            if (!id) continue;
            const key = `${id}`;
            if (!acc.catalog.some((c) => c.id === key)) {
              acc.catalog.push({ id: String(id), account, baseUrl: trimSlash(item?.baseUrl || '') });
            }
          }
        }
      }
    }

    // 4) 手工导入的账号
    for (const item of this.meta.imported) {
      const acc = ensure(item.id);
      if (!acc) continue;
      if (!acc.sources.includes('imported')) acc.sources.push('imported');
      const authorization = String(item.authorization || '').trim();
      const baseUrl = trimSlash(item.baseUrl || '');
      if (baseUrl && authorization) {
        const basic = parseBasicAuthorization(authorization);
        const fp = `${baseUrl}||${authorization}`;
        if (!acc.credentials.some((c) => c.fingerprint === fp)) {
          acc.credentials.push({
            id: 'cred-imported',
            baseUrl,
            authorization,
            authPreview: maskSecret(authorization),
            akPreview: basic ? `${basic.ak.slice(0, 8)}…` : '',
            ak: basic ? basic.ak : '',
            models: [],
            provider: 'imported',
            source: 'data/accounts.json',
            fingerprint: fp,
          });
        }
      }
      if (item.expiresAt) {
        acc.profile = { ...(acc.profile || {}), expiresAt: toMs(item.expiresAt), accessKeyId: (parseBasicAuthorization(authorization) || {}).ak || '' };
      }
    }

    // 4.5) 自助登录进来的账号（本机自己跑的 OAuth，不依赖 OfficeAce 桌面端）
    for (const rec of Object.values(loadOauthAccounts(this.oauthFile))) {
      const built = toAccountRecord(rec);
      const acc = ensure(built.id);
      if (!acc) continue;
      if (!acc.sources.includes('oauth-login')) acc.sources.push('oauth-login');
      for (const c of built.credentials) {
        if (!acc.credentials.some((x) => x.fingerprint === c.fingerprint)) acc.credentials.push(c);
      }
      acc.lastSeenAt = Math.max(acc.lastSeenAt, built.lastSeenAt);
      // 这里的 profile 比磁盘档案那份新（它带 refresh_token 和 DPoP 私钥），
      // 但不能覆盖 OfficeAce 自己那份 —— 同 ID 时以桌面端的为准，它更权威。
      if (!acc.profile) acc.profile = built.profile;
      acc.oauthLogin = true;
    }

    // 5) 收尾：别名、启用状态、健康度
    for (const acc of map.values()) {
      acc.userName = acc.profile?.userName || '';
      acc.accountId = acc.profile?.accountId || String(acc.id).split(':')[0] || '';
      acc.userId = acc.profile?.userId || String(acc.id).split(':')[1] || '';
      acc.label = this.meta.labels[acc.id] || defaultLabel(acc);
      acc.enabled = !this.meta.disabled.includes(acc.id);
      // 磁盘档案是 24 小时就过期的旧凭据，但我们可能已经用 refresh_token 换过新的了。
      // 这一步要把内存里的新凭据盖回来，否则面板会一直喊「已过期」，连接池也会误判。
      this._applyRefreshed(acc);
      acc.userName = acc.profile?.userName || acc.userName;
      acc.health = evaluateHealth(acc);
      acc.keyFingerprint = acc.profile?.accessKeyId
        ? `${acc.profile.accessKeyId.slice(0, 8)}…${acc.profile.accessKeyId.slice(-4)}`
        : acc.credentials[0]?.akPreview || '';
      acc.profileAgeMs = acc.profile?.expiresAt ? acc.profile.expiresAt - Date.now() : 0;
    }

    this.accounts = map;
    this.lastScanAt = Date.now();
    this.pruneMetaKeys();
    this._logScan();
    return this.list();
  }

  /**
   * 号池扫描的日志：**只在真有变化时打 INFO**，没变化就退到 DEBUG 并限流。
   *
   * 为什么必须这样：scan() 被短周期轮询反复调用（授权 3 秒 / 注册 5 秒 / 面板
   * 按钮 / 45 秒周期），而「扫完发现还是 2 个号、2 条凭据」这句话**没有任何信息量**。
   * 以前它无条件打 INFO，实测把日志刷成 400 行里 274 行都是同一句，真正的事件
   * （新增账号、凭据数变了、被忽略名单拦下）全被埋在里面看不出来。
   *
   * 现在的规矩：
   *   有变化   → INFO，带上变化前后的数字（面板/文件里都看得见）
   *   没变化   → DEBUG，且最多每 5 分钟一条心跳，证明扫描还活着
   *
   * 注意「没变化」不等于「没事发生」：忽略名单拦下已删除账号的凭据那一步在
   * boot 的 discover 里另有一条 INFO，不受这里影响。
   */
  _logScan() {
    const summary = {
      accounts: this.accounts.size,
      credentials: [...this.accounts.values()].reduce((n, a) => n + a.credentials.length, 0),
    };
    const before = this._scanSummary;
    const changed = !before || before.accounts !== summary.accounts || before.credentials !== summary.credentials;
    if (changed) {
      this._scanSummary = summary;
      this._scanBeatAt = Date.now();
      log.info('号池扫描完成', before ? { ...summary, was: before } : summary);
      return;
    }
    if (Date.now() - this._scanBeatAt >= SCAN_HEARTBEAT_MS) {
      this._scanBeatAt = Date.now();
      log.debug('号池扫描完成（无变化）', summary);
    }
  }

  /**
   * 清掉 `accounts.json` 里那些**对应的账号根本不存在**的键。
   *
   * 只做减法、只删"长得就不像真账号"的键：真实 ID 是 `<32位hex>:<32位hex>`。
   * 所以真正的数据不会被误删 —— 哪怕一个账号此刻扫不到（OfficeAce 没启动），
   * 它的键也仍然是合法形态，会原样留着。
   *
   * 为什么必须做：`labels` 里躺着一个幽灵键时，面板上永远会多出一行；
   * 更糟的是 `remove()` 之类按 id 找账号的地方会得到 `notFound`，
   * 而用户看到的是一个"存在但删不掉"的号。
   */
  pruneMetaKeys() {
    let removed = 0;
    const drop = (list) => list.filter((k) => {
      if (isRealAccountId(k)) return true;
      removed += 1;
      return false;
    });
    for (const field of ['labels', 'disabled', 'ignored']) {
      const src = this.meta[field];
      if (!src) continue;
      if (field === 'labels') {
        for (const k of Object.keys(src)) {
          if (!isRealAccountId(k)) {
            delete src[k];
            removed += 1;
          }
        }
      } else if (Array.isArray(src)) {
        this.meta[field] = drop(src);
      }
    }
    if (removed) {
      log.info('清掉 accounts.json 里对不上账号的键', { removed });
      this.save();
    }
    return removed;
  }

  /* ---- 读取 ---- */

  /**
   * 把刚自助登录成功的账号立刻塞进号池，不用等下一次 scan()。
   * src/oauth.mjs 拿到凭据后调这个。
   *
   * ⚠️ 这里同时要把「忽略名单 / 停用名单」里的同一个 ID 撤掉，否则整个登录
   * 白跑一趟：attach 完立刻会 `runDiscovery('oauth-login')` 触发全量 scan()，
   * 而 scan() 里每个调用点都会拿 `ensure(id)` 挡一道 —— 被忽略的 ID 一律返回
   * null 直接 continue。表现就是「导入账号走完了、日志也写『自助登录完成』，
   * 但列表里什么都没多」。
   *
   * 语义上也该这样：**用户亲手登录一次，就是最明确的「我要用这个号」**。
   * 忽略名单是给「扫盘扫出来的、你不想看到」那种准备的，不能反过来把用户的
   * 显式操作也一起挡掉。
   */
  attachOauthAccount(rec) {
    const built = toAccountRecord(rec);
    if (!built.id) return false;
    const key = built.id;

    // 显式登录 = 撤销之前的「删除 / 停用」
    const wasIgnored = (this.meta.ignored || []).includes(key);
    const wasDisabled = (this.meta.disabled || []).includes(key);
    if (wasIgnored) this.meta.ignored = this.meta.ignored.filter((x) => x !== key);
    if (wasDisabled) this.meta.disabled = this.meta.disabled.filter((x) => x !== key);

    const acc = this.accounts.get(key) || {
      id: key,
      short: built.short,
      sources: [],
      credentials: [],
      catalog: [],
      profile: null,
      files: {},
      lastSeenAt: 0,
    };
    if (!acc.sources.includes('oauth-login')) acc.sources.push('oauth-login');
    for (const c of built.credentials) {
      if (!acc.credentials.some((x) => x.fingerprint === c.fingerprint)) acc.credentials.push(c);
    }
    acc.oauthLogin = true;
    acc.lastSeenAt = Math.max(acc.lastSeenAt, built.lastSeenAt);
    if (!acc.profile) acc.profile = built.profile;
    acc.userName = acc.profile?.userName || built.userName;
    acc.accountId = acc.profile?.accountId || built.accountId;
    acc.userId = acc.profile?.userId || built.userId;
    acc.label = this.meta.labels[key] || built.label;
    acc.enabled = true; // 显式登录的号默认就是启用的
    this._applyRefreshed(acc);
    // 续期链之前被烧穿过的话，新的 refresh_token 到手了就该重新上膛
    if (wasIgnored || wasDisabled) acc.revivedAt = Date.now();
    acc.health = evaluateHealth(acc);
    acc.keyFingerprint = acc.profile?.accessKeyId
      ? `${acc.profile.accessKeyId.slice(0, 8)}…${acc.profile.accessKeyId.slice(-4)}`
      : acc.credentials[0]?.akPreview || '';
    acc.profileAgeMs = acc.profile?.expiresAt ? acc.profile.expiresAt - Date.now() : 0;
    this.accounts.set(key, acc);
    if (wasIgnored || wasDisabled) {
      log.info('自助登录的号已从忽略 / 停用名单里撤销', { id: key, wasIgnored, wasDisabled });
    }
    this.save();
    return true;
  }

  /**
   * 给「有临时 AK/SK、但没有 MaaS 网关凭据」的账号补上那条网关凭据。
   *
   * 为什么会缺：账号可能是通过**一键授权**进来的（走本机 OfficeAce 那条路），
   * 那条路只会让桌面端写一份档案和用户目录，**从来不会产生 routing_state 里的
   * models.json** —— 而网关的 Basic key 一直是从那个文件里读的。
   * 桌面端之所以有，是因为它自己请求过模型；没请求过就没有。
   *
   * 结果就是：号在池子里看得见（健康度写着"无凭据"），但一条凭据都没有，
   * 转发永远不会选它。面板上「今日签到 2/2」「积分 13000」却说得像是两个都能用。
   *
   * 补的数据来自控制面 `GET /v1/claw/client-permission-validate`：
   * 它返回的 `subscription.model_info.model_auth_info` 就是那对 key，
   * 而且和自助登录走的是同一个接口、同一套字段。
   *
   * ⚠️ 只补**零凭据**的账号。已经有凭据的一律不动 —— 那种号手上那条要么来自
   * 桌面端（更权威），要么已经补过了；重复覆盖只会把能用的换成没验证过的。
   *
   * @param {string} accountId
   * @param {{appKey:string, appSecret:string, baseUrl:string, accountId?:string, principalId?:string}} info
   * @returns {boolean} 是否真的写进去了
   */
  backfillGatewayCredential(accountId, info) {
    const key = String(accountId || '');
    const acc = this.get(key);
    if (!acc) return false;
    if (!info?.appKey || !info?.appSecret || !info?.baseUrl) return false;

    if (acc.credentials?.length) {
      log.debug('该账号已有凭据，跳过补凭据', { id: key, credentials: acc.credentials.length });
      return false;
    }
    // 档案里的 accountId 和云端返回的对不上 → 不补。
    // 这种情况说明我们大概算错了 id，硬写进去会生成一条**挂在别人名下**的凭据，
    // 而它会真的被拿去发请求、真的扣别人的积分。
    const cloudAccountId = String(info.accountId || '');
    if (cloudAccountId && acc.accountId && cloudAccountId !== acc.accountId) {
      log.warn('补凭据时账号 ID 对不上，已放弃', { id: key, local: acc.accountId, cloud: cloudAccountId });
      return false;
    }

    const authorization = `Basic ${Buffer.from(`${info.appKey}:${info.appSecret}`).toString('base64')}`;
    const baseUrl = trimSlash(info.baseUrl);
    const rec = {
      id: key,
      label: acc.label,
      accountId: acc.accountId || cloudAccountId,
      userId: acc.userId || info.principalId || '',
      userName: acc.userName || '',
      baseUrl,
      authorization,
      createdAt: Date.now(),
    };
    return this.upsertOauthAccount(rec, { reason: 'backfill' });
  }

  /**
   * 读整份 `data/oauth-accounts.json`（换电脑导出用；拿到的就是文件里的原始结构）。
   * 每次现读，不用缓存 —— 这个文件也会被别的路径（自助登录 / 补凭据）写。
   */
  readOauthDoc() {
    return loadOauthAccounts(this.oauthFile);
  }

  /**
   * 整份写回 `data/oauth-accounts.json`（换电脑导入用）。
   *
   * 只给 bundle.mjs 的合并结果用：合并是**读整份 → 改 → 写整份**，
   * 所以这里不能走 upsertOauthAccount（那是单条合并，会把别的号覆盖掉）。
   * 权限收紧（lockDownFile）：里面是明文 Basic 凭据 + 一次性 token + DPoP 私钥。
   */
  writeOauthDoc(doc) {
    if (!this.oauthFile) return false;
    try {
      fs.mkdirSync(path.dirname(this.oauthFile), { recursive: true });
      writeFileAtomic(this.oauthFile, JSON.stringify(doc || {}, null, 2), { mode: 0o600 });
      lockDownFile(this.oauthFile);
      return true;
    } catch (err) {
      log.error('写账号档案失败', { error: err.message });
      return false;
    }
  }

  /** 文件路径（给 CLI / 报错信息用） */
  oauthFilePath() {
    return this.oauthFile;
  }

  /**
   * 往 `data/oauth-accounts.json` 里写一条自助登录记录（或补进已有的那条）。
   *
   * ⚠️ 是**合并**不是覆盖：文件里还有 refresh_token、DPoP 私钥这些续期要用的东西，
   * 补凭据时它们必须原样留着，否则补完就续不了期了。
   */
  upsertOauthAccount(rec, { reason = '' } = {}) {
    if (!this.oauthFile) return false;
    const id = String(rec?.id || '').trim();
    if (!id) return false;
    try {
      const all = loadOauthAccounts(this.oauthFile);
      const prev = all[id] || {};
      all[id] = { ...prev, ...rec };
      fs.mkdirSync(path.dirname(this.oauthFile), { recursive: true });
      writeFileAtomic(this.oauthFile, JSON.stringify(all, null, 2), { mode: 0o600 });
      log.info('账号凭据已写入档案', { id, reason, keys: Object.keys(all[id]).length });
      return true;
    } catch (err) {
      log.warn('写账号档案失败', { id, reason, error: err.message });
      return false;
    }
  }

  /**
   * 把续期换回来的新凭据套到账号上（QuotaService 续期成功后调用）。
   *
   * 只改内存，**绝不写 OfficeAce 的任何文件**；scan() 之后会自动重新盖上，
   * 所以磁盘上那份过期的旧凭据不会把显示和调度带偏。
   */
  applyRefreshedCredential(id, credential) {
    const acc = this.get(id);
    if (!acc || !credential?.accessKeyId) return false;
    const expiresAt = toMs(credential.expiresAt) || Date.parse(credential.expiresAt || '') || 0;
    // 已经过期的凭据要直接挡在门外：存进去会把手上那条还能用的挤掉，
    // 下次 scan() 就没人可套，档案又会退回磁盘上那份旧的。
    if (expiresAt && expiresAt <= Date.now()) {
      log.warn('忽略已过期的续期凭据', { id: acc.id });
      return false;
    }
    this.refreshed.set(String(acc.id), {
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      securityToken: credential.securityToken,
      projectId: credential.projectId,
      expiresAt,
      at: Date.now(),
    });
    const applied = this._applyRefreshed(acc);
    if (applied) {
      acc.health = evaluateHealth(acc);
      acc.keyFingerprint = `${credential.accessKeyId.slice(0, 8)}…${credential.accessKeyId.slice(-4)}`;
      acc.profileAgeMs = acc.profile?.expiresAt ? acc.profile.expiresAt - Date.now() : 0;
      log.info('账号已套用续期凭据', { id: acc.id, expiresAt: credential.expiresAt });
    }
    return applied;
  }

  _applyRefreshed(acc) {
    const r = this.refreshed.get(String(acc.id));
    if (!r) return false;
    if (r.expiresAt && r.expiresAt <= Date.now()) {
      this.refreshed.delete(String(acc.id));
      return false;
    }
    acc.profile = {
      ...(acc.profile || {}),
      accessKeyId: r.accessKeyId,
      secretAccessKey: r.secretAccessKey,
      securityToken: r.securityToken,
      projectId: r.projectId || acc.profile?.projectId,
      expiresAt: r.expiresAt || acc.profile?.expiresAt,
      refreshed: true,
      diskExpiresAt: acc.profile?.diskExpiresAt || acc.profile?.expiresAt || 0,
    };
    return true;
  }

  /** 续期凭据的概览，面板用 */
  refreshedInfo(id) {
    const r = this.refreshed.get(String(id));
    return r ? { at: r.at, expiresAt: r.expiresAt } : null;
  }

  /**
   * 最近一次（自助 / 面板）登录拿到的 refresh_token。
   *
   * 续期链烧穿之后，这份 token 往往是这个号唯一还有救的东西 ——
   * 桌面端档案里那份早被用过了，而这是新一轮授权周期刚发下来的。
   * 返回脱敏之外的最小信息，调用方拿去重新上膛。
   */
  oauthRefreshToken(id) {
    if (!this.oauthFile) return null;
    const key = String(id || '');
    const all = loadOauthAccounts(this.oauthFile);
    const hit = all[key] || Object.values(all).find((r) => r.accountId && key.startsWith(r.accountId));
    if (!hit?.refreshToken) return null;
    return {
      id: String(hit.id || ''),
      refreshToken: hit.refreshToken,
      refreshExpiresAt: Number(hit.refreshExpiresAt) || 0,
      userName: hit.userName || '',
      createdAt: hit.createdAt || 0,
    };
  }

  /** 续期链救回来之后，把「已断链」的内存标记一并清掉（面板不再红） */
  forgetBroken(id) {
    const key = String(id || '');
    const acc = this.accounts.get(key);
    if (acc) {
      acc.broken = false;
      acc.brokenReason = '';
      if (acc.health) acc.health = evaluateHealth(acc);
    }
    return !!acc;
  }

  /**
   * 把档案里那份「磁盘 refresh_token」换成新的（**只改内存**）。
   *
   * 为什么必须换：`CredentialRefresher.refresh()` 是拿 `profile.refreshToken`
   * 当作「磁盘锚点」去问 RefreshState 该发哪一份的。重新上膛之后新 token 存在
   * RefreshState 里，可 profile 上还是旧的那份 —— 那份已经被拉黑，于是
   * `pickToken` 直接判 None，用户重登了却仍然报「token 都作废了」。
   *
   * ⚠️ 必须**原地改**，不能 `target.profile = {...}` 换个新对象。
   * 调用方（QuotaService.refreshCredential）手里攥着的是 `acc.profile` 这个引用，
   * 上面还挂着 `raw.dpop` 之类的字段；换成新对象之后，紧接着那次 refresh()
   * 读到的还是旧引用，于是「刚上膛完又报 token 全废」。
   *
   * ⚠️ 这里**只改 profile，不碰 RefreshState 的锚点**。
   * 锚点（`diskTokenUsed`）的职责是「档案那条线我们走到哪了」，由
   * `RefreshState.record()` 按「这次发的是不是档案那条线的」来决定 ——
   * 在这里把锚点往前推会让 profile 和锚点指向同一份，`pickToken` 于是
   * 放着新鲜 token 不用、或反复触发多余的「重新上膛」（每上膛一次烧掉一份
   * 一次性 refresh_token）。踩过，见 README「链子烧穿之后要能自愈」。
   */
  applyRearmedToken(id, refreshToken, { refreshExpiresAt = 0 } = {}) {
    const key = String(id || '');
    const token = String(refreshToken || '');
    if (!token) return false;
    const acc = this.accounts.get(key);
    // 号池是按完整 ID 存的，档案偶尔只按 accountId 建；两条都试一遍
    const target =
      (acc?.profile && acc) ||
      [...this.accounts.values()].find((a) => String(a.accountId) === key.split(':')[0] || String(a.id) === key) ||
      acc;
    if (!target) return false;
    if (!target.profile) target.profile = {};
    target.profile.refreshToken = token;
    if (refreshExpiresAt) target.profile.refreshExpiresAt = refreshExpiresAt;
    log.info('账号档案已换上新的 refresh_token（仅内存）', { id: target.id });
    return true;
  }

  get(id) {
    return this.accounts.get(String(id || '')) || null;
  }

  /** 所有启用账号的凭据（扁平），供上游连接池使用 */
  enabledCredentials() {
    const out = [];
    for (const acc of this.accounts.values()) {
      if (!acc.enabled) continue;
      for (const c of acc.credentials) out.push({ ...c, accountId: acc.id, accountLabel: acc.label });
    }
    return out;
  }

  ids() {
    return [...this.accounts.keys()];
  }

  size() {
    return this.accounts.size;
  }

  /* ---- 面板视图（脱敏） ---- */

  /**
   * 号池内部记录原样返回（**带明文凭据**）。
   *
   * 只给"换电脑导出"那条路用（src/bundle.mjs 要拿全量档案拼搬运包），
   * 面板走的是下面脱敏的 list()。别在别处拿它往 HTTP 上吐。
   */
  rawList() {
    return [...this.accounts.values()];
  }

  list({ includeSecret = false } = {}) {
    return [...this.accounts.values()].map((a) => ({
      id: a.id,
      short: a.short,
      label: a.label,
      userName: a.userName || '',
      accountId: a.accountId || '',
      userId: a.userId || '',
      enabled: a.enabled,
      health: a.health,
      sources: a.sources,
      lastSeenAt: a.lastSeenAt,
      keyFingerprint: a.keyFingerprint,
      expiresAt: a.profile?.expiresAt || 0,
      // 磁盘上原封不动的那份（用来对比「已自动续期」到底续了多久）
      diskExpiresAt: a.profile?.diskExpiresAt || 0,
      // 'refreshed' = 现在用的是 refresh_token 换回来的；'disk' = 用的还是档案里那份
      credentialSource: a.profile?.refreshed && this.refreshed.has(String(a.id)) ? 'refreshed' : 'disk',
      refreshedAt: this.refreshed.get(String(a.id))?.at || 0,
      refreshExpiresAt: a.profile?.refreshExpiresAt || 0,
      hoursLeft: a.profile?.expiresAt ? Math.max(0, Math.floor((a.profile.expiresAt - Date.now()) / 3600000)) : null,
      region: a.profile?.region || '',
      projectId: a.profile?.projectId || '',
      hasDpop: !!a.profile?.hasDpop,
      credentialCount: a.credentials.length,
      modelCount: a.catalog.length,
      baseUrl: a.credentials[0]?.baseUrl || '',
      credentials: a.credentials.map((c) => ({
        id: c.id,
        baseUrl: c.baseUrl,
        authPreview: c.authPreview,
        akPreview: c.akPreview,
        authorization: includeSecret ? c.authorization : undefined,
        models: c.models.length,
        provider: c.provider,
      })),
      files: a.files,
      profileRaw: includeSecret ? a.profile?.raw : undefined,
    }));
  }

  /* ---- 编辑 ---- */

  /**
   * 改别名。
   *
   * ⚠️ 必须要求「这个 id 在号池里真的存在」，两道关卡都要过：
   *   ① 形态得像真账号（`<32hex>:<32hex>`）；
   *   ② 号池里能查到它。
   *
   * 为什么不是"宽容一点算了"：`meta.labels` 是**持久**的，写进去就跟着
   * accounts.json 一直落盘。以前这里只判 `if (!key)`，于是任何拿着假 id 打进来的
   * 调用都会留一个永久键 —— 实测盘上就躺过一个 `pending-<64位hex>`
   * （桌面端授权过程中上报的临时 userId），并且面板/恢复页会一直渲染它。
   * 那种键永远对应不上任何真实账号，用户看到的是一个"存在但删不掉"的号。
   */
  setLabel(id, label) {
    const key = String(id || '');
    if (!key) return false;
    if (!isRealAccountId(key)) {
      log.warn('拒绝给一个不像账号的 id 写别名', { id: key.slice(0, 40) });
      return false;
    }
    if (!this.accounts.has(key)) {
      log.warn('拒绝给一个号池里不存在的账号写别名', { id: key });
      return false;
    }
    const text = String(label || '').trim();
    if (text) this.meta.labels[key] = text;
    else delete this.meta.labels[key];
    this.save();
    const acc = this.accounts.get(key);
    if (acc) acc.label = text || defaultLabel(acc);
    return true;
  }

  setEnabled(id, enabled) {
    const key = String(id || '');
    if (!key) return false;
    const set = new Set(this.meta.disabled);
    if (enabled) set.delete(key);
    else set.add(key);
    this.meta.disabled = [...set];
    this.save();
    const acc = this.accounts.get(key);
    if (acc) acc.enabled = !!enabled;
    return true;
  }

  /** 手工导入：粘贴 baseUrl + Authorization */
  importManual({ id, label, baseUrl, authorization, expiresAt }) {
    const cleanBase = trimSlash(baseUrl || '');
    const auth = String(authorization || '').trim();
    if (!cleanBase || !auth) throw new Error('baseUrl 与 authorization 都不能为空');
    const basic = parseBasicAuthorization(auth);
    const key = String(id || '').trim() || (basic ? `manual:${basic.ak.slice(0, 12)}` : `manual:${cleanBase}`);
    const others = this.meta.imported.filter((x) => x.id !== key);
    others.push({ id: key, label: label || '', baseUrl: cleanBase, authorization: auth, expiresAt: expiresAt || 0 });
    this.meta.imported = others;
    if (label) this.meta.labels[key] = label;
    this.save();
    return key;
  }

  /**
   * 面板上的「删除」。
   *
   * 分两种情况：
   *   - 手工导入的（`sources === ['imported']`）：这是本服务自己记的，真删。
   *   - 本机 OfficeAce 文件里发现的：**删不掉** —— 它来自磁盘上三处只读文件，
   *     抹掉内存记录之后下一轮 `scan()`（45 秒一轮）又会把它原样捡回来。
   *     所以记进 `ignored` 名单，以后扫盘直接跳过、面板上也不再出现，
   *     效果和删除一样，而且不碰 OfficeAce 的任何文件（这是本项目的硬约束）。
   *     想找回来就在面板上「取消忽略」。
   *
   * ⚠️ 这里以前写的是 `this.meta.disabled.filter((x) => x !== key)` ——
   * 那是 `setEnabled()` 里「**启用**」那一半，抄反了方向。结果点「删除」
   * 既不删也不停，反而会把一个本来停用的号**重新启用**，而且没有任何提示。
   */
  remove(id) {
    const key = String(id || '');
    if (!key) return { removed: 0, removable: false, notFound: true };

    const acc = this.accounts.get(key);
    // 号池里根本没有这个号 —— 别往忽略名单里塞垃圾。
    //
    // 以前这里不判，于是任何拿假 id 打进来的调用（比如自测里那条用
    // 'no-such-account:0' 验「body 有没有丢」的反向对照）都会把那个假 id
    // 永久写进 data/accounts.json，恢复页上从此一直挂着一行「no-such-」。
    if (!acc) return { removed: 0, removable: false, notFound: true };

    const before = this.meta.imported.length;
    this.meta.imported = this.meta.imported.filter((x) => x.id !== key);
    const removable = acc.sources.length === 1 && acc.sources[0] === 'imported';

    if (removable) {
      delete this.meta.labels[key];
      this.meta.disabled = this.meta.disabled.filter((x) => x !== key);
      this.meta.ignored = (this.meta.ignored || []).filter((x) => x !== key);
      this.accounts.delete(key);
      this.save();
      return { removed: before - this.meta.imported.length, removable: true };
    }

    // 磁盘发现的号：进忽略名单（顺带进停用名单，双保险）。
    // 顺手把当前别名存下来 —— 忽略名单要靠它显示成人看得懂的名字，
    // 否则恢复页上只能看到 `a1b2c3d4` 这种 ID 前缀，认不出是哪个号。
    if (acc?.label) this.meta.labels[key] = acc.label;
    this.meta.ignored = [...new Set([...(this.meta.ignored || []), key])];
    this.meta.disabled = [...new Set([...this.meta.disabled, key])];
    this.accounts.delete(key); // 立刻从面板消失，不用等下一轮扫描
    this.save();
    return { removed: 0, removable: false, ignored: true };
  }

  /**
   * 取消忽略：把号放回扫盘范围，并在下一次 scan() 把它带回来。
   * 默认顺带启用 —— 用户既然要把它找回来，多半就是想用它。
   */
  restore(id, { enable = true } = {}) {
    const key = String(id || '');
    if (!key) return false;
    const list = this.meta.ignored || [];
    if (!list.includes(key)) return false;
    this.meta.ignored = list.filter((x) => x !== key);
    if (enable) this.meta.disabled = this.meta.disabled.filter((x) => x !== key);
    this.save();
    return true;
  }

  /** 面板用：当前被忽略（删掉过）的账号，带别名方便辨认 */
  ignoredList() {
    return (this.meta.ignored || []).map((id) => ({
      id,
      label: this.meta.labels[id] || '',
      short: shortId(id),
    }));
  }

  /** 记录一次调用结果，用于号池健康度 */
  markResult(id, ok) {
    const acc = this.accounts.get(String(id || ''));
    if (!acc) return;
    acc.stats = acc.stats || { ok: 0, fail: 0, lastAt: 0 };
    if (ok) acc.stats.ok += 1;
    else acc.stats.fail += 1;
    acc.stats.lastAt = Date.now();
  }

  status() {
    const list = [...this.accounts.values()];
    return {
      total: list.length,
      enabled: list.filter((a) => a.enabled).length,
      healthy: list.filter((a) => a.health.state === 'ok').length,
      expired: list.filter((a) => a.health.state === 'expired').length,
      credentials: list.filter((a) => a.enabled).reduce((n, a) => n + a.credentials.length, 0),
      lastScanAt: this.lastScanAt,
      dpapi: dpapiStatus(),
      warnings: this.warnings,
    };
  }
}

/* ------------------------------------------------------------------ 内部 */

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function defaultLabel(acc) {
  if (acc.profile?.userName) return acc.profile.userName;
  const region = acc.profile?.region ? ` · ${acc.profile.region}` : '';
  return `账号 ${acc.short}${region}`;
}

export function evaluateHealth(acc) {
  const now = Date.now();
  const exp = acc.profile?.expiresAt || 0;
  if (!acc.enabled) return { state: 'disabled', label: '已停用', detail: '' };
  if (acc.credentials.length === 0) return { state: 'nocred', label: '无凭据', detail: '该账号还没产生凭据' };
  if (exp && exp < now) {
    // 过期的是**签名用**的临时 AK/SK（只有 24 小时）。请求本身走的是不失效的
    // Basic 凭据，所以这种号**还能正常转发**，只是积分/签到读不出来。
    // 标成红色的「已过期」会让用户以为整个号废了 —— 实际不是。
    const usable = acc.credentials.some((c) => c.authorization || c.authPreview);
    if (usable) {
      return {
        state: 'expired',
        label: '可用 · 待续期',
        detail: `转发正常；积分需重新登录一次（签名凭据过期于 ${new Date(exp).toLocaleString('zh-CN')}）`,
      };
    }
    return { state: 'expired', label: '已过期', detail: `过期于 ${new Date(exp).toLocaleString('zh-CN')}` };
  }
  if (exp) {
    const left = exp - now;
    // 余量只有 55 分钟时，`Math.floor(left / 3600000)` 会得到 0 ——
    // 界面上就变成「已自动续期 / 凭据剩 0 小时」，和旁边「55 分」的倒计时自相矛盾。
    // 一分钟以下按分钟说，别把不足一小时的余量抹成 0。
    const mins = Math.max(0, Math.round(left / 60000));
    const h = Math.floor(mins / 60);
    const leftText =
      h >= 24 ? `${Math.floor(h / 24)} 天 ${h % 24} 小时`
        : h > 0 ? `${h} 小时${mins % 60 ? ` ${mins % 60} 分` : ''}`
          : `${mins} 分`;
    // 续期换回来的凭据要标出来：不然看档案上的旧时间会以为早就该过期了
    if (acc.profile?.refreshed) return { state: 'ok', label: '已自动续期', detail: `凭据剩 ${leftText}` };
    return { state: 'ok', label: '有效', detail: `剩 ${leftText}` };
  }
  return { state: 'unknown', label: '未知', detail: '拿不到过期时间（安装密钥解不开）' };
}

/**
 * 这个账号 ID 长得像**真实**账号吗？
 *
 * 真实形态是 `<32位hex>:<32位hex>`（accountId:userId），两个 id 都是
 * 32 位小写十六进制。用正则卡一道，是为了挡住两种会污染盘的数据：
 *   - 桌面端授权过程中上报的临时 userId，形如 `pending-<64位hex>`；
 *   - 任何测试 / 手工调用写进来的假 id（历史上出现过 `no-such-account:0`）。
 * 它们都会以"幽灵别名"的形式长期留在 accounts.json 的 labels 里。
 */
export function isRealAccountId(id) {
  return /^[0-9a-f]{32}:[0-9a-f]{32}$/.test(String(id || '').trim());
}

/** models.json 里模型清单可能挂在 defaults / 各 provider 下，这里统一捞出来 */
function collectModelLists(doc) {
  const lists = [];
  if (Array.isArray(doc.defaults)) lists.push(doc.defaults);
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'defaults' || key === '_meta') continue;
    if (Array.isArray(value)) lists.push(value);
    else if (value && typeof value === 'object' && Array.isArray(value.entries)) lists.push(value.entries);
  }
  return lists;
}
