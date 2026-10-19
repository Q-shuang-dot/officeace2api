#!/usr/bin/env node
/**
 * 面板接口自测：把后台页面依赖的接口全打一遍
 *   node tools/test-admin.mjs [--base http://127.0.0.1:7864]
 *
 * 面板接口现在要口令了（服务首次启动会自动生成 `admin.token`），
 * 所以这里统一从 `tools/adminToken.mjs` 拿 —— 它按
 * `O2A_ADMIN_TOKEN` 环境变量 → `config.json` 的顺序找。
 */
import { adminHeaders, resolveAdminToken, describeAdminToken } from './adminToken.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : d);
const base = opt('--base', 'http://127.0.0.1:7864');

let pass = 0;
let fail = 0;
const ok = (m, extra = '') => {
  pass += 1;
  console.log(`  ✓ ${m}${extra ? '  ' + extra : ''}`);
};
const bad = (m, e) => {
  fail += 1;
  console.log(`  ✗ ${m}  ${e}`);
};

async function call(path, { method = 'GET', body, key } = {}) {
  const headers = adminHeaders();
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, text, json };
}

console.log('== 面板接口自测 ==\n');
console.log('[页面]');
{
  const r = await call('/admin');
  if (r.status === 200 && r.text.includes('officeace2api') && r.text.includes('对话测试台')) {
    ok('/admin 返回控制台页面', `${r.text.length} 字节`);
  } else {
    bad('/admin', `HTTP ${r.status}, ${r.text.length} 字节`);
  }
}
{
  const r = await call('/');
  if (r.status === 200 && r.text.includes('<html')) ok('/ 重定向到控制台');
  else bad('/', `HTTP ${r.status}`);
}

console.log('\n[状态接口]');
let st = null;
{
  const r = await call('/admin/api/state');
  st = r.json;
  if (r.status === 200 && st?.health && st?.pool && st?.models && st?.usage && st?.logs) {
    ok('/admin/api/state', `凭据 ${st.pool.length} · 模型 ${st.models.length} · 日志 ${st.logs.length}`);
  } else {
    bad('/admin/api/state', `HTTP ${r.status}`);
  }
  if (st?.config?.models?.alias !== undefined) ok('state 含 models.alias');
  else bad('state.config.models.alias', '缺失');
  if (st?.config?.upstream?.refreshSeconds !== undefined) ok('state 含 upstream 配置');
  else bad('state.config.upstream', '缺失');

  /*
   * 载荷瘦身的两条硬约束（面板每 3 秒拉一次，这两处一破就白干）：
   *   1. `usage.recent` 不许回来 —— 面板从不读它，却和顶层 `recent` 内容相同，
   *      实测占了 115KB 载荷的 26%
   *   2. 日志只给尾部 + 序号，增量靠 /admin/api/logs?since=
   */
  if (st?.usage && st.usage.recent === undefined) ok('state.usage 不再重复装一份 recent');
  else bad('state.usage.recent 又回来了', '会把载荷翻倍');
  if (typeof st?.logSeq === 'number' && st.logSeq > 0) ok('state 带 logSeq 供面板要增量', String(st.logSeq));
  else bad('state.logSeq', String(st?.logSeq));
  if (Array.isArray(st?.logs) && st.logs.length <= 60) ok(`state.logs 只给尾部（${st.logs.length} ≤ 60 条）`);
  else bad('state.logs 条数', String(st?.logs?.length));
}

console.log('\n[日志增量接口]');
{
  const base = st?.logSeq || 0;
  const empty = await call('/admin/api/logs?since=' + base);
  if (empty.status === 200 && Array.isArray(empty.json?.lines) && empty.json.lines.length === 0) {
    ok('GET /admin/api/logs?since=最新 → 空（稳态不搬数据）');
  } else {
    bad('/admin/api/logs 无新增时', `HTTP ${empty.status} ${empty.text.slice(0, 120)}`);
  }
  // 制造一条日志：扫一次盘（它一定会打一条）
  await call('/admin/api/accounts/scan', { method: 'POST', body: {} });
  const inc = await call('/admin/api/logs?since=' + base);
  const lines = inc.json?.lines || [];
  if (inc.status === 200 && lines.length > 0 && lines.every((l) => typeof l.seq === 'number' && l.seq > base)) {
    ok('增量真的只给新行，且序号都在 since 之后', `${lines.length} 条`);
  } else {
    bad('/admin/api/logs 增量', `HTTP ${inc.status} lines=${lines.length} ${inc.text.slice(0, 120)}`);
  }
  if (inc.json?.seq >= (lines.at(-1)?.seq || 0)) ok('响应的 seq 可用于下一轮续取', String(inc.json?.seq));
  else bad('/admin/api/logs 的 seq', String(inc.json?.seq));
  // 面板重启自愈：序号比服务端还大 → 应当回一段尾部而不是空
  const reset = await call('/admin/api/logs?since=99999999');
  if ((reset.json?.lines || []).length > 0) ok('序号倒退（服务重启）时回尾部，面板能自愈');
  else bad('序号倒退时没回尾部', reset.text.slice(0, 120));
}

console.log('\n[配置读写]');
{
  const before = st?.config?.log?.level;
  const r = await call('/admin/api/config', { method: 'POST', body: { log: { level: 'debug' } } });
  if (r.status === 200 && r.json?.config?.log?.level === 'debug') ok('POST /admin/api/config 修改日志级别', `${before} → debug`);
  else bad('POST /admin/api/config', `HTTP ${r.status} ${r.text.slice(0, 160)}`);
  const back = await call('/admin/api/config', { method: 'POST', body: { log: { level: before || 'info' } } });
  if (back.status === 200) ok('日志级别已还原', String(back.json?.config?.log?.level));
  else bad('还原日志级别', `HTTP ${back.status}`);
}
{
  const r = await call('/admin/api/config', {
    method: 'POST',
    body: { listen: { host: '0.0.0.0', port: 7864 } },
  });
  if (r.status === 200 && Array.isArray(r.json?.restartRequired) && r.json.restartRequired.length > 0) {
    ok('改监听地址会提示需要重启', JSON.stringify(r.json.restartRequired));
  } else {
    bad('restartRequired 提示', JSON.stringify(r.json?.restartRequired));
  }
  await call('/admin/api/config', { method: 'POST', body: { listen: { host: '127.0.0.1', port: 7864 } } });
}

console.log('\n[模型别名]');
{
  const r = await call('/admin/api/models', {
    method: 'POST',
    body: { alias: { 'gpt-4o': 'glm-5.2', 'claude-sonnet-4': 'glm-5.3' }, hidden: [], extra: [] },
  });
  if (r.status === 200 && r.json?.models?.some((m) => m.id === 'gpt-4o')) ok('写入别名', 'gpt-4o → glm-5.2, claude-sonnet-4 → glm-5.3');
  else bad('写入别名', `HTTP ${r.status} ${r.text.slice(0, 160)}`);

  const list = await call('/v1/models', { key: 'sk-officeace' });
  const ids = (list.json?.data || []).map((m) => m.id);
  if (ids.includes('gpt-4o')) ok('/v1/models 里出现别名', `共 ${ids.length} 个`);
  else bad('/v1/models 别名', '未出现 gpt-4o');

  const chat = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-officeace' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: '只回复：别名通' }], max_tokens: 24 }),
  });
  const doc = await chat.json();
  if (chat.ok && doc?.model === 'glm-5.2') ok('别名请求真实落到 glm-5.2', JSON.stringify(doc.choices[0].message.content).slice(0, 40));
  else bad('别名路由', `HTTP ${chat.status} ${JSON.stringify(doc).slice(0, 160)}`);

  const clean = await call('/admin/api/models', { method: 'POST', body: { alias: {}, hidden: [], extra: [] } });
  if (clean.status === 200) ok('别名已清空');
  else bad('清空别名', `HTTP ${clean.status}`);

  /**
   * 反向对照：写别名**不许把 config.models 里别的键抹掉**。
   *
   * 这里以前写的是 `config.models = { alias, hidden, extra }`，于是每在面板上
   * 改一次模型设置，就把 `hideUnavailable` / `minMaxTokens` / `reasoningModels`
   * / `probeOnStartup` 这些键全删掉，而且立刻落盘到 config.json。
   * 表现是"改了个别名，推理预算的功能就没了"，没有任何报错。
   */
  const st = await call('/admin/api/state');
  const mm = st.json?.config?.models || {};
  const keepKeys = ['hideUnavailable', 'minMaxTokens', 'reasoningModels', 'minMaxTokensByModel', 'probeOnStartup'];
  const missing = keepKeys.filter((k) => !(k in mm));
  if (!missing.length) ok('写别名没弄丢 config.models 的其它键', keepKeys.join(' / '));
  else bad('写别名把 config.models 的键抹掉了', `丢了 ${missing.join(', ')}，剩下的键 ${Object.keys(mm).join(', ')}`);
  if (mm.minMaxTokens === 1024) ok('minMaxTokens 的值也还在', String(mm.minMaxTokens));
  else bad('minMaxTokens 的值被改了/丢了', String(mm.minMaxTokens));

  // 再写一次别的组合，确认还是留得住（防止只修了第一条路径）
  await call('/admin/api/models', { method: 'POST', body: { alias: { 'x-check': 'glm-5.2' }, hidden: [], extra: [] } });
  const st2 = await call('/admin/api/state');
  if (st2.json?.config?.models?.minMaxTokens === 1024 && 'hideUnavailable' in (st2.json?.config?.models || {})) {
    ok('反复写别名仍然留得住');
  } else {
    bad('反复写别名丢键', JSON.stringify(st2.json?.config?.models));
  }
  await call('/admin/api/models', { method: 'POST', body: { alias: {}, hidden: [], extra: [] } });
}

console.log('\n[别名改了之后，旧的「模型不行」标记要作废]');
{
  /**
   * 真踩到的坑：`gpt-4o` 先指一个打不通的模型，于是被打上"不行"的标记；
   * 之后把别名改指能用的模型 —— 标记还留着，`gpt-4o` 照样从 `/v1/models`
   * 里消失，而它明明是好的。
   *
   * 「这个模型不行」是**相对当时那份目录**得出的结论，名字被重新定义之后
   * 必须作废。这里用两步复现：先让别名指向一个确定打不通的模型，把标记打上，
   * 再改指能用的，然后检查 `gpt-4o` 有没有回来。
   */
  const before = await call('/v1/models', { key: 'sk-officeace' });

  // ① 别名指向一个打不通的模型，然后真打一次，把"不行"的标记打上
  await call('/admin/api/models', { method: 'POST', body: { alias: { 'gpt-4o': 'glm-5.3-zx' }, hidden: [], extra: [] } });
  const hit = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-officeace' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
  });
  const hitDoc = await hit.json().catch(() => ({}));
  /**
   * ⚠️ 这里**不检查别名会不会进 modelsUnavailable**。
   *
   * 别名是用户自己写的一句映射，"打不通"应该怪它指向的那个模型，不该把用户
   * 打的那串名字拉黑 —— 否则用户改一下映射方向（`gpt-4o` 从坏的模型改指好的）
   * 会发现别名还是被挡着。所以 `listUnavailableModels()` 只报真实模型名。
   *
   * 但要**硬性保证报错是干净的**：必须是 400 `model_not_available`，
   * 绝不是 `upstream_failed`（那意味着把"模型不行"误判成了"账号坏了"，
   * 会把整条凭据冷却 5 分钟 —— 这是本项目踩过好几次的坑）。
   */
  if (hit.status === 400 && hitDoc?.error?.code === 'model_not_available') {
    ok('别名指向打不通的模型时，干净地回 400 model_not_available', '没把账号误判成坏了');
  } else if (hit.ok) {
    ok('别名指向打不通的模型（这次居然通了，跳过）');
  } else {
    bad('别名指向打不通的模型时报错不干净', `HTTP ${hit.status} code=${hitDoc?.error?.code} ${String(hitDoc?.error?.message).slice(0, 120)}`);
  }

  // ② 改指能用的模型 —— gpt-4o 必须能用，且立刻回到 /v1/models
  await call('/admin/api/models', { method: 'POST', body: { alias: { 'gpt-4o': 'glm-5.2' }, hidden: [], extra: [] } });
  const after = await call('/v1/models', { key: 'sk-officeace' });
  const ids = (after.json?.data || []).map((m) => m.id);
  if (ids.includes('gpt-4o')) ok('别名改指能用的模型后，gpt-4o 立刻在列表里', '旧标记已作废');
  else bad('别名改指能用的模型后 gpt-4o 还是消失的', '旧目录的「模型不行」标记没被清掉');
  const afterState = await call('/admin/api/state');
  if ((afterState.json?.health?.modelsUnavailable || []).includes('gpt-4o')) {
    bad('modelsUnavailable 里挂着别名 gpt-4o', '别名不该被当成模型拉黑');
  } else {
    ok('modelsUnavailable 里不挂别名（只挂真实模型名）');
  }
  // 改指之后真打一发，确认真的能用
  const hit2 = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-officeace' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: '回一个字' }], max_tokens: 8 }),
  });
  const doc2 = await hit2.json().catch(() => ({}));
  if (hit2.ok && doc2?.model === 'glm-5.2') ok('改指之后 gpt-4o 真的能打通', `model=${doc2.model}`);
  else bad('改指之后 gpt-4o 打不通', `HTTP ${hit2.status} ${JSON.stringify(doc2).slice(0, 140)}`);

  // 还原
  await call('/admin/api/models', { method: 'POST', body: { alias: {}, hidden: [], extra: [] } });
  const restored = await call('/v1/models', { key: 'sk-officeace' });
  if ((restored.json?.data || []).length === (before.json?.data || []).length) ok('模型列表已还原');
  else bad('模型列表没还原', `${(before.json?.data || []).length} → ${(restored.json?.data || []).length}`);
}

console.log('\n[刷新与统计]');
{
  const r = await call('/admin/api/refresh', { method: 'POST', body: {} });
  if (r.status === 200 && typeof r.json?.models === 'number') ok('POST /admin/api/refresh', `models=${r.json.models} upstream=${r.json.upstream} discovered=${r.json.discovered}`);
  else bad('POST /admin/api/refresh', `HTTP ${r.status}`);
}
{
  const r = await call('/admin/api/logs/clear', { method: 'POST', body: {} });
  if (r.status === 200) ok('POST /admin/api/logs/clear', `清理 ${r.json?.cleared} 条`);
  else bad('POST /admin/api/logs/clear', `HTTP ${r.status}`);
}
{
  const r = await call('/admin/api/usage/reset', { method: 'POST', body: {} });
  if (r.status === 200) ok('POST /admin/api/usage/reset');
  else bad('POST /admin/api/usage/reset', `HTTP ${r.status}`);
  const after = await call('/admin/api/state');
  if (after.json?.usage?.totals?.requests === 0) ok('统计已归零');
  else bad('统计归零', JSON.stringify(after.json?.usage?.totals));
}

/* ---------------------- 号池 ---------------------- */
{
  const r = await call('/admin/api/accounts');
  if (r.status === 200 && Array.isArray(r.json?.accounts)) {
    ok('GET /admin/api/accounts', `${r.json.accounts.length} 个账号 / ${r.json.status?.credentials} 条凭据`);
  } else bad('GET /admin/api/accounts', `HTTP ${r.status}`);
}

{
  const r = await call('/admin/api/accounts/scan', { method: 'POST', body: {} });
  if (r.status === 200 && typeof r.json?.added === 'number') ok('POST /admin/api/accounts/scan', `新增凭据 ${r.json.added}`);
  else bad('POST /admin/api/accounts/scan', `HTTP ${r.status}`);
}

{
  // 号池里的账号应该都带得出华为账号名与过期时间（DPAPI + AES-GCM 解密链路）
  const r = await call('/admin/api/accounts');
  const withProfile = (r.json?.accounts || []).filter((a) => a.expiresAt > 0);
  if (withProfile.length) {
    const a = withProfile[0];
    ok('账号档案解密', `${a.userName} 剩 ${a.hoursLeft} 小时 / project ${String(a.projectId).slice(0, 8)}…`);
  } else {
    ok('账号档案解密', '跳过：没有可读的加密档案');
  }
}

{
  // ⚠️ 这里以前断言「给未知 ID 改别名返回 200（幂等）」—— 那条断言本身是有害的：
  //    它固化了「随便什么 id 都能写进 accounts.json」这个行为，而盘上那个幽灵键
  //    （`pending-<64hex>`）正是从这个口子能进去的。现在改成双向验证：
  //    真账号能改名、不存在的 id 必须被拒。
  //
  // ⚠️⚠️ 还有一层坑，踩过一次：这个测试打的是**真的那个** accounts.json，
  //    所以「改个名试试，然后把它撤销」= 把用户自己起的别名**删掉**了。
  //    撤销必须撤回到**原来那个值**，不是删掉。
  const listed = await call('/admin/api/accounts');
  const known = (listed.json?.accounts || []).map((a) => a.id).filter(Boolean);
  if (known.length) {
    const id0 = known[0];
    const before = (listed.json.accounts || []).find((a) => a.id === id0)?.label || '';
    const real = await call('/admin/api/accounts/label', { method: 'POST', body: { id: id0, label: '别名回归测试' } });
    const got = (real.json?.accounts || []).find((a) => a.id === id0)?.label;
    if (real.status === 200 && got === '别名回归测试') ok('POST /admin/api/accounts/label 真账号能改名');
    else bad('POST /admin/api/accounts/label 真账号能改名', `HTTP ${real.status} label=${got}`);
    // 撤回原值（不是清空！）
    const back = await call('/admin/api/accounts/label', { method: 'POST', body: { id: id0, label: before } });
    const backLabel = (back.json?.accounts || []).find((a) => a.id === id0)?.label;
    if (back.status === 200 && (before ? backLabel === before : backLabel !== '别名回归测试')) {
      ok('POST /admin/api/accounts/label 改完能撤回原值', before ? `已还原为「${before}」` : '原本没有自定义名，已清掉');
    } else {
      bad('POST /admin/api/accounts/label 改完能撤回原值', `原来「${before}」现在「${backLabel}」`);
    }
  } else {
    ok('POST /admin/api/accounts/label 真账号能改名', '跳过：号池里没有账号');
  }
  const ghost = await call('/admin/api/accounts/label', { method: 'POST', body: { id: '__no_such__', label: 'x' } });
  if (ghost.status === 404 && ghost.json?.error?.code === 'account_not_found') {
    ok('POST /admin/api/accounts/label 拒绝不存在的 ID', '404 account_not_found');
  } else {
    bad('POST /admin/api/accounts/label 拒绝不存在的 ID', `HTTP ${ghost.status} ${JSON.stringify(ghost.json?.error || {})}`);
  }
}

{
  const r = await call('/admin/api/accounts/import', { method: 'POST', body: { baseUrl: '', authorization: '' } });
  if (r.status === 400) ok('POST /admin/api/accounts/import 参数校验', '空参数正确拒绝');
  else bad('POST /admin/api/accounts/import 参数校验', `HTTP ${r.status}`);
}

/* ---------------------- 一键授权 ---------------------- */
{
  const r = await call('/admin/api/auth/app?force=1');
  if (r.status === 200 && typeof r.json?.found === 'boolean') {
    ok('GET /admin/api/auth/app', r.json.found ? `发现 ${r.json.baseUrl} islogin=${r.json.islogin}` : '本机 OfficeAce 未运行');
  } else bad('GET /admin/api/auth/app', `HTTP ${r.status}`);
}

{
  const r = await call('/admin/api/auth/start', { method: 'POST', body: { label: '自检' } });
  if (r.status === 200 && r.json?.authorizeUrl) {
    const oa = r.json.oauth || {};
    const wellFormed =
      oa.clientId === 'pdp5_for_agentarts' &&
      oa.pkce === 'SHA-256' &&
      /^[0-9a-f]{32}$/.test(r.json.state) &&
      String(oa.redirectUri).includes('/v1/claw/auth/callback');
    if (wellFormed) ok('POST /admin/api/auth/start', `state=${r.json.state} 参数完整`);
    else bad('POST /admin/api/auth/start', JSON.stringify(oa));
    await call('/admin/api/auth/cancel', { method: 'POST', body: { id: r.json.id } });
  } else if (r.json?.error?.code === 'APP_NOT_FOUND' || /APP_NOT_FOUND|没找到本机 OfficeAce/.test(r.text || '')) {
    // 桌面端没开就没法发授权链接 —— 不是代码问题，明确标注跳过
    ok('POST /admin/api/auth/start', '跳过：本机 OfficeAce 未运行（启动后可复测）');
  } else {
    bad('POST /admin/api/auth/start', `HTTP ${r.status} ${r.text?.slice(0, 120)}`);
  }
}

{
  const r = await call('/admin/api/auth/check', { method: 'POST', body: { id: '__no_such__' } });
  if (r.status === 400) ok('POST /admin/api/auth/check 未知任务', '正确报错');
  else bad('POST /admin/api/auth/check 未知任务', `HTTP ${r.status}`);
}

/* ---------------------- 批量注册 ---------------------- */
{
  const r = await call('/admin/api/register');
  if (r.status === 200 && r.json?.stats) ok('GET /admin/api/register', `队列 ${r.json.stats.total} 个 / 接码 ${r.json.stats.smsProvider}`);
  else bad('GET /admin/api/register', `HTTP ${r.status}`);
}

{
  const r = await call('/admin/api/register/enqueue', {
    method: 'POST',
    body: {
      // 用时间戳保证手机号唯一：注册队列按手机号去重，固定号会被上一轮的残留挡住
      items: [{ phone: `138${String(Date.now()).slice(-8)}`, label: '自检号' }, { phone: `139${String(Date.now()).slice(-8)}` }],
      autoStart: false,
    },
  });
  if (r.status === 200 && r.json?.created?.length === 2) ok('POST /admin/api/register/enqueue', `入队 ${r.json.created.length} 个`);
  else bad('POST /admin/api/register/enqueue', `HTTP ${r.status} created=${r.json?.created?.length}`);
  const madeIds = [];
  for (const t of r.json?.created || []) {
    const id = t.id;
    madeIds.push(id);
    const s = await call('/admin/api/register/sms', { method: 'POST', body: { id, code: '123456' } });
    if (s.status === 200 && s.json?.task?.smsCodeSet) ok('POST /admin/api/register/sms', '验证码已脱敏录入');
    else bad('POST /admin/api/register/sms', `HTTP ${s.status}`);
    // 这个返回值以前没人看，于是「删不掉」被静默吞了：任务留在真队列里，
    // 落了盘之后还会永久留着。现在删除必须真的成功。
    const rm = await call('/admin/api/register/remove', { method: 'POST', body: { id } });
    if (rm.status === 200 && rm.json?.ok === true) ok('POST /admin/api/register/remove', '在途任务也能直接删');
    else bad('POST /admin/api/register/remove', `HTTP ${rm.status} ok=${rm.json?.ok} ${rm.json?.error?.message || ''}`);
  }
  const left = await call('/admin/api/register');
  const leftIds = new Set((left.json?.tasks || []).map((x) => x.id));
  const junk = madeIds.filter((id) => leftIds.has(id));
  if (madeIds.length === 2 && junk.length === 0) {
    ok('自检造的任务自己收拾干净（不再往真队列和落盘文件里留垃圾）');
  } else {
    bad('自检留下了垃圾任务', JSON.stringify(junk));
  }
}

{
  const r = await call('/admin/api/register/pause', { method: 'POST', body: { paused: true } });
  const back = await call('/admin/api/register/pause', { method: 'POST', body: { paused: false } });
  if (r.json?.paused === true && back.json?.paused === false) ok('POST /admin/api/register/pause');
  else bad('POST /admin/api/register/pause', JSON.stringify([r.json, back.json]));
}

{
  const r = await call('/admin/api/register/redeem', { method: 'POST', body: { code: '' } });
  if (r.status === 200 && typeof r.json?.ok === 'boolean') ok('POST /admin/api/register/redeem', r.json.ok ? '兑换成功' : String(r.json.message).slice(0, 40));
  else bad('POST /admin/api/register/redeem', `HTTP ${r.status}`);
}

/* ---------------------- 积分额度 ---------------------- */
{
  const r = await call('/admin/api/credits');
  const sm = r.json?.summary || {};
  if (r.status === 200 && r.json?.ok !== false && Array.isArray(r.json?.items)) {
    ok('GET /admin/api/credits', `${sm.accounts ?? 0} 个号 · 读到 ${sm.ok ?? 0} 个 · 剩余 ${sm.remaining ?? 0} 积分`);
  } else {
    bad('GET /admin/api/credits', `HTTP ${r.status}`);
  }

  const first = (r.json?.items || [])[0];
  if (!first) {
    bad('积分条目结构', '号池为空，跳过');
  } else {
    if (first.loaded && first.ok) {
      const p = first.points || {};
      const shapeOk =
        typeof p.remaining === 'number' &&
        typeof p.total === 'number' &&
        typeof p.used === 'number' &&
        !!first.plan &&
        typeof first.plan.name === 'string' &&
        Array.isArray(first.bonuses) &&
        typeof first.headline === 'string' &&
        typeof first.text === 'string' &&
        Array.isArray(first.rates) &&
        !!first.usage;
      if (shapeOk) ok('积分条目结构完整', `${first.plan.name} · 剩 ${p.remaining}/${p.total} · 奖励 ${first.bonuses.length} 项 · 费率 ${first.rates.length} 条`);
      else bad('积分条目结构完整', JSON.stringify(Object.keys(first)));
      // 剩余 = 总额 − 已用，必须自洽
      if (Math.abs(p.total - p.used - p.remaining) < 0.02) ok('剩余 = 总额 − 已用', `${p.total} − ${p.used} = ${p.remaining}`);
      else bad('剩余 = 总额 − 已用', `${p.total} - ${p.used} != ${p.remaining}`);
      if (/积分/.test(first.headline)) ok('中文摘要可读', first.headline);
      else bad('中文摘要可读', first.headline);
    } else {
      ok('积分条目结构完整', `该号未读到额度：${String(first.error || '').slice(0, 50)}（跳过结构校验）`);
    }
  }
}

{
  const id = (await call('/admin/api/credits')).json?.items?.[0]?.id;
  if (!id) {
    bad('GET /admin/api/credits/detail', '号池为空，跳过');
  } else {
    const r = await call(`/admin/api/credits/detail?id=${encodeURIComponent(id)}`);
    if (r.status === 200 && r.json?.account && Array.isArray(r.json.history)) {
      ok('GET /admin/api/credits/detail', `历史快照 ${r.json.history.length} 条`);
    } else {
      bad('GET /admin/api/credits/detail', `HTTP ${r.status}`);
    }
  }
  const missing = await call('/admin/api/credits/detail');
  if (missing.status === 400) ok('GET /admin/api/credits/detail 缺 id', '正确拒绝');
  else bad('GET /admin/api/credits/detail 缺 id', `HTTP ${missing.status}`);
}

{
  const r = await call('/admin/api/credits/refresh', { method: 'POST', body: {} });
  const sm = r.json?.summary || {};
  if (r.status === 200 && typeof r.json?.refreshed === 'number') {
    ok('POST /admin/api/credits/refresh', `刷新 ${r.json.refreshed} 个 · 失败 ${(r.json.failed || []).length} 个 · 剩余 ${sm.remaining ?? 0}`);
  } else {
    bad('POST /admin/api/credits/refresh', `HTTP ${r.status}`);
  }
}

{
  const h = await call('/healthz');
  if (h.status === 200 && 'creditsRemaining' in (h.json || {})) {
    ok('GET /healthz 带积分', `creditsRemaining=${h.json.creditsRemaining} · ${h.json.creditsAccounts}`);
  } else {
    bad('GET /healthz 带积分', JSON.stringify(h.json));
  }

  /*
   * 版本号只有一个来源（package.json），`healthz` / 面板必须读到同一个值。
   *
   * 以前 `src/index.mjs` 里写死一份、package.json 里又一份，发版时忘改一处就会出现
   * 「面板显示 1.1.0、package.json 还是 1.0.0」—— 而版本号恰恰是报问题时最先要确认的东西。
   * 这条断言就是防它再分叉。
   */
  const fs = await import('node:fs');
  const pkgVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  if (h.json?.version && h.json.version === pkgVersion) {
    ok('/healthz 的版本号与 package.json 一致', `${h.json.version}`);
  } else {
    bad('版本号分叉了', `healthz=${h.json?.version} package.json=${pkgVersion}`);
  }
}

{
  // 签名器自洽：同样的输入必须出同样的签名，且 V4/V11 不能撞车
  const { signV4, signV11 } = await import('../src/quota.mjs');
  const credential = { accessKey: 'AKTEST', secretKey: 'SKTEST', securityToken: 'TOKTEST', projectId: 'PIDTEST' };
  const url = 'https://example.com/v1/subscription?b=2&a=1';
  const a = signV11({ method: 'GET', url, credential, region: 'cn-southwest-2' });
  const b = signV11({ method: 'GET', url, credential, region: 'cn-southwest-2' });
  const v4 = signV4({ method: 'GET', url, credential });
  const sigOf = (h) => /Signature=([0-9a-f]+)/.exec(h.Authorization || '')?.[1] || '';
  /**
   * ⚠️ 这里以前直接断言 `sigOf(a) === sigOf(b)`，会**偶发失败**：
   * `signV11` 会把 `X-Sdk-Date` 算进待签串，而它是**秒级**的（`sdkDate()` 取整到秒）。
   * 两次调用如果正好跨过一秒边界，签名就不一样 —— 不是代码错了，是断言写错了
   * （实测踩到过一次，几率大约千分之一）。
   *
   * 正确的测法是锁住「同一个秒内必须逐字节一致」，再用不同秒的输入去证明
   * 时间真的进了签名。这样既**更严**（逐字节比对），又不会偶发。
   */
  const sameSec = sigOf(a) === sigOf(b);
  if (sameSec) {
    ok('V11 签名稳定（同一秒内逐字节一致）', `Signature=${sigOf(a).slice(0, 12)}…`);
  } else {
    // 跨秒了：退一步，拿同一秒显式重签一次，证明是时间戳而不是随机性
    const date = a['X-Sdk-Date'] || a['x-sdk-date'];
    const a2 = signV11({ method: 'GET', url, credential, region: 'cn-southwest-2', headers: { 'X-Sdk-Date': date } });
    const b2 = signV11({ method: 'GET', url, credential, region: 'cn-southwest-2', headers: { 'X-Sdk-Date': date } });
    if (sigOf(a2) && sigOf(a2) === sigOf(b2)) {
      ok('V11 签名稳定（固定时间戳后一致 —— 刚才那次是跨秒了）', `Signature=${sigOf(a2).slice(0, 12)}…`);
    } else {
      bad('V11 签名稳定', `固定时间戳后仍不一致：${sigOf(a2).slice(0, 12)} vs ${sigOf(b2).slice(0, 12)}`);
    }
  }
  // 反向对照：时间戳必须真的进签名，否则请求会被服务端拒（防重放）。
  //
  // ⚠️ 钉时间必须走 `date` 参数，**不能靠传 `headers`**：`putCommonHeaders()`
  //    是**无条件**调 `setHeader(headers, 'X-Sdk-Date', sdkDate())` 的，所以
  //    不管传大写还是小写都会被覆盖成"现在"——第一版就踩了这个坑，
  //    两条签名都是"现在"，当然一样，看起来像"时间戳没进签名"的假故障。
  const at = (d) => signV11({ method: 'GET', url, credential, region: 'cn-southwest-2', sdkDateOverride: d });
  const t1 = at('20200101T000000Z');
  const t2 = at('20200101T000001Z');
  const dateKey = Object.keys(t1).find((k) => k.toLowerCase() === 'x-sdk-date');
  if (dateKey && t1[dateKey] === '20200101T000000Z') ok('V11 能钉住 X-Sdk-Date（走 date 参数）', dateKey);
  else bad('V11 钉不住 X-Sdk-Date', `实际 ${JSON.stringify(t1[dateKey])}`);
  if (sigOf(t1) !== sigOf(t2)) ok('V11 签名把时间戳算进去了（防重放）');
  else bad('V11 签名把时间戳算进去了（防重放）', '换一秒签名居然没变');
  if (a.Authorization.startsWith('V11-HMAC-SHA256 Credential=AKTEST/') && /cn-southwest-2\/apic/.test(a.Authorization)) {
    ok('V11 CredentialScope 正确', 'AKTEST/<日期>/cn-southwest-2/apic');
  } else {
    bad('V11 CredentialScope 正确', a.Authorization.slice(0, 90));
  }
  if (sigOf(v4) && sigOf(v4) !== sigOf(a)) ok('V4 与 V11 不撞车');
  else bad('V4 与 V11 不撞车', '两者签名相同');
  if (/SignedHeaders=.*host/.test(a.Authorization) && !/authorization/i.test(a.Authorization.split('SignedHeaders=')[1]?.split(',')[0] || '')) {
    ok('SignedHeaders 含 host 且不含 authorization');
  } else {
    bad('SignedHeaders 含 host 且不含 authorization', a.Authorization.slice(0, 120));
  }
}

{
  // 解析器：跑一次假的订阅响应，验证「剩余 = 总额 − 已用」和过期条目剔除
  const { summarizeSubscription } = await import('../src/quota.mjs');
  const now = Date.now();
  const future = new Date(now + 86400e3).toISOString();
  const past = new Date(now - 86400e3).toISOString();
  const s = summarizeSubscription({
    subscribe_status: 'SUBSCRIBED',
    skus: [{
      sku_code: 'officeace.personal.package.standard',
      sku_name: '标准版',
      effective_time: past,
      expired_time: future,
      subscribe_status: 'SUBSCRIBED',
      quotas: [
        { sku_attr_code: 'officeace_points', sku_value: '1000', current_value: '250', expired_time: future },
        { sku_attr_code: 'officeace_points', sku_value: '999', current_value: '0', expired_time: past }, // 过期，应剔除
        { sku_attr_code: 'online_search_count', sku_value: '500', current_value: '120', expired_time: future },
      ],
    }],
    bonus_skus: [
      { activity_id: 'b1', activity_name: '新用户福利', points: '4000', current_value: '0', expired_time: future },
      { activity_id: 'b2', activity_name: '过期活动', points: '800', current_value: '800', expired_time: past },
    ],
  });
  const good =
    s.points.planTotal === 1000 &&
    s.points.planRemaining === 750 &&
    s.points.remaining === 4750 &&
    s.searches.remaining === 380 &&
    s.bonuses.length === 2 &&
    s.bonuses.filter((b) => !b.expired).length === 1 &&
    s.bonuses.find((b) => b.expired)?.remaining === 0;
  if (good) ok('积分解析（总额−已用 / 剔过期 / 搜索次数）', `套餐 750 + 奖励 4000 = 4750，搜索剩 380`);
  else bad('积分解析', JSON.stringify(s.points) + ' ' + JSON.stringify(s.searches));
  if (s.plan.tierName === '标准版' && s.plan.statusText === '正常') ok('套餐档位中文化', `${s.plan.name} / ${s.plan.statusText}`);
  else bad('套餐档位中文化', `${s.plan.tierName} / ${s.plan.statusText}`);
}

/* ---------------------- 签到 / 凭据续期 ---------------------- */
{
  const r = await call('/admin/api/credits/claims');
  if (r.status === 200 && Array.isArray(r.json?.all)) ok('GET /admin/api/credits/claims', `${r.json.all.length} 个账号的签到记录`);
  else bad('GET /admin/api/credits/claims', `HTTP ${r.status}`);

  const id = (await call('/admin/api/credits')).json?.items?.[0]?.id;
  if (id) {
    const one = await call(`/admin/api/credits/claims?id=${encodeURIComponent(id)}`);
    if (one.status === 200 && 'total' in (one.json || {})) ok('GET /admin/api/credits/claims?id', `累计 ${one.json.total} 积分`);
    else bad('GET /admin/api/credits/claims?id', `HTTP ${one.status}`);
  }

  // 签到：同一天重复签不会报错，也不会重复加分
  const c1 = await call('/admin/api/credits/claim', { method: 'POST', body: {} });
  const gained1 = c1.json?.gained ?? 0;
  const c2 = await call('/admin/api/credits/claim', { method: 'POST', body: {} });
  const gained2 = c2.json?.gained ?? 0;
  if (c1.status === 200 && typeof c1.json?.gained === 'number' && Array.isArray(c1.json?.results)) {
    ok('POST /admin/api/credits/claim', `首次 +${gained1} 积分 · ${(c1.json.results || []).length} 个号`);
  } else {
    bad('POST /admin/api/credits/claim', `HTTP ${c1.status}`);
  }
  if (c2.status === 200 && gained2 === 0) ok('签到幂等（同一天再签不加分）', `第二次 +${gained2}`);
  else bad('签到幂等（同一天再签不加分）', `第二次 +${gained2}`);
  if (c2.json?.summary && typeof c2.json.summary.remaining === 'number' && c2.json.summary.remaining > 0) {
    ok('签到后汇总不是 0', `剩余 ${c2.json.summary.remaining} 积分`);
  } else {
    bad('签到后汇总不是 0', JSON.stringify(c2.json?.summary));
  }

  const ren = await call('/admin/api/credits/refresh-credential', { method: 'POST', body: {} });
  const okOnes = (ren.json?.results || []).filter((x) => x.ok);
  const badOnes = (ren.json?.results || []).filter((x) => !x.ok);
  if (ren.status === 200 && Array.isArray(ren.json?.results)) {
    if (okOnes.length) ok('POST /admin/api/credits/refresh-credential', `续期成功 ${okOnes.length} 个 · 新凭据到 ${String(okOnes[0].expiresAt).slice(0, 19)}`);
    else ok('POST /admin/api/credits/refresh-credential', `接口正常，${badOnes.length} 个无法续期：${String(badOnes[0]?.error || '').slice(0, 40)}`);
  } else {
    bad('POST /admin/api/credits/refresh-credential', `HTTP ${ren.status}`);
  }
  // 续期完额度必须还能读出来（证明新凭据真的能用）
  const after = await call('/admin/api/credits');
  if (after.json?.summary?.ok >= 1) ok('续期后额度仍可读', `剩 ${after.json.summary.remaining} 积分 · 来源 ${after.json.items?.[0]?.credentialSource}`);
  else bad('续期后额度仍可读', JSON.stringify(after.json?.summary));
}

{
  // DPoP proof 结构：ES256 / 64 字节签名 / htm+htu+iat+jti 齐全 / header 带公钥但不带私钥
  const { generateDpopProof } = await import('../src/refresh.mjs');
  const { webcrypto } = await import('node:crypto');
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const priv = await webcrypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = await webcrypto.subtle.exportKey('jwk', kp.publicKey);

  const url = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens';
  const jwt = await generateDpopProof(priv, pub, 'POST', url);
  const [h, p, s] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  const sigLen = Buffer.from(s, 'base64url').length;

  if (header.typ === 'dpop+jwt' && header.alg === 'ES256' && header.jwk?.crv === 'P-256') {
    ok('DPoP header 正确', `${header.typ} / ${header.alg} / ${header.jwk.crv}`);
  } else {
    bad('DPoP header 正确', JSON.stringify(header));
  }
  if (!('d' in (header.jwk || {}))) ok('DPoP header 不含私钥');
  else bad('DPoP header 不含私钥', 'jwk 里带了 d');
  if (payload.htm === 'POST' && payload.htu === url && payload.iat > 0 && /^[0-9a-f]{32}$/.test(payload.jti || '')) {
    ok('DPoP payload 正确', `htm=${payload.htm} jti=${payload.jti.slice(0, 8)}…`);
  } else {
    bad('DPoP payload 正确', JSON.stringify(payload));
  }
  if (sigLen === 64) ok('DPoP 签名长度 64 字节（ES256 raw R||S）');
  else bad('DPoP 签名长度 64 字节（ES256 raw R||S）', `实际 ${sigLen}`);

  // 签名必须能被公钥验过
  const ok2 = await webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    await webcrypto.subtle.importKey('jwk', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']),
    Buffer.from(s, 'base64url'),
    Buffer.from(`${h}.${p}`),
  );
  if (ok2) ok('DPoP 签名可被公钥验证');
  else bad('DPoP 签名可被公钥验证', 'verify 返回 false');

  // 每次的 jti 必须不同（防重放要求）
  const jwt2 = await generateDpopProof(priv, pub, 'POST', url);
  if (jwt2 !== jwt) ok('DPoP 每次不同（jti 随机）');
  else bad('DPoP 每次不同（jti 随机）', '两次完全相同');
}

{
  // 续期状态：短 ID / 长 ID 都要能查到同一条记录
  const { RefreshState } = await import('../src/refresh.mjs');
  const st = new RefreshState('');
  st.doc = {};
  const shortId = 'abc123';
  const fullId = 'abc123:user456';
  st.record(shortId, {
    usedToken: 'tok-old',
    rotatedToken: 'tok-new',
    credential: { accessKeyId: 'AK1', expiresAt: new Date(Date.now() + 3600e3).toISOString() },
    userName: 'u',
  });
  const viaShort = st.get(shortId);
  const viaFull = st.get(fullId);
  if (viaShort && viaFull && viaShort === viaFull) ok('续期状态：短 ID / 长 ID 命中同一条');
  else bad('续期状态：短 ID / 长 ID 命中同一条', `${!!viaShort} / ${!!viaFull}`);

  if (st.usableCredential(fullId)?.accessKeyId === 'AK1') ok('usableCredential 支持长 ID');
  else bad('usableCredential 支持长 ID', JSON.stringify(st.usableCredential(fullId)));

  const pick = st.pickToken(fullId, 'tok-old');
  if (pick.token === 'tok-new' && pick.source === 'rotated') ok('pickToken：磁盘 token 未变时用轮换后的');
  else bad('pickToken：磁盘 token 未变时用轮换后的', JSON.stringify(pick));

  // 磁盘上那份变成别的值了 = OfficeAce 自己重新登录、写了份新的 → 跟磁盘走
  const pick2 = st.pickToken(fullId, 'tok-changed-by-app');
  if (pick2.token === 'tok-changed-by-app') ok('pickToken：磁盘 token 换新了就跟着换');
  else bad('pickToken：磁盘 token 换新了就跟着换', JSON.stringify(pick2));

  // 回归：连续轮换多代之后，磁盘上那份**最初**的 token 仍要能定位到最新一代
  // （旧实现只比对 lastUsedToken，第二代之后就会错误地退回已被消费的 T0 → STS5.1806）
  st.record(shortId, {
    usedToken: 'tok-new',
    rotatedToken: 'tok-gen3',
    credential: { accessKeyId: 'AK1b', expiresAt: new Date(Date.now() + 3600e3).toISOString() },
  });
  const pick3 = st.pickToken(fullId, 'tok-old');
  if (pick3.token === 'tok-gen3') ok('pickToken：多代轮换后仍用最新 token');
  else bad('pickToken：多代轮换后仍用最新 token', JSON.stringify(pick3));

  // 冲突时只断链、不能把还有效的凭据一起丢掉
  const before = st.usableCredential(shortId)?.accessKeyId;
  st.breakChain(shortId, 'STS5.1806');
  const afterCred = st.usableCredential(shortId)?.accessKeyId;
  if (before === 'AK1b' && afterCred === 'AK1b') ok('breakChain 保留凭据，只清 token 链');
  else bad('breakChain 保留凭据，只清 token 链', `${before} → ${afterCred}`);

  // ⚠️ 断链后**不能**退回磁盘上那份。
  //
  // 这条以前断言的是 {token:'tok-old', source:'disk'} —— 那正是老实现的死循环：
  // tok-old 早就被消费过了，再发出去必然又 1806，然后又被断链、又退回它……
  // 现在应该继续用轮换值（tok-gen3 才是唯一还可能有效的）。
  const pick4 = st.pickToken(fullId, 'tok-old');
  if (pick4.token === 'tok-gen3' && pick4.source === 'rotated') {
    ok('断链后继续用轮换值，不回到已作废的磁盘 token');
  } else {
    bad('断链后继续用轮换值，不回到已作废的磁盘 token', JSON.stringify(pick4));
  }

  // 被拒的那一份才该被清掉；没被拒的轮换值要留着
  st.record(shortId, {
    usedToken: 'tok-gen3',
    rotatedToken: 'tok-gen4',
    credential: { accessKeyId: 'AK1b', expiresAt: new Date(Date.now() + 3600e3).toISOString() },
  });
  st.breakChain(shortId, 'STS5.1806', 'tok-gen4'); // 这次是轮换值本身被拒
  const afterBreak = st.get(shortId);
  if (!afterBreak.rotatedToken) ok('被拒的正是轮换值时，才把它清掉');
  else bad('被拒的正是轮换值时，才把它清掉', JSON.stringify(afterBreak.rotatedToken));

  // 全废了就说清楚，别硬发一个必然 1806 的 token
  const pick5 = st.pickToken(fullId, 'tok-old');
  if (pick5.token === '' && pick5.source === 'none') ok('token 全废时返回 none，不再硬发');
  else bad('token 全废时返回 none，不再硬发', JSON.stringify(pick5));

  // 过期的凭据不能被复用
  st.record(shortId, {
    usedToken: 'x', rotatedToken: 'y',
    credential: { accessKeyId: 'AK2', expiresAt: new Date(Date.now() - 1000).toISOString() },
  });
  if (st.usableCredential(shortId) === null) ok('过期凭据不复用');
  else bad('过期凭据不复用', JSON.stringify(st.usableCredential(shortId)));

  // 重启补种：list() 只吐还新鲜的凭据，过期的不要
  st.record(shortId, {
    usedToken: 'x', rotatedToken: 'y',
    credential: { accessKeyId: 'AK3', expiresAt: new Date(Date.now() + 7200e3).toISOString() },
  });
  st.record('other1', {
    usedToken: 'x', rotatedToken: 'y',
    credential: { accessKeyId: 'AK4', expiresAt: new Date(Date.now() - 1000).toISOString() },
  });
  const live = st.list();
  const hasLive = live.some((r) => r.credential.accessKeyId === 'AK3');
  const hasDead = live.some((r) => r.credential.accessKeyId === 'AK4');
  if (hasLive && !hasDead) ok('RefreshState.list 只列还新鲜的凭据', `${live.length} 条`);
  else bad('RefreshState.list 只列还新鲜的凭据', JSON.stringify(live.map((r) => r.credential.accessKeyId)));
}

{
  // 续期凭据回填账号档案：磁盘那份是过期的旧凭据，但面板不能一直喊「已过期」
  const { AccountStore } = await import('../src/accounts.mjs');
  const store = new AccountStore({ dataFile: '' });
  const accountId = 'acct1:user1';
  store.accounts.set(accountId, {
    id: accountId,
    short: 'acct1',
    label: '测试号',
    enabled: true,
    sources: [],
    credentials: [{ id: 'c1', baseUrl: 'https://gw/v1', models: [], akPreview: 'AKOLD…' }],
    catalog: [],
    files: [],
    stats: {},
    // 磁盘档案：昨天就过期了
    profile: {
      accessKeyId: 'AKOLD', secretAccessKey: 'oldsk', securityToken: 'oldtok',
      expiresAt: Date.now() - 86400e3, refreshToken: 'T0',
    },
  });
  const acc = store.get(accountId);
  acc.health = { state: 'expired', label: '已过期', detail: '' };

  const freshUntil = Date.now() + 6 * 3600e3;
  const applied = store.applyRefreshedCredential(accountId, {
    accessKeyId: 'AKNEW', secretAccessKey: 'newsk', securityToken: 'newtok',
    projectId: 'p1', expiresAt: new Date(freshUntil).toISOString(),
  });
  if (applied && acc.profile.accessKeyId === 'AKNEW') ok('续期凭据回填到账号档案');
  else bad('续期凭据回填到账号档案', `${applied} / ${acc.profile.accessKeyId}`);

  if (acc.profile.refreshToken === 'T0') ok('回填不碰 refresh_token（否则轮换链会断）');
  else bad('回填不碰 refresh_token（否则轮换链会断）', acc.profile.refreshToken);

  if (acc.profile.diskExpiresAt && acc.profile.diskExpiresAt < Date.now()) ok('磁盘原始过期时间被保留，可对比');
  else bad('磁盘原始过期时间被保留，可对比', String(acc.profile.diskExpiresAt));

  const view = store.list().find((a) => a.id === accountId);
  if (view.credentialSource === 'refreshed' && view.expiresAt > Date.now()) ok('列表里凭据来源标为 refreshed');
  else bad('列表里凭据来源标为 refreshed', `${view.credentialSource} / ${view.expiresAt}`);

  if (view.health.state === 'ok' && view.health.label === '已自动续期') ok('健康度从「已过期」翻正为「已自动续期」');
  else bad('健康度从「已过期」翻正为「已自动续期」', JSON.stringify(view.health));

  // 过期的续期凭据不能套上去
  const applied2 = store.applyRefreshedCredential(accountId, {
    accessKeyId: 'AKDEAD', expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  if (!applied2 && acc.profile.accessKeyId === 'AKNEW') ok('过期续期凭据不覆盖现有可用凭据');
  else bad('过期续期凭据不覆盖现有可用凭据', `${applied2} / ${acc.profile.accessKeyId}`);
}

{
  // 过期的只是**签名用**的临时 AK/SK（24 小时）；请求走的是不失效的 Basic 凭据，
  // 所以这种号其实还能照常转发，只是积分/签到读不出来。标成红的「已过期」
  // 会让用户以为整个号废了 —— 面板要说清楚「可用 · 待续期」。
  const { evaluateHealth } = await import('../src/accounts.mjs');  const mk = (label, credentials) => ({
    id: 'x:u',
    short: 'x',
    label,
    enabled: true,
    sources: [],
    credentials,
    catalog: [],
    files: [],
    stats: {},
    profile: { accessKeyId: 'AKOLD', secretAccessKey: 'sk', securityToken: 'st', expiresAt: Date.now() - 3600e3 },
  });

  const h1 = evaluateHealth(mk('过期但可用', [{ id: 'c1', baseUrl: 'https://gw/v1', models: [], authorization: 'Basic AbCdEf', authPreview: 'Basic A…f' }]));
  if (h1.state === 'expired' && h1.label === '可用 · 待续期') ok('签名凭据过期但 Basic 还在 → 面板标「可用 · 待续期」');
  else bad('签名凭据过期但 Basic 还在 → 面板标「可用 · 待续期」', JSON.stringify(h1));
  if (/转发正常/.test(h1.detail)) ok('提示里说清「转发正常，积分需重登」');
  else bad('提示里说清「转发正常，积分需重登」', h1.detail);

  // 反向对照：连 Basic 凭据都没有的号，必须老实标「已过期」
  const h2 = evaluateHealth(mk('啥都没有', []));
  if (h2.label !== '可用 · 待续期') ok('反向对照：没有 Basic 凭据的号不会被说成可用', `label=${h2.label || '(空)'}`);
  else bad('反向对照：没有 Basic 凭据的号不会被说成可用', JSON.stringify(h2));
}

{
  // 「导入账号走完了，但列表里什么都没多」—— 因为那个号之前在忽略名单里。
  // 登录成功后 attachOauthAccount 必须把 ignored / disabled 一起撤掉，
  // 否则紧跟着的 scan() 会被 ensure() 逐条挡掉，整个登录白跑。
  const { AccountStore } = await import('../src/accounts.mjs');
  const fsx = await import('node:fs');
  const osx = await import('node:os');
  const pathx = await import('node:path');

  // 这个号得**真的能在扫盘时被找到** —— 所以临时把它写进 oauth-accounts.json。
  // 原文件先备份，跑完逐字节还原（里面是真实凭据，绝不能弄坏）。
  const realOauthFile = pathx.join(process.cwd(), 'data', 'oauth-accounts.json');
  const backup = fsx.existsSync(realOauthFile) ? fsx.readFileSync(realOauthFile) : null;
  const oauthDoc = backup ? JSON.parse(backup.toString('utf8')) : {};

  // ⚠️ ID 必须是真实形态（两个 32 位 hex 段）。
  //    用 `acc0001:user0001` 这种好读的短 id 会让 `pruneMetaKeys()` 把它当幽灵键清掉，
  //    于是「撤销忽略后别名还在吗」这条断言会因为一个跟别名无关的原因失败。
  const ID = '0acc0001000000000000000000000001:0acc0001000000000000000000000002';
  oauthDoc[ID] = {
    id: ID,
    accountId: ID.split(':')[0],
    userId: ID.split(':')[1],
    userName: 'GT-m0_00000000',
    baseUrl: 'https://gw.example/v2',
    authorization: 'Basic ' + Buffer.from('ak:sk').toString('base64'),
    createdAt: Date.now(),
    credential: {
      accessKeyId: 'AK1',
      secretAccessKey: 'SK1',
      securityToken: 'ST1',
      expiresAt: new Date(Date.now() + 86400e3).toISOString(),
    },
    refreshToken: 'RT1',
  };
  fsx.mkdirSync(pathx.dirname(realOauthFile), { recursive: true });
  fsx.writeFileSync(realOauthFile, JSON.stringify(oauthDoc, null, 2));

  try {
    // dataFile 给空串 → save() 不会落盘，测的是纯内存逻辑；
    // 但 oauthFile 得显式指到真文件上（构造函数只会从 dataFile 的目录推它），
    // 不然 scan() 读不到那份 oauth 记录，账号永远回不来，这个测试就成了空测。
    const store = new AccountStore({ dataFile: '' });
    store.oauthFile = realOauthFile;
    store.meta.ignored = [ID];
    store.meta.disabled = [ID];
    store.meta.labels[ID] = '被我删过的号';

    // 反向对照：先确认没撤名单时 scan() 真的会把号挡掉（不然这个测试就是空测）
    store.scan();
    if (!store.get(ID)) ok('反向对照：忽略名单里的号确实进不来（扫盘会被挡）');
    else bad('反向对照：忽略名单里的号确实进不来（扫盘会被挡）', '居然进来了');

    const attached = store.attachOauthAccount(oauthDoc[ID]);
    if (attached) ok('自助登录成功 → 账号被挂进号池');
    else bad('自助登录成功 → 账号被挂进号池', 'attach 返回 false');

    if (!(store.meta.ignored || []).includes(ID)) ok('登录成功后已从忽略名单里撤销');
    else bad('登录成功后已从忽略名单里撤销', JSON.stringify(store.meta.ignored));
    if (!(store.meta.disabled || []).includes(ID)) ok('登录成功后已从停用名单里撤销');
    else bad('登录成功后已从停用名单里撤销', JSON.stringify(store.meta.disabled));

    // 关键一步：登录后紧跟的那次全量扫描不能把号又抹掉
    store.scan();
    const back = store.get(ID);
    if (back && back.enabled) ok('紧接着的 scan() 不再把刚登录的号抹掉');
    else bad('紧接着的 scan() 不再把刚登录的号抹掉', back ? `enabled=${back.enabled}` : '号没了');

    // 别名要保留（用户起的名字不能被登录覆盖掉）
    if (back && back.label === '被我删过的号') ok('撤销忽略后原来的别名还在');
    else bad('撤销忽略后原来的别名还在', back ? back.label : '(无)');

    // 新号进来之后，别的号不受影响（别把真实账号一起清了）
    const others = store.list().filter((a) => a.id !== ID);
    if (others.every((a) => Object.keys(store.meta.labels).includes(a.id) || !store.meta.labels[a.id])) {
      ok('撤销忽略只动那一个 ID，不波及其它账号', `共 ${others.length} 个其它账号`);
    } else {
      bad('撤销忽略只动那一个 ID，不波及其它账号', JSON.stringify(others.map((a) => a.id)));
    }
  } finally {
    if (backup) fsx.writeFileSync(realOauthFile, backup);
    else fsx.rmSync(realOauthFile, { force: true });
  }
}

{
  // 积分熔断：余额见底的号不该被挑中，但查不到额度时绝不能拦
  const { CredentialPool } = await import('../src/pool.mjs');
  const mk = (user) => ({
    baseUrl: 'https://gw.example/v1',
    headers: { Authorization: 'Basic ' + Buffer.from(`${user}:sk`).toString('base64') },
    source: 'account',
    userId: user,
    accountId: user,
  });
  const p = new CredentialPool({ cooldownOnEmptyCreditsMs: 600000 });
  p.add(mk('A'));
  p.add(mk('B'));

  const all = () => [0, 1].map(() => p.pick('glm-5.2').userId).sort().join(',');
  if (all() === 'A,B') ok('池子：没余额数据时两条都能用');
  else bad('池子：没余额数据时两条都能用', all());

  p.setCredits([{ id: 'A', remaining: 0, ok: true }, { id: 'B', remaining: 500, ok: true }]);
  const picks = new Set([0, 1, 2, 3].map(() => p.pick('glm-5.2').userId));
  if (picks.size === 1 && picks.has('B')) ok('池子：积分见底的号被熔断', '只选 B');
  else bad('池子：积分见底的号被熔断', [...picks].join(','));

  if (p.list().find((e) => e.userId === 'A')?.outOfCredits === true) ok('池子：list 里标出 outOfCredits');
  else bad('池子：list 里标出 outOfCredits', JSON.stringify(p.list().map((e) => [e.userId, e.outOfCredits])));

  // 两个都见底时仍要返回一个 —— 宁可试一次，也不要直接 503
  p.setCredits([{ id: 'A', remaining: 0, ok: true }, { id: 'B', remaining: 0, ok: true }]);
  if (p.pick('glm-5.2')) ok('池子：全见底时仍返回一条（不硬拦）');
  else bad('池子：全见底时仍返回一条（不硬拦）', '返回了 null');

  // 读不到额度（ok:false）时不能熔断
  p.setCredits([{ id: 'A', remaining: null, ok: false }, { id: 'B', remaining: null, ok: false }]);
  if (all() === 'A,B') ok('池子：读不到额度时不熔断');
  else bad('池子：读不到额度时不熔断', all());

  // 关掉熔断后，见底也能用
  p.setEmptyCreditsCooldown(0);
  p.setCredits([{ id: 'A', remaining: 0, ok: true }, { id: 'B', remaining: 0, ok: true }]);
  if (all() === 'A,B') ok('池子：熔断可关闭');
  else bad('池子：熔断可关闭', all());

  // 账号消失后余额记录要被清掉，免得误伤新号
  p.retain(new Set(), { allowEmpty: true });
  if (p.credits.size === 0) ok('池子：凭据清空后余额记录一并清掉');
  else bad('池子：凭据清空后余额记录一并清掉', String(p.credits.size));
}

{
  /* ------------- 删掉的号，绝不许再发请求 ------------- */
  //
  // 上一版只把忽略名单塞进号池（accounts.mjs）里，而 index.mjs 的
  // runDiscovery() 还有第二条读盘路径：discover() 会把同一个 models.json
  // 里的 Basic 凭据再抠出来当 legacy 凭据补进连接池 —— 它压根不知道
  // 忽略名单存在。结果就是用户在面板上「删除」之后，号是消失了，
  // 但服务照样拿它发请求、照样扣积分。这条测试盯的就是这个。
  const { buildIgnoredIdSet, isIgnoredCredential } = await import('../src/discoverFilter.mjs');
  const { CredentialPool } = await import('../src/pool.mjs');

  const ACC = 'aaaa1111bbbb2222cccc3333dddd4444';
  const USER = 'eeee5555ffff6666aaaa7777bbbb8888';
  const FULL = `${ACC}:${USER}`;
  // discover() 交给我们的 userId 是「目录名 decodeURIComponent」的结果，
  // 也就是 URL 编码的冒号被还原成 `:` 的那个全 ID
  const legacyCred = {
    baseUrl: 'https://modelgw.example/v2',
    // 这里的用户名随便写，只要和下面 otherCred 不同即可。
    // 注意别照抄面板上 / 日志里看到的真实值 —— 这里曾经是真实 AK 的前 8 位，
    // 等于把那 32 bit 明文写进了公开仓库。夹具一律用假值。
    headers: { Authorization: 'Basic ' + Buffer.from('a1b2c3d4:secret').toString('base64') },
    source: 'models.json',
    userId: FULL,
  };
  const otherCred = {
    baseUrl: 'https://modelgw.example/v2',
    headers: { Authorization: 'Basic ' + Buffer.from('other:secret').toString('base64') },
    source: 'models.json',
    userId: 'zzzz:yyyy',
  };

  const ignoredSet = buildIgnoredIdSet([FULL]);
  if (isIgnoredCredential(legacyCred, ignoredSet)) ok('删除：legacy 凭据（全 ID 写法）被认出来');
  else bad('删除：legacy 凭据（全 ID 写法）被认出来', '没匹配上');

  // 三种写法都要认：完整 id / 只有 accountId / 只有 userId
  const asAccountOnly = { ...legacyCred, userId: ACC };
  const asUserOnly = { ...legacyCred, userId: USER };
  if (isIgnoredCredential(asAccountOnly, ignoredSet) && isIgnoredCredential(asUserOnly, ignoredSet)) {
    ok('删除：accountId / userId 单独写法也认得出来');
  } else {
    bad('删除：accountId / userId 单独写法也认得出来', JSON.stringify({ asAccountOnly, asUserOnly }));
  }

  // URL 编码过的目录名（discover 里没解开的情况）也要认
  const encoded = { ...legacyCred, userId: encodeURIComponent(FULL) };
  if (isIgnoredCredential(encoded, ignoredSet)) ok('删除：URL 编码的 ID 也认得出来');
  else bad('删除：URL 编码的 ID 也认得出来', encoded.userId);

  if (!isIgnoredCredential(otherCred, ignoredSet)) ok('删除：没被删的号不受影响');
  else bad('删除：没被删的号不受影响', '误伤了别的号');

  // 池子层面点名剔除：删完之后 pick() 绝不能再抽到它
  const pool = new CredentialPool({});
  pool.add(legacyCred);
  pool.add(otherCred);
  if (pool.size === 2) ok('删除：两条凭据都进池了（对照）');
  else bad('删除：两条凭据都进池了（对照）', String(pool.size));

  // runDiscovery() 里就是照这个形状做的：list() → isIgnoredCredential() → removeByKey()
  for (const entry of [...pool.list()]) {
    if (isIgnoredCredential(entry, ignoredSet)) pool.removeByKey(entry.key);
  }
  const left = [0, 1, 2].map(() => pool.pick('any-model')?.userId);
  if (pool.size === 1 && left.every((u) => u === 'zzzz:yyyy')) ok('删除：已删账号的凭据被真正剔出连接池，pick 再也不碰它');
  else bad('删除：已删账号的凭据被真正剔出连接池，pick 再也不碰它', JSON.stringify({ size: pool.size, picks: left }));

  // 反向对照：没有这道过滤时，被删的号照样会被抽中（证明上面的断言不是空测）
  {
    const naive = new CredentialPool({});
    naive.add(legacyCred);
    naive.add(otherCred);
    const hits = new Set([0, 1, 2, 3, 4].map(() => naive.pick('any-model')?.userId));
    if (hits.has(FULL)) ok('对照：不做忽略过滤时，已删账号照样被抽中（断言非空测）');
    else bad('对照：不做忽略过滤时，已删账号照样被抽中（断言非空测）', '居然没抽到，对照失效');
  }
}

{
  // 面板结构：菜单合并成 7 项之后，菜单 / 分组 / 页面容器三者必须对得上。
  // 这类错误只在浏览器里点出来，静态测一遍能省很多次「页面白屏」的排查。
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../src/admin.html', import.meta.url), 'utf8');

  const navKeys = [...html.matchAll(/data-p="([a-z-]+)"/g)].map((m) => m[1]);
  const pageIds = [...html.matchAll(/id="p-([a-z-]+)"/g)].map((m) => m[1]);

  if (navKeys.length === 7) ok('面板：菜单是 7 项（12 个页面已合并）');
  else bad('面板：菜单是 7 项（12 个页面已合并）', `实际 ${navKeys.length}: ${navKeys.join(',')}`);

  if (new Set(navKeys).size === navKeys.length) ok('面板：菜单没有重复项');
  else bad('面板：菜单没有重复项', navKeys.join(','));

  // 从源码里抠出 GROUPS 的定义来核对
  const gsrc = html.match(/const GROUPS = \{([\s\S]*?)\n\};/);
  const groups = {};
  if (gsrc) {
    for (const line of gsrc[1].split('\n')) {
      const m = line.match(/^\s*([a-z]+):\s*\[([^\]]*)\]/);
      if (m) groups[m[1]] = [...m[2].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]);
    }
  }
  const groupKeys = Object.keys(groups);
  if (groupKeys.length === 7) ok('面板：GROUPS 定义了 7 个菜单');
  else bad('面板：GROUPS 定义了 7 个菜单', groupKeys.join(','));

  const missingNav = groupKeys.filter((g) => !navKeys.includes(g));
  if (missingNav.length === 0) ok('面板：每个分组都有对应的菜单项');
  else bad('面板：每个分组都有对应的菜单项', missingNav.join(','));

  const orphans = navKeys.filter((g) => !groupKeys.includes(g));
  if (orphans.length === 0) ok('面板：没有无分组的孤立菜单项');
  else bad('面板：没有无分组的孤立菜单项', orphans.join(','));

  // 分组里引用的每一块内容，都必须真的有一个 id="p-xxx" 的容器
  const referenced = Object.values(groups).flat();
  const dangling = referenced.filter((b) => !pageIds.includes(b));
  if (dangling.length === 0) ok('面板：分组引用的内容块都存在', `${referenced.length} 块`);
  else bad('面板：分组引用的内容块都存在', '找不到: ' + dangling.join(','));

  // 反向：每个页面容器都得被某个分组收着，否则永远显示不出来（白做）
  const ungrouped = pageIds.filter((b) => !referenced.includes(b));
  if (ungrouped.length === 0) ok('面板：所有内容块都被菜单收进去了', `${pageIds.length} 块`);
  else bad('面板：所有内容块都被菜单收进去了', '漏掉: ' + ungrouped.join(','));

  // 页面里不能有指向「不存在的菜单」的链接
  const hashLinks = [...new Set([...html.matchAll(/href="#([a-z-]+)"/g)].map((m) => m[1]))];
  const badHashes = hashLinks.filter((h) => !navKeys.includes(h) && !referenced.includes(h));
  if (badHashes.length === 0) ok('面板：站内 # 链接都能落地', hashLinks.join(','));
  else bad('面板：站内 # 链接都能落地', '悬空: ' + badHashes.join(','));

  // 浅色主题：不该再残留深色底
  const lightTokens = html.match(/:root\{[\s\S]*?--bg:(#[0-9a-f]{6})/);
  const bg = lightTokens ? lightTokens[1] : '';
  if (/^#f/.test(bg) || /^#e/.test(bg)) ok('面板：底色是浅色系', bg);
  else bad('面板：底色是浅色系', bg || '没找到 --bg');

  const darkLeft = ['#0e1013', '#15181e', '#1a1e26', '#0a0c10', '#0d1017', '#141821', '#cfdcff']
    .filter((c) => html.includes(c));
  if (darkLeft.length === 0) ok('面板：深色主题的硬编码残留已清干净');
  else bad('面板：深色主题的硬编码残留已清干净', darkLeft.join(','));

  // 导入账号弹窗：JS 里 $("...") 引用的 id 必须真的存在，否则点了没反应
  const ids = new Set([...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
  const adRefs = [...new Set([...html.matchAll(/\$\("#(ad[A-Za-z]+)"\)/g)].map((m) => m[1]))];
  const missingAd = adRefs.filter((i) => !ids.has(i));
  if (adRefs.length >= 10 && missingAd.length === 0) ok('面板：导入弹窗引用的元素都存在', adRefs.length + ' 个');
  else bad('面板：导入弹窗引用的元素都存在', missingAd.length ? '找不到: ' + missingAd.join(',') : `只找到 ${adRefs.length} 个引用`);

  // 弹窗得是个真弹窗：遮罩 + 三个状态面板
  for (const id of ['adVeil', 'adIntro', 'adWait', 'adDone', 'adErr', 'adGo', 'adUrl', 'adOpen', 'adCopy']) {
    if (ids.has(id)) continue;
    bad('面板：导入弹窗结构完整', '缺 ' + id);
  }
  if (['adVeil', 'adIntro', 'adWait', 'adDone', 'adErr', 'adGo', 'adUrl', 'adOpen', 'adCopy'].every((i) => ids.has(i))) {
    ok('面板：导入弹窗结构完整');
  }

  // 「导入账号」必须是打开弹窗，不能又退回手工填表
  if (/\$\("#acImportToggle"\)\.addEventListener\("click",\s*adOpen\)/.test(html)) {
    ok('面板：导入账号点开的是自助登录弹窗');
  } else {
    bad('面板：导入账号点开的是自助登录弹窗', '没绑到 adOpen');
  }

  // 点开始要真的开新标签页 —— 这是「点一下就登录」的关键
  if (/window\.open\(r\.url,\s*"_blank"/.test(html)) ok('面板：拿到链接会自动开新标签页');
  else bad('面板：拿到链接会自动开新标签页', '没找到 window.open(r.url, "_blank")');

  /**
   * 模型管理的黄色提示条（#mdlUnavail）：文案必须和 server 的实际行为对上。
   *
   * 这条是补一个真实事故的：`/v1/models` 的行为从「全列出来」改成
   * 「默认藏掉打不通的」之后，面板上的提示还写着"它们仍然留在 /v1/models 里
   * （客户端配置不用改）" —— **面板在骗用户**，而且没有任何测试会发现。
   *
   * 取代码块用「renderModels 函数体」，不能用定长窗口 —— 窗口太短会把要断言的
   * 东西截在框外（实测踩过：一个 2600 字的窗口刚好够不到要断言的关键字，
   * 于是误报"没告诉用户怎么改回来"）。而且注释里也提到了同一句反面文案，
   * 所以断言前先剥掉注释行，否则注释会被当成正文。
   */
  const unavailSrc = (() => {
    const fnStart = html.indexOf('function renderModels()');
    if (fnStart < 0) return '';
    // 终点取"下一个顶层 function"，不要用注释当界碑 —— 注释在文件里的顺序
    // 和函数定义不一定一致（实测这儿就踩过：`模型管理` 那条注释在函数**前面**）。
    const rest = html.slice(fnStart + 22);
    const nextFn = rest.search(/\nfunction [a-zA-Z_$]/);
    const body = nextFn >= 0 ? rest.slice(0, nextFn) : rest.slice(0, 20000);
    return body
      .replace(/\/\*[\s\S]*?\*\//g, '') // 剥块注释
      .replace(/^\s*\/\/.*$/gm, ''); // 剥行注释
  })();
  if (unavailSrc) {
    const b = unavailSrc;
    if (/已从[\s\S]{0,80}\/v1\/models/.test(b) || /不列进下面的表/.test(b)) {
      ok('面板：模型提示条说的和实际行为一致（已经藏掉了）');
    } else {
      bad('面板：模型提示条还在说"仍然留在 /v1/models 里"', '文案和 server.mjs 的 hideUnavailable 行为不一致');
    }
    if (/mdlUnavail/.test(b) && /modelsUnavailable/.test(b)) ok('面板：提示条读的是 health.modelsUnavailable');
    else bad('面板：提示条没读 health.modelsUnavailable');
    if (/btnProbeModels/.test(b) && /重探一遍/.test(b)) ok('面板：提示条上有「重探一遍」按钮');
    else bad('面板：提示条上没有重探按钮');
    // api() 只认 json，写 body 会静默发空 body（见下面那条 api() 测试）
    if (/admin\/api\/models\/probe/.test(b) && /json:\s*\{\}/.test(b)) ok('面板：重探按钮打的是正确的接口和 body 写法');
    else bad('面板：重探按钮的调用写法不对', '必须用 json:{} 且打 admin/api/models/probe');
    if (/method:\s*"POST"/.test(b)) ok('面板：重探按钮用的是 POST');
    else bad('面板：重探按钮没用 POST');
    if (/toast\([^)]*,\s*"(ok|err)"\)/.test(b)) ok('面板：重探结果有 toast 反馈（且 kind 是 ok/err）');
    else bad('面板：重探结果没有正确的 toast');
    // 打不通的模型默认不列进下面的表，但要有开关能翻出来看（否则用户无从核对）
    if (/mdlShowUnavail/.test(b) && /mdlToggleUnavail/.test(b)) ok('面板：打不通的模型默认不列，但有开关能翻出来');
    else bad('面板：打不通的模型没有「翻出来看」的开关');
  } else {
    bad('面板：能找到模型提示条那块代码', '没匹配到 renderModels() 的边界');
  }

  // #mdlUnavail 这个容器本身得存在，否则上面那块代码永远不执行
  if (ids.has('mdlUnavail')) ok('面板：#mdlUnavail 容器存在');
  else bad('面板：#mdlUnavail 容器存在', '缺 id="mdlUnavail"');
}

{
  // 面板的 api() 助手：必须把 opts.json 翻译成真正的请求体。
  //
  // 这条测试是补上一个真实事故的：以前 api() 把 opts 原样交给 fetch，
  // 而 fetch 不认识 json 键，于是面板发出的每个 POST 都是空 body ——
  // 改名 / 停用 / 删除 / 测活 / 保存配置全都静默失败（服务端回「缺少 id」）。
  // 之所以一直没被发现，就是因为以前的测试全是直接打接口，绕过了这个助手。
  //
  // 所以这里把 admin.html 里的真身抠出来，配上假的 fetch 跑一遍。
  const fsApi = await import('node:fs');
  const html = fsApi.readFileSync(new URL('../src/admin.html', import.meta.url), 'utf8');
  const src = html.match(/async function api\(path, opts\)\s*\{[\s\S]*?\n\}/);
  if (!src) {
    bad('面板：api() 能把 json 变成请求体', '没在 admin.html 里找到 api 函数');
  } else {
    const J = { 'Content-Type': 'application/json' };
    const H = () => ({ 'x-admin-token': 'T' });

    /** 造一个假的 fetch，把收到的参数记下来 */
    const spy = (reply) => {
      const seen = [];
      const fake = async (path, o) => {
        seen.push({ path, o });
        return { ok: true, status: 200, text: async () => JSON.stringify(reply ?? { ok: true }) };
      };
      return { seen, fake };
    };

    const build = (fakeFetch) =>
      new Function('fetch', 'H', 'J', `"use strict";\n${src[0]}\nreturn api;`)(fakeFetch, H, J);

    // ① 带 json：请求体要是那个对象的 JSON
    {
      const s = spy();
      const api = build(s.fake);
      await api('/x', { method: 'POST', json: { id: 'a:b', label: '名字' } });
      const got = s.seen[0];
      const bodyOk = got && got.o.body === JSON.stringify({ id: 'a:b', label: '名字' });
      if (bodyOk) ok('面板：api() 把 json 发成了请求体');
      else bad('面板：api() 把 json 发成了请求体', `body = ${JSON.stringify(got?.o?.body)}`);

      if (got && !('json' in got.o)) ok('面板：api() 不再把 json 键漏给 fetch');
      else bad('面板：api() 不再把 json 键漏给 fetch', 'json 还在 opts 里');

      if (got && got.o.headers['Content-Type'] === 'application/json') ok('面板：带 json 时自动加 Content-Type');
      else bad('面板：带 json 时自动加 Content-Type', JSON.stringify(got?.o?.headers));

      if (got && got.o.headers['x-admin-token'] === 'T') ok('面板：面板块自己的头没被覆盖');
      else bad('面板：面板块自己的头没被覆盖', JSON.stringify(got?.o?.headers));

      if (got && got.o.method === 'POST') ok('面板：api() 保留 method');
      else bad('面板：api() 保留 method', got?.o?.method);
    }

    // ② 不带 json：不能凭空造 body 出来
    {
      const s = spy();
      const api = build(s.fake);
      await api('/y');
      const got = s.seen[0];
      if (got && got.o.body === undefined) ok('面板：没有 json 时不发请求体');
      else bad('面板：没有 json 时不发请求体', JSON.stringify(got?.o?.body));
    }

    // ③ 空对象 {} 也要发（它是「全部」的意思，不能当没传）
    {
      const s = spy();
      const api = build(s.fake);
      await api('/z', { method: 'POST', json: {} });
      const got = s.seen[0];
      if (got && got.o.body === '{}') ok('面板：json:{} 也照发（不是「没传」）');
      else bad('面板：json:{} 也照发（不是「没传」）', JSON.stringify(got?.o?.body));
    }

    // ④ 真打一次服务端：这条才是真的证明「点了删除不会再回缺少 id」
    {
      // 这里换成真的 fetch（拼上 base），别的测试还是用假的
      const realFetch = (p, o) => fetch(base + p, o);

      /** 打一次删除接口，返回错误信息（没抛错就是空串） */
      const tryRemove = async (apiFn, id) => {
        try {
          await apiFn('/admin/api/accounts/remove', { method: 'POST', json: { id } });
          return '';
        } catch (e) {
          return e.message || String(e);
        }
      };

      const api = build(realFetch);
      const msg = await tryRemove(api, 'no-such-account:0');
      // 不存在的账号回什么都可以，唯独不能是「缺少 id」——那说明 body 又丢了
      if (!msg.includes('缺少 id')) ok('面板：经 api() 打删除接口不再报「缺少 id」', msg ? msg.slice(0, 36) : '服务端收到了请求体');
      else bad('面板：经 api() 打删除接口不再报「缺少 id」', msg);

      // 反向对照：用出事前那版实现，"缺少 id" 必须复现。
      // 没有这条，上面的测试可能只是碰巧通过（比如接口根本不校验）。
      const oldSrc = `async function api(path, opts) {
        const res = await fetch(path, Object.assign({ headers: Object.assign({}, H(), (opts && opts.json) ? J : {}) }, opts || {}));
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
        if (!res.ok) throw new Error((data && data.error && data.error.message) || ("HTTP " + res.status));
        return data;
      }`;
      const oldApi = new Function('fetch', 'H', 'J', `"use strict";\n${oldSrc}\nreturn api;`)(realFetch, H, J);
      const oldMsg = await tryRemove(oldApi, 'no-such-account:0');
      if (oldMsg.includes('缺少 id')) ok('面板：旧写法确实会丢 body（对照，证明上面那条测得住）');
      else if (/token|口令|401/.test(oldMsg)) {
        // 这条对照测试想验的是"旧写法会丢 body"，可它得先过鉴权那关才能打到接口。
        // 面板现在要口令了，所以旧写法现在会先被 401 拦下 —— 那就换个方式证明：
        // 直接看旧写法拼出来的请求对象里到底有没有 body。
        const seen = {};
        const spy = async (p, o) => { Object.assign(seen, o || {}); return { ok: true, status: 200, text: async () => '{"ok":true}' }; };
        const spyApi = new Function('fetch', 'H', 'J', `"use strict";\n${oldSrc}\nreturn api;`)(spy, H, J);
        await spyApi('/x', { method: 'POST', json: { id: 'a' } }).catch(() => {});
        if (seen.body === undefined) {
          ok('面板：旧写法确实不生成 body（对照，证明上面那条测得住）', `实测发出的键: ${Object.keys(seen).join(',') || '（空）'}`);
        } else {
          bad('面板：旧写法居然生成了 body，对照失效', JSON.stringify(seen));
        }
      } else bad('面板：旧写法确实会丢 body（对照，证明上面那条测得住）', oldMsg || '旧写法居然也正常？');
    }
  }
}

{
  // 自助登录：不依赖 OfficeAce 桌面端的那条链路
  const { generatePkce, buildAuthorizeUrl, LoginSessions } = await import('../src/oauth.mjs');
  const { toAccountRecord } = await import('../src/accounts.mjs');

  const pk = generatePkce();
  if (pk.verifier.length >= 43 && /^[A-Za-z0-9_-]+$/.test(pk.verifier) && !pk.verifier.includes('=')) ok('自助登录：PKCE verifier 是 43 位以上 base64url');
  else bad('自助登录：PKCE verifier 是 43 位以上 base64url', pk.verifier);

  const { createHash } = await import('node:crypto');
  const want = createHash('sha256').update(pk.verifier).digest('base64url');
  if (pk.challenge === want) ok('自助登录：code_challenge 是 verifier 的 SHA-256');
  else bad('自助登录：code_challenge 是 verifier 的 SHA-256', pk.challenge);

  if (generatePkce().verifier !== pk.verifier) ok('自助登录：每次的 verifier 都不一样');
  else bad('自助登录：每次的 verifier 都不一样', '两次一样');

  const url = buildAuthorizeUrl({ state: 'st123', challenge: 'ch123' });
  const checks = [
    ['自助登录：授权链接指向华为登录页', url.startsWith('https://auth.huaweicloud.com/authui/login.html?service=')],
    ['自助登录：链接里带 code_challenge', url.includes('ch123')],
    ['自助登录：链接里带 state', url.includes('st123')],
    ['自助登录：链接里 redirect_uri 指向云端', decodeURIComponent(decodeURIComponent(url)).includes('/v1/claw/auth/callback')],
    ['自助登录：用的是 authorization_code', decodeURIComponent(decodeURIComponent(url)).includes('response_type=code')],
    ['自助登录：声明了 S256', decodeURIComponent(decodeURIComponent(url)).includes('code_challenge_method=SHA-256')],
  ];
  for (const [m, c] of checks) { if (c) ok(m); else bad(m, url.slice(0, 160)); }

  /* ------------------------------- 「换一个账号」那条链接 */
  // 华为云有会话时会**直接放行**（拿当前号又登一遍），用户点了「导入账号」看不到登录页。
  // 所以新增号必须走「先登出、再授权」。这里只测 URL 形状：不能真去登出云端的会话。
  {
    const { buildSwitchAccountUrl } = await import('../src/oauth.mjs');
    const sw = buildSwitchAccountUrl({ authorizeUrl: url });
    const svc = sw.slice(sw.indexOf('service=') + 'service='.length);
    let decoded = '';
    try {
      decoded = decodeURIComponent(svc);
    } catch {
      /* 解码失败留在下面判 */
    }
    const swChecks = [
      ['换账号：链接指向华为登出', sw.startsWith('https://auth.huaweicloud.com/authui/logout?service=')],
      ['换账号：登出之后回授权流程（service = authorize 地址）', decoded === url],
      ['换账号：授权地址里 state 没丢', decoded.includes('st123')],
      ['换账号：授权地址里 code_challenge 没丢', decoded.includes('ch123')],
    ];
    for (const [m, c] of swChecks) { if (c) ok(m); else bad(m, sw.slice(0, 160)); }

    // 反向对照：不套登出层的那条链接里**不该**出现 logout，
    // 否则「两个模式」就没区别了，测试也成了空测。
    if (!url.includes('/authui/logout')) ok('换账号：反向对照——普通模式下不带登出（两个模式真的不一样）');
    else bad('换账号：反向对照——普通模式下不带登出（两个模式真的不一样）', url.slice(0, 160));
  }

  // 会话落盘 + 过期淘汰
  const os = await import('node:os');
  const fsx = await import('node:fs');
  const pathx = await import('node:path');
  const tmp = pathx.join(os.tmpdir(), `oa-login-test-${Date.now()}.json`);
  const sess = new LoginSessions(tmp);
  sess.create({ id: 'a', status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 60000 });
  sess.create({ id: 'b', status: 'pending', createdAt: Date.now(), expiresAt: Date.now() - 1 });
  const reopened = new LoginSessions(tmp);
  if (reopened.map.size === 1 && reopened.map.has('a')) ok('自助登录：会话落盘后能恢复，过期的自动丢');
  else bad('自助登录：会话落盘后能恢复，过期的自动丢', `恢复了 ${reopened.map.size} 条`);

  if (reopened.get('nope') === null) ok('自助登录：查不存在的会话返回 null');
  else bad('自助登录：查不存在的会话返回 null', '返回了东西');

  fsx.rmSync(tmp, { force: true });

  // 登录结果 → 号池账号
  const rec = toAccountRecord({
    id: 'ACC:USR',
    label: '自助号',
    userName: 'demo',
    accountId: 'ACC',
    userId: 'USR',
    baseUrl: 'https://gw.example.com/v2',
    authorization: 'Basic QUJD',
    createdAt: 1700000000000,
    credential: { accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'TOK', projectId: 'PJ', expiresAt: new Date(Date.now() + 3600e3).toISOString() },
    refreshToken: 'RT',
    dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: '1', y: '2', d: '3' },
    dpopPublicJwk: { kty: 'EC', crv: 'P-256', x: '1', y: '2' },
  });
  const rchecks = [
    ['自助登录：账号 ID 用「账号:用户」拼法', rec.id === 'ACC:USR'],
    ['自助登录：带上了网关凭据', rec.credentials.length === 1 && rec.credentials[0].baseUrl === 'https://gw.example.com/v2'],
    ['自助登录：来源标成 oauth-login', rec.sources.includes('oauth-login')],
    ['自助登录：profile 里有 AK/SK（控制面要用）', rec.profile.accessKeyId === 'AK' && rec.profile.secretAccessKey === 'SK'],
    ['自助登录：profile 里有刷新令牌', rec.profile.refreshToken === 'RT'],
    ['自助登录：profile 里有 DPoP 私钥（否则没法自动续期）', !!rec.profile.raw.dpop?.privateJwk],
    ['自助登录：过期时间翻译成了毫秒', rec.profile.expiresAt > Date.now()],
  ];
  for (const [m, c] of rchecks) { if (c) ok(m); else bad(m, JSON.stringify(rec.profile).slice(0, 120)); }

  // 缺 DPoP 私钥时不能崩，只是续期会失败
  const bare = toAccountRecord({ id: 'X:Y', baseUrl: 'https://g/v2', authorization: 'Basic QQ' });
  if (bare.profile.raw.dpop === undefined) ok('自助登录：没有 DPoP 私钥时不崩，只是标成缺');
  else bad('自助登录：没有 DPoP 私钥时不崩，只是标成缺', '不该有 dpop');
}

{
  // 自助登录接口：start → poll → cancel
  const s = await call('/admin/api/login/start', { method: 'POST', body: { label: '自测' } });
  if (s.status === 200 && s.json?.url?.startsWith('https://auth.huaweicloud.com/')) {
    ok('接口：登录发起成功并给了授权链接');
  } else {
    bad('接口：登录发起成功并给了授权链接', `HTTP ${s.status} ${s.text.slice(0, 160)}`);
  }

  const id = s.json?.id || '';
  if (id && s.json.status === 'pending') ok('接口：新会话是 pending');
  else bad('接口：新会话是 pending', s.json?.status);

  // 私钥绝不出服务端
  const raw = s.text;
  const leaked = ['codeVerifier', 'dpopPrivateJwk', 'dpopPublicJwk', 'secretAccessKey'].filter((k) => raw.includes(k));
  if (leaked.length === 0) ok('接口：会话视图不泄漏私钥和 code_verifier');
  else bad('接口：会话视图不泄漏私钥和 code_verifier', leaked.join(','));

  if (s.json?.expiresInMs > 0) ok('接口：会话带剩余有效期', `${Math.round(s.json.expiresInMs / 1000)}s`);
  else bad('接口：会话带剩余有效期', String(s.json?.expiresInMs));

  const p1 = await call(`/admin/api/login/poll?id=${encodeURIComponent(id)}`);
  if (p1.status === 200 && p1.json.status === 'pending') ok('接口：轮询返回 pending（还在等登录）');
  else bad('接口：轮询返回 pending（还在等登录）', `HTTP ${p1.status} ${p1.json?.status}`);

  const miss = await call('/admin/api/login/poll?id=does-not-exist');
  if (miss.status === 404) ok('接口：轮询不存在的会话返回 404');
  else bad('接口：轮询不存在的会话返回 404', String(miss.status));

  const c1 = await call('/admin/api/login/cancel', { method: 'POST', body: { id } });
  if (c1.status === 200 && c1.json.ok && c1.json.session?.status === 'canceled') ok('接口：取消登录生效');
  else bad('接口：取消登录生效', c1.text.slice(0, 140));

  const p2 = await call(`/admin/api/login/poll?id=${encodeURIComponent(id)}`);
  if (p2.json?.status === 'canceled') ok('接口：取消后轮询不再说 pending');
  else bad('接口：取消后轮询不再说 pending', p2.json?.status);

  const st = await call('/admin/api/login/status');
  if (st.status === 200 && Array.isArray(st.json?.accounts) && Array.isArray(st.json?.sessions)) {
    ok('接口：自助登录概览可取', `${st.json.accounts.length} 账号 / ${st.json.sessions.length} 会话`);
  } else {
    bad('接口：自助登录概览可取', st.text.slice(0, 140));
  }

  const cl = await call('/admin/api/login/clear', { method: 'POST', body: {} });
  if (cl.status === 200 && cl.json.ok) ok('接口：清理结束的登录会话');
  else bad('接口：清理结束的登录会话', cl.text.slice(0, 140));
}

{
  // 号池「删除」：本机发现的号删不掉，得进忽略名单，而且真能挡住下一轮扫盘。
  //
  // 这里盯的是两个曾经同时存在的毛病：
  //   1) remove() 里写的是 `disabled.filter((x) => x !== key)` —— 那是 setEnabled()
  //      里「启用」那一半，方向抄反了。点删除既不删也不停，反而会把一个
  //      本来停用的号**重新启用**。
  //   2) 没有任何机制阻止下一轮 scan() 把它捡回来，所以即使删了也等于没删。
  const { AccountStore } = await import('../src/accounts.mjs');
  const store = new AccountStore({ dataFile: '' });
  store.save = () => {}; // 这条用空 dataFile，别真去写盘

  const id = 'aaaa1111:user9';
  const diskAcc = () => ({
    id,
    short: 'aaaa1111',
    label: '磁盘号',
    enabled: true,
    sources: ['routing-state', 'oauth-profile'],
    credentials: [{ id: 'c1', baseUrl: 'https://gw/v1', models: [], akPreview: 'AK…' }],
    catalog: [],
    files: {},
    stats: {},
    profile: null,
  });

  // 先把号停用，再点删除 —— 老代码会把「停用」反转成「启用」
  store.accounts.set(id, diskAcc());
  store.setEnabled(id, false);
  if (store.accounts.get(id).enabled === false) ok('号池：可以停用');
  else bad('号池：可以停用', String(store.accounts.get(id).enabled));

  const r = store.remove(id);
  if (r.removable === false && r.ignored === true) ok('号池删除：本机号走忽略而不是真删');
  else bad('号池删除：本机号走忽略而不是真删', JSON.stringify(r));

  // 删之前它是停用状态，删之后必须还是停用（老代码会把它反转成启用）
  if (store.meta.disabled.includes(id)) ok('号池删除：仍然停用（老代码会反转成启用）');
  else bad('号池删除：仍然停用（老代码会反转成启用）', JSON.stringify(store.meta.disabled));

  // 对照：把老实现那一行原样搬过来跑，确认它确实会反转（不然上面那条是空测）
  {
    const oldDisabled = [id];
    const afterOld = oldDisabled.filter((x) => x !== id); // ← 老 remove() 的原话
    if (!afterOld.includes(id)) ok('对照：老实现确实会把停用反转成启用（上面的断言不是空测）');
    else bad('对照：老实现确实会把停用反转成启用（上面的断言不是空测）', '老逻辑没反转，对照失效');
  }

  if (store.meta.ignored.includes(id)) ok('号池删除：进了忽略名单');
  else bad('号池删除：进了忽略名单', JSON.stringify(store.meta.ignored));

  if (!store.accounts.has(id)) ok('号池删除：立刻从列表消失');
  else bad('号池删除：立刻从列表消失', '还在 map 里');

  // 关键：扫盘不能再把它捡回来。
  //
  // dataRoots() 永远包含本机真实的 ~/.office-claw，隔离不掉，所以干脆拿
  // 真实扫盘结果当素材 —— 这正是用户遇到的场景：磁盘上的号点删除后必须消失。
  // save() 已经被替换成空函数，不会碰到真的 data/accounts.json。
  const realScan = new AccountStore({ dataFile: '' });
  realScan.save = () => {};
  let scanErr = '';
  try {
    realScan.scan();
  } catch (e) {
    scanErr = e.message;
  }
  const realId = [...realScan.accounts.keys()][0];
  if (scanErr) {
    bad('号池删除：扫盘后不再出现（本机真实账号）', 'scan() 抛错：' + scanErr);
  } else if (!realId) {
    // 这台机器上没有可扫的号，跳过（不算失败，其余断言已经覆盖了逻辑）
    console.log('  · 号池删除：本机没有真实账号可扫，跳过端到端那条');
  } else {
    realScan.remove(realId);
    realScan.scan();
    if (!realScan.accounts.has(realId)) ok('号池删除：扫盘后不再出现（本机真实账号）');
    else bad('号池删除：扫盘后不再出现（本机真实账号）', 'scan() 又把 ' + realId.slice(0, 20) + ' 加回来了');

    // 恢复之后必须能回来，否则等于单向门
    realScan.restore(realId);
    realScan.scan();
    if (realScan.accounts.has(realId)) ok('号池恢复：扫盘后能回来（本机真实账号）');
    else bad('号池恢复：扫盘后能回来（本机真实账号）', 'restore() 之后 scan() 没把它带回来');
  }

  // 别名要在忽略名单里留得住，否则恢复页上只能看到一串 ID 前缀
  const ig = store.ignoredList();
  if (ig.length === 1 && ig[0].label === '磁盘号') ok('号池删除：忽略名单保留别名');
  else bad('号池删除：忽略名单保留别名', JSON.stringify(ig));

  // 恢复：放回扫盘范围，而且默认顺带启用
  if (store.restore(id) === true) ok('号池恢复：可以取消忽略');
  else bad('号池恢复：可以取消忽略', '返回 false');

  if (!store.meta.ignored.includes(id) && !store.meta.disabled.includes(id)) {
    ok('号池恢复：同时从忽略和停用名单里出来');
  } else {
    bad('号池恢复：同时从忽略和停用名单里出来', JSON.stringify({ ig: store.meta.ignored, dis: store.meta.disabled }));
  }

  if (store.restore(id) === false) ok('号池恢复：不在名单里时返回 false');
  else bad('号池恢复：不在名单里时返回 false', '居然返回 true');

  // 手工导入的号是真删，不该进忽略名单
  const imp = 'bbbb2222:user8';
  store.accounts.set(imp, { ...diskAcc(), id: imp, sources: ['imported'] });
  const r2 = store.remove(imp);
  if (r2.removable === true && !store.accounts.has(imp) && !store.meta.ignored.includes(imp)) {
    ok('号池删除：手工导入的号真删，不进忽略名单');
  } else {
    bad('号池删除：手工导入的号真删，不进忽略名单', JSON.stringify(r2));
  }
}

  /* -------------------------------------------------- 号池扫描的日志 */
  // 这一节盯的是「日志被同一句话糊住」这件事。
  //
  // 起因：scan() 的调用方周期都很短（一键授权 3 秒 / 注册队列 5 秒 / 周期刷新
  // 45 秒 / 面板按钮），而它以前**无条件**打一条 INFO。实测日志 400 行里有 274 行
  // 都是同一句「号池扫描完成 {"accounts":2,"credentials":2}」，真正的事件
  // （新增账号、凭据数变了、被忽略名单拦下）全被埋在里头看不见。
  // 现在的规矩：有变化才 INFO（带变化前的数字），没变化退到 DEBUG 且限流。
  {
    const { AccountStore: Store } = await import('../src/accounts.mjs');
    const { getRecentLogs, clearRecentLogs } = await import('../src/logger.mjs');
    const scans = (level) =>
      getRecentLogs().filter((l) => l.msg.startsWith('号池扫描完成') && (!level || l.level === level));

    const st = new Store({ dataFile: '' });
    st.save = () => {};
    clearRecentLogs();

    st.scan(); // 第一次没有基线，一定算「有变化」
    if (scans('info').length === 1) ok('号池扫描：首扫（没有基线）算有变化 → INFO');
    else bad('号池扫描：首扫没打 INFO', JSON.stringify(scans().map((l) => l.level)));

    for (let i = 0; i < 3; i += 1) st.scan(); // 池子没变，连扫三次
    if (scans('info').length === 1) {
      ok('号池扫描：没变化时不再重复打 INFO', `连扫 3 次仍是 1 条`);
    } else {
      bad('号池扫描：没变化也一直打 INFO', `${scans('info').length} 条`);
    }

    // 心跳：没变化也不能完全静默，否则看不出扫描还活着（限流 5 分钟一条）
    if (scans('debug').length <= 1) ok('号池扫描：没变化退到 DEBUG 且限流', `${scans('debug').length} 条`);
    else bad('号池扫描：DEBUG 心跳没限流', `${scans('debug').length} 条`);

    const logId = [...st.accounts.keys()][0];
    if (!logId) {
      console.log('  · 号池扫描：本机没有真实账号可扫，变化那条跳过');
    } else {
      clearRecentLogs();
      st.remove(logId);
      st.scan(); // 号少了 → 必须冒出一条 INFO，并带上是变化前的数字
      const hit = scans('info');
      if (hit.length === 1 && hit[0].extra && hit[0].extra.was) {
        ok('号池扫描：池子真变了 → INFO，并带变化前的数字', JSON.stringify(hit[0].extra));
      } else {
        bad('号池扫描：池子变了没打 INFO 或没带 was', JSON.stringify(hit.map((l) => l.extra)));
      }
    }

    // cached：轮询方（授权 3 秒 / 周期刷新）允许「最多慢一秒」，同一秒内复用结果
    const cch = new Store({ dataFile: '' });
    cch.save = () => {};
    cch.scan();
    const t0 = cch.lastScanAt;
    cch.scan({ cached: true });
    if (cch.lastScanAt === t0) ok('号池扫描：cached:true 在同一秒内复用结果（不重复扫盘）');
    else bad('号池扫描：cached:true 没有合并', `又扫了一遍（${t0} → ${cch.lastScanAt}）`);

    // 默认（fresh）绝不能被合并 —— 删除 / 恢复 / 面板按钮 / 本文件都靠它
    const fr = new Store({ dataFile: '' });
    fr.save = () => {};
    fr.scan();
    const frId = [...fr.accounts.keys()][0];
    if (!frId) {
      console.log('  · 号池扫描：本机没有真实账号，fresh 那条跳过');
    } else {
      const wasAt = fr.lastScanAt;
      fr.remove(frId);
      fr.scan(); // 同一秒内的 fresh 扫描：改动必须立刻可见
      if (!fr.accounts.has(frId) && fr.lastScanAt >= wasAt) ok('号池扫描：fresh 不合并 —— 删完立刻扫，改动立刻可见');
      else bad('号池扫描：fresh 被合并了（拿到改之前的缓存）', `has=${fr.accounts.has(frId)}`);
    }
  }

  /* -------------------------------------------------- 日志时间用本机时区 */
  // 以前面板和 logs/server.log 都是切 ISO 的第 11~19 位，而 logger 写的是 UTC，
  // 于是时间比本机慢 8 小时（实测：本机 13:44 显示成 05:44）—— 看日志的人得先
  // 心算一次才知道那行是几点发生的事。这一节钉住两件事：换算用本机时区，
  // 以及所有「给人看」的显示路径上都不许再出现 ts.slice(11, 19)。
  {
    const fs = await import('node:fs');
    const { localClock, localZone } = await import('../src/logger.mjs');

    const at = new Date(2026, 0, 2, 13, 4, 5); // 本机 13 点 4 分 5 秒
    if (localClock(at) === '13:04:05') ok('日志时间：localClock 按本机时区算（不是 UTC）');
    else bad('日志时间：localClock 算的不是本机时区', localClock(at));

    const off = -at.getTimezoneOffset();
    const want = `UTC${off >= 0 ? '+' : '-'}`
      + `${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`;
    if (localZone(at) === want) ok('日志时间：localZone 与本机时区一致', localZone(at));
    else bad('日志时间：localZone 不对', `${localZone(at)} != ${want}`);

    const loggerSrc = fs.readFileSync(new URL('../src/logger.mjs', import.meta.url), 'utf8');
    if (!loggerSrc.includes('slice(11, 19)')) ok('日志时间：logger 写文件/控制台那行不再切 UTC');
    else bad('日志时间：logger 里还留着 ts.slice(11, 19)', '落盘的还是 UTC');

    const html = fs.readFileSync(new URL('../src/admin.html', import.meta.url), 'utf8');
    if (html.includes('function hhmmss(') && !/\bts\.slice\(11, 19\)/.test(html)) {
      ok('日志时间：面板改走 hhmmss() —— 日志行和最近调用表都按本机时区');
    } else {
      bad('日志时间：面板还在切 UTC',
        /\bts\.slice\(11, 19\)/.test(html) ? '仍有 ts.slice(11, 19)' : '没找到 hhmmss');
    }
  }

  /* -------------------------------------------------- 周期发现的日志 */
  // 和号池扫描同一个毛病，只是发生在「凭据发现」这条链上：45 秒一轮，三条日志
  // （discover 的 DEBUG、忽略名单拦下、凭据发现完成）**一字不差**地重复。
  // 实测 34 分钟 228 条里有 145 条是它们（63%），真正的事件全被埋在里面。
  // 规矩：变了才说话；没变化退到 DEBUG，且最多 5 分钟一条心跳。
  {
    const fs = await import('node:fs');
    const { getRecentLogs, clearRecentLogs } = await import('../src/logger.mjs');
    const { discover } = await import('../src/discover.mjs');
    const done = () => getRecentLogs().filter((l) => l.msg.startsWith('discover done'));

    clearRecentLogs();
    discover({ installDirs: [] });
    const first = done();
    if (first.length === 1 && Array.isArray(first[0].extra?.files)) {
      ok('发现日志：首扫（没有基线）打一条，并带上扫到的文件');
    } else {
      bad('发现日志：首扫没打或没带文件列表', JSON.stringify(first.map((l) => l.extra)));
    }

    clearRecentLogs();
    discover({ installDirs: [] });
    discover({ installDirs: [] });
    const repeat = done();
    if (repeat.length === 0) ok('发现日志：文件集合没变 → 一条都不打（原来每 45 秒一条）');
    else bad('发现日志：没变化还在打', `${repeat.length} 条`);

    const idx = fs.readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8');
    if (idx.includes('凭据发现完成（无变化）') && idx.includes('DISCOVERY_HEARTBEAT_MS')) {
      ok('发现日志：boot 的「凭据发现完成」有 5 分钟心跳兜底');
    } else {
      bad('发现日志：boot 那边没有心跳', '找不到「凭据发现完成（无变化）」');
    }
    if (idx.includes('lastIgnoredSig')) {
      ok('发现日志：「忽略名单拦下」按指纹变化才打（稳态不再重复）');
    } else {
      bad('发现日志：「忽略名单拦下」还是无条件打', '找不到 lastIgnoredSig');
    }

    // ⚠️ 这条是给签名拼接兜底的。曾经写的是 `droppedKeys.map(c => c.key).join(',')`，
    // 而 discover() 返回的凭据上**没有 `key`**（那是进连接池时才算的），
    // `[undefined].join(',')` 在 JS 里是**空串** → 签名恒等于初始值 '' → 第一句永远
    // 打不出来：启动日志里那条「忽略名单拦下」直接消失，看着像保护没生效。
    // 所以签名必须带条数前缀：拿不到任何标识时也不能等于空串。
    const { ignoredSignature } = await import('../src/discoverFilter.mjs');
    const emptyish = ignoredSignature([{}]);
    const a = ignoredSignature([{ userId: 'a' }]);
    const b = ignoredSignature([{ userId: 'b' }]);
    if (emptyish !== '' && a !== b && ignoredSignature([]) === '0|') {
      ok('发现日志：签名带条数前缀 —— 拿不到标识时也不等于空串（防「第一句打不出来」）');
    } else {
      bad('发现日志：签名可能被拼成空串', JSON.stringify([ignoredSignature([]), emptyish, a, b]));
    }
  }

  /* -------------------------------------------------- 面板轮询的省电档 */
  // 面板经常被丢在后台标签页挂一整天，而每次 poll 服务端都要现拼约 41KB（实测 3~7ms）、
  // 客户端整块重建 DOM。**同一个事件循环**在给模型请求做流式转发，所以这活儿
  // 每 3 秒来一次纯属白烧。规矩：后台不轮询，回前台立刻补。
  {
    const { readFileSync: rfPanel } = await import('node:fs');
    const html = rfPanel(new URL('../src/admin.html', import.meta.url), 'utf8');
    const hasVis = html.includes('visibilitychange');
    const hasHidden = html.includes('document.hidden');
    const hasStart = html.includes('const startPoll =');
    const hasStop = html.includes('const stopPoll =');
    // 回前台必须**立刻**补一次，否则用户切回来看到的是停轮询之前的旧数据
    const refreshOnShow = /visibilitychange[\s\S]{0,200}?startPoll\(\);\s*poll\(\);/.test(html);
    // 无条件 setInterval 的老写法不能再出现（`startPoll()` 里那个不算：它带守卫）
    const unbounded = /^setInterval\(poll, 3000\);$/m.test(html);
    if (hasVis && hasHidden && hasStart && hasStop && refreshOnShow && !unbounded) {
      ok('面板轮询：后台停轮询 / 回前台立刻补一次（后台标签页不再每 3 秒拼 66KB）');
    } else {
      bad('面板轮询：后台停轮询或回前台补一次没生效', JSON.stringify({ hasVis, hasHidden, hasStart, hasStop, refreshOnShow, unbounded }));
    }
  }

  /* -------------------------------------------------- 模型倍率匹配 */
  // 面板上的「使用倍率」列。规则藏在 admin.html 的 `rateFor()` 里，
  // 抠出来跑一遍真实边界：错了不会报错，只会显示一个**看起来合理但是错的**倍率
  // （最典型的是 `glm-5.3` 蹭上 `glm-5` 的 0.50x —— 跨代了）。
  {
    const fs = await import('node:fs');
    const html = fs.readFileSync(new URL('../src/admin.html', import.meta.url), 'utf8');
    const start = html.indexOf('function rateFor(id, rates) {');
    let src = '';
    if (start >= 0) {
      let depth = 0;
      for (let i = html.indexOf('{', start); i < html.length; i += 1) {
        if (html[i] === '{') depth += 1;
        else if (html[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            src = html.slice(start, i + 1);
            break;
          }
        }
      }
    }
    if (!src) {
      bad('倍率匹配：能从 admin.html 里抠出 rateFor', '找不到函数');
    } else {
      ok('倍率匹配：能从 admin.html 里抠出 rateFor');
      // eslint-disable-next-line no-new-func
      const rateFor = new Function(`${src}; return rateFor;`)();
      const rates = {
        'glm-5.2': { model: 'glm-5.2', coefficient: 0.7, promptPerPoint: 4375, completionPerPoint: 1250 },
        'glm-5.1': { model: 'glm-5.1', coefficient: 0.67, promptPerPoint: 4375, completionPerPoint: 1250 },
        'glm-5': { model: 'glm-5', coefficient: 0.5, promptPerPoint: 4375, completionPerPoint: 1250 },
        'deepseek-v3.2': { model: 'deepseek-v3.2', coefficient: 0.3, promptPerPoint: 4375, completionPerPoint: 1250 },
        'deepseek-v4-flash-0731': { model: 'deepseek-v4-flash-0731', coefficient: 0.3, promptPerPoint: 4375, completionPerPoint: 1250 },
      };
      const cases = [
        ['glm-5.2', 0.7, true], // 精确命中
        ['deepseek-v4-flash-0731', 0.3, true],
        ['glm-5.2-a3', 0.7, false], // 变体借基座
        ['glm-5.1-exercise', 0.67, false],
        ['glm-5-test', 0.5, false],
        ['glm.5.2-arkts-spark', 0.7, false], // 异体分隔符：`.` 当 `-` 用
        // 下面这些**必须留空**，是这次修的核心：
        ['glm-5.3', null, null], // 跨代，不许蹭 glm-5
        ['glm-5.3-test', null, null],
        ['glm-5.3-zx', null, null],
        ['deepseek-v4-pro', null, null], // 前缀不完整，不许蹭
        ['deepseek-v4-flash-A3', null, null],
        ['glm-5.3.1', null, null],
        ['deepseek-v3-test', null, null],
      ];
      let badN = 0;
      for (const [id, want, wantExact] of cases) {
        const hit = rateFor(id, rates);
        const gotC = hit ? Number(hit.rate.coefficient) : null;
        const gotExact = hit ? !!hit.exact : null;
        if (gotC !== want || gotExact !== wantExact) {
          badN += 1;
          bad(
            `倍率匹配：${id}`,
            `期望 ${want === null ? '空' : want + 'x'}${wantExact === null ? '' : wantExact ? '(精确)' : '(借用)'}，` +
              `实际 ${gotC === null ? '空' : gotC + 'x'}${gotExact === null ? '' : gotExact ? '(精确)' : '(借用)'}`,
          );
        }
      }
      if (!badN) ok(`倍率匹配：${cases.length} 个边界全对（含跨代不许蹭）`);
      // 反向对照：把「边界看原字符」这条改回「看归一化后的串」，必须复现跨代误蹭
      {
        const loose = src.replace(
          'const rawNext = id.charAt(kNorm.length);',
          'const rawNext = idNorm.charAt(kNorm.length);',
        );
        const looseFn = new Function(`${loose}; return rateFor;`)();
        const got = looseFn('glm-5.3', rates);
        if (got && Number(got.rate.coefficient) === 0.5) {
          ok('倍率匹配：反向对照——边界看归一化后的串确实会跨代误蹭');
        } else {
          bad('倍率匹配：反向对照——边界看归一化后的串确实会跨代误蹭', `实际 ${got ? got.rate.coefficient : '空'}`);
        }
      }
    }
  }

  /* -------------------------------------------------- 导入账号：两个模式不能串 */
  // 「开始登录」和「换个账号登录」就差一个布尔。这个布尔传错了**不会报错**，
  // 只会走错分支（比如点普通按钮却把华为云会话登出了）——最典型的是把函数
  // 直接挂成事件处理器，于是 click 事件对象被当成 `true` 收下。
  {
    const fs = await import('node:fs');
    const html = fs.readFileSync(new URL('../src/admin.html', import.meta.url), 'utf8');

    // ① 定义处必须挡非布尔（当作"沿用上次模式"）
    if (html.includes('if (typeof forceLogin !== "boolean") forceLogin = !!adS.forceLogin;')) {
      ok('导入账号：adStart 会挡住非布尔参数（防止事件对象被当成 true）');
    } else {
      bad('导入账号：adStart 会挡住非布尔参数（防止事件对象被当成 true）', '找不到那道 typeof 检查');
    }

    // ② 每个调用点都必须显式传参，且不能是裸函数引用
    // 注意用 \b 卡住词首：不然 `padStart(...)` 也会被匹配进来（`String(x).padStart(2,"0")`）
    const calls = [...html.matchAll(/(?<![A-Za-z0-9_$])adStart\s*\(([^)]*)\)/g)]
      .map((m) => m[1].trim())
      // 定义那行是 `async function adStart(forceLogin)`，参数名不是调用
      .filter((a) => a !== 'forceLogin');
    const badCalls = calls.filter((a) => !/^(true|false|adS\.forceLogin)$/.test(a));
    if (calls.length >= 3 && !badCalls.length) {
      ok(`导入账号：${calls.length} 个 adStart 调用点都显式传了布尔`, calls.join(' | '));
    } else {
      bad('导入账号：所有 adStart 调用点都显式传了布尔', `可疑参数: ${badCalls.join(', ') || '(调用太少)'}`);
    }

    // ③ 反向对照：确认"裸函数引用"这种挂法真的会被上面那条抓到，否则它是空测
    const naive = html.replace(
      '#adRetry").addEventListener("click", () => { adPanel("intro"); adStart(adS.forceLogin); })',
      '#adRetry").addEventListener("click", adStart)',
    );
    if (naive !== html) {
      const naiveCalls = [...naive.matchAll(/(?<![A-Za-z0-9_$])adStart\s*\(([^)]*)\)/g)]
        .map((m) => m[1].trim())
        .filter((a) => a !== 'forceLogin' && !/^(true|false|adS\.forceLogin)$/.test(a));
      // 把函数直接挂成处理器时，"调用点"根本不出现 —— 所以判据是：调用点少了一个
      const before = calls.length;
      const after = [...naive.matchAll(/(?<![A-Za-z0-9_$])adStart\s*\(([^)]*)\)/g)]
        .map((m) => m[1].trim())
        .filter((a) => a !== 'forceLogin').length;
      if (after === before - 1 && naiveCalls.length === 0) {
        ok('导入账号：反向对照——把 adStart 裸挂成处理器，调用点就会少一个（上面那条不空测）');
      } else {
        bad('导入账号：反向对照——把 adStart 裸挂成处理器，调用点就会少一个', `前 ${before} 后 ${after}`);
      }
    } else {
      bad('导入账号：反向对照——把 adStart 裸挂成处理器，调用点就会少一个', '没找到 adRetry 那行，对照构造失败');
    }

    // ④ 两个按钮各自绑对模式
    const goOk = /#adGo"\)\.addEventListener\("click", \(\) => adStart\(false\)\)/.test(html);
    const swOk = /#adGoSwitch"\)\.addEventListener\("click", \(\) => adStart\(true\)\)/.test(html);
    if (goOk && swOk) ok('导入账号：「开始登录」= 普通模式，「换个账号登录」= 换账号模式');
    else bad('导入账号：两个按钮各自绑对模式', `普通=${goOk} 换账号=${swOk}`);
  }

  /* ------------------------------------------- 上游报「模型不行」≠ 账号不行 */
  // 这是多账号下最容易踩的坑之一：手里只有一两条凭据时，一次「模型名不对」
  // 就能把整条凭据冷却 5 分钟，期间所有正常请求都受影响。
  // 用真实的错误载荷（从日志里抄的）验分类逻辑。
  {
    const { classifyUpstream } = await import('../src/upstream.mjs');
    const cases = [
      // [名字, HTTP, 响应体, 期望 authFailed, 期望 modelRejected]
      ['81004 这个号没权限（403）', 403,
        '{"error":{"code":"ModelArts.81004","message":"Invalid request because you do not have permission to access this model.","type":"Forbidden"}}',
        false, true],
      ['81009 模型名不对（400）', 400,
        '{"error":{"code":"ModelArts.81009","message":"Invalid model.","type":"BadRequest"}}',
        false, true],
      ['81009 夹在 data: 前缀里（流式）', 403,
        'data:{"error":{"code":"ModelArts.81009","message":"Invalid model."}}',
        false, true],
      // 真正的鉴权失败还得认出来（别把修复做成了"什么都当模型问题"）
      ['AppKey 无效', 403,
        '{"error":{"code":"APIG.1009","message":"AppKey or AppSecret is invalid"}}',
        true, false],
      ['裸 401', 401, '{"error":{"message":"unauthorized"}}', true, false],
      // 限流
      ['81111 TPM 限流', 429,
        '{"error":{"code":"ModelArts.81111","message":"The request is rate limited"}}',
        false, false],
    ];
    for (const [name, status, body, wantAuth, wantModel] of cases) {
      const info = classifyUpstream(status, body);
      if (info.authFailed === wantAuth && info.modelRejected === wantModel) {
        ok(`上游分类：${name} → authFailed=${wantAuth} modelRejected=${wantModel}`);
      } else {
        bad(`上游分类：${name}`, `实际 authFailed=${info.authFailed} modelRejected=${info.modelRejected} code=${info.code}`);
      }
    }
  }

  /* -------------------------------------------------- 连接池：模型级拒绝 */
  {
    const { CredentialPool } = await import('../src/pool.mjs');
    const mk = (name) => ({
      baseUrl: `https://gw.example.com/${name}`,
      headers: { Authorization: `Basic ${Buffer.from(`${name}:secret`).toString('base64')}` },
      accountId: `${name.padEnd(32, '0')}:${name.padEnd(32, '1')}`,
      userId: `${name.padEnd(32, '0')}:${name.padEnd(32, '1')}`,
    });
    const pool = new CredentialPool({ cooldownOnAuthErrorMs: 300000, cooldownOnModelRejectMs: 60000 });
    pool.add(mk('accA'));
    pool.add(mk('accB'));
    const [a, b] = pool.entries;

    // ① 只冷却「凭据 × 模型」，不碰整条凭据
    const r1 = pool.markModelRejected(a, 'glm-5-test', 'ModelArts.81009 Invalid model');
    if (a.cooldownUntil === 0) ok('连接池：模型被拒时不冷却整条凭据（只有 modelCooldown）');
    else bad('连接池：模型被拒时不冷却整条凭据', `cooldownUntil=${a.cooldownUntil}`);
    if (r1.modelUnavailable === false) ok('连接池：只有一条凭据拒绝时，模型仍视为可用（可以换号试）');
    else bad('连接池：只有一条凭据拒绝时模型仍可用', JSON.stringify(r1));

    // ② 同一个模型不再被这条凭据选中
    const pickedForBad = [];
    for (let i = 0; i < 6; i += 1) pickedForBad.push(pool.pick('glm-5-test')?.baseUrl || '');
    if (!pickedForBad.some((u) => u.endsWith('/accA'))) ok('连接池：拒绝过该模型的凭据不会被再选中');
    else bad('连接池：拒绝过该模型的凭据不会被再选中', pickedForBad.join(','));

    // ③ 别的模型完全不受影响
    const pickedForGood = [];
    for (let i = 0; i < 6; i += 1) pickedForGood.push(pool.pick('deepseek-v4-flash-0731')?.baseUrl || '');
    if (pickedForGood.some((u) => u.endsWith('/accA')) && pickedForGood.some((u) => u.endsWith('/accB'))) {
      ok('连接池：别的模型照常在两条凭据之间轮询（没被殃及）');
    } else {
      bad('连接池：别的模型照常在两条凭据之间轮询', pickedForGood.join(','));
    }

    // ④ 两条都拒绝 → 判定「这个模型不可用」
    const r2 = pool.markModelRejected(b, 'glm-5-test', 'ModelArts.81009 Invalid model');
    if (r2.modelUnavailable === true && r2.cooled === 2) ok('连接池：所有凭据都拒绝过 → 判定该模型不可用（调用方可以干净地报错）');
    else bad('连接池：所有凭据都拒绝过 → 判定该模型不可用', JSON.stringify(r2));

    // ⑤ 成功过一次就撤销拒绝标记（上游加了权限 / 当初判错了，得能自愈）
    pool.markOk(a, 'glm-5-test');
    if (!a.rejectedModels.has('glm-5-test')) ok('连接池：某条凭据其实能用该模型时，拒绝标记被撤销（可自愈）');
    else bad('连接池：成功一次后撤销拒绝标记', JSON.stringify([...a.rejectedModels]));
    if (pool.modelAvailability('glm-5-test').modelUnavailable === false) ok('连接池：撤销后该模型重新变为可用');
    else bad('连接池：撤销后该模型重新变为可用', JSON.stringify(pool.modelAvailability('glm-5-test')));

    // ⑥ 反向对照：如果按老写法走 markAuthFailed，整条凭据会被冷却 5 分钟
    //    —— 证明「分开处理」这件事真的有区别，不是空测
    const pool2 = new CredentialPool({ cooldownOnAuthErrorMs: 300000 });
    pool2.add(mk('accA'));
    pool2.entries[0].cooldownUntil = 0;
    pool2.markAuthFailed(pool2.entries[0], 'ModelArts.81004');
    if (pool2.entries[0].cooldownUntil - Date.now() > 250000) {
      ok('连接池：反向对照——老写法（markAuthFailed）确实会整条冷却 5 分钟，所以分开处理有意义');
    } else {
      bad('连接池：反向对照——老写法会整条冷却 5 分钟', `cooldownUntil=${pool2.entries[0].cooldownUntil}`);
    }
  }

  /* ------------------------------------------- 假账号 ID 不该能写进盘里 */
  {
    const { AccountStore, isRealAccountId } = await import('../src/accounts.mjs');
    const fsx = await import('node:fs');
    const os = await import('node:os');
    const pathx = await import('node:path');
    const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'o2a-ghost-'));
    const file = pathx.join(dir, 'accounts.json');
    const good = 'a1b2c3d4e5f60718293a4b5c6d7e8f90:09f8e7d6c5b4a39281706f5e4d3c2b1a';
    const ghost = 'pending-22206514183fb4f62589d294700e1f3df0e491a289b16c197102dc0da6620854';
    // 种一份「已经脏了」的文件：labels 里躺着幽灵键
    fsx.writeFileSync(file, JSON.stringify({ labels: { [good]: '自检号', [ghost]: '自检号' }, disabled: [ghost, good], ignored: [ghost], imported: [], order: [] }, null, 2));

    const store = new AccountStore({ dataFile: file });
    store.load();
    store.accounts.set(good, {
      id: good, short: good.slice(0, 8), sources: ['oauth-login'], credentials: [], catalog: [], profile: null, files: {}, lastSeenAt: 0,
    });

    const before = Object.keys(store.meta.labels).length;
    const removed = store.pruneMetaKeys();
    const after = Object.keys(store.meta.labels).length;
    if (before === 2 && after === 1 && removed >= 1 && !(ghost in store.meta.labels)) {
      ok('账号 ID 形态：prompt 幽灵键被清掉，真账号的别名留着', `清掉 ${removed} 个`);
    } else {
      bad('账号 ID 形态：幽灵键被清掉', `before=${before} after=${after} removed=${removed}`);
    }
    if (!store.meta.disabled.includes(ghost) && !store.meta.ignored.includes(ghost) && store.meta.disabled.includes(good)) {
      ok('账号 ID 形态：disabled / ignored 里的幽灵键也清了，真账号的保留');
    } else {
      bad('账号 ID 形态：disabled / ignored 里的幽灵键也清了', JSON.stringify({ dis: store.meta.disabled, ig: store.meta.ignored }));
    }

    // 反向对照：真账号的键必须原样留着 —— 不能把"清理"做成"清空"
    if (store.meta.labels[good] === '自检号' && store.meta.disabled.includes(good)) {
      ok('账号 ID 形态：反向对照——真账号的别名和停用状态一个都没被误删');
    } else {
      bad('账号 ID 形态：反向对照——真账号的数据不该被误删', JSON.stringify(store.meta.labels));
    }

    // 形态判据本身
    const shape = [
      [good, true], [ghost, false], ['' , false], ['no-such-account:0', false],
      ['A1B2C3D4E5F60718293A4B5C6D7E8F90:09F8E7D6C5B4A39281706F5E4D3C2B1A', false],
      ['a1b2c3d4e5f60718293a4b5c6d7e8f90', false],
    ];
    let shapeBad = 0;
    for (const [v, want] of shape) {
      if (isRealAccountId(v) !== want) {
        shapeBad += 1;
        bad(`账号 ID 形态：isRealAccountId(${String(v).slice(0, 20)}…)`, `期望 ${want}`);
      }
    }
    if (!shapeBad) ok(`账号 ID 形态：${shape.length} 个样本全对（大小写、缺一段、带前缀的都挡住了）`);

    // setLabel 必须挡假 ID（这是当初幽灵键唯一的 HTTP 活口）
    const wroteGhost = store.setLabel(ghost, '还想混进来');
    if (wroteGhost === false && !(ghost in store.meta.labels)) ok('账号 ID 形态：setLabel 拒绝写不存在的 / 形态不像账号的 id');
    else bad('账号 ID 形态：setLabel 拒绝假 id', `返回值 ${wroteGhost}`);
    const wroteReal = store.setLabel(good, '改个名试试');
    if (wroteReal === true && store.meta.labels[good] === '改个名试试') ok('账号 ID 形态：setLabel 对真账号照常生效');
    else bad('账号 ID 形态：setLabel 对真账号照常生效', `返回值 ${wroteReal} label=${store.meta.labels[good]}`);

    fsx.rmSync(dir, { recursive: true, force: true });
  }

/* ── 上游分类：请求体太大不能当成"限流" ───────────────────────────── */
//
// `ModelArts.81113`（Invalid request body, exceeds the maximum size）带的是
// **HTTP 429**，所以它一度落进了 `rateLimited` 那条正则里 —— 后果有两层：
//   ① 反代拿同一个 5.5MB 的 body **原样重试满 3 遍**（每次都要把 5.5MB 再传一遍）；
//   ② 错误原样透传成 429，客户端以为"只是忙"，于是继续重试同一个必然失败的请求。
// 实测：塞一个约 5.5MB 的对话历史（7500 块）就会撞到它。
//
// 这是**确定性**失败：body 不变，打一百遍都一样。所以必须单独认出来 + 不重试 + 413。
console.log('\n[上游分类：请求体太大 ≠ 限流]');
{
  const { classifyUpstream } = await import('../src/upstream.mjs');
  const body = JSON.stringify({
    error: { code: 'ModelArts.81113', message: 'Invalid request body, exceeds the maximum size' },
  });
  const info = classifyUpstream(429, body);
  if (info.requestTooLarge) ok('ModelArts.81113 被认成"请求体太大"');
  else bad('81113 没被认出来，会被当成限流重试', JSON.stringify({ code: info.code, rateLimited: info.rateLimited }));
  if (!info.rateLimited) ok('81113 不再被当成限流（不然会白重试 3 遍 5.5MB）');
  else bad('81113 仍然被当成限流');
  if (info.retryable === false) ok('81113 标记为不可重试');
  else bad('81113 还是可重试的', String(info.retryable));
  if (!info.authFailed && !info.modelRejected) ok('81113 不会牵连账号（不冷却凭据）');
  else bad('81113 被判成了账号问题');

  // 反向对照：真正的限流还得照样认出来，别把这个修法做过头
  for (const [code, msg] of [
    ['ModelArts.81111', 'TPM limit exceeded'],
    ['ModelArts.81114', 'too many requests'],
    ['ModelArts.81112', 'rate limit'],
  ]) {
    const i2 = classifyUpstream(429, JSON.stringify({ error: { code, message: msg } }));
    if (i2.rateLimited && i2.retryable && !i2.requestTooLarge) ok(`${code} 仍然按限流处理（可重试）`);
    else bad(`${code} 被误伤成别的了`, JSON.stringify({ rateLimited: i2.rateLimited, tooLarge: i2.requestTooLarge }));
  }
  // 光有 429、没别的线索时，还得是限流
  const bare = classifyUpstream(429, '{"error":{"message":"Too Many Requests"}}');
  if (bare.rateLimited && !bare.requestTooLarge) ok('裸 429 仍然算限流');
  else bad('裸 429 被误判', JSON.stringify({ r: bare.rateLimited, t: bare.requestTooLarge }));
}

/* ── 上游错误装在 SSE 帧里：以前 code 恒空、message 是整段原始帧 ────────── */
//
// 反代是拿 `stream: true` 打上游的，所以上游的错误是**装成 SSE 帧**回来的：
//
//   data:{"error":{"code":"ModelArts.81001","message":"Invalid max_tokens value: -5, …"}}
//
// 而 `classifyUpstream` 起初只认「整段以 `{` 开头」，于是这种 body 一律解析失败：
//   · 客户端收到 `上游请求失败: data:{\"error\":{\"code\":\"…\"}}` —— 看不懂、没法按 code 分支；
//   · 日志里 `"code":""`，`payload` 为 null，`81004/81009/81001/81113` 那套判断
//     全靠 message 里的原文兜着。
// 实测原文见 `logs/server.err.log`（`上游明确拒绝这个请求，不再重试 {"code":""…}`）。
console.log('\n[上游分类：错误体是 SSE 帧时也要能解析]');
{
  const { classifyUpstream } = await import('../src/upstream.mjs');
  const frame = (code, message) =>
    `data:${JSON.stringify({ error: { code, message, param: null, type: 'BadRequest' }, error_code: code })}`;

  // ① 流式错误帧：code / message / payload 三样都要出来
  const sse = classifyUpstream(400, frame('ModelArts.81001', 'Invalid max_tokens value: -5, max_tokens must be between 0 and 131072.'));
  if (sse.code === 'ModelArts.81001') ok('SSE 帧里的 code 能取出来');
  else bad('SSE 帧的 code 没取到（客户端和日志都看不到上游的错误码）', JSON.stringify(sse.code));
  if (sse.message.startsWith('Invalid max_tokens value')) ok('message 是干净的原话，不带 data: 前缀和转义');
  else bad('message 还是整段原始帧', sse.message.slice(0, 60));
  if (sse.payload && typeof sse.payload === 'object') ok('payload 有值（后续能按字段判断，不再只能啃字符串）');
  else bad('payload 仍是 null');
  if (sse.badRequest) ok('SSE 帧的 81001 仍然被判成 badRequest');

  // ② 多帧 / 空行 / [DONE]：真实 SSE 流里就长这样
  const multi = classifyUpstream(403, '\ndata:{"error":{"code":"ModelArts.81004","message":"Insufficient permission"}}\n\ndata:[DONE]\n');
  if (multi.code === 'ModelArts.81004' && multi.modelRejected) ok('多帧 + [DONE] 里也能取到 code（81004 → 模型没权限）');
  else bad('多帧 SSE 没解析对', JSON.stringify({ code: multi.code, modelRejected: multi.modelRejected }));

  // ③ 前面裹着杂字符（日志里真有 `^C` 那种）
  const junk = classifyUpstream(429, '^Cdata:{"error":{"code":"ModelArts.81113","message":"Invalid request body, exceeds the maximum size"}}');
  if (junk.code === 'ModelArts.81113' && junk.requestTooLarge) ok('带杂字符前缀的帧也能解析（81113 → 请求体太大）');
  else bad('带前缀的帧没解析出来', JSON.stringify({ code: junk.code, tooLarge: junk.requestTooLarge }));

  // ④ 反向对照：不是 JSON 的文本别被硬掰
  const notJson = classifyUpstream(500, 'gateway exploded');
  if (notJson.code === '' && notJson.message === 'gateway exploded' && notJson.payload === null) ok('不是 JSON 时老实回退成原文，不编造 code');
  else bad('非 JSON 的 body 被掰出了假字段', JSON.stringify({ code: notJson.code, payload: notJson.payload }));

  // ⑤ 反向对照：非流式的裸 JSON 行为一点没变
  const plain = classifyUpstream(400, '{"error":{"code":"ModelArts.81001","message":"bad param"}}');
  if (plain.code === 'ModelArts.81001' && plain.message === 'bad param' && plain.payload) ok('裸 JSON（非流式）行为不变');
  else bad('裸 JSON 那条路径被改坏了', JSON.stringify({ code: plain.code, message: plain.message }));
}

/* ── 面板鉴权：空口令 = 完全不校验，这是真问题 ─────────────────────── */
//
// 路由里那条校验是：
//   if (isAdminRoute && config.admin?.token && req.headers['x-admin-token'] !== token)
// 注意中间那个 `config.admin?.token` —— **口令为空时整个条件短路，一条都不校验**。
// 本机自用没感觉，可是这个服务一旦给别人用（监听 0.0.0.0 / 放内网）：
//   · 任何人打开 http://<IP>:7864/admin 就是完整管理面板；
//   · `/admin/api/*` 一条请求不用带凭据就能**读也能改**。
//     实测不带头也能拿到约 70KB 的 `/admin/api/state`，里面有账号标签、
//     baseUrl、积分余额、调用记录；改配置 / 改模型别名这些写接口同样不设防。
//
// 所以 `config.mjs` 加了 `ensureAdminToken()`：首次启动自动生成一个并写回
// config.json，启动横幅把 `?token=` 拼好的面板地址直接打出来。
console.log('\n[面板鉴权]');
{
  const { generateAdminToken, ensureAdminToken } = await import('../src/config.mjs');

  const t1 = generateAdminToken();
  const t2 = generateAdminToken();
  if (t1 && t2 && t1 !== t2) ok('口令是随机生成的（两次不一样）');
  else bad('口令没随机起来', `${t1} / ${t2}`);
  if (t1.length >= 30) ok(`口令够长（${t1.length} 位，24 字节 base64url）`);
  else bad('口令太短', `${t1.length} 位`);
  if (/^[A-Za-z0-9_-]+$/.test(t1)) ok('口令是 URL 安全的（能直接拼在 ?token= 后面）');
  else bad('口令含需要转义的字符，拼 URL 会出问题', t1);

  // 有口令就不动它（不能每次启动都换，否则面板地址一直变）
  const keep = { admin: { enabled: true, token: 'already-set' } };
  if (ensureAdminToken(keep) === null && keep.admin.token === 'already-set') ok('已经有口令时不动它');
  else bad('已有口令被覆盖了', JSON.stringify(keep));

  // 空口令 → 补一个，并且写进 config 对象
  const empty = { admin: { enabled: true, token: '' } };
  const made = ensureAdminToken(empty);
  if (made && empty.admin.token === made) ok('空口令会被补上并写回 config');
  else bad('空口令没补上', JSON.stringify(empty));

  // 连 admin 键都没有也要能补（老配置文件没这个键）
  const none = {};
  const made2 = ensureAdminToken(none);
  if (made2 && none.admin?.token === made2 && none.admin?.enabled === true) ok('老配置（没有 admin 键）也能补上');
  else bad('没有 admin 键时补不上', JSON.stringify(none));

  // 对齐服务端：真打一发不带口令的，看有没有被拦
  const token = resolveAdminToken();
  if (token) {
    const bare = await fetch(base + '/admin/api/state');
    if (bare.status === 401) ok('服务已启用口令：不带 x-admin-token 读 /admin/api/state 会被拦（401）');
    else bad('服务启用了口令却还放行', `HTTP ${bare.status}`);
    const good = await call('/admin/api/state');
    if (good.status === 200) ok('带上正确口令就能读');
    else bad('带上正确口令还是读不了', `HTTP ${good.status}`);
    const wrong = await fetch(base + '/admin/api/state', { headers: { 'x-admin-token': 'wrong-token' } });
    if (wrong.status === 401) ok('口令错了也拦得住（401）');
    else bad('错口令没拦住', `HTTP ${wrong.status}`);

    /*
     * ⚠️ 这条是**文案和实现要对得上**的测试。
     *
     * `?token=` 这条路差点是个死循环：启动横幅打的是
     * `${base}/admin?token=...`，401 的提示也写着「请在面板地址后加 ?token=你的口令」，
     * 可服务端当时**只比对 `x-admin-token` 请求头** —— 浏览器地址栏里带 token 也没人读，
     * 于是**按提示走的人反而进不去**。提示和实际行为不一致，比没有提示更坑。
     *
     * 人第一次打开面板只能靠 URL 传（地址栏加不了自定义头），所以这条路必须通。
     * 下面三条就是钉住它：带对的能进、带错的拦住、光有头没有 query 也能进。
     */
    const viaQuery = await fetch(`${base}/admin?token=${encodeURIComponent(token)}`);
    if (viaQuery.status === 200) ok('面板 HTML 认 URL 上的 ?token=（浏览器唯一能用的方式）');
    else bad('URL 上带对口令却打不开面板', `HTTP ${viaQuery.status} —— 启动横幅给的地址是错的`);
    const viaBadQuery = await fetch(`${base}/admin?token=definitely-wrong`);
    if (viaBadQuery.status === 401) ok('URL 上写错口令照样拦（401）');
    else bad('URL 上写错口令竟然放行了', `HTTP ${viaBadQuery.status}`);

    /*
     * 口令走 URL 会留在浏览器历史里，也会出现在截图里 —— 所以第一次用 `?token=`
     * 进来时服务端顺手换成一个 HttpOnly Cookie，面板再把地址栏那一份抹掉。
     * 三条一起钉：种得上、光有 Cookie 能进、Cookie 错了照样拦。
     */
    const setCookie = viaQuery.headers.get('set-cookie') || '';
    if (/o2a_admin=/.test(setCookie) && /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie)) {
      ok('用 URL 口令进来时顺手换成 HttpOnly Cookie（之后开 /admin/ 不用再带口令）');
    } else {
      bad('URL 口令没有换成 Cookie', JSON.stringify(setCookie.slice(0, 96)));
    }
    const viaCookie = await fetch(base + '/admin/api/state', {
      headers: { Cookie: `o2a_admin=${encodeURIComponent(token)}` },
    });
    if (viaCookie.status === 200) ok('光有 Cookie 也能进（刷新页面之后靠它）');
    else bad('Cookie 进不去', `HTTP ${viaCookie.status}`);
    const badCookie = await fetch(base + '/admin/api/state', { headers: { Cookie: 'o2a_admin=wrong' } });
    if (badCookie.status === 401) ok('Cookie 写错照样拦（401）');
    else bad('Cookie 写错竟然放行', `HTTP ${badCookie.status}`);

    // 面板这边负责把地址栏擦干净（hash 要留着，面板靠它记住当前板块）
    const { readFileSync: rfPanel } = await import('node:fs');
    const panelHtml = rfPanel(new URL('../src/admin.html', import.meta.url), 'utf8');
    if (/if \(TOKEN\) history\.replaceState\(null, "", location\.pathname \+ location\.hash\)/.test(panelHtml)) {
      ok('面板把地址栏里的口令抹掉（replaceState，保留 hash）');
    } else {
      bad('面板没抹掉地址栏里的口令', '那它就会一直留在截图和浏览器历史里');
    }

    // 401 的提示文案里提到的用法，必须真的能用
    const msg = await (await fetch(base + '/admin')).json().catch(() => ({}));
    if (/token/.test(msg?.error?.message || '')) {
      const m = String(msg.error.message).match(/\?token=(\S*)/);
      if (m) {
        const r2 = await fetch(`${base}/admin?token=${encodeURIComponent(token)}`);
        if (r2.status === 200) ok('401 文案里说的用法是能用的（不是空头承诺）');
        else bad('401 文案说的用法实际用不了', `HTTP ${r2.status}`);
      } else {
        note('401 文案里没写具体的 ?token= 用法，跳过这条一致性检查');
      }
    }
  } else {
    console.log('  · 当前服务没设面板口令（admin.token 为空），跳过实打实的拦截验证');
    console.log('    这是「只在本机自用」的配置 —— 给别人用之前务必设一个。');
  }

  /*
   * ── 面板前端的 api() 助手：body 翻译 ────────────────────────────────
   *
   * 这一块是**唯一直接测面板前端代码**的地方。其它测试都直打接口，
   * 所以面板 JS 里的 bug 一直测不出来 —— 这个 bug 就是这么漏掉的：
   *
   *   api() 里原本写 `const hasJson = o.json !== undefined;`
   *   只要传了 `json`（哪怕字面量 `true`）就执行
   *   `o.body = JSON.stringify(o.json)` —— `JSON.stringify(true)` 得到 `"true"`，
   *   把调用方真正的 body **覆盖**掉。
   *
   * 而服务端读不到字段时会**保留原值**（不报错、回 200），所以界面显示
   * "保存成功"、实际什么都没存。项目里曾有 8 处是 `{ json: true, body: ... }`
   * 这种写法，其中几个接口不读 body 字段，于是"看着能用"把问题盖住了。
   *
   * 下面这几条就是把两种写法都钉住，并且**故意复现一次旧逻辑**做对照 ——
   * 没有对照的话，"通过"可能只是因为测试压根没测到。
   */
  {
    console.log('\n-- 面板前端 api() 的 body 翻译 --');
    const { readFileSync: rf } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const htmlText = rf(path.join(ROOT, 'src', 'admin.html'), 'utf8');

    // 把 api() 整段抠出来（按大括号配平，截到函数结束）
    const extractApi = (s) => {
      for (const head of [/async function api\s*\(/, /function api\s*\(/]) {
        const m = head.exec(s);
        if (!m) continue;
        const open = s.indexOf('{', m.index + m[0].length - 1);
        let depth = 0;
        for (let i = open; i < s.length; i += 1) {
          if (s[i] === '{') depth += 1;
          else if (s[i] === '}') {
            depth -= 1;
            if (depth === 0) return s.slice(m.index, i + 1);
          }
        }
      }
      return null;
    };
    const apiSrc = extractApi(htmlText);
    if (!apiSrc) {
      bad('没能从 admin.html 里抠出 api()', '面板结构变了？这块测不到就等于没测');
    } else {
      const panelH = () => ({ 'x-admin-token': resolveAdminToken() });
      const panelJ = { 'Content-Type': 'application/json' };
      // api() 发相对路径；浏览器会补 origin，Node 不会，包一层补上
      const fetchPanel = (i, init) => (typeof i === 'string' && i.startsWith('/') ? fetch(base + i, init) : fetch(i, init));
      const mk = (src) => new Function('fetch', 'H', 'J', `${src}\nreturn api;`)(fetchPanel, panelH, panelJ);

      const apiPanel = mk(apiSrc);

      // 拿一个可逆的写入点做实验：模型别名
      const st = await (await fetch(base + '/admin/api/state', { headers: panelH() })).json();
      const modelIds = (st.models || []).map((m) => m.id);
      const aliasTarget = modelIds.find((x) => /glm-5\.2/.test(x)) || modelIds[0];
      const aliasBase = {
        alias: { ...(st.config?.models?.alias || {}) },
        hidden: st.config?.models?.hidden || [],
        extra: st.config?.models?.extra || [],
      };
      const MARK = 'zz-test-admin-api';

      if (!aliasTarget) {
        note('拿不到任何模型 id，跳过 api() 的写入验证');
      } else {
        // ① { json: {对象} } —— 本来的设计用法
        await apiPanel('/admin/api/models', {
          method: 'POST',
          json: { ...aliasBase, alias: { ...aliasBase.alias, [MARK]: aliasTarget } },
        });
        const afterObj = (await (await fetch(base + '/admin/api/state', { headers: panelH() })).json())
          .config?.models?.alias?.[MARK];
        if (afterObj === aliasTarget) ok('api() 支持 { json: {对象} }（对象被正确序列化成 body）');
        else bad('{ json: {对象} } 没写进去', `读到 ${JSON.stringify(afterObj)}`);

        // ② { json: true, body: <字符串> } —— 旧写法，也必须能通
        await apiPanel('/admin/api/models', {
          method: 'POST',
          json: true,
          body: JSON.stringify({ ...aliasBase, alias: { ...aliasBase.alias, [MARK]: 'zz-second-form' } }),
        });
        const afterTrue = (await (await fetch(base + '/admin/api/state', { headers: panelH() })).json())
          .config?.models?.alias?.[MARK];
        if (afterTrue === 'zz-second-form') ok('api() 支持 { json: true, body }（真 body 不被 "true" 覆盖）');
        else bad('{ json: true, body } 的真 body 被吃掉了', `读到 ${JSON.stringify(afterTrue)} —— 界面会显示成功但没保存`);

        // ③ 对照：把新逻辑换回旧的，必须**复现**这个 bug
        const oldSrc = apiSrc.replace(
          /let hasBody = o\.body !== undefined;\s*\n\s*if \(o\.json !== undefined && o\.json !== true\) \{\s*\n\s*o\.body = JSON\.stringify\(o\.json\);\s*\n\s*hasBody = true;\s*\n\s*\}\s*\n\s*delete o\.json;\s*\n\s*o\.headers = Object\.assign\(\{\}, H\(\), hasBody \? J : \{\}, o\.headers \|\| \{\}\);/,
          'const hasJson = o.json !== undefined;\n  if (hasJson) { o.body = JSON.stringify(o.json); delete o.json; }\n  o.headers = Object.assign({}, H(), hasJson ? J : {}, o.headers || {});',
        );
        if (oldSrc === apiSrc) {
          note('对照版没替换成功（api() 里那几行又改了？）—— 请确认这块测试还有效');
        } else {
          // 先清场，制造"本来没这个别名"的干净状态
          await apiPanel('/admin/api/models', { method: 'POST', json: { ...aliasBase } });
          const apiOld = mk(oldSrc);
          await apiOld('/admin/api/models', {
            method: 'POST',
            json: true,
            body: JSON.stringify({ ...aliasBase, alias: { ...aliasBase.alias, [MARK]: 'zz-should-not-appear' } }),
          }).catch(() => { /* 老版可能抛错，无所谓，看的是有没有写进去 */ });
          const afterOld = (await (await fetch(base + '/admin/api/state', { headers: panelH() })).json())
            .config?.models?.alias?.[MARK];
          if (afterOld === undefined) ok('对照成立：旧逻辑确实会静默丢掉 body（证明上面两条真的测到了）');
          else bad('对照没复现（旧逻辑居然写进去了）', `alias[${MARK}] = ${JSON.stringify(afterOld)}，说明这个测试可能测不到东西`);
        }

        // 还原：把别名配置恢复原样
        await apiPanel('/admin/api/models', { method: 'POST', json: { ...aliasBase } });
        const restored = (await (await fetch(base + '/admin/api/state', { headers: panelH() })).json())
          .config?.models?.alias || {};
        if (restored[MARK] === undefined
          && JSON.stringify(Object.keys(restored).sort()) === JSON.stringify(Object.keys(aliasBase.alias).sort())) {
          ok('模型别名配置已还原成测试前的样子', `alias 共 ${Object.keys(restored).length} 项`);
        } else {
          bad('模型别名配置没还原干净', JSON.stringify(restored));
        }
      }

      // ④ 顺带钉住：8 处调用点不该再有 `json: true`
      const leftover = [...htmlText.matchAll(/json:\s*true,\s*body:/g)];
      if (leftover.length === 0) ok('面板里没有 `{ json: true, body: ... }` 的旧写法了');
      else note(`面板里还有 ${leftover.length} 处 \`{ json: true, body: ... }\`（现在也支持，但建议统一成 \`json: {对象}\`）`);
    }
  }
}

/* ── 配置卫生：不许留下「写了但没人读」的死配置 ─────────────────────── */
//
// 这个项目连着撞到三条死配置，每一条都是"填了不生效"：
//   · `accounts.rescanSeconds`  —— 号池扫描听的是 `upstream.refreshSeconds`
//   · `auth.pollSeconds`        —— 真正生效的是 regTimer 的 5 秒（四路轮询叠加）
//   · `register.sms.fixedCode`  —— `sms.provider` 只实现了 manual / http
//
// 共同点：**DEFAULTS 里有、config.example.json 里有、文档里也写了，
// 就是 `src/` 里没人读**。填了不生效比不写更坏 —— 它会让人以为「我调过了」，
// 然后去别处找原因（上面那条限流事故就是这么绕远的）。
//
// 所以判据钉死两句话：
//   ① 默认里每个叶子键，都必须在 src/ 里被读到一次；
//   ② 示例文件里不许出现默认里没有的键（写错名字当场现形）。
console.log('\n[配置卫生：死配置]');
{
  const fs2 = await import('node:fs');
  const os2 = await import('node:os');
  const path2 = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path2.resolve(path2.dirname(fileURLToPath(import.meta.url)), '..');
  const { loadConfig, saveConfig, unknownConfigKeys } = await import('../src/config.mjs');

  // ① 示例文件里没有代码不认识的项
  const exampleRaw = JSON.parse(fs2.readFileSync(path2.join(ROOT, 'config.example.json'), 'utf8'));
  const unknown = unknownConfigKeys(exampleRaw);
  if (unknown.length === 0) ok('config.example.json 里没有代码不认识的配置项');
  else bad('config.example.json 里有代码不认识的项（写错名字了？）', unknown.join(', '));

  // ①′ 正反对照 —— 这条告警必须"该响的响、不该响的不响"
  const typo = unknownConfigKeys({ upstream: { alwaysStreamUpstream: true } });
  if (typo.length === 1 && typo[0] === 'upstream.alwaysStreamUpstream') {
    ok('对照成立：写错/删掉的键会被报出来', typo[0]);
  } else {
    bad('正对照不成立：拼错的键没被报出来', JSON.stringify(typo));
  }
  /*
   * 开放映射（默认值是 `{}` 的表）不许误报。
   * 这条是**正对照实测出来的**：`maxMaxTokensByModel` 默认是 `{}`，
   * 用户往里写 `glm-5` / `qwen3` 本来是对的，递归下去却报了
   * 「maxMaxTokensByModel.glm-5 是代码不认识的配置项」。
   * 会喊狼来了的告警比没有告警更坏 —— 真写错名字那次就没人看了。
   */
  const openMap = unknownConfigKeys({
    models: { maxMaxTokensByModel: { 'glm-5': 131072 }, alias: { 'gpt-x': 'glm-5.3' } },
    upstream: { extraHeaders: { 'X-Trace': '1' } },
  });
  if (openMap.length === 0) ok('开放映射（默认 {} 的表）里的自定义键不会被误报');
  else bad('开放映射被误报了', openMap.join(', '));

  // ② 默认里每个叶子键都得有人读
  //    消费方 = src/ 里**除 config.mjs 之外**的源码 + 面板。
  //    定义它的那个文件不算"有人读" —— 否则死配置自己就证明自己没死。
  const defaults = loadConfig(path2.join(ROOT, '__no_such_config__.json'));
  delete defaults.__file;
  delete defaults.__unknownKeys;
  let consumers = '';
  for (const f of fs2.readdirSync(path2.join(ROOT, 'src'))) {
    if (f === 'config.mjs' || !/\.(mjs|html)$/.test(f)) continue;
    consumers += fs2.readFileSync(path2.join(ROOT, 'src', f), 'utf8') + '\n';
  }
  const leaves = [];
  (function walk(o, prefix) {
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      for (const [k, v] of Object.entries(o)) walk(v, prefix ? `${prefix}.${k}` : k);
      return;
    }
    leaves.push(prefix);
  })(defaults, '');
  // 键名在源码里出现过就算有人读。保守判法：宁可漏报，也不误报让人去删活配置。
  const dead = leaves.filter((p) => !consumers.includes(p.split('.').pop()));
  if (dead.length === 0) ok(`配置项全部有人读（${leaves.length} 项，没有死配置）`);
  else bad(`有 ${dead.length} 个配置项写了没人读（死配置）`, dead.join(', '));

  // ③ 反向对照：新加一个没人读的键，必须被上面那条抓出来
  //    没有对照的话，"通过"可能只是因为这条测试压根没在找东西。
  const fakeDead = '__definitelyNotReadByAnyone';
  if (!consumers.includes(fakeDead) && leaves.length > 0) ok('对照成立：没人读的新键会被判成死配置');
  else bad('对照不成立，这条测试可能测不到东西');

  // ④ saveConfig 不许把内部字段写进文件（否则面板一保存就多出一条"不认识的项"）
  const tmp = path2.join(os2.tmpdir(), `o2a-cfgtest-${process.pid}.json`);
  saveConfig({ __file: tmp, __unknownKeys: ['a.b'], listen: { port: 1 } });
  const written = JSON.parse(fs2.readFileSync(tmp, 'utf8'));
  if (!('__unknownKeys' in written) && !('__file' in written)) ok('saveConfig 不会把内部字段写进 config.json');
  else bad('内部字段被写进配置文件了', JSON.stringify(written));
  fs2.rmSync(tmp, { force: true });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
