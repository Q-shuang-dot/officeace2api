#!/usr/bin/env node
/**
 * officeace2api —— 把本机 OfficeAce（果办）客户端的模型网关反代成标准 OpenAI 接口
 *
 *   node src/index.mjs [--config ./config.json] [--dump]
 */

import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, ensureAdminToken } from './config.mjs';
import { configureLogger, createLogger, localZone } from './logger.mjs';
import { discover } from './discover.mjs';
import { CredentialPool } from './pool.mjs';
import { ModelRegistry } from './models.mjs';
import { UsageStore } from './stats.mjs';
import { createApp } from './server.mjs';
import { fingerprintOf } from './fingerprint.mjs';
import { buildIgnoredIdSet, isIgnoredCredential, ignoredSignature } from './discoverFilter.mjs';
import { AccountStore } from './accounts.mjs';
import { AuthFlow } from './authflow.mjs';
import { LoginFlow } from './oauth.mjs';
import { RegisterQueue } from './register.mjs';
import { QuotaService } from './quota.mjs';
import { backfillGatewayCredentials } from './gatewayKey.mjs';
import { ModelProbe } from './modelProbe.mjs';

const VERSION = '1.0.0';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { config: path.join(ROOT, 'config.json'), dump: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config' || a === '-c') out.config = path.resolve(argv[++i]);
    else if (a === '--dump') out.dump = true;
    else if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`officeace2api v${VERSION}

用法:
  node src/index.mjs [选项]

选项:
  -c, --config <file>   指定配置文件（默认 ./config.json）
  -p, --port <port>     覆盖监听端口
      --dump            只打印发现到的凭据与模型，然后退出
  -h, --help            显示帮助

环境变量:
  OFFICEACE2API_PORT / OFFICEACE2API_HOST / OFFICEACE2API_KEYS
  OFFICEACE2API_BASE_URL / OFFICEACE2API_AUTHORIZATION
  OFFICEACE_MODELS_JSON（手工指定 models.json 路径）
`);
  process.exit(0);
}

const config = loadConfig(args.config);
if (args.port) config.listen.port = args.port;
/*
 * 面板口令为空就补一个（并写回 config.json）。
 *
 * 空口令 = 面板和 `/admin/api/*` **完全不校验**，本机自用无所谓，
 * 给别人用就是门户大开。所以第一次启动自动生成一个。
 * 想关掉：把 config.json 里 `admin.token` 手动改回 `""`。
 */
const generatedAdminToken = ensureAdminToken(config);
if (generatedAdminToken) saveConfig(config);
const LOG_FILE = path.join(ROOT, 'logs', 'server.log');
// 单实例锁：一个数据目录只能有一个服务在跑，见 acquireInstanceLock()
const LOCK_FILE = path.join(ROOT, 'data', 'instance.lock');
configureLogger({
  ...config.log,
  file: LOG_FILE,
});
const log = createLogger('boot');

/*
 * 配置里出现代码不认识的项就说一声 —— 放在**最前面**（紧跟 logger）。
 *
 * 两个原因：① 配置问题越早说越好，别让人爬到服务起来之后才发现；
 * ② 单实例保护会把第二个实例挡在 `listen` 之前，告警要是写在 `listen` 回调里，
 *    换个入口启动就看不见了（正是它自己的正对照实测出来的）。
 *
 * 这个项目连着撞到三条**死配置**（写了、文档里也有，但没人读）：
 * `accounts.rescanSeconds` / `auth.pollSeconds` / `register.sms.fixedCode`。
 * 填了不生效比不写更坏 —— 它会让人以为「我调过了」，然后去别处找原因。
 */
if (config.__unknownKeys?.length) {
  log.warn('config.json 里有代码不认识的配置项（写错名字了？改了不会生效）', {
    keys: config.__unknownKeys,
  });
}

// 日志时间一律按本机时区显示。先把「哪个区」说清楚 —— 以前是 UTC，面板上比
// 本机时间慢 8 小时，看日志的人得先做一次心算才知道那是几点发生的事。
log.info('日志时间使用本机时区', { zone: localZone(), file: LOG_FILE });

const usageFile = path.join(ROOT, 'data', 'usage.json');
const usage = new UsageStore({ file: usageFile });

const pool = new CredentialPool({
  cooldownOnRateLimitMs: config.quota?.cooldownOnRateLimitMs ?? 20000,
  cooldownOnAuthErrorMs: config.quota?.cooldownOnAuthErrorMs ?? 300000,
  perModelCooldown: config.quota?.credentialPerModelCooldown !== false,
});

const registry = new ModelRegistry(config.models || {});

/* --------------------------------------------------------------- 号池 */

const accountStore = new AccountStore({
  dataFile: path.join(ROOT, 'data', 'accounts.json'),
  installDirs: config.discover?.installDirs || [],
});
accountStore.load();
accountStore.scan();

// 积分额度：从华为云把「每个号还剩多少积分」问出来（带缓存 + 凭据自动续期）
// onUpdate 把余额推给连接池，用来做「积分熔断」——见底的号不再被挑中
const credits = new QuotaService({
  accounts: accountStore,
  config: {
    ...(config.credits || {}),
    onUpdate: (list) => {
      try {
        pool.setCredits(list);
        if (config.credits?.lowBalanceWarn > 0) {
          for (const item of list) {
            if (item.ok && item.remaining !== null && item.remaining <= config.credits.lowBalanceWarn) {
              const acc = accountStore.get(item.id);
              log.warn('积分余额偏低', { account: acc?.label || item.id, remaining: item.remaining });
            }
          }
        }
      } catch (err) {
        log.debug('积分熔断数据推送失败', { error: err.message });
      }
    },
  },
  historyFile: config.credits?.history !== false ? path.join(ROOT, 'data', 'quota-history.json') : '',
  refreshStateFile: path.join(ROOT, 'data', 'refresh-state.json'),
});
pool.setEmptyCreditsCooldown(config.credits?.cooldownOnEmptyCreditsMs ?? 600000);

// 把续期链状态接给号池：`AccountStore.applyRearmedToken(..., { markConsumed: true })`
// 要靠它推进「磁盘 token 已被消费」的锚点。不接上的话，续期成功后锚点不动，
// 下一轮会误判链子烧穿、拿登录 token 反复上膛，把一次性 refresh_token 白白烧光。
accountStore.refreshState = credits.refreshState;

const authFlow = new AuthFlow({
  accounts: accountStore,
  appApis: config.auth?.appApis || [],
  // 问云端同一 state 的节奏。这条配置以前没人读（死配置），真正生效的是
  // regTimer 的 5 秒 + 注册状态机 + 面板 + 桌面端四路叠加，直接把 state
  // 问进云端的限流里（AgentArts.1100011）。
  pollSeconds: config.auth?.pollSeconds,
  // 授权链接的有效期。同样是死配置 —— 代码里原本写死 10 分钟，改配置不生效。
  stateTtlMinutes: config.auth?.stateTtlMinutes,
  onBound: async (task) => {
    // 一键授权进来的号只有档案、没有网关凭据 —— 先补上再重新发现，
    // 否则下一次发现会把这个"没有凭据的号"原样扫进来，用户以为加成功了却用不了。
    if (task?.newAccountId) {
      try {
        const r = await backfillGatewayCredentials({
          accounts: accountStore,
          credits,
          ids: [task.newAccountId],
        });
        if (r.filled) log.info('一键授权后已补上网关凭据', { id: task.newAccountId });
        else if (r.failed) log.warn('一键授权后没能补上网关凭据，这个号暂时只能读额度', { id: task.newAccountId });
      } catch (err) {
        log.warn('一键授权后补凭据异常', { id: task.newAccountId, error: err.message });
      }
    }
    runDiscovery('auth-bound');
  },
});

/**
 * 自助登录：自己跑 OAuth，不依赖 OfficeAce 桌面端。
 * 登录成功后账号直接进号池，并重建连接池。
 */
const loginFlow = new LoginFlow({
  accounts: accountStore,
  config: {
    ...(config.credits || {}),
    refresh: config.credits?.refresh || {},
    // 云端地址留个可改的口，万一以后换 region 不用改代码
    cloudBase: config.credits?.cloudBase,
    authBase: config.credits?.authBase,
    redirectUri: config.credits?.redirectUri,
  },
  sessionFile: path.join(ROOT, 'data', 'login-sessions.json'),
  accountFile: path.join(ROOT, 'data', 'oauth-accounts.json'),
  onDone: () => runDiscovery('oauth-login'),
});

const registerQueue = new RegisterQueue({
  getConfig: () => config.register || {},
  authFlow,
  accounts: accountStore,
  // 任务落盘：重启不再把整条队列丢掉（在途任务会被标成「中断，可重试」，见 load()）
  dataFile: path.join(ROOT, 'data', 'register-tasks.json'),
  onDone: () => runDiscovery('register-done'),
});

/** 把「已启用账号」的凭据摊平成连接池需要的形状 */
function poolCredentialsFromAccounts() {
  const out = [];
  const seen = new Set();
  const onlyEnabled = config.accounts?.onlyEnabled !== false;
  const source = onlyEnabled
    ? accountStore.enabledCredentials()
    : [...accountStore.accounts.values()].flatMap((a) =>
        a.credentials.map((c) => ({ ...c, accountId: a.id, accountLabel: a.label })),
      );
  for (const c of source) {
    const fp = `${c.baseUrl}||${c.authorization}`;
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push({
      baseUrl: c.baseUrl,
      headers: { Authorization: c.authorization },
      source: c.source,
      userId: c.accountId,
      accountId: c.accountId,
      accountLabel: c.accountLabel,
      models: c.models || [],
      provider: c.provider || 'OpenAI',
    });
  }
  return out;
}

let lastDiscoveryAt = 0;
// 上一次「忽略名单拦下」的那批凭据指纹（见 runDiscovery 里那段说明）
let lastIgnoredSig = '';

/**
 * 「凭据发现完成」的日志：和号池扫描一个规矩 —— **只看变化**。
 *
 * 这行原来是每 45 秒无条件 INFO。实测 34 分钟 228 条日志里有 46 条是它，内容一字
 * 不差（`credentials:2 / accounts:2 / added:0 / catalog:47`）；加上同样重复的
 * 「忽略名单拦下…」46 条、`discover done` 的 DEBUG 53 条，**一共占了 63%**，
 * 真正的事件（新号授权进来、注册完成、上游目录变了）全被埋在里头。
 *
 *   reason 不是 interval（说明刚发生了某件事）→ 一律 INFO
 *   interval 且数字变了（有基线）            → INFO，并带上变化前的数字
 *   interval 且一字没变                      → DEBUG 心跳，最多 5 分钟一条
 *
 * 心跳不能省：没有它就看不出「发现这条链还活着没有」。
 */
const DISCOVERY_HEARTBEAT_MS = 5 * 60 * 1000;
let lastDiscoverySummary = null;
let lastDiscoveryBeatAt = 0;

function logDiscoveryResult(summary) {
  const before = lastDiscoverySummary;
  const same = before
    && before.credentials === summary.credentials
    && before.accounts === summary.accounts
    && before.catalog === summary.catalog
    && before.added === summary.added;
  lastDiscoverySummary = summary;
  if (!(summary.reason === 'interval' && same)) {
    log.info('凭据发现完成', before ? { ...summary, was: before } : summary);
    lastDiscoveryBeatAt = Date.now();
    return;
  }
  if (Date.now() - lastDiscoveryBeatAt >= DISCOVERY_HEARTBEAT_MS) {
    lastDiscoveryBeatAt = Date.now();
    log.debug('凭据发现完成（无变化）', {
      credentials: summary.credentials,
      accounts: summary.accounts,
    });
  }
}

function runDiscovery(reason = 'startup') {
  // 先扫号池，号池是凭据的第一来源（带启用开关和账号归属）
  let accountCreds = [];
  if (config.accounts?.enabled !== false) {
    try {
      // 只有周期刷新这一路是「看看有没有变」，可以合并同一秒里的重复扫描
      // （它每 45 秒本来就会再来一次）。其余 reason 都表示**刚发生了某件事** ——
      // 删除 / 恢复 / 导入 / 授权完成 / 面板按钮 / 配置改动 —— 必须拿到此刻的真实状态。
      accountStore.scan({ cached: reason === 'interval' });
      accountCreds = poolCredentialsFromAccounts();
      // 新冒出来的账号（刚授权 / 刚注册完）顺手把积分也拉一次
      if (config.credits?.enabled !== false) {
        for (const id of accountStore.ids()) {
          if (!credits.cache.has(id)) {
            credits.get(id, { force: true }).catch((err) => log.debug('新账号积分拉取失败', { id, error: err.message }));
          }
        }
      }
    } catch (err) {
      log.warn('号池扫描失败', { error: String(err?.message || err) });
    }
  }

  const result = discover({ installDirs: config.discover?.installDirs || [] });
  registry.setDiscovered(result.catalog);

  // 号池是账号归属的唯一权威：被停用的账号，即使磁盘上还留着 models.json，
  // 也不能被 discover() 重新捞回连接池。
  const useAccounts = config.accounts?.enabled !== false;
  const norm = (v) => {
    try {
      return decodeURIComponent(String(v || ''));
    } catch {
      return String(v || '');
    }
  };
  const disabled = new Set(
    [...accountStore.accounts.values()].filter((a) => !a.enabled).map((a) => norm(a.id)),
  );
  const legacy = useAccounts
    ? result.credentials.filter((c) => !c.userId || !disabled.has(norm(c.userId)))
    : result.credentials;

  // ⚠️ 「已删除（忽略）」的号必须在这最后一道关口也拦掉。
  //
  // 号池的 ignored 名单只在 accountStore.scan() 里生效，而 discover() 是**另写一遍**
  // 的读盘逻辑，压根不知道这张名单 —— 它会把同一个 models.json 里的 Basic 凭据
  // 重新抠出来当 legacy 凭据。结果就是：面板上点「删除」之后号消失了，
  // 但连接池里那条凭据还在正常收发请求（真实踩过：删掉的号还在扣积分）。
  const ignoredIds = useAccounts
    ? buildIgnoredIdSet([...(accountStore.meta?.ignored || [])].map((id) => norm(id)))
    : new Set();
  const droppedKeys = [];
  const effectiveLegacy = ignoredIds.size
    ? legacy.filter((c) => {
      if (!isIgnoredCredential(c, ignoredIds)) return true;
      droppedKeys.push(c);
      return false;
    })
    : legacy;
  const droppedIgnored = droppedKeys.length;
  // 「忽略名单拦下已删除账号的凭据」是**稳态**，不是事件：只要你删过一个号，它那份
  // models.json 还留在盘上，于是每一轮（45 秒）都会拦下同一条 —— 实测 34 分钟里这句
  // 重复了 46 次。所以按「拦下的那批凭据有没有变」说话：变了（又删了一个号 / 恢复了
  // 一个号）才 INFO，没变就闭嘴。
  //
  // ⚠️ 签名拼接一定要走 ignoredSignature()（它带条数前缀）。当初在这里写
  // `droppedKeys.map(c => c.key).join(',')` 踩了个坑：discover() 返回的凭据上**没有
  // `key`**（那是进池时才算的），`[undefined].join(',')` 在 JS 里是空串，签名于是
  // 恒等于初始的 ''，**第一条永远打不出来** —— 启动日志里这条直接消失，看着像保护
  // 没生效（实际拦下了）。
  const ignoredSig = ignoredSignature(droppedKeys);
  if (droppedIgnored > 0 && ignoredSig !== lastIgnoredSig) {
    lastIgnoredSig = ignoredSig;
    log.info('忽略名单拦下已删除账号的凭据', { count: droppedIgnored, reason });
  }

  const all = [...accountCreds, ...effectiveLegacy];
  let added = 0;
  for (const cred of all) {
    if (pool.add(cred)) added += 1;
  }

  // 配置里手工指定的凭据
  if (config.upstream?.baseUrl && config.upstream?.authorization) {
    const manual = {
      baseUrl: config.upstream.baseUrl,
      headers: { Authorization: config.upstream.authorization, ...(config.upstream.extraHeaders || {}) },
      source: 'config.json',
      userId: '',
      models: [],
    };
    if (pool.add(manual)) added += 1;
    all.push(manual);
  }

  const validKeys = new Set(all.map((c) => fingerprintOf(c)));
  // 忽略（已删除）账号的凭据：即使上面哪条路径漏进来了，也在这里点名剔掉，
  // 免得「删掉之后还在用」这种事复发。
  for (const c of [...pool.list()]) {
    if (!isIgnoredCredential(c, ignoredIds)) continue;
    validKeys.delete(c.key);
    pool.removeByKey(c.key);
  }
  // 号池启用时，连接池必须严格等于「已启用账号的凭据集合」——
  // 所以哪怕算出来是空集也要 retain（allowEmpty），否则停用账号后旧凭据会留在池子里继续被用。
  pool.retain(validKeys, { allowEmpty: useAccounts });

  lastDiscoveryAt = Date.now();
  logDiscoveryResult({
    reason,
    credentials: pool.size,
    accounts: accountStore.size(),
    added,
    catalog: result.catalog.length,
  });
  return added;
}

runDiscovery('startup');

// 开机补一轮网关凭据：把历史上通过「一键授权」进来、只有档案没有凭据的号修好。
// 不 await —— 这要打控制面，不该拖慢启动；补好之后自己会重新发现一次。
backfillGatewayCredentials({ accounts: accountStore, credits })
  .then((r) => {
    if (r.checked === 0) return;
    log.info('开机补网关凭据完成', { checked: r.checked, filled: r.filled, failed: r.failed, skipped: r.skipped });
    if (r.filled) runDiscovery('backfill');
  })
  .catch((err) => log.warn('开机补网关凭据异常', { error: err.message }));

if (pool.size === 0) {
  /*
   * 零凭据时的引导。
   *
   * ⚠️ 原文是「请先登录并运行一次 OfficeAce 桌面端（发起一次对话），再重启本服务」——
   * 这对着**装了桌面端、只是还没登录**的人是对的，但对"拉了这个项目、根本没装
   * OfficeAce"的人（也就是只想自己加个号的人）就成了死胡同：他照做也没得做。
   *
   * 必须把「面板里自助登录」摆在第一位 —— 那条路不需要桌面端，
   * 只要一个华为云账号。桌面端那条降为备选，说清它还额外要求跑一次对话。
   */
  log.warn('未发现任何凭据：打开控制台点「换个账号登录」即可（不需要 OfficeAce 桌面端）');
  console.log('');
  console.log('  ────────────────────────────────────────────────');
  console.log('  ⚠️  现在一个可用的号都没有，反代没法转发任何请求。');
  console.log('     下一步（二选一）：');
  console.log('       ① 打开控制台 → 「号池」页 → 点「换个账号登录」，用你自己的');
  console.log('          华为云账号登录一次就行（不需要装 OfficeAce 桌面端）。');
  console.log('       ② 或者如果你已经装过 OfficeAce：登录它、发一次对话，');
  console.log('          然后重启本服务，会自动把凭据抠出来。');
  if (config.admin?.token) {
    /*
     * 面板地址不能直接拿 `listen.host` 拼 —— 监听 `0.0.0.0` 时那个地址
     * 浏览器打不开（0.0.0.0 是"所有网卡"的意思，不是能访问的主机名）。
     * 本机自己开面板一律用 127.0.0.1，监听宽了就再补一句提示。
     */
    const p = config.listen.port;
    console.log(`     控制台地址：http://127.0.0.1:${p}/admin?token=${config.admin.token}`);
    const host = String(config.listen.host || '');
    if (host && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
      console.log(`     （服务监听在 ${host}，别人也能连；面板地址换成他的机器 IP + :${p} 即可）`);
    }
  }
  console.log('  ────────────────────────────────────────────────');
  console.log('');
}

const modelProbe = new ModelProbe({
  dataFile: path.join(ROOT, 'data', 'model-probe.json'),
  config: config.models || {},
  pool,
  registry,
  log,
  usage,
});

const ctx = {
  config,
  pool,
  registry,
  usage,
  accounts: accountStore,
  authFlow,
  loginFlow,
  register: registerQueue,
  credits,
  modelProbe,
  startedAt: Date.now(),
  version: VERSION,
  logFile: LOG_FILE,
  runDiscovery,
  requestRediscover(reason) {
    try {
      return runDiscovery(reason);
    } catch (err) {
      log.warn('重新发现凭据失败', { error: String(err?.message || err) });
      return 0;
    }
  },
};

const { server, refreshUpstreamCatalog } = createApp(ctx);

/**
 * 模型可用性探测：开机后台跑一遍，之后按 TTL 周期性重跑。
 *
 * 为什么要开机就跑：客户端是在**打开下拉框那一刻**读 `/v1/models` 的，
 * 而"学习式"的黑名单那时候还是空的 —— 必须提前探出来，不能等用户踩到。
 *
 * 为什么放在后台（`setTimeout` 而不是 `await`）：探测要 1~2 分钟
 * （`glm-5.1`/`glm-5.2` 单个就要 10~14 秒），不能让服务启动卡在那里。
 * 探测结果同时落盘，下次开机能直接读回来。
 */
if (config.models?.probeOnStartup !== false) {
  setTimeout(() => {
    modelProbe.probe().catch((err) => log.warn('开机模型可用性探测失败', { error: String(err?.message || err) }));
  }, 15000).unref?.();
}
const probeIntervalMs = Math.max(600, Number(config.models?.probeIntervalSeconds) || 21600) * 1000; // 默认 6 小时
const modelProbeTimer = setInterval(() => {
  modelProbe.probe().catch((err) => log.warn('周期性模型可用性探测失败', { error: String(err?.message || err) }));
}, probeIntervalMs);
modelProbeTimer.unref?.();

// 周期任务：刷新本机凭据 + 上游模型列表
const refreshMs = Math.max(10, Number(config.upstream?.refreshSeconds) || 45) * 1000;
let tick = 0;
const refreshTimer = setInterval(async () => {
  tick += 1;
  try {
    if (config.upstream?.autoDiscover !== false) runDiscovery('interval');
    if (tick % Math.max(1, Math.round(300 / (refreshMs / 1000))) === 0) {
      await refreshUpstreamCatalog();
      registry.setDiscovered(discover({ installDirs: config.discover?.installDirs || [] }).catalog);
    }
  } catch (err) {
    log.warn('周期刷新异常', { error: String(err?.message || err) });
  }
}, refreshMs);
refreshTimer.unref?.();

// 周期任务：推进注册队列 + 轮询在途的一键授权
const regMs = Math.max(2, Number(config.register?.tickSeconds) || 5) * 1000;
const regTimer = setInterval(async () => {
  try {
    if (config.register?.enabled !== false) await registerQueue.kick();
    for (const t of authFlow.pending()) {
      try {
        await authFlow.check(t.id);
      } catch (err) {
        log.debug('授权轮询失败', { state: t.state, error: err.message });
      }
    }
  } catch (err) {
    log.warn('注册/授权周期任务异常', { error: String(err?.message || err) });
  }
}, regMs);
regTimer.unref?.();

// 后台探一次本机 OfficeAce，方便面板一打开就有状态
authFlow.detectApp().catch(() => {});

// 周期任务：刷新所有账号的积分额度
const creditMs = Math.max(30, Number(config.credits?.autoRefreshSeconds) || 900) * 1000;
if (config.credits?.enabled !== false && Number(config.credits?.autoRefreshSeconds) > 0) {
  const creditTimer = setInterval(async () => {
    try {
      await credits.refresh(null, { force: true });
      const s = credits.view().summary;
      log.info('积分额度已刷新', { accounts: s.ok, remaining: s.remaining, failed: s.failed });
    } catch (err) {
      log.warn('刷新积分额度异常', { error: String(err?.message || err) });
    }
  }, creditMs);
  creditTimer.unref?.();
}

// 开机先拉一次（不阻塞启动流程）
if (config.credits?.enabled !== false) {
  credits.refresh(null, { force: true }).catch((err) => log.debug('首次拉取积分失败', { error: err.message }));
}

/**
 * 周期任务：**临期前主动续期**。
 *
 * 为什么单独开一个：临时 AK/SK 有寿命（实测这套 STS 发下来的是 **2 小时**，
 * 不是华为云默认的 24 小时），而老逻辑只在「过期之后」才被积分轮询顺带发现
 * —— 于是面板上永远写着「凭据剩余 1 小时」晃来晃去，看得人心慌，
 * 明明一份还有效的 refresh_token 就摆在手边。
 *
 * 这里改成**提前续**。寿命是未知的（不同 STS 策略不一样），所以阈值用**比例**：
 * 剩余时间掉到「本轮寿命的 25%」以内就换一份新的（2 小时寿命 → 剩 30 分时换；
 * 24 小时寿命 → 剩 6 小时时换）。换一份又是满寿命，于是**永远不会在临界点
 * 掉链子**，面板上也看不到刺眼的倒计时。
 *
 * 安全阀：只在链子还能挑出 token 时才动；挑不出就记一条日志等人工重登，
 * 绝不硬撞（硬撞只会把一次性 token 白烧掉）。
 */
const renewEnabled = config.credits?.autoRenewCredentials !== false;
const renewLeadRatio = Math.min(0.9, Math.max(0.02, Number(config.credits?.renewLeadRatio) || 0.25));
// 24 小时寿命的兜底上限：别为了「剩 6 小时」这种完全不需要急的情况白换一次
const renewLeadCapMs = Math.max(1, Number(config.credits?.renewBeforeHours) || 3) * 3600 * 1000;
if (renewEnabled && config.credits?.enabled !== false && config.credits?.autoRefreshCredentials !== false) {
  // 检查间隔取「提前量的一半」，钳在 1 分钟 ~ 30 分钟之间：
  // 太密没必要（一份能用好几小时），太疏又可能整段窗口都错过。
  const RENEW_CHECK_MS = 15 * 60 * 1000;
  /**
   * 正在续期的账号集合。
   *
   * ⚠️ 以前这是一个模块级**单布尔** `renewInFlight`：它防的是「上一轮没跑完又开一轮」，
   * 意图没错；但 `renewPass` 内部是 `for + await refreshCredential` **串行**跑，
   * 一个号的续期请求撞上 25 秒超时，后面所有号的临期判断都得排队等。
   * 多账号下这就变成了「一个坏号拖住所有好号」。
   *
   * 改成按账号记：同一个号不会被重复续期，但不同号之间互不阻塞。
   */
  const renewInFlightAccounts = new Set();
  const renewPass = async () => {
    try {
      for (const id of accountStore.ids()) {
        if (renewInFlightAccounts.has(id)) continue;
        const acc = accountStore.get(id);
        if (!acc?.enabled) continue;

        // 现在到底还有多久？两处都要看：续期记录里那份、磁盘档案里那份。
        // 取「最晚的那个」当实际寿命 —— 只要还有一份能用就不急着换。
        const live = credits.refreshState.usableCredential(id, { skewMs: 0 });
        const disk = acc.profile?.expiresAt || 0;
        const bestExp = Math.max(live ? Date.parse(live.expiresAt || '') || 0 : 0, disk || 0);
        if (!bestExp) continue;
        const leftMs = bestExp - Date.now();
        // 已经过期 → 交给积分轮询那条路去救（那条会走「过期就续」的分支）
        if (leftMs <= 0) continue;

        // 本轮寿命多长？用「到期时间 - 上次签发时间」估，估不出来就按 24 小时算。
        const rec = credits.refreshState.get(id) || {};
        const issuedAt = Number(rec.refreshedAt) || 0;
        const lifeMs = issuedAt && bestExp > issuedAt ? bestExp - issuedAt : 24 * 3600 * 1000;
        const leadMs = Math.min(renewLeadCapMs, lifeMs * renewLeadRatio);
        if (leftMs > leadMs) continue;

        // 硬前提：手里得有一份**能发出去**的 refresh_token。挑不出就别动 ——
        // 那只会把一个必然 1806 的值发上去。
        const pick = credits.refreshState.pickToken(id, acc.profile?.refreshToken || '');
        if (!pick.token) {
          log.warn('凭据即将过期，但续期链上挑不出可用 token，只能等重新登录', {
            id,
            leftMinutes: Math.round(leftMs / 60000),
            pick: pick.source,
          });
          continue;
        }

        renewInFlightAccounts.add(id);
        try {
          const r = await credits.refreshCredential(id);
          if (r?.ok) {
            log.info('临期凭据已主动续期', {
              id,
              leftMinutes: Math.round(leftMs / 60000),
              leadMinutes: Math.round(leadMs / 60000),
              tokenSource: pick.source,
              expiresAt: r.credential?.expiresAt || '',
            });
          } else {
            log.warn('临期续期失败', { id, leftMinutes: Math.round(leftMs / 60000), error: r?.error || '' });
          }
        } finally {
          renewInFlightAccounts.delete(id);
        }
      }
    } catch (err) {
      log.warn('临期续期任务异常', { error: String(err?.message || err) });
    }
  };
  const renewTimer = setInterval(renewPass, RENEW_CHECK_MS);
  renewTimer.unref?.();
  // 开机先跑一遍：重启时凭据可能只剩一点点，等 15 分钟就来不及了
  renewPass().catch(() => {});
  log.info('临期自动续期已启用', {
    leadRatio: renewLeadRatio,
    leadCapHours: renewLeadCapMs / 3600000,
    checkSeconds: RENEW_CHECK_MS / 1000,
  });
}

// 周期任务：每天自动签到领积分
const ac = config.credits?.autoClaim || {};
if (config.credits?.enabled !== false && ac.enabled !== false) {
  const atHour = Math.max(0, Math.min(23, Number(ac.hour) || 9));
  const atMinute = Math.max(0, Math.min(59, Number(ac.minute) || 5));
  const bjDayOf = (d) => {
    // 活动按北京时间 23:59:59 到期，用 UTC+8 判断「今天」最稳
    const t = new Date(d.getTime() + 8 * 3600 * 1000);
    return `${t.getUTCFullYear()}-${t.getUTCMonth() + 1}-${t.getUTCDate()}`;
  };
  let inFlight = false;
  /**
   * 签到重试退避：accountId -> 下次允许尝试的时间戳。
   *
   * 为什么需要：签到失败时**不会**把「今天已签」标上（这是对的，`claimBonus`
   * 在写 claims 之前就 return 了），可筛选条件 `!claimedToday(id)` 于是**永远成立**
   * —— 定时器 60 秒一轮，一个没有 AK/SK、或者没开通服务的号会被**每分钟**打一次，
   * 无限重试到当天结束。实测两个号里就有一个这种「签也签不上、但一直在试」的。
   *
   * 失败之后隔 30 分钟再试：当天签到窗口很宽（默认 09:05 之后都算），
   * 真要补救得回来也来得及；但不会把上游和自己都按住反复打。
   */
  const CLAIM_RETRY_BACKOFF_MS = 30 * 60 * 1000;
  const claimRetryAfter = new Map();
  // 每天只清一次退避记录，不然这台机器几天不重启的话会越攒越多
  let claimRetryDay = bjDayOf(new Date());
  const claimTimer = setInterval(async () => {
    if (inFlight) return;
    const now = new Date();
    const today = bjDayOf(now);
    if (today !== claimRetryDay) {
      claimRetryDay = today;
      claimRetryAfter.clear();
    }
    const due = now.getHours() * 60 + now.getMinutes() >= atHour * 60 + atMinute;
    // 关键：只要过了今天的签到时间点、且今天还没签，就补上。
    // 否则电脑 10 点才开机的人永远领不到（只在 09:05 那一分钟触发过一次的写法就有这个毛病）。
    if (!due) return;
    const pending = accountStore
      .ids()
      .filter((id) => accountStore.get(id)?.enabled && !credits.claimedToday(id))
      // 刚失败过的先放过，别每分钟重试
      .filter((id) => (claimRetryAfter.get(id) || 0) <= Date.now());
    if (!pending.length) return;
    inFlight = true;
    try {
      const r = await credits.claimAll();
      const got = r.results.filter((x) => x.ok && !x.skipped);
      log.info('自动签到完成', { due: bjDayOf(now), accounts: r.results.length, claimed: got.length, gained: r.gained });
      // 失败的号记上退避时间，下一轮先跳过（否则每分钟重试一次，永远重试）
      for (const x of r.results) {
        if (x.skipped) continue; // 停用的、今天已签的 —— 不算失败
        if (x.ok) {
          claimRetryAfter.delete(String(x.id)); // 这次成了，清掉退避
          continue;
        }
        claimRetryAfter.set(String(x.id), Date.now() + CLAIM_RETRY_BACKOFF_MS);
      }
      if (r.gained > 0) {
        console.log(`  [签到] 领到 ${r.gained} 积分：${got.map((x) => `${x.label || x.id} +${x.gained}`).join('、')}`);
      }
      await credits.refresh(null, { force: true });
    } catch (err) {
      log.warn('自动签到异常', { error: String(err?.message || err) });
    } finally {
      inFlight = false;
    }
  }, 60 * 1000);
  claimTimer.unref?.();
}

await refreshUpstreamCatalog();

/**
 * 单实例锁（配合下面的 pidFile 使用）。
 *
 * 为什么必须有：所有人的状态都落在同一个 `data/` 下 —— refresh-state.json
 * 里的 refresh_token 链、accounts.json 的忽略名单、bonus-claims.json 的
 * 「今天签过没」。两个进程同时跑，两边各自把内存里的版本写回去，后写的那个
 * 就是最终版本，另一个进程刚换回来的 refresh_token 会被**直接抹掉**。
 * 而 refresh_token 是单次使用、用一次就作废的 —— 丢一次就得重新登录。
 *
 * 进程活着判定用「pid 活着 **且** 进程创建时间对得上」：Windows 会把刚退出的
 * pid 很快复用给别的进程，只看 pid 会把「上位留下的锁」误判成「还在跑」，
 * 于是服务再也起不来。
 */
function processStartMs(pid) {
  if (process.platform !== 'win32') return 0;
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate | ForEach-Object { $_.ToFileTimeUtc() / 10000 }`],
      // stdio 显式收窄：execFileSync 不指定时会**继承**父进程的 stderr，
      // powershell 的报错就会绕过 logger 漏进 logs\server.err.log（乱码）。
      // 这里只认 stdout，出错走 catch 返回 0。
      { encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const v = Number(String(out).trim());
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM'; // 活着但不归我们管（权限不够）
  }
}

function acquireInstanceLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  const mine = {
    pid: process.pid,
    startedAt: Date.now(),
    // 进程创建时间（Windows 上由系统给出，和启动耗时无关）；拿不到就记 0，
    // 那种情况下退化成「只看 pid」。
    startMs: processStartMs(process.pid),
    port: config.listen.port,
    argv: process.argv.slice(1).join(' '),
  };

  const readLock = () => {
    try {
      return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    } catch {
      return null;
    }
  };

  const other = readLock();
  if (other && other.pid !== process.pid && pidAlive(Number(other.pid))) {
    // 双保险：进程活着，但创建时间差得远 → 是复用的 pid，锁其实是死的
    const real = processStartMs(Number(other.pid));
    const stale = real > 0 && other.startMs > 0 && Math.abs(real - other.startMs) > 15000;
    if (!stale) {
      return {
        ok: false,
        holder: other,
        reason: `已经有一个实例在跑（pid ${other.pid}，端口 ${other.port || '?'}）。\n` +
          '同时跑两个会让两边互相覆盖 data/ 下的状态 —— refresh_token 是单次使用的，\n' +
          '被覆盖掉就得重新登录一次。\n' +
          '要停掉旧的：运行 stop.cmd，或者任务管理器结束那个 node 进程。',
      };
    }
    log.warn('发现陈旧的实例锁（进程已不在），直接接管', { pid: other.pid });
  }

  const fd = fs.openSync(LOCK_FILE, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(mine, null, 2));
  } finally {
    try { fs.closeSync(fd); } catch { /* noop */ }
  }
  return { ok: true, lock: mine };
}

function releaseInstanceLock() {
  try {
    const doc = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (Number(doc?.pid) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {
    /* 锁文件不在 / 不是我们的，都别动 */
  }
}

const lock = acquireInstanceLock();
if (!lock.ok) {
  console.error('');
  console.error(`  ✗ ${lock.reason}`);
  console.error('');
  process.exit(1);
}

if (args.dump) {
  console.log(
    JSON.stringify(
      {
        credentials: pool.list(),
        models: registry.detailed(),
        configFile: config.__file,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

server.listen(config.listen.port, config.listen.host, () => {
  /*
   * `base` 用来拼"给人点"的地址，所以不能直接拿 `listen.host` 拼 ——
   * 监听 `0.0.0.0` 时那是个"所有网卡"的记号，浏览器打不开。
   * 本机自己开面板一律显示 127.0.0.1；监听宽了就另外提示一句。
   */
  const host = String(config.listen.host || '');
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const base = `http://${loopback ? '127.0.0.1' : host}:${config.listen.port}`;
  log.info(`officeace2api v${VERSION} 已启动`, { base });
  console.log('');
  /*
   * 面板地址后面带 ?token= —— 面板前端是从 URL 的 query 里读这个口令的
   * （`const TOKEN = new URLSearchParams(location.search).get("token")`），
   * 不带就是空口令、每条 `/admin/api/*` 都会被回 401。
   * 所以这里把完整可点的地址打出来，省得人去翻 config.json。
   */
  const adminToken = config.admin?.token || '';
  console.log(`  控制台     ${base}/admin${adminToken ? `?token=${adminToken}` : ''}`);
  console.log(`  OpenAI 基址 ${base}/v1`);
  console.log(`  API Key    ${(config.apiKeys || []).join(', ') || '(不校验)'}`);
  if (generatedAdminToken) {
    console.log(`  面板口令   ${generatedAdminToken}  ← 刚生成，已写进 config.json`);
  } else if (adminToken) {
    console.log(`  面板口令   ${adminToken}（在 config.json 的 admin.token，可改）`);
  } else {
    console.log('  面板口令   (空 = 面板不校验，只适合本机自用)');
  }
  console.log(`  默认模型   ${registry.defaultModel()}`);
  console.log(`  可用模型   ${registry.ids().length} 个`);
  console.log(`  凭据       ${pool.size} 条`);
  console.log(`  号池       ${accountStore.size()} 个账号（${accountStore.status().enabled} 个启用）`);
  const cs = credits.view().summary;
  if (cs.loaded) {
    console.log(`  积分额度   剩 ${cs.remaining} 积分（${cs.ok}/${cs.accounts} 个号已读到）`);
  } else {
    console.log('  积分额度   正在后台拉取…（打开控制台「号池」页可看）');
  }
  console.log('');

  /*
   * 监听地址不是回环，就等于「别人也能连上来」。
   *
   * 这一步纯粹是**把风险说到明处**：默认 127.0.0.1 只有本机能连，
   * 改成 0.0.0.0（或内网 IP）之后，这个端口上的一切都暴露给能访问到它的人 ——
   * 而 `/v1/*` 只要一个 API Key（默认还是 `sk-officeace` 这种谁都猜得到的），
   * `/admin/*` 则全靠上面那个 `admin.token`。
   */
  // `host` / `loopback` 已在上面算好，这里复用，别再声明一遍（重复 const 是语法错）
  if (!loopback && config.admin?.enabled !== false) {
    const weakKey = !config.apiKeys?.length || (config.apiKeys || []).some((k) => String(k).length < 16);
    console.log('  ────────────────────────────────────────────────');
    console.log(`  ⚠️  监听在 ${host}，不只是本机 —— 这个端口上的一切都开放给能连上它的人。`);
    if (!adminToken) console.log('      · 面板口令是空的：谁能连上谁就是管理员。建议在 config.json 里设 admin.token。');
    if (weakKey) console.log('      · API Key 太短或没设：默认那个 sk-officeace 谁都能猜，建议换成长的随机串。');
    console.log('  ────────────────────────────────────────────────');
    console.log('');
  }

  const pidFile = path.join(ROOT, 'data', 'server.pid');
  try {
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid));
  } catch {
    /* noop */
  }
});

// 端口被占：说清楚是谁占的，别只丢一句 EADDRINUSE
server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  ✗ 端口 ${config.listen.port} 已被占用，服务起不来。`);
    console.error('    多半是上一个实例还没退干净。运行 stop.cmd，或换 config.json 里的 listen.port。');
    console.error('');
    releaseInstanceLock();
    process.exit(1);
  }
  log.error('HTTP 服务异常', { error: String(err?.message || err) });
});

function shutdown(signal) {
  log.info('收到退出信号，正在关闭…', { signal });
  releaseInstanceLock();
  server.close(() => process.exit(0));
  usage.flush();
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// 兜底：不管怎么退（正常 / 异常 / 被 watchdog 掐），都别把锁留在盘上
process.on('exit', () => releaseInstanceLock());
process.on('uncaughtException', (err) => log.error('未捕获异常', { error: String(err?.stack || err) }));
process.on('unhandledRejection', (err) => log.error('未处理 Promise 拒绝', { error: String(err?.stack || err) }));
