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
    // 所有模型的 max_tokens 下限。设 0 = 完全不动客户端的参数（不改写）。
    //
    // 初衷只是给推理模型兜底，但实测（tools/probe-reasoning-models.mjs，34 个模型全扫）
    // 发现**能用的一共就 9 个，9 个全是推理模型** —— 连 `glm-5.2` 这种名字里
    // 毫无提示的，给 max_tokens:64 时 completion_tokens 都能干到 474，多的一次 8460。
    // 靠"名字像推理模型"编名单永远会漏，所以默认就对所有模型生效。
    //
    // 1024 这个数是实测来的（tools/probe-deep41-stability.mjs，同一问题连打 6 次）：
    //   512  → 3/6 次正文为空      768  → 2/6 次
    //   1024 → 0/6                 1536 → 0/6
    // 而且继续加高也没用：2048 那档反而是 1/12 空 —— 推理开销是随机的，
    // 所以真正兜底的是下面那条"空正文自动重试"，这个下限只是让重试少发生。
    minMaxTokens: 1024,
    // 只给这些模型抬升，留空 = 所有模型（推荐的默认）。
    // 想精确控制就填模型名，匹配时忽略大小写和 . _ - 的差异，前缀命中即可
    // （填 deepseek-v4-flash 会顺带覆盖 deepseek-v4-flash-0731）。
    reasoningModels: [],
    // 覆盖个别模型的下限：{ "qwen3-32b": 0, "glm-5.3": 4096 }
    minMaxTokensByModel: {},
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
