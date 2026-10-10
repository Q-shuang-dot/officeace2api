/**
 * ModelProbe 的单元测试 —— 注入假的 fetch，不碰网络、不花积分。
 *
 * 这个模块会在开机时**主动打 34 次上游**，所以它的行为必须有测试兜着：
 * 探错了会把好模型藏起来（用户找不到），探漏了会把坏模型列出来（用户撞墙）。
 *
 * 用法：node tools/test-model-probe.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelProbe } from '../src/modelProbe.mjs';

let pass = 0;
let fail = 0;
const ok = (m, extra = '') => { pass += 1; console.log(`  ✓ ${m}${extra ? '  ' + extra : ''}`); };
const bad = (m, extra = '') => { fail += 1; console.log(`  ✗ ${m}${extra ? '  ' + extra : ''}`); };

const tmp = mkdtempSync(path.join(os.tmpdir(), 'o2a-probe-'));
const silent = { info() {}, warn() {}, debug() {} };

/* ---- 假的池子 / 目录 / fetch ---- */
function makePool(ids = ['cred-a']) {
  return {
    list: () => ids.map((userId, index) => ({ index, userId })),
    pick: () => ({ baseUrl: 'https://gw.example/v2', headers: { Authorization: 'Basic x' } }),
    markOk() {},
    markFailed() {},
  };
}
function makeRegistry(ids) {
  return { toOpenAiList: () => ids.map((id) => ({ id })) };
}

/**
 * 假 fetch：`good` 里的模型返回 200，其余返回 400 + 81004。
 * @returns {{fetchImpl: Function, calls: string[]}}
 */
function makeFetch(good, { failStatus = 400, failBody = '{"error":{"code":"ModelArts.81004"}}' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.model);
    // 探测必须用 max_tokens:1 —— 成本几乎为零是靠这个，不能被人改大
    if (body.max_tokens !== 1) throw new Error(`探测请求的 max_tokens 应该是 1，实际 ${body.max_tokens}`);
    const hit = good.includes(body.model);
    return {
      ok: hit,
      status: hit ? 200 : failStatus,
      text: async () => (hit ? '{"choices":[]}' : failBody),
    };
  };
  return { fetchImpl, calls };
}

const MODELS = ['m-good-1', 'm-good-2', 'm-bad-1', 'm-bad-2', 'm-bad-3'];

/* ================================================================ 1. 基本探测 */
console.log('\n══ ModelProbe ══\n');
console.log('【1】基本探测：能用的 2 个 / 打不通的 3 个');
{
  const file = path.join(tmp, 'p1.json');
  const { fetchImpl, calls } = makeFetch(['m-good-1', 'm-good-2']);
  const p = new ModelProbe({ dataFile: file, config: {}, pool: makePool(), registry: makeRegistry(MODELS), log: silent, fetchImpl });
  const r = await p.probe({ force: true });
  if (r.probed === 5) ok('探了全部 5 个模型', `probed=${r.probed}`);
  else bad('探测数量不对', String(r.probed));
  if (r.unavailable.length === 3) ok('探出 3 个打不通的', r.unavailable.join(', '));
  else bad('打不通的个数不对', JSON.stringify(r.unavailable));
  if (r.unavailable.includes('m-bad-1') && r.unavailable.includes('m-bad-3')) ok('打不通的名单正确');
  else bad('打不通的名单不对', JSON.stringify(r.unavailable));
  if (!r.unavailable.includes('m-good-1')) ok('能用的没被误判');
  else bad('能用的被误判成打不通', JSON.stringify(r.unavailable));
  if (calls.length === 5) ok('每个模型都真打了一次', `${calls.length} 次`);
  else bad('请求次数不对', String(calls.length));
  if (p.isUnavailable('m-bad-1') && !p.isUnavailable('m-good-1')) ok('isUnavailable() 判定正确');
  else bad('isUnavailable() 判定不对');
}

/* ================================================================ 2. 落盘与读回 */
console.log('\n【2】结果落盘 + 下次开机直接读回');
{
  const file = path.join(tmp, 'p2.json');
  const { fetchImpl } = makeFetch(['m-good-1']);
  const p1 = new ModelProbe({ dataFile: file, config: {}, pool: makePool(), registry: makeRegistry(MODELS), log: silent, fetchImpl });
  await p1.probe({ force: true });
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (Array.isArray(raw.unavailable) && raw.unavailable.length === 4) ok('缓存文件写对了', `${raw.unavailable.length} 个`);
  else bad('缓存文件不对', JSON.stringify(raw.unavailable));
  if (raw.lastProbeAt > 0 && raw.probedWithCredentials) ok('记下了探测时间和号池指纹');
  else bad('没记探测时间/号池指纹', JSON.stringify({ t: raw.lastProbeAt, c: raw.probedWithCredentials }));

  // 新实例（模拟重启）必须直接读回，不能再打一次
  const { fetchImpl: f2, calls: c2 } = makeFetch(['m-good-1']);
  const p2 = new ModelProbe({ dataFile: file, config: {}, pool: makePool(), registry: makeRegistry(MODELS), log: silent, fetchImpl: f2 });
  if (p2.unavailable.size === 4) ok('重启后读回了 4 个打不通的');
  else bad('重启后没读回', String(p2.unavailable.size));
  const r2 = await p2.probe(); // 不带 force
  if (r2.skipped && c2.length === 0) ok('TTL 内 + 号池没变 → 跳过，一次请求都不打', `reason=${r2.reason}`);
  else bad('该跳过却打了请求', JSON.stringify({ skipped: r2.skipped, calls: c2.length }));
}

/* ================================================================ 3. TTL 是额度，不能被号池变化绕过 */
console.log('\n【3】号池变了要重探，但**不能绕过 TTL**（TTL 是打上游的额度）');
{
  const file = path.join(tmp, 'p3.json');
  const { fetchImpl } = makeFetch(['m-good-1']);
  const p = new ModelProbe({ dataFile: file, config: {}, pool: makePool(['cred-a']), registry: makeRegistry(MODELS), log: silent, fetchImpl });
  await p.probe({ force: true });

  // ① 同一个号池、TTL 内 → 跳过
  const { fetchImpl: f1, calls: c1 } = makeFetch(['m-good-1']);
  const same = new ModelProbe({ dataFile: file, config: {}, pool: makePool(['cred-a']), registry: makeRegistry(MODELS), log: silent, fetchImpl: f1 });
  await same.probe();
  if (c1.length === 0) ok('号池没变 + TTL 内 → 跳过');
  else bad('号池没变却重探了', String(c1.length));

  // ② 多个了号，但 TTL 内 → 仍然跳过（不能让加号/删号把 34 次请求反复打出去）
  const { fetchImpl: f2, calls: c2 } = makeFetch(['m-good-1', 'm-bad-1']);
  const grownTooSoon = new ModelProbe({ dataFile: file, config: {}, pool: makePool(['cred-a', 'cred-b']), registry: makeRegistry(MODELS), log: silent, fetchImpl: f2 });
  const r2 = await grownTooSoon.probe();
  if (c2.length === 0 && r2.skipped) ok('号池变了但 TTL 内 → 还是跳过（TTL 是硬额度）', r2.reason);
  else bad('号池变了就绕过 TTL 重探了', JSON.stringify({ calls: c2.length, reason: r2.reason }));

  // ③ 多了一个号 + TTL 已过 → 必须重探（新号可能有新权限）
  const stale = JSON.parse(readFileSync(file, 'utf8'));
  stale.lastProbeAt = Date.now() - 7 * 60 * 60 * 1000;
  writeFileSync(file, JSON.stringify(stale));
  const { fetchImpl: f3, calls: c3 } = makeFetch(['m-good-1', 'm-bad-1']);
  const grown = new ModelProbe({ dataFile: file, config: {}, pool: makePool(['cred-a', 'cred-b']), registry: makeRegistry(MODELS), log: silent, fetchImpl: f3 });
  await grown.probe();
  if (c3.length === MODELS.length) ok('TTL 过了 + 号池变了 → 重探了一遍', `${c3.length} 次`);
  else bad('该重探却没探', String(c3.length));
  if (grown.unavailable.size === 3) ok('新结论生效（新号能让 m-bad-1 用起来）', grown.unavailable.size + ' 个');
  else bad('新结论不对', JSON.stringify([...grown.unavailable]));

  // ④ TTL 过了但号池没变 → 也不用重打（结论还能用）
  const stale2 = JSON.parse(readFileSync(file, 'utf8'));
  stale2.lastProbeAt = Date.now() - 7 * 60 * 60 * 1000;
  stale2.probedWithCredentials = 'cred-a,cred-b';
  writeFileSync(file, JSON.stringify(stale2));
  const { fetchImpl: f4, calls: c4 } = makeFetch(['m-good-1']);
  const unchanged = new ModelProbe({ dataFile: file, config: {}, pool: makePool(['cred-a', 'cred-b']), registry: makeRegistry(MODELS), log: silent, fetchImpl: f4 });
  const r4 = await unchanged.probe();
  if (c4.length === 0 && r4.skipped) ok('TTL 过了 + 号池没变 → 沿用上次结果，不打上游', r4.reason);
  else bad('号池没变却重打了', String(c4.length));
}

/* ================================================================ 4. TTL 过期要重探 */
console.log('\n【4】TTL 过期要重探');
{
  const file = path.join(tmp, 'p4.json');
  // 手写一份"很久以前探的"缓存
  writeFileSync(file, JSON.stringify({ lastProbeAt: Date.now() - 7 * 60 * 60 * 1000, probedWithCredentials: 'cred-other', unavailable: ['m-bad-1'], results: {} }));
  const { fetchImpl, calls } = makeFetch(['m-good-1']);
  const p = new ModelProbe({ dataFile: file, config: {}, pool: makePool(['cred-a']), registry: makeRegistry(MODELS), log: silent, fetchImpl });
  await p.probe();
  if (calls.length === MODELS.length) ok('7 小时前的结论已过期 → 重探了');
  else bad('过期了却没重探', String(calls.length));
  // 自定义 probeTtlMs 也要认
  // ⚠️ 光把 TTL 调小还不够：TTL 过了之后还有"号池没变就沿用旧结论"这一关，
  //    所以这里连号池指纹一起改掉，才是真正的"过期 + 值得重探"
  const file2 = path.join(tmp, 'p4b.json');
  writeFileSync(file2, JSON.stringify({ lastProbeAt: Date.now() - 1000, probedWithCredentials: 'cred-OLD', unavailable: [], results: {} }));
  const { fetchImpl: f2, calls: c2 } = makeFetch(['m-good-1']);
  const p2 = new ModelProbe({ dataFile: file2, config: { probeTtlMs: 1 }, pool: makePool(['cred-a']), registry: makeRegistry(MODELS), log: silent, fetchImpl: f2 });
  await p2.probe();
  if (c2.length === MODELS.length) ok('probeTtlMs 配成 1 也能生效（可调）');
  else bad('probeTtlMs 没生效', String(c2.length));

  // 反面：TTL 很长时，即使号池指纹变了也不许打上游
  const file3 = path.join(tmp, 'p4c.json');
  writeFileSync(file3, JSON.stringify({ lastProbeAt: Date.now() - 1000, probedWithCredentials: '', unavailable: [], results: {} }));
  const { fetchImpl: f3, calls: c3 } = makeFetch(['m-good-1']);
  const p3 = new ModelProbe({ dataFile: file3, config: { probeTtlMs: 3600000 }, pool: makePool(['cred-a']), registry: makeRegistry(MODELS), log: silent, fetchImpl: f3 });
  const r3 = await p3.probe();
  if (c3.length === 0 && r3.skipped) ok('probeTtlMs 配长时压得住（TTL 内一律不打上游）', r3.reason);
  else bad('长 TTL 没压住', String(c3.length));
}

/* ================================================================ 5. 自愈 */
console.log('\n【5】自愈：某次真实请求成功了要能撤销黑名单');
{
  const file = path.join(tmp, 'p5.json');
  const { fetchImpl } = makeFetch(['m-good-1']);
  const p = new ModelProbe({ dataFile: file, config: {}, pool: makePool(), registry: makeRegistry(MODELS), log: silent, fetchImpl });
  await p.probe({ force: true });
  if (p.isUnavailable('m-bad-1')) ok('m-bad-1 先被打不通');
  else bad('m-bad-1 没进名单');
  if (p.clear('m-bad-1') === true && !p.isUnavailable('m-bad-1')) ok('clear() 撤销成功（权限是活的）');
  else bad('clear() 没生效');
  if (p.clear('m-bad-1') === false) ok('再 clear 一次返回 false（不重复写盘）');
  else bad('重复 clear 返回值不对');
  const back = new ModelProbe({ dataFile: file, config: {}, pool: makePool(), registry: makeRegistry(MODELS), log: silent, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '' }) });
  if (!back.isUnavailable('m-bad-1')) ok('撤销结果也落盘了（重启不会复活）');
  else bad('撤销没落盘');
}

/* ================================================================ 6. 空池 / 空目录 / 并发保护 */
console.log('\n【6】边界：池子为空、目录为空、重复调用');
{
  const file = path.join(tmp, 'p6.json');
  const noPool = new ModelProbe({ dataFile: file, config: {}, pool: { list: () => [], pick: () => null }, registry: makeRegistry(MODELS), log: silent, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '' }) });
  const r1 = await noPool.probe({ force: true });
  if (r1.probed === 0 && noPool.unavailable.size === 0 && r1.skipped) ok('池子为空 → 不探、不误报（不能凭空藏模型）', r1.reason);
  else bad('池子为空时行为不对', JSON.stringify(r1));

  // 池子空了**不能把已有结论清空** —— 清了会让好模型被当成"没探过"从而全部列出来
  const seeded = new ModelProbe({ dataFile: file, config: {}, pool: { list: () => [], pick: () => null }, registry: makeRegistry(MODELS), log: silent });
  seeded.noteLearned(['m-bad-1']);
  const r1b = await seeded.probe({ force: true });
  if (r1b.skipped && seeded.isUnavailable('m-bad-1')) ok('池子为空时保留已有结论（不清空）');
  else bad('池子为空把结论清了', JSON.stringify({ ...r1b, kept: seeded.isUnavailable('m-bad-1') }));

  const empty = new ModelProbe({ dataFile: file, config: {}, pool: makePool(), registry: makeRegistry([]), log: silent, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '' }) });
  const r2 = await empty.probe({ force: true });
  if (r2.skipped && r2.probed === 0) ok('目录为空 → 跳过', r2.reason);
  else bad('目录为空时行为不对', JSON.stringify(r2));

  // 探测中再次调用 → 不能并发打两遍
  let resolveHold;
  const hold = new Promise((r) => { resolveHold = r; });
  const slow = new ModelProbe({
    dataFile: file, config: {}, pool: makePool(), registry: makeRegistry(['m1']), log: silent,
    fetchImpl: async () => { await hold; return { ok: true, status: 200, text: async () => '' }; },
  });
  const first = slow.probe({ force: true });
  await new Promise((r) => setTimeout(r, 20));
  const second = await slow.probe({ force: true });
  if (second.skipped && /探测中/.test(second.reason)) ok('探测中再次调用会被挡（不重复打）', second.reason);
  else bad('探测中可以重入', JSON.stringify(second));
  resolveHold();
  await first;
}

/* ================================================================ 7. 错误与超时不能崩 */
console.log('\n【7】网络错 / 5xx / 坏响应都不许把探测搞崩');
{
  const file = path.join(tmp, 'p7.json');
  const p = new ModelProbe({
    dataFile: file, config: {}, pool: makePool(), registry: makeRegistry(['a', 'b', 'c']), log: silent,
    fetchImpl: async (url, init) => {
      const m = JSON.parse(init.body).model;
      if (m === 'a') throw new Error('ECONNRESET');
      if (m === 'b') return { ok: false, status: 502, text: async () => 'gateway boom' };
      return { ok: true, status: 200, text: async () => '' };
    },
  });
  const r = await p.probe({ force: true });
  if (r.probed === 3) ok('三个模型都走到了（异常没中断整轮）');
  else bad('异常中断了整轮', JSON.stringify(r));
  if (r.unavailable.sort().join(',') === 'a,b') ok('异常的两个被记成打不通', r.unavailable.join(', '));
  else bad('异常的处理不对', JSON.stringify(r.unavailable));
  if (p.results.get('a')?.code === 'FETCH_ERROR' || /^FETCH_/.test(p.results.get('a')?.code || '')) ok('异常被记成 FETCH_* 码', p.results.get('a')?.code);
  else bad('异常没记成 FETCH_*', JSON.stringify(p.results.get('a')));
  if (p.isUnavailable('c') === false) ok('正常那个没被连累');
  else bad('正常那个被误判');
}

/* ================================================================ 8. 学习结果合并 */
console.log('\n【8】运行期学习到的打不通模型要能并进来');
{
  const file = path.join(tmp, 'p8.json');
  const p = new ModelProbe({ dataFile: file, config: {}, pool: makePool(), registry: makeRegistry(MODELS), log: silent });
  const added = p.noteLearned(['m-bad-1', 'm-new-bad']);
  if (added === 2 && p.isUnavailable('m-new-bad')) ok('noteLearned() 并进来 2 个', `added=${added}`);
  else bad('noteLearned() 不对', String(added));
  if (p.noteLearned(['m-bad-1']) === 0) ok('重复的不会重复计');
  else bad('重复计了');
}

/* ================================================================ 9. 别名不参与探测 */
console.log('\n【9】别名不参与探测（它不是一个真上游模型）');
{
  const file = path.join(tmp, 'p9.json');
  const { fetchImpl, calls } = makeFetch(['glm-5.2']);
  const reg = makeRegistry(['glm-5.2', 'gpt-4o', 'claude-sonnet-4']);
  reg.alias = { 'gpt-4o': 'glm-5.2', 'claude-sonnet-4': 'glm-5.2' };
  const p = new ModelProbe({ dataFile: file, config: {}, pool: makePool(), registry: reg, log: silent, fetchImpl });
  const r = await p.probe({ force: true });
  // 探测直接打上游，上游不认识别名，一律 81009 —— 探了只会把好别名记成"打不通"
  if (calls.length === 1 && calls[0] === 'glm-5.2') ok('只探了真模型，没探别名', calls.join(','));
  else bad('别名被拿去探测了', calls.join(','));
  if (!p.isUnavailable('gpt-4o') && !p.isUnavailable('claude-sonnet-4')) ok('别名没被记进"打不通"');
  else bad('别名被记进黑名单了（用户下次再起同名别名会一上来就"打不通"）', JSON.stringify([...p.unavailable]));
  if (r.probed === 1) ok('probed 只算真模型', String(r.probed));
  else bad('probed 把别名也算进去了', String(r.probed));

  // 全是别名 → 跳过，不该报错
  const reg2 = makeRegistry(['a-alias']);
  reg2.alias = { 'a-alias': 'glm-5.2' };
  const p2 = new ModelProbe({ dataFile: path.join(tmp, 'p9b.json'), config: {}, pool: makePool(), registry: reg2, log: silent, fetchImpl });
  const r2 = await p2.probe({ force: true });
  if (r2.skipped && r2.probed === 0) ok('目录里全是别名 → 跳过', r2.reason);
  else bad('全是别名时行为不对', JSON.stringify(r2));
}

/* ================================================================ 10. 清掉"名字已不在目录里"的旧结论 */
console.log('\n【10】prune：丢掉名字已经不在目录里的旧结论');
{
  const file = path.join(tmp, 'p10.json');
  // 手写一份含"已经删掉的模型名"的缓存
  writeFileSync(file, JSON.stringify({
    lastProbeAt: Date.now(),
    probedWithCredentials: 'cred-a',
    unavailable: ['m-bad-1', '故意写个目录里没有的名字'],
    results: { 'm-bad-1': { ok: false }, '故意写个目录里没有的名字': { ok: false }, 'm-good-1': { ok: true } },
  }));
  const p = new ModelProbe({ dataFile: file, config: {}, pool: makePool(), registry: makeRegistry(MODELS), log: silent, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '' }) });
  const n = p.prune(MODELS);
  if (n === 1) ok('prune 清掉 1 条不在目录里的', `removed=${n}`);
  else bad('prune 清的数量不对', String(n));
  if (!p.isUnavailable('故意写个目录里没有的名字')) ok('那个名字确实没了');
  else bad('那个名字还在');
  if (p.isUnavailable('m-bad-1')) ok('还在目录里的不受影响');
  else bad('把还在目录里的也清掉了');
  const back = JSON.parse(readFileSync(file, 'utf8'));
  if (!back.unavailable.includes('故意写个目录里没有的名字')) ok('prune 结果落盘了');
  else bad('prune 没落盘');
  // 目录为空时不许乱清（拿不到参照物就别动手）
  const p2 = new ModelProbe({ dataFile: path.join(tmp, 'p10b.json'), config: {}, pool: makePool(), registry: makeRegistry(MODELS), log: silent });
  p2.noteLearned(['m-bad-1']);
  if (p2.prune([]) === 0 && p2.isUnavailable('m-bad-1')) ok('目录为空时 prune 不动手（宁可留着）');
  else bad('目录为空时 prune 乱清了');
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══\n`);
process.exit(fail ? 1 : 0);
