#!/usr/bin/env node
/**
 * 一键授权轮询的节奏测试 —— 不碰真云端，把 node:https 换成假的。
 *
 * 为什么值得单独一条测试：这条链路的毛病是**节奏**问题，不是逻辑问题。
 * 同一个 state 有四路调用方（regTimer 5 秒一轮、注册状态机自己又 check 一遍、
 * 面板点「检查」、本机 OfficeAce 应用自己也在问云端），每一路单独看都没写错，
 * 叠在一起就把云端问进了限流：
 *
 *   AgentArts.1100011: Too many requests for the same state. Please retry later.
 *
 * 于是**越问越问不到**，最后 10 分钟到点被判超时 —— 表现就是
 * 「注册任务失败：一键授权失败：授权链接超过 10 分钟未完成，请重新发起」。
 *
 * 这种 bug 只有把「谁问了、问了几次、下次什么时候问」数出来才看得见，
 * 所以下面每个用例都在数云端请求次数和看 nextPollAt。
 *
 * 用法：node tools/test-authflow-poll.mjs
 */
import { EventEmitter } from 'node:events';
import https from 'node:https';

let pass = 0;
let fail = 0;
const ok = (m, extra = '') => { pass += 1; console.log(`  ✓ ${m}${extra ? '  ' + extra : ''}`); };
const bad = (m, extra = '') => { fail += 1; console.log(`  ✗ ${m}${extra ? '  ' + extra : ''}`); };

const CLOUD_HOST = 'agentarts.cn-southwest-2.myhuaweicloud.com';
const APP_BASE = 'https://127.0.0.1:3004';

/** 造一个「像真的」授权链接：state 藏在内层 OAuth 参数里，和真链路同构 */
const mkAuthorizeUrl = (state) =>
  'https://auth.huaweicloud.com/authui/login.html?service=' +
  encodeURIComponent(
    `https://auth.huaweicloud.com/authui/v1/oauth2/authorize?client_id=pdp5_for_agentarts&state=${state}&response_type=code`,
  );

/* ------------------------------------------------ 假的 node:https ------- */

const calls = { cloud: 0, local: 0, log: [] };
let cloudBehavior = 'pending'; // pending(202) | pending404 | rate | http429 | callback | error
let appLogin = { islogin: false, userId: null };
const realRequest = https.request;

function respond(res, spec) {
  const res2 = new EventEmitter();
  res2.statusCode = spec.status;
  res2.headers = {};
  res2.resume = () => {};
  res(spec);
}

https.request = function fakeRequest(opts, cb) {
  const host = String(opts.hostname || '');
  const path = String(opts.path || '');
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.write = () => {};
  req.destroy = (err) => req.emit('error', err || new Error('destroyed'));
  req.end = () => {
    const isCloud = host === CLOUD_HOST;
    if (isCloud) calls.cloud += 1;
    else calls.local += 1;
    calls.log.push((isCloud ? 'cloud' : 'local') + path.split('?')[0]);

    if (isCloud && cloudBehavior === 'error') {
      setImmediate(() => req.emit('error', new Error('socket hang up')));
      return;
    }

    let spec;
    if (isCloud) {
      if (cloudBehavior === 'rate') spec = { status: 404, json: { error_code: 'AgentArts.1100011', error_msg: 'Too many requests for the same state. Please retry later.' } };
      else if (cloudBehavior === 'http429') spec = { status: 429, json: { error_msg: 'slow down' } };
      else if (cloudBehavior === 'callback') spec = { status: 200, json: { code: 'fake-code' } };
      // 实测真实云端「还没好」回的是 **202**，不是 404 —— 下面专门有断言盯这件事
      else if (cloudBehavior === 'pending404') spec = { status: 404, json: { error_code: 'AgentArts.11000009', error_msg: 'Authorization code is not ready, please retry later.' } };
      else spec = { status: 202, json: { error_code: 'AgentArts.11000009', error_msg: 'Authorization code is not ready, please retry later.' } };
    } else if (path.startsWith('/api/islogin')) {
      spec = { status: 200, json: appLogin };
    } else if (path.startsWith('/api/login/authorize')) {
      const st = 'abcdef0123456789abcdef0123456789';
      spec = { status: 200, json: { authorizeUrl: mkAuthorizeUrl(st), state: st } };
    } else {
      spec = { status: 200, json: { ok: true } };
    }

    setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = spec.status;
      res.headers = {};
      res.resume = () => {};
      cb(res);
      const text = spec.json === undefined || spec.json === null ? '' : JSON.stringify(spec.json);
      setImmediate(() => {
        if (text) res.emit('data', Buffer.from(text, 'utf8'));
        res.emit('end');
      });
    });
  };
  return req;
};

/* ------------------------------------------------ 被测对象 -------------- */

const { AuthFlow } = await import('../src/authflow.mjs');

// 号池用假的：这条测试只关心"问了几次云端"，扫盘另有 test-admin.mjs 管
const fakeAccounts = {
  list: () => [],
  ids: () => [],
  get: () => null,
  setLabel: () => {},
  scan: () => [],
};

const flow = new AuthFlow({ accounts: fakeAccounts, appApis: [APP_BASE], pollSeconds: 5 });
const started = await flow.start({ label: '测试号' });
const task = flow.tasks.get(started.id);

console.log('\n══ 一键授权的轮询节奏 ══\n');

/* ---------- 1. 基线 ---------- */
console.log('【1】发起之后：第一次问云端、之后按 pollSeconds 走');
{
  if (started.status === 'pending' && started.state === task.state) ok('发起成功，拿到 state', started.state);
  else bad('发起异常', JSON.stringify({ status: started.status, state: started.state }));

  const beforeCloud = calls.cloud;
  const v1 = await flow.check(started.id);
  if (calls.cloud - beforeCloud === 1) ok('第一次 check 问了云端 1 次');
  else bad('第一次 check 没问云端', `${calls.cloud - beforeCloud} 次`);
  if (v1.polls === 1 && v1.poll.intervalMs === 5000) ok('节奏用 pollSeconds', `interval=${v1.poll.intervalMs}ms`);
  else bad('节奏不对', JSON.stringify(v1.poll));
  if (v1.poll.nextInMs > 0) ok('已经把"下次允许的时间"推到未来', `${Math.round(v1.poll.nextInMs / 1000)}s 后`);
  else bad('没排下次时间', JSON.stringify(v1.poll));
}

/* ---------- 2. 未到点：不碰云端，但本机那两步照做 ---------- */
console.log('\n【2】未到点时：不碰云端，本机那两步照做');
{
  const beforeCloud = calls.cloud;
  const beforeLocal = calls.local;
  const v = await flow.check(started.id);
  if (calls.cloud === beforeCloud) ok('未到点就不问云端了（这是要治的毛病）');
  else bad('未到点还问了云端', `${calls.cloud - beforeCloud} 次`);
  if (calls.local > beforeLocal) ok('本机调用照做（认"授权完成"靠它们）', `+${calls.local - beforeLocal} 次`);
  else bad('本机调用也没做', '那样授权完成就认不出来了');
  if (v.polls === 1) ok('polls 没被虚增', String(v.polls));
  else bad('polls 被虚增了', String(v.polls));
}

/* ---------- 3. 四路并发：只打一次（核心回归） ---------- */
console.log('\n【3】四路调用方同一瞬间来问：只打一次云端');
{
  task.nextPollAt = 0; // 假装到点了
  const before = calls.cloud;
  await Promise.all([
    flow.check(started.id), // regTimer
    flow.check(started.id), // 注册状态机
    flow.check(started.id), // 面板
    flow.check(started.id), // 桌面端那条转发
  ]);
  const n = calls.cloud - before;
  if (n === 1) ok('四个调用方并发只发出 1 次云端请求', `${n} 次`);
  else bad('并发时重复打云端（就是这条把 state 问进限流的）', `${n} 次`);
}

/* ---------- 4. 被限流 → 指数退避到封顶 ---------- */
console.log('\n【4】云端回 1100011：指数退避，封顶 60 秒');
{
  cloudBehavior = 'rate';
  const seq = [];
  for (let i = 0; i < 5; i += 1) {
    task.nextPollAt = 0;
    await flow.check(started.id);
    seq.push(Math.round(task.intervalMs / 1000));
  }
  if (seq.join('→') === '10→20→40→60→60') ok('退避序列 10→20→40→60→60 秒', seq.join('→'));
  else bad('退避序列不对', seq.join('→'));
  if (task.rateLimited === 5) ok('限流次数记在 task 上', String(task.rateLimited));
  else bad('限流次数没记', String(task.rateLimited));
  if (task.lastPoll?.rateLimited === true) ok('lastPoll 上标了限流（面板看得出来）');
  else bad('lastPoll 没标限流', JSON.stringify(task.lastPoll));
  const ev = task.events.filter((e) => /嫌问得太快/.test(e.message));
  if (ev.length >= 1 && ev.length <= 2) ok('退避事件只在前几次记（没刷满事件表）', `${ev.length} 条`);
  else bad('退避事件数量不对', `${ev.length} 条`);
}

/* ---------- 5. 云端恢复正常 → 立刻回到原节奏 ---------- */
console.log('\n【5】云端恢复正常：间隔立刻回到 pollSeconds');
{
  cloudBehavior = 'pending';
  task.nextPollAt = 0;
  await flow.check(started.id);
  if (task.intervalMs === 5000 && task.rateLimited === 0) ok('回到 5 秒、限流计数清零', `interval=${task.intervalMs}ms`);
  else bad('没回到原节奏', `interval=${task.intervalMs} rateLimited=${task.rateLimited}`);
}

/* ---------- 6. HTTP 429 也算限流 ---------- */
console.log('\n【6】HTTP 429/503 同样按限流处理');
{
  cloudBehavior = 'http429';
  task.nextPollAt = 0;
  await flow.check(started.id);
  if (task.intervalMs === 10000) ok('429 → 退避到 10 秒', `${task.intervalMs}ms`);
  else bad('429 没退避', `${task.intervalMs}ms`);
  cloudBehavior = 'pending';
  task.nextPollAt = 0;
  await flow.check(started.id);
  if (task.intervalMs === 5000) ok('恢复后回到 5 秒');
  else bad('没恢复', `${task.intervalMs}ms`);
}

/* ---------- 7. 网络抽风也不能空转 ---------- */
console.log('\n【7】网络错误：按节奏重试，不空转、不抛');
{
  cloudBehavior = 'error';
  task.nextPollAt = 0;
  let threw = '';
  try { await flow.check(started.id); } catch (e) { threw = e.message; }
  if (!threw) ok('网络错误没往上抛（轮询是后台任务）');
  else bad('网络错误抛出来了', threw);
  if (task.nextPollAt > Date.now()) ok('网络错误后排了下一次（不空转）', `+${Math.round((task.nextPollAt - Date.now()) / 1000)}s`);
  else bad('网络错误后没排下一次', '下一轮会立刻再打');
  cloudBehavior = 'pending';
}

/* ---------- 8. force：人工点了就立刻问 ---------- */
console.log('\n【8】force：面板上人工点「立即查询」时无视节流');
{
  const before = calls.cloud;
  await flow.check(started.id, { force: true });
  if (calls.cloud - before === 1) ok('force 时照样问云端');
  else bad('force 被节流挡住了', `${calls.cloud - before} 次`);
}

/* ---------- 9. 节流期间也要能认出「授权完成」 ---------- */
console.log('\n【9】被节流时，本机已登录仍然能立刻入池');
{
  appLogin = { islogin: true, userId: '09f8e7d6c5b4a39281706f5e4d3c2b1a' };
  task.nextPollAt = Date.now() + 60000; // 远端这一秒被节流挡住
  const before = calls.cloud;
  const v = await flow.check(started.id);
  if (calls.cloud === before && v.status === 'bound') ok('没问云端也认出了授权完成', v.newUserId);
  else bad('节流期间漏掉了授权完成', JSON.stringify({ status: v.status, cloud: calls.cloud - before }));
  if (v.newAccountId === '' || v.newAccountId === null) ok('没有新账号目录时不瞎认账号 ID');
  else bad('认出了不该有的账号', String(v.newAccountId));
}

/* ---------- 10. 老行为不许退化：超时仍然判 expired ---------- */
console.log('\n【10】10 分钟到点仍然判超时（老行为）');
{
  const t2 = await flow.start({ label: '第二个' });
  const task2 = flow.tasks.get(t2.id);
  task2.expiresAt = Date.now() - 1;
  const v = await flow.check(t2.id);
  if (v.status === 'expired' && /超过 10 分钟/.test(v.error)) ok('超时判定没变', v.error);
  else bad('超时判定被改坏了', JSON.stringify({ status: v.status, error: v.error }));
}

/* ---------- 11. 「还没好」不许被记成事件 ---------- */
console.log('\n【11】「还没好」不许被记成事件（每次轮询都记会把事件表刷满）');
{
  appLogin = { islogin: false, userId: null }; // 复位：上一节把"已登录"留在全局了
  const t3 = await flow.start({ label: '事件噪音' });
  const task3 = flow.tasks.get(t3.id);
  task3.events.length = 0;

  // ① 实测真实云端回的是 202（不是 404）
  cloudBehavior = 'pending';
  for (let i = 0; i < 3; i += 1) {
    task3.nextPollAt = 0;
    await flow.check(t3.id);
  }
  const spam202 = task3.events.filter((e) => /11000009|not ready/i.test(e.message));
  if (spam202.length === 0) ok('202 + AgentArts.11000009 不产生事件', '老代码只认 404，每次都记一条');
  else bad('「还没好」被记成事件了', `${spam202.length} 条：${spam202[0]?.message}`);

  // ② 老代码认识的那种 404 形态也不许记
  cloudBehavior = 'pending404';
  for (let i = 0; i < 2; i += 1) {
    task3.nextPollAt = 0;
    await flow.check(t3.id);
  }
  const spam404 = task3.events.filter((e) => /11000009|not ready/i.test(e.message));
  if (spam404.length === 0) ok('404 + AgentArts.11000009 同样不产生事件');
  else bad('404 那条被记成事件了', `${spam404.length} 条`);

  // ③ 但真回调必须记下来 —— 别把有用的信息一起吞了
  cloudBehavior = 'callback';
  task3.nextPollAt = 0;
  await flow.check(t3.id);
  if (task3.events.some((e) => /云端已收到授权回调/.test(e.message))) ok('真回调照样记事件（没把有用的吞掉）');
  else bad('真回调没记事件', JSON.stringify(task3.events.map((e) => e.message)));
  cloudBehavior = 'pending';
}

/* ---------- 12. stateTtlMinutes 真接上了 ---------- */
console.log('\n【12】stateTtlMinutes：有效期配置真的生效（以前写死 10 分钟）');
{
  const flow15 = new AuthFlow({ accounts: fakeAccounts, appApis: [APP_BASE], pollSeconds: 5, stateTtlMinutes: 15 });
  const t = await flow15.start({ label: 'TTL' });
  const mins = Math.round((t.expiresAt - t.startedAt) / 60000);
  if (mins === 15) ok('配置 15 分钟 → 有效期 15 分钟', `${mins} 分钟`);
  else bad('TTL 配置没生效', `${mins} 分钟`);

  const tk = flow15.tasks.get(t.id);
  tk.expiresAt = Date.now() - 1;
  const v = await flow15.check(t.id);
  if (v.status === 'expired' && /超过 15 分钟/.test(v.error)) ok('超时文案也跟着配置走', v.error);
  else bad('超时文案没跟着配置', JSON.stringify({ status: v.status, error: v.error }));

  // 非法值退回默认，而不是变成一个荒谬的有效期
  const flowBad = new AuthFlow({ accounts: fakeAccounts, appApis: [APP_BASE], stateTtlMinutes: 'abc' });
  const tb = await flowBad.start({ label: 'TTL-bad' });
  const minsBad = Math.round((tb.expiresAt - tb.startedAt) / 60000);
  if (minsBad === 10) ok('非法 TTL 退回默认 10 分钟', `${minsBad} 分钟`);
  else bad('非法 TTL 没兜住', `${minsBad} 分钟`);
}

/* ---------- 假 https 装回去 ---------- */
https.request = realRequest;

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══\n`);
console.log(`（本次共发出 云端 ${calls.cloud} 次 / 本机 ${calls.local} 次 HTTP 请求，全部走假实现）`);
process.exit(fail ? 1 : 0);
