/**
 * 失败调用诊断字段的回归测试。
 *
 * 面板的「错误 / 诊断」列依赖 recent 里的 requestId / errorCode / attempts。
 * 这些字段一旦在 record() 或落盘时丢了，UI 只会安静地退回一坨错误文本，
 * 所以用纯 Node 测一遍，不依赖正在运行的服务。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageStore } from '../src/stats.mjs';

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o2a-call-diag-'));
const file = path.join(dir, 'usage.json');
const store = new UsageStore({ file, flushMs: 60_000 });

store.record({
  model: 'm1',
  ok: false,
  status: 502,
  errorCode: 'ModelArts.81004',
  requestId: 'rid-test-1',
  accountId: 'acct-1',
  credential: 'https://gw.example/v2',
  latencyMs: 123,
  error: 'no permission for model',
  attempts: [
    { attempt: 1, credential: 'https://gw-a/v2', accountId: 'acct-a', status: 502, code: 'ModelArts.81004', error: 'no permission' },
    { attempt: 2, credential: 'https://gw-b/v2', accountId: 'acct-1', status: 502, code: 'ModelArts.81004', error: 'still no permission' },
  ],
});

const row = store.snapshot().recent[0];
check('请求 ID', row.requestId, 'rid-test-1');
check('错误码', row.errorCode, 'ModelArts.81004');
check('HTTP 状态', row.status, 502);
check('账号 ID', row.accountId, 'acct-1');
check('尝试次数', row.attempts.length, 2);
check('第一次尝试账号', row.attempts[0].accountId, 'acct-a');
check('第二次尝试错误', row.attempts[1].error, 'still no permission');

store.flush();
const reloaded = new UsageStore({ file, flushMs: 60_000 });
const again = reloaded.snapshot().recent[0];
check('落盘后请求 ID 仍在', again.requestId, 'rid-test-1');
check('落盘后尝试链仍在', again.attempts.length, 2);

store.timer?.unref?.();
reloaded.timer?.unref?.();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
