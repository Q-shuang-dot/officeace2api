import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * 生成一个面板口令。
 *
 * 用 `randomBytes` 而不是 `Math.random()` —— 这个是**真的**要当密码用的，
 * 而 `Math.random()` 是可预测的（V8 的 xorshift128+，看到几个输出就能推后续）。
 * 24 字节 base64url ≈ 32 个字符、192 bit，爆破不现实。
 */
export function generateAdminToken() {
  return randomBytes(24).toString('base64url');
}

/**
 * 面板口令为空就补一个，并持久化。
 *
 * 为什么要有这一步：`admin.token` 的默认值是空字符串，而路由里那条
 * 校验是 `if (isAdminRoute && config.admin?.token && ...)` ——
 * 也就是说**口令为空 = 完全不校验**。本机自己用没事，可一旦把这个服务
 * 给别人用（改成监听 0.0.0.0、或者放内网），那就是：
 *
 *   · 任何人打开 `http://<你的IP>:7864/admin` 就是完整管理面板；
 *   · `/admin/api/*` 更是**一条请求都不用带凭据**就能读能改 ——
 *     实测不带头也能拿到 70.8KB 的 `/admin/api/state`（含账号标签、
 *     baseUrl、积分、调用记录），而且改设置、改模型别名这些写接口同样不设防。
 *
 * 所以第一次启动时自动生成一个、写进 config.json、并让调用方打印出来。
 * 想关掉（纯本机自用）就把 `admin.token` 手动改回空字符串 —— 那时
 * 校验逻辑会跳过，和以前一样。
 */
export function ensureAdminToken(config) {
  if (config.admin?.token) return null;
  const token = generateAdminToken();
  config.admin = { ...(config.admin || { enabled: true }), token };
  return token;
}

const DEFAULTS = {
  listen: { host: '127.0.0.1', port: 7864 },
  apiKeys: ['sk-officeace'],
  upstream: {
    autoDiscover: true,
    refreshSeconds: 45,
    baseUrl: '',
    authorization: '',
    extraHeaders: {},
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
    // ── 发给上游的 `max_tokens` 硬上限 ─────────────────────────────
    //
    // 上游自己有范围，而且**各家不一样**（都是实测出来的原文）：
    //   glm-5.x    → `max_tokens参数非法：限制数值范围[1,131072]`
    //   qwen3-32b  → `maximum context length is 131072`，且 max_tokens 和提示词
    //                一起算，所以别按上下文满编，留出提示词的余量
    //   deepseek / kimi → 393216 以内都收
    //
    // 为什么需要：上面那套「推理预算」是**加法**。客户端给的正好是上游上限时
    // 会被顶出去 —— 393216 + 1024 = 394240 → 400 ModelArts.81001，而且请求不变
    // 打一百遍一样被拒（确定性失败，客户端只会觉得"反代一直是坏的"）。
    // 实测被 VS Code + 网关那条链路踩中：网关按 maxOutputTokens 声明能力，
    // 客户端照着 393216 发，到这儿被加成 394240。
    //
    // 所以追加之后再夹一道上限。"夹上限"不改客户端的小请求，只在客户端要得比
    // 上游能给的还多时收敛到上游能给的值；客户端没给 max_tokens 时不凭空造。
    // 设 0 = 不夹（原样透传客户端的值）。
    maxMaxTokens: 393216,
    // 按模型/模型族覆盖上限，前缀命中（填 `glm-5` 覆盖 glm-5.1/5.2/5.3，
    // 填 `qwen3` 覆盖 qwen3-32b/qwen3-30b-a3b），多个键命中取最长的那个。
    maxMaxTokensByModel: {},
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
    /*
     * 自动续期的三个旋钮 —— index.mjs 一直在读它们，但**默认值里以前没有**，
     * 只有 config.example.json 和文档里写了。后果是：config.json 里写了这几项的人
     * 会被告警说"代码不认识的配置项"（新加的启动检查），而实际上代码是认的。
     * 默认值必须和文档/示例一致，别让三处各说各话。
     */
    autoRenewCredentials: true, // 总开关
    renewLeadRatio: 0.25, // 提前量 = 本轮寿命 × 这个比例（代码里夹在 0.02~0.9）
    renewBeforeHours: 3, // 提前量的上限（24 小时的寿命别为"剩 6 小时"白换一份）
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
      // manual —— 面板里手工填码；http —— 接码平台
      provider: 'manual',
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

/**
 * 找出「配置文件里有、DEFAULTS 里没有」的项（返回点分路径）。
 *
 * 为什么要有这个：本项目连着撞到**三条死配置** —— 写了、文档里也写了、
 * 示例里也有，但代码里根本没人读：
 *
 *   accounts.rescanSeconds      （号池扫描听的是 upstream.refreshSeconds）
 *   auth.pollSeconds            （真正生效的是 regTimer 的 5 秒）
 *   register.sms.fixedCode      （sms.provider 只实现了 manual / http）
 *
 * 填了不生效比不写更坏：它会让人以为「我调过了」。启动时把这类项 warn 一下，
 * 名字写错当场就能看见，而不是等哪天发现"改了配置没反应"。
 *
 * ⚠️ 这只查得出"文件里有、默认里没有"。反过来那种「默认里有、文件里也有、
 *    但代码没人读」的死配置，靠 `tools/test-admin.mjs` 里的配置卫生测试守。
 */
export function unknownConfigKeys(raw, base = DEFAULTS, prefix = '') {
  const out = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const root = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('__')) continue; // 内部字段（__file / __unknownKeys）不算配置
    const key = prefix ? `${prefix}.${k}` : k;
    if (!(k in root)) {
      out.push(key);
      continue;
    }
    const baseVal = root[k];
    /*
     * 默认值是**空对象** = 开放映射，键由用户自己定，不递归检查。
     *
     * 这条是正对照实测出来的：`maxMaxTokensByModel: {}` 那种表，
     * 用户往里写 `glm-5` / `qwen3` 本来是**对的**，递归下去却会报
     * 「maxMaxTokensByModel.glm-5 是代码不认识的配置项」—— 一条假告警。
     * 会喊狼来了的告警比没有告警更坏：真写错名字那次就没人看了。
     * 同类还有 `models.alias` / `upstream.extraHeaders`。
     */
    const openMap =
      baseVal && typeof baseVal === 'object' && !Array.isArray(baseVal) && Object.keys(baseVal).length === 0;
    if (!openMap && v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...unknownConfigKeys(v, baseVal, key));
    }
  }
  return out;
}

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
  // 配置这一层还没有 logger，先挂上去，等 index.mjs 起来之后 warn
  config.__unknownKeys = unknownConfigKeys(raw);
  return config;
}

export function saveConfig(config) {
  const file = config.__file;
  if (!file) return;
  const clone = { ...config };
  delete clone.__file;
  // 必须一起删掉：否则面板一保存，这个内部字段就被写进 config.json，
  // 下次启动它自己又变成一条"不认识的配置项"。
  delete clone.__unknownKeys;
  fs.writeFileSync(file, JSON.stringify(clone, null, 2));
}
