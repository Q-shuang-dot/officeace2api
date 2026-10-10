import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  listen: { host: '127.0.0.1', port: 7864 },
  apiKeys: ['sk-officeace'],
  upstream: {
    autoDiscover: true,
    refreshSeconds: 45,
    baseUrl: '',
    authorization: '',
    extraHeaders: {},
    alwaysStreamUpstream: true,
    includeUsage: true,
    timeoutSeconds: 600,
    maxRetries: 3,
    retryBackoffMs: 1200,
  },
  discover: { installDirs: [] },
  models: {
    alias: {},
    hidden: [],
    extra: [],
    // 推理模型的「推理预算」：客户端要多少，就额外再给这么多 token 让它推理。
    // 设 0 = 完全不动客户端的参数。
    //
    // 为什么需要：这类模型先花几百 token 推理再吐正文，客户端按老习惯给
    // max_tokens:64 的话预算会被推理全吃掉，返回 content:"" + finish_reason:"length"，
    // 客户端拿到 200 和空正文，只会以为反代坏了。
    //
    // 为什么是「追加」而不是「设下限」：客户端给 max_tokens:1（真只要一个字）时，
    // 设下限会把正文也放开（实测吐出 369 个 token）；追加式给 1+1024，
    // 正文仍然只有 1 个 token，客户端意图完整保留。
    //
    // 1024 这个数是实测来的（tools/probe-deep41-stability.mjs，同一问题连打 6 次）：
    //   预算 512 → 3/6 次正文为空；768 → 2/6 次；1024 → 0/6；1536 → 0/6
    // 继续加高也没用：2048 那档反而 1/12 空 —— 推理开销是随机的，
    // 所以真正兜底的是"空正文自动重试"，这个预算只是让重试少发生。
    minMaxTokens: 1024,
    // 只给这些模型追加，留空 = 所有模型。
    // 实测（tools/probe-reasoning-models.mjs 扫全目录）**能用的 9 个全是推理模型**，
    // 连 `glm-5.2` 这种名字里毫无提示的，给 max_tokens:64 都能干到 474，
    // 多的一次 8460 —— 靠名字编名单注定漏，所以默认全都算。
    // 想精确控制就填模型名，匹配时忽略大小写和 . _ - 的差异，前缀命中即可。
    reasoningModels: [],
    // 覆盖个别模型的推理预算：{ "qwen3-32b": 0, "glm-5.3": 2048 }
    minMaxTokensByModel: {},
    // ── 「正文为空」重试时用的预算 ────────────────────────────────
    //
    // ⚠️ 这两个数是为了修一个**真的会坏**的 bug：重试原来原样重发同一个
    //    `max_tokens`，而推理开销是随机的 —— 预算不够的话第二次照样不够。
    //    实测（tools/diag-empty-window.mjs）16/64/256 三档各 12 次，
    //    **每档 4 次空正文、共 12/36**，失败的是固定的两个问题。
    //
    // 重试预算 = max(emptyRetryFloorTokens, 上一发的 reasoningTokens + emptyRetryContentTokens)
    //
    //   · `emptyRetryFloorTokens` 是保底：第一次可能只是"轻轻"超了一点，但第二次
    //     推理开销是**独立随机**的 —— 实测同一个问题从 116 到 7328 字符都出现过。
    //     2048 那一版实测还会剩 10/36 空正文（因为观测到的 p90 推理就已经
    //     5396 字符 ≈ 3400 token，超过了 2048）。
    //   · `emptyRetryContentTokens` 是留给正文的空间：在**已知**推理开销之上再加这么多。
    //
    // 抬高预算不额外花钱：上游按实际生成的 token 计费，空正文的失败请求才是真浪费
    // （那一发已经烧掉整整一个预算的推理 token，却什么都没给客户端）。
    emptyRetryFloorTokens: 8192,
    emptyRetryContentTokens: 0,
    // /v1/models 不列「打不通」的模型（默认开）。
    // 实测两个号：目录 34 个里只有 11 个真的能打通，其余 23 个上游回
    // 81004（没权限）/ 81009（名字不认）。全列出来的话客户端会照着一个个试、
    // 试一个错一个。面板永远显示全量并标出它们，所以这里藏了也不丢信息。
    hideUnavailable: true,
    // 模型可用性探测：开机后台跑一遍，把"目录里列着但上游不认"的模型从
    // /v1/models 里去掉。客户端是在打开下拉框那一刻读列表的，所以必须提前探，
    // 不能等用户踩到（学习式黑名单那时还是空的）。
    // 每次探测花掉的 token 极少（每个模型 max_tokens:1），但慢的模型要等它
    // 把推理跑完（glm-5.1/glm-5.2 各 10~14 秒），所以并发跑 + 结果落盘。
    probeOnStartup: true, // 开机 15 秒后跑一次
    probeIntervalSeconds: 21600, // 之后每 6 小时重探一次
    probeTtlMs: 21600000, // 结论多久算过期（6 小时）
    probeConcurrency: 4, // 并发数
  },
  quota: { cooldownOnRateLimitMs: 20000, cooldownOnAuthErrorMs: 300000, credentialPerModelCooldown: true },
  // 积分额度：把「每个号还剩多少积分」从华为云端问出来（V11-HMAC-SHA256 签名）
  credits: {
    enabled: true,
    ttlSeconds: 300, // 面板读缓存，多久算过期
    autoRefreshSeconds: 900, // 后台隔多久自动刷一遍；0 = 只在手动/打开面板时刷
    timeoutMs: 20000,
    region: 'cn-southwest-2',
    gateway: '', // 留空 = 自动探测该账号的专属网关
    history: true, // 记历史快照，用来看消耗速度
    // 凭据自动续期：临时 AK/SK 只有 24 小时，用 refresh_token（能撑 30 天）自动换新的
    autoRefreshCredentials: true,
    refresh: {
      tokenUrl: 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens',
      clientId: 'pdp5_for_agentarts',
      timeoutMs: 25000,
    },
    // 每日自动签到领积分
    autoClaim: {
      enabled: true,
      hour: 9, // 每天几点（本机时间）跑一次
      minute: 5,
    },
    // 积分熔断：余额见底的号在冷却期内不再被挑中（0 = 关掉）
    cooldownOnEmptyCreditsMs: 600000,
    // 余额低于这个数就在日志里告警（0 = 不告警）
    lowBalanceWarn: 200,
  },
  log: { level: 'info', keepRecent: 300 },
  admin: { enabled: true, token: '' },
  // 号池：把本机（和手工导入的）账号聚合成一等公民
  accounts: {
    enabled: true,
    rescanSeconds: 60,
    onlyEnabled: true, // 只把「已启用」账号的凭据喂给上游连接池
  },
  // 一键授权：默认自动探测本机 OfficeAce API，留空走内置候选列表
  auth: {
    appApis: [],
    pollSeconds: 3,
    stateTtlMinutes: 10,
  },
  // 批量注册 / 开通
  register: {
    enabled: true,
    registerUrl: 'https://reg.huaweicloud.com/registerui/register.html',
    concurrency: 1,
    maxAttempts: 3,
    autoAuth: true,
    tickSeconds: 5,
    sms: {
      // manual —— 面板里手工填码；http —— 接码平台；fixed —— 固定码（自建环境）
      provider: 'manual',
      fixedCode: '',
      http: {
        urlTemplate: '',
        project: '',
        method: 'GET',
        codePath: 'data.code',
        headers: {},
        timeoutMs: 20000,
      },
    },
    activation: {
      autoActivate: true,
      promotionCodes: [],
      waitBeforeAuthMs: 8000,
    },
  },
};

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override ?? base;
  if (typeof base !== 'object' || base === null) return override ?? base;
  if (typeof override !== 'object' || override === null) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function loadConfig(configPath) {
  const file = configPath ? path.resolve(configPath) : path.resolve(process.cwd(), 'config.json');
  let raw = {};
  try {
    // 记事本/PowerShell 写出的 UTF-8 可能带 BOM，JSON.parse 会直接报错，这里统一剥掉
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    raw = JSON.parse(text);
  } catch (err) {
    if (fs.existsSync(file)) throw new Error(`config.json 解析失败: ${err.message}`);
  }
  const config = deepMerge(DEFAULTS, raw);

  if (process.env.OFFICEACE2API_PORT) config.listen.port = Number(process.env.OFFICEACE2API_PORT);
  if (process.env.OFFICEACE2API_HOST) config.listen.host = process.env.OFFICEACE2API_HOST;
  if (process.env.OFFICEACE2API_KEYS) {
    config.apiKeys = process.env.OFFICEACE2API_KEYS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (process.env.OFFICEACE2API_BASE_URL) config.upstream.baseUrl = process.env.OFFICEACE2API_BASE_URL;
  if (process.env.OFFICEACE2API_AUTHORIZATION) config.upstream.authorization = process.env.OFFICEACE2API_AUTHORIZATION;

  config.__file = file;
  return config;
}

export function saveConfig(config) {
  const file = config.__file;
  if (!file) return;
  const clone = { ...config };
  delete clone.__file;
  fs.writeFileSync(file, JSON.stringify(clone, null, 2));
}
