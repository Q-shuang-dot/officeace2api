/**
 * 「别人 clone 下来能不能跑起来」的真实验证。
 *
 * 做法不是"看代码觉得应该行"，而是**真的造一个干净目录**：
 *   · 只放 git 跟踪的那些文件（没有 data/、没有 config.json、没有 logs/）
 *   · 换个端口起一个独立实例（不碰正在跑的那个）
 *   · 看它能不能自己把该建的都建出来、面板能不能打开、加号的入口在不在
 *
 * 用 `git archive` 导出跟踪文件，等于精确还原 `git clone` 之后的目录内容 ——
 * 比手工挑文件可靠（手挑容易不小心带上 data/ 让人误判）。
 *
 * 全程只读原仓库，不改任何东西；跑完把临时目录删掉。
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

/*
 * 端口要挑一个**真的空着**的。
 *
 * 一开始我写死 7899 —— 结果那台机器上 7899 被 Clash Verge 的代理核心
 * (`verge-mihomo`) 占着（它监听 `::`，IPv6 通吃），服务一起来就撞端口。
 * EADDRINUSE 那条分支会 `process.exit(1)`，而我的就绪探测只看了 exitCode，
 * 于是一路报"服务起不来"却看不出原因。改成先探一个空闲端口再用。
 */
async function pickFreePort(start = 7911) {
  for (let p = start; p < start + 60; p += 1) {
    const free = await new Promise((resolve) => {
      const srv = createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(p, '127.0.0.1');
    });
    if (free) return p;
  }
  throw new Error('找不到空闲端口');
}

const PORT = await pickFreePort();
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const ok = (m, d) => { pass += 1; console.log(`  ✓ ${m}${d ? `  ${d}` : ''}`); };
const bad = (m, d) => { fail += 1; console.log(`  ✗ ${m}${d ? `  ${d}` : ''}`); };
const note = (m) => console.log(`  · ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ESM 顶层不能 `return`，所以整段包成一个 async 函数，
   早退用 `return` 就行（外面的 finally 照样会清理临时目录）。 */
async function main() {

/* ── 1. 导出「clone 之后的目录」 ─────────────────────────────────── */

console.log('\n【1】模拟 clone：用 git archive 导出跟踪文件到一个干净目录');
const dir = mkdtempSync(path.join(tmpdir(), 'o2a-fresh-'));
try {  // git archive 输出 tar，再解开 —— Windows 上 git 自带 tar 不可靠，
  // 所以直接走 `git archive --format=tar` + 管道给 node 解，太重。
  // 更简单：`git ls-files` 拿到清单，逐个 copy。这样也能顺便验"清单里有什么"。
  // `core.quotepath=false` 是必须的：默认 git 会把非 ASCII 文件名转义成
  // `"docs/\346\212\200..."` 这种八进制形式，照着它 mkdir 会立刻 ENOENT。
  const files = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  for (const f of files) {
    const dst = path.join(dir, f);
    mkdirSync(path.dirname(dst), { recursive: true });
    copyFileSync(path.join(ROOT, f), dst);
  }
  console.log(`    目标目录 ${dir}`);
  console.log(`    拷了 ${files.length} 个跟踪文件`);

  // 关键：确认这个目录里**真的**没有运行期状态 —— 不然这个测试就是假的
  for (const forbidden of ['data', 'config.json', 'logs', 'node_modules']) {
    if (existsSync(path.join(dir, forbidden))) bad(`干净目录里不该有 ${forbidden}`);
    else ok(`干净目录里没有 ${forbidden}（和 clone 之后一致）`);
  }

  /* ── 2. 启动 ───────────────────────────────────────────────────── */

  console.log('\n【2】直接起服务（不用 .cmd，跨平台口径：node src/index.mjs）');
  /*
   * 把「用户目录」也沙箱掉 —— 不然这个测试是假的。
   *
   * 第一次跑就露馅了：新目录里的服务照样发现了 **我这台机器上** 的
   * OfficeAce（`%USERPROFILE%\.office-claw\...`），因为它找凭据时是
   * 从 `home()` 开始找的，而 `home()` 跟着 `USERPROFILE` 走。
   * 那样测出来的"能跑"是蹭了我自己的号，对新用户毫无参考价值。
   *
   * ⚠️ 有个位子沙箱不掉：`discover.mjs` 还会硬扫
   *    `<系统盘>\软件\OfficeAce\.office-claw`、`<安装盘>\OfficeAce\.office-claw`、
   *    `Program Files\...` 这些固定位置（那些路径是写死在代码里的）。
   *    所以在这台装了 OfficeAce 的机器上，**没法完全模拟"什么都没装"** ——
   *    那部分只能靠下面「零凭据时的行为」那几条间接看。
   *    `%USERPROFILE%\.office-claw`（本机那 2 个号的真正来源）是沙箱得掉的。
   */
  const fakeHome = path.join(dir, '_fakehome');
  mkdirSync(fakeHome, { recursive: true });
  const logFile = path.join(dir, 'fresh.log');
  const child = spawn(NODE, ['src/index.mjs'], {
    cwd: dir,
    env: {
      ...process.env,
      OFFICEACE2API_PORT: String(PORT),
      // 用户目录全部指到沙箱里，别让它摸到本机真实的 .office-claw
      USERPROFILE: fakeHome,
      HOME: fakeHome,
      APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'),
      // 别让外部显式指定的路径把它指回真实数据
      OFFICEACE_MODELS_JSON: '',
      OFFICEACE_ROUTING_STATE: '',
      OFFICEACE_INSTALL_DIR: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b.toString('utf8'); });
  child.stderr.on('data', (b) => { out += b.toString('utf8'); });

  const kill = () => { try { child.kill('SIGKILL'); } catch { /* noop */ } };

  try {
    // 等它就绪
    let up = false;
    for (let i = 0; i < 40; i += 1) {
      await sleep(1000);
      try {
        const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(3000) });
        if (r.ok) { up = true; break; }
      } catch { /* 还没起来 */ }
      if (child.exitCode !== null) break;
    }

    if (child.exitCode !== null) {
      bad('服务起不来就退出了', `exit=${child.exitCode}`);
      console.log(`      输出：${out.slice(0, 900)}`);
      return;
    }
    if (!up) {
      bad('等了 40 秒服务还没就绪');
      console.log(`      输出：${out.slice(0, 900)}`);
      return;
    }
    ok('全新目录下服务能起来', `${BASE}/healthz 通了`);

    writeFileSync(logFile, out, 'utf8');

    /* ── 3. 它自己建了该建的东西吗 ───────────────────────────────── */

    console.log('\n【3】首次启动有没有自己把目录和配置建出来');
    for (const f of ['data', 'config.json', 'logs']) {
      if (existsSync(path.join(dir, f))) ok(`自动创建了 ${f}`);
      else bad(`没有自动创建 ${f}`, '新用户会卡在这里');
    }

    if (existsSync(path.join(dir, 'config.json'))) {
      const cfg = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'));
      if (cfg.admin?.token) ok('首次启动自动生成了面板口令', `${cfg.admin.token.slice(0, 4)}…${cfg.admin.token.slice(-4)}`);
      else bad('没有自动生成面板口令', '面板会处于不设防状态');
      if (Array.isArray(cfg.apiKeys) && cfg.apiKeys.length) note(`默认 apiKeys = ${JSON.stringify(cfg.apiKeys)}（新用户该换掉）`);
    }

    /* ── 4. 零凭据状态下服务健不健康 ─────────────────────────────── */

    console.log('\n【4】一个号都没有的时候，服务状态是不是"干净的"（不是崩了一半）');
    const hz = await (await fetch(`${BASE}/healthz`)).json();
    note(`status=${hz.status}  凭据=${hz.credentials}  号=${hz.accountsUsable}/${hz.accounts}  额度=${hz.creditsRemaining}`);
    if (hz.credentials === 0 && hz.accounts === 0) {
      ok('如实报告"零凭据"（没有假装健康，也没有崩）');
    } else {
      note(`这台机器上还能发现到 ${hz.credentials} 条凭据 —— 说明它读到了本机 OfficeAce 的残留`);
    }

    const lm = await fetch(`${BASE}/v1/models`, { headers: { Authorization: 'Bearer sk-officeace' } });
    const lmBody = await lm.json().catch(() => null);
    note(`/v1/models（零凭据时）→ HTTP ${lm.status}${lmBody?.error ? `  ${lmBody.error.code || lmBody.error.message}` : `  ${lmBody?.data?.length} 个`}`);
    if (lm.status === 200 || lm.status === 503 || lm.status === 401) {
      ok('零凭据时的接口行为是可解释的（不是 500 崩栈）');
    } else {
      bad('零凭据时接口行为异常', `HTTP ${lm.status}`);
    }

    /* ── 5. 加号入口在不在（这才是新用户真正要做的事）─────────────── */

    // ⚠️ 这条**不是**"不用装桌面端"：`/admin/api/login/start` 是去问本机桌面端
    //（默认 127.0.0.1:3004）要授权链接的，桌面端没装/没启动就会失败。
    // 早先这里标成"不用装"，把人带沟里过（详见 README 第五章）。
    console.log('\n【5】「自己加自己的号」这条路通不通（要本机 OfficeAce 桌面端在跑）');
    const cfg = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'));
    const T = cfg.admin.token;

    const loginStart = await fetch(`${BASE}/admin/api/login/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': T },
      body: JSON.stringify({ label: '新用户的号', forceLogin: true }),
    });
    const sess = await loginStart.json().catch(() => null);
    if (loginStart.status === 200 && sess?.url) {
      ok('能取到"换个账号登录"的链接（本机桌面端在跑，链接是它给的）');
      const host = (() => { try { return new URL(sess.url).host; } catch { return '?'; } })();
      note(`登录域名 ${host}`);
      note(`回调地址 ${sess.redirectUri || sess.callback || '（未在响应里给出）'}`);
      if (/^(127\.0\.0\.1|localhost)/.test(host)) bad('登录链接指向本机，不像是华为云的登录页', host);
      // 顺手把会话取消掉，别让它挂在 pending
      await fetch(`${BASE}/admin/api/login/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': T },
        body: JSON.stringify({ id: sess.id }),
      }).catch(() => {});
      ok('能取消这个登录会话（不留垃圾）');
    } else {
      bad('取不到登录链接（多半是本机 OfficeAce 桌面端没在跑：127.0.0.1:3004 不通就这样）', `HTTP ${loginStart.status} ${JSON.stringify(sess).slice(0, 200)}`);
    }

    // 有没有"手工导入"这条退路（用户自己已经有 baseUrl + authorization 时）
    if (existsSync(path.join(dir, 'src', 'admin.html'))) {
      const html = readFileSync(path.join(dir, 'src', 'admin.html'), 'utf8');
      if (/admin\/api\/accounts\/import/.test(html)) ok('面板上还有「手工导入」入口（兜底路径）');
      else bad('面板上没有手工导入入口');
      if (/login\/start/.test(html)) ok('面板上「换个账号登录」入口在');
      else bad('面板上没有登录入口', '新用户没法加号');
    }

    /* ── 6. 面板能不能打开 ───────────────────────────────────────── */

    console.log('\n【6】面板能不能打开（新用户第一步就是打开它）');
    const noTok = await fetch(`${BASE}/admin`);
    const withTok = await fetch(`${BASE}/admin?token=${encodeURIComponent(T)}`);
    if (withTok.status === 200) ok('带口令能打开面板');
    else bad('带口令也打不开面板', `HTTP ${withTok.status}`);
    if (noTok.status === 401) ok('不带口令被拦（新装的默认就是安全状态）');
    else note(`不带口令 → HTTP ${noTok.status}（口令为空放行；这里已自动生成，不该放行）`);

    /* ── 7. 启动输出对新用户友不友好 ─────────────────────────────── */

    console.log('\n【7】新用户第一眼看到的启动输出');
    const lines = out.split('\n').filter((l) => l.trim()).slice(0, 22);
    for (const l of lines) console.log(`      ${l}`);
    if (/admin\?token=/.test(out)) ok('启动输出直接给了带 token 的面板地址（不用去翻 config.json）');
    else bad('启动输出没给可点的面板地址');
    if (/面板口令/.test(out)) ok('启动输出里有「面板口令」这一行');
    else bad('启动输出里没说面板口令');

    /* ── 8. .cmd 必须纯 ASCII ──────────────────────────────────── */

    console.log('\n【8】.cmd 启动脚本是不是纯 ASCII');
    /*
     * 这条是被真踩过才加的：我给 start.cmd / status.cmd / open-panel.cmd
     * 加了几行中文注释，结果**脚本直接跑崩**：
     *
     *   '��里改了端口，' is not recognized as an internal or external command
     *   'ait' is not recognized as an internal or external command
     *
     * 原因：cmd.exe 是用 **OEM 代码页**（简中系统是 936/GBK）去读 .cmd 的，
     * 而文件存的是 UTF-8。中文注释的字节被按 GBK 拆成乱七八糟的字符，
     * 其中一些组合还会把 `rem` 那行"撑破"，后面的行被当成新命令。
     * 更坑的是它不报语法错，只报一堆莫名其妙的 "is not recognized"，
     * 看起来像路径问题，其实跟路径无关 —— 我一开始就在这条上绕了两圈。
     *
     * 所以这些 .cmd 一律**只写英文注释**（原文件本来就是，是我改了才出的事）。
     * 给人看的中文放进 README；echo 出去的中文无所谓（echo 不解析，乱码也不影响逻辑）。
     */
    const cmdFiles = readdirSync(dir).filter((f) => f.endsWith('.cmd'));
    const cmdTools = readdirSync(path.join(dir, 'tools')).filter((f) => f.endsWith('.cmd'));
    let nonAscii = 0;
    for (const f of cmdFiles) {
      const n = [...readFileSync(path.join(dir, f))].filter((x) => x > 127).length;
      if (n) { nonAscii += 1; bad(`${f} 含 ${n} 个非 ASCII 字节`, 'cmd.exe 按 GBK 解析会把它当命令'); }
    }
    for (const f of cmdTools) {
      const n = [...readFileSync(path.join(dir, 'tools', f))].filter((x) => x > 127).length;
      if (n) { nonAscii += 1; bad(`tools\\${f} 含 ${n} 个非 ASCII 字节`, 'cmd.exe 按 GBK 解析会把它当命令'); }
    }
    if (nonAscii === 0) ok(`${cmdFiles.length + cmdTools.length} 个 .cmd 全是纯 ASCII（cmd.exe 读得动）`);

    /* ── 9. 启动器里没有写死的面板地址 ─────────────────────────── */

    console.log('\n【9】启动脚本里的面板地址是不是现算的（写死会 401）');
    let hardStart = 0;
    for (const f of cmdFiles) {
      const txt = readFileSync(path.join(dir, f), 'utf8');
      if (/start\s+""\s+"http:\/\/127\.0\.0\.1:7864\/admin"/.test(txt)) {
        hardStart += 1;
        bad(`${f} 里写死打开了裸 /admin`, '面板要口令，这样点开就是 401');
      }
    }
    if (hardStart === 0) ok('没有哪个 .cmd 写死裸 /admin');
    if (existsSync(path.join(dir, 'tools', 'admin-url.mjs'))) {
      ok('有 tools\\admin-url.mjs（地址和口令都现算）');
      if (existsSync(path.join(dir, 'open-panel.cmd'))
        && /admin-url\.mjs/.test(readFileSync(path.join(dir, 'open-panel.cmd'), 'utf8'))) {
        ok('open-panel.cmd 走的是现算那条路');
      } else {
        bad('open-panel.cmd 没用 admin-url.mjs');
      }
      // 现算出来的那个中间文件里是**明文口令**，必须落在被忽略的 data/ 下
      const varsInTools = existsSync(path.join(dir, 'tools', 'admin-url.vars.cmd'));
      if (!varsInTools) ok('中间文件没有落在 tools/（tools/ 是会提交的）');
      else bad('含明文口令的中间文件落在 tools/ 下了', '会被 git 收进去');
      // 模拟它真的被生成一次，确认 data/ 兜得住
      execFileSync(NODE, [path.join(dir, 'tools', 'admin-url.mjs'), '--cmd'], { cwd: dir });
      if (existsSync(path.join(dir, 'data', 'admin-url.vars.cmd'))) ok('生成物落在 data\\ 下（已被 .gitignore 挡住）');
      else bad('没生成 data\\admin-url.vars.cmd');
    } else {
      bad('缺 tools\\admin-url.mjs');
    }
  } finally {
    kill();
  }
} finally {
  await sleep(800);
  try { rmSync(dir, { recursive: true, force: true }); console.log(`\n  临时目录已清理`); } catch { /* noop */ }
}
}

await main();
console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══\n`);
process.exit(fail ? 1 : 0);
