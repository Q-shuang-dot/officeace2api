#!/usr/bin/env node
/**
 * 批量注册：状态机 + 面板展示层的回归测试（这个模块原先也没有测试，
 * 而它正好是这周出问题的那条链）。
 *
 * 这里刻意**不碰网络**（真发短信、真走注册页那部分靠人工和 tools/probe-* ）：
 *   · 入队：去重（同号在途不再排队）、空号丢弃、并发数收敛到 1~5
 *   · 状态推进：暂停时 kick() 一次都不跑；重试把失败任务退回 pending
 *   · 删除策略：在途任务不许删（只能删已完成/失败）
 *   · 面板 view()：**验证码绝不能进 view**（它会进截图），手机号只给脱敏形态
 *
 *   node tools/test-register.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_REGISTER_URL,
  PROMOTION_ERRORS,
  TASK_STATES,
  RegisterQueue,
  buildRegisterUrl,
  maskPhone,
  pickPath,
} from '../src/register.mjs';

let pass = 0;
const fails = [];
function ok(name) {
  pass += 1;
  console.log(`  ✓ ${name}`);
}
function bad(name, extra) {
  fails.push(name);
  console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`);
}

const makeQueue = (over = {}) => {
  const cfg = {
    registerUrl: 'https://example.invalid/reg.html',
    concurrency: 2,
    sms: { provider: 'manual' },
    activation: { autoActivate: false, promotionCodes: [] },
    ...over,
  };
  const q = new RegisterQueue({ getConfig: () => cfg, authFlow: {}, accounts: {}, onDone: () => {} });
  return { q, cfg };
};

console.log('批量注册（纯状态机，不碰网络）');

/* ---------------------------------------------------- 常量与纯函数 */
{
  const keys = Object.keys(TASK_STATES);
  const need = ['pending', 'opening', 'needcode', 'submitted', 'awaiting_auth', 'activating', 'done', 'failed', 'skipped'];
  if (need.every((k) => keys.includes(k)) && need.every((k) => TASK_STATES[k])) {
    ok(`TASK_STATES 覆盖全部 ${need.length} 个状态且都有中文文案`);
  } else {
    bad('TASK_STATES 覆盖全部状态', JSON.stringify(keys));
  }

  const errKeys = Object.keys(PROMOTION_ERRORS);
  if (errKeys.length && errKeys.every((k) => /^(AgentArts|common)\./.test(k)) && errKeys.every((k) => PROMOTION_ERRORS[k])) {
    ok(`PROMOTION_ERRORS 是「错误码 → 中文」映射（${errKeys.length} 条，键都是上游码形）`);
  } else {
    bad('PROMOTION_ERRORS 是错误码映射', JSON.stringify(errKeys));
  }

  // 脱敏：中间那几位必须看不见（它会进日志和截图）
  const cases = [
    ['', ''],
    ['1234', '****'],
    ['12345', '123****45'],
    ['13800138000', '138****00'],
  ];
  const badCase = cases.find(([inp, want]) => maskPhone(inp) !== want);
  if (!badCase && !maskPhone('13800138000').includes('001380')) {
    ok('maskPhone 边界正确，且不泄露中间号段');
  } else {
    bad('maskPhone 边界正确', JSON.stringify([badCase, maskPhone('13800138000')]));
  }

  if (buildRegisterUrl('https://example.invalid/reg.html', { phone: '13800138000' }) === 'https://example.invalid/reg.html?phone=13800138000') {
    ok('buildRegisterUrl 带上手机号');
  } else {
    bad('buildRegisterUrl 带上手机号', buildRegisterUrl('https://example.invalid/reg.html', { phone: '13800138000' }));
  }
  if (buildRegisterUrl('', {}) === DEFAULT_REGISTER_URL) ok('buildRegisterUrl 空 base 回落到默认注册页');
  else bad('buildRegisterUrl 空 base 回落', buildRegisterUrl('', {}));
  if (buildRegisterUrl('这不是 URL', { phone: '1' }) === '这不是 URL') ok('buildRegisterUrl 非法 base 原样返回（不抛）');
  else bad('buildRegisterUrl 非法 base 原样返回', buildRegisterUrl('这不是 URL', { phone: '1' }));

  // pickPath 是「从上游 JSON 里掏验证码」那一步，掏错了就是静默失败
  const obj = { data: { code: '998877', nested: { v: 0 } }, list: [{ x: 1 }] };
  const checks = [
    [pickPath(obj, 'data.code'), '998877'],
    [pickPath(obj, 'data.nested.v'), 0], // falsy 也要原样返回，不能当成「没有」
    [pickPath(obj, 'data.nope'), undefined],
    [pickPath(null, 'data.code'), undefined],
    [pickPath(obj, ''), undefined],
  ];
  const miss = checks.find(([got, want]) => JSON.stringify(got) !== JSON.stringify(want));
  if (!miss) ok('pickPath 取嵌套值 / falsy 也返回 / 缺路径给 undefined');
  else bad('pickPath 行为', JSON.stringify(miss));
}

/* ---------------------------------------------------- 入队与去重 */
{
  const { q, cfg } = makeQueue();
  const created = q.enqueue({ phones: ['13800138000', '13900139000'], autoStart: false });
  if (created.length === 2 && q.pendingCount() === 2) ok('入队两个号：两条任务、pending 计数为 2');
  else bad('入队两个号', JSON.stringify([created.length, q.pendingCount()]));

  const list = q.list();
  if (list.length === 2 && list[0].phoneMasked === '139****00') ok('list() 最新任务排在最前');
  else bad('list() 排序', JSON.stringify(list.map((t) => t.phoneMasked)));

  const dup = q.enqueue({ phones: ['13800138000'], autoStart: false });
  if (dup.length === 0 && q.pendingCount() === 2) ok('同号已有在途任务 → 不再重复入队');
  else bad('同号去重', JSON.stringify([dup.length, q.pendingCount()]));

  const blank = q.enqueue({ phones: ['', '   ', null], items: [{ phone: '' }], autoStart: false });
  if (blank.length === 0) ok('空号/空白号被丢弃');
  else bad('空号被丢弃', JSON.stringify(blank.length));

  const st = q.stats();
  if (st.total === 2 && st.byState.pending === 2 && st.paused === false && st.running === false) {
    ok('stats() 计数与状态自洽');
  } else {
    bad('stats() 计数与状态自洽', JSON.stringify(st));
  }
  if (st.concurrency === 2 && st.smsProvider === 'manual') ok('stats() 反映并发数与接码方式');
  else bad('stats() 反映配置', JSON.stringify([st.concurrency, st.smsProvider]));
}

/* ---------------------------------------------------- 并发数收敛到 1~5 */
{
  const cases = [[99, 5], [0, 1], [-3, 1], ['abc', 1], [3, 3]];
  const miss = cases.find(([inp, want]) => makeQueue({ concurrency: inp }).q.stats().concurrency !== want);
  if (!miss) ok('concurrency 收敛到 1~5（99→5、0/-3/abc→1、3→3）');
  else bad('concurrency 收敛到 1~5', JSON.stringify(miss));
}

/* ---------------------------------------------------- 暂停 / 重试 / 删除 */
{
  const { q } = makeQueue();
  const [t1] = q.enqueue({ phones: ['13800138000'], autoStart: false });
  const [t2] = q.enqueue({ phones: ['13900139000'], autoStart: false });

  q.setSmsCode(t1.id, '123456');
  const v = q.get(t1.id);
  if (v.smsCodeSet === true && v.smsCodeMasked === '1***6') ok('setSmsCode 记下验证码，view 只给脱敏形态');
  else bad('setSmsCode / 脱敏', JSON.stringify(v && [v.smsCodeSet, v.smsCodeMasked]));

  const dumped = JSON.stringify(v);
  if (!dumped.includes('123456') && !dumped.includes('smsCode"')) {
    ok('view() 里没有验证码明文字段（它会进截图）');
  } else {
    bad('view() 不该带验证码明文', dumped.slice(0, 120));
  }

  let threw = false;
  try {
    q.setSmsCode('不存在的任务', '123');
  } catch {
    threw = true;
  }
  if (threw && q.get('不存在的任务') === null) ok('未知任务 id：setSmsCode 抛错、get 返回 null');
  else bad('未知任务 id 的处理', JSON.stringify([threw, q.get('不存在的任务')]));

  // 暂停时 kick() 一次都不该跑（这里如果跑了就会去打上游）
  q.setPaused(true);
  const kicked = await q.kick();
  if (kicked.ran === 0 && q.stats().paused === true) ok('暂停状态下 kick() 一次都不跑');
  else bad('暂停状态下 kick()', JSON.stringify([kicked, q.stats().paused]));
  q.setPaused(false);

  // 在途任务也允许删除。老规则是「只能删已完成或失败」，本意护住在途任务，
  // 但把「卡在等待验证码上的任务」也堵死了 —— 那种任务在面板上删不掉，
  // 唯一出路是重启服务（重启才会把它变成失败）。自测也因此每跑一次就留两条垃圾。
  const removedPending = q.remove(t1.id);
  if (removedPending === true && q.get(t1.id) === null) ok('在途任务也能删除（卡住的任务能清掉）');
  else bad('在途任务也能删除', JSON.stringify(removedPending));

  q.tasks.get(t2.id).status = 'failed';
  const afterRetry = q.retry(t2.id);
  if (afterRetry.status === 'pending' && afterRetry.attempts === 0 && afterRetry.error === '') {
    ok('retry() 把失败任务退回 pending 并清空错误/次数');
  } else {
    bad('retry() 退回 pending', JSON.stringify(afterRetry && [afterRetry.status, afterRetry.attempts, afterRetry.error]));
  }

  q.tasks.get(t2.id).status = 'failed';
  const removed = q.remove(t2.id);
  if (removed === true && q.get(t2.id) === null) ok('失败任务可以删除');
  else bad('失败任务可以删除', JSON.stringify(removed));

  // 同一个号「失败之后」应该允许重新入队（去重不能把它永久挡住）
  const again = q.enqueue({ phones: ['13900139000'], autoStart: false });
  if (again.length === 1) ok('同号在「失败/完成」之后可以重新入队');
  else bad('同号失败后可重新入队', JSON.stringify(again.length));

  q.tasks.get(again[0].id).status = 'done';
  if (q.clearDone() === 1) ok('clearDone() 只清已完成/失败的任务');
  else bad('clearDone() 清理数', String(q.clearDone()));
}

/* ---------------------------------------------------- 事件流上限 */
{
  const { q } = makeQueue();
  const [t] = q.enqueue({ phones: ['13800138000'], autoStart: false });
  if (t.events.length === 1 && t.events[0].message.includes('已加入注册队列')) ok('入队即留一条事件');
  else bad('入队事件', JSON.stringify(t.events));
  for (let i = 0; i < 60; i += 1) q._event(q.tasks.get(t.id), `第 ${i} 条`);
  const ev = q.get(t.id).events;
  if (ev.length === 30 && ev[ev.length - 1].message === '第 59 条') ok('事件流裁到最近 30 条（不会无限涨）');
  else bad('事件流上限', JSON.stringify([ev.length, ev[ev.length - 1] && ev[ev.length - 1].message]));
}

/* ---------------------------------------------------- 落盘与恢复：重启不丢任务 */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o2a-register-'));
  const file = path.join(dir, 'register-tasks.json');
  const mk = (dataFile) =>
    new RegisterQueue({
      getConfig: () => ({ concurrency: 1, sms: { provider: 'manual' } }),
      authFlow: {},
      accounts: {},
      dataFile,
    });

  const q1 = mk(file);
  const [a] = q1.enqueue({ phones: ['13800138000'], autoStart: false });
  const [b] = q1.enqueue({ phones: ['13900139000'], autoStart: false });
  q1.setSmsCode(a.id, '654321');
  // a 推到「等待短信验证码」，这样恢复时才能验证「中断在哪一步」有没有写在提示里
  q1.tasks.get(a.id).status = 'needcode';
  // 手工把 b 推到终态（正常流程要真发短信，这里只验落盘）
  const bt = q1.tasks.get(b.id);
  bt.status = 'done';
  bt.finishedAt = Date.now();
  bt.accountId = 'acc-1';
  q1.save();

  const raw = fs.readFileSync(file, 'utf8');
  const doc = JSON.parse(raw);
  if (doc.tasks.length === 2) ok('落盘：两条任务都写进文件');
  else bad('落盘：两条任务都写进文件', String(doc.tasks.length));

  if (!/password|smsCode/.test(raw)) ok('落盘：文件里没有 password / smsCode（省掉一份没用的敏感数据）');
  else bad('落盘：不该出现 password / smsCode', (raw.match(/.{0,16}(password|smsCode).{0,16}/) || [''])[0]);

  if (raw.includes('13800138000')) ok('落盘：手机号明文（否则重启后没法接着注册），走 writeFileSecure 锁权限');
  else bad('落盘：手机号应为明文');

  const q2 = mk(file);
  if (q2.tasks.size === 2 && q2.get(b.id).status === 'done' && q2.get(b.id).accountId === 'acc-1') {
    ok('恢复：终态任务原样读回（含 accountId 和事件流）');
  } else {
    bad('恢复：终态任务原样读回', JSON.stringify([q2.tasks.size, q2.get(b.id) && q2.get(b.id).status]));
  }

  const ra = q2.get(a.id);
  if (ra.status === 'failed' && ra.error.includes('中断') && ra.error.includes('等待短信验证码')) {
    ok('恢复：在途任务如实标成「中断在等待短信验证码」，不假装还在跑');
  } else {
    bad('恢复：在途任务标成中断并说明停在哪一步', JSON.stringify(ra && [ra.status, ra.error]));
  }

  if (q2.get(a.id).smsCodeSet === false) ok('恢复：验证码不复原（分钟级有效，重启后没用）');
  else bad('恢复：验证码不复原', '竟然还在');

  const retried = q2.retry(a.id);
  if (retried.status === 'pending' && q2.pendingCount() === 1) ok('恢复：中断的任务点一下重试就能重来');
  else bad('恢复：中断的任务可重试', JSON.stringify([retried.status, q2.pendingCount()]));

  const [c] = q2.enqueue({ phones: ['13700137000'], autoStart: false });
  if (c.id !== a.id && c.id !== b.id && q2.tasks.size === 3) ok('恢复：seq 接着数，新任务 id 不撞车');
  else bad('恢复：seq 续号', JSON.stringify(c.id));

  const q3 = new RegisterQueue({ getConfig: () => ({}), authFlow: {}, accounts: {} });
  q3.enqueue({ phones: ['13600136000'], autoStart: false });
  if (q3.save() === false && fs.readdirSync(dir).length === 1) {
    ok('不传 dataFile 时是纯内存模式（一个字节都不写）');
  } else {
    bad('纯内存模式', JSON.stringify([q3.save(), fs.readdirSync(dir).length]));
  }

  // 历史裁剪：塞 200 条终态 + 1 条在途，读回来不该全留着
  const big = path.join(dir, 'big.json');
  const many = [];
  for (let i = 0; i < 200; i += 1) {
    many.push({
      id: `reg-${i}-x`,
      phone: `1390000${String(i).padStart(4, '0')}`,
      status: 'done',
      createdAt: i,
      updatedAt: i,
      finishedAt: i,
      events: [],
    });
  }
  many.push({ id: 'reg-live-1', phone: '13800138001', status: 'needcode', createdAt: 9999, updatedAt: 9999, events: [] });
  fs.writeFileSync(big, JSON.stringify({ seq: 300, tasks: many }), 'utf8');
  const q4 = mk(big);
  if (q4.tasks.size === 60 && q4.get('reg-live-1')) {
    ok('历史裁剪：终态只留最近 60 条（HISTORY_LIMIT），在途那条一定留着');
  } else {
    bad('历史裁剪', JSON.stringify([q4.tasks.size, !!q4.get('reg-live-1')]));
  }
  if (q4.get('reg-199-x') && !q4.get('reg-0-x')) ok('历史裁剪：留下的是「最近」的那批，不是最老的');
  else bad('历史裁剪：留最近的', JSON.stringify([!!q4.get('reg-199-x'), !!q4.get('reg-0-x')]));

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n' + '='.repeat(56));
console.log(`结果：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log(`  - ${f}`);
}
console.log('\n提示：这个文件只跑状态机，不碰网络、不碰 data/ 里的真实状态。');
process.exit(fails.length ? 1 : 0);
