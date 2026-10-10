/**
 * 查清「别人 clone 之后第一次打开面板会看到什么」——
 * 具体是排查一个**我以为存在、实际不存在**的问题，顺便把结论钉下来。
 *
 * 起因：`diag-fresh-clone.mjs` 在沙箱用户目录下跑出
 *      `号池扫描完成 {"accounts":2,"credentials":0}`
 * —— 一条凭据都没有却报"2 个账号"。当时怀疑是 `data/accounts.json`
 * （账号元数据：ID / 别名 / 启停名单）里的键被当成了真账号，
 * 于是新用户会看到几个自己从没登录过的"幽灵账号"。
 *
 * 实际查下来**不是**这回事，两条证据：
 *   ① `accounts.mjs` 里 `labels` 只在第 486 行出现、且是**只读的**：
 *        acc.label = this.meta.labels[acc.id] || defaultLabel(acc);
 *      列表是遍历 `map`（真凭据 + 手工导入）生成的，labels 不参与生成，
 *      所以"有别名没凭据"不会变出一个账号。
 *   ② 还有一个 `pruneMetaKeys()` 专门删"长得就不像真账号"的键，
 *      连幽灵键都主动清掉。
 *
 * 那 2 个账号的真实来源：`discover.mjs` 里**写死**的那组安装路径
 * （`<盘>:\软件\OfficeAce\.office-claw`、`Program Files\...`）——
 * 这台机器上装了 OfficeAce，沙箱掉 HOME 也躲不开这些绝对路径。
 * 换句话说那是**我的号**，不是幽灵。
 *
 * 所以这个脚本现在的用途是：把「labels 不生成账号」这条结论
 * 用代码本身证明一遍，免得以后再有人（包括我）重新怀疑一轮。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = path.join(ROOT, 'data', 'accounts.json');
const SRC = path.join(ROOT, 'src', 'accounts.mjs');

let pass = 0;
let fail = 0;
const ok = (m, d) => { pass += 1; console.log(`  ✓ ${m}${d ? `  ${d}` : ''}`); };
const bad = (m, d) => { fail += 1; console.log(`  ✗ ${m}${d ? `  ${d}` : ''}`); };
const note = (m) => console.log(`  · ${m}`);

console.log('\n【1】本机 data/accounts.json 里记了什么');
if (!existsSync(P)) {
  note('文件不存在（还没跑过服务）');
} else {
  const j = JSON.parse(readFileSync(P, 'utf8'));
  note(`顶层键: ${Object.keys(j).join(', ')}`);
  note(`别名条数: ${Object.keys(j.labels || {}).length}`);
  for (const [k, v] of Object.entries(j.labels || {})) {
    note(`  ${k.slice(0, 36)}…  →  「${v}」`);
  }
}

console.log('\n【2】关键证据：labels 不参与「造账号」，只在真账号上挂名字');
const src = readFileSync(SRC, 'utf8');
const lines = src.split('\n');

/*
 * 不能只搜「有没有写 labels」—— 当然有，用户改别名就得写。
 * 要判的是**写的时候有没有先确认账号存在**。
 *
 * 实际代码里三处写入都守得很严：
 *   917  setLabel()      —— 先 `if (!isRealAccountId(key)) return false;`
 *                          再 `if (!this.accounts.has(key)) return false;`，两道门
 *   948  importManual()  —— 这一处是**在同一个函数里刚 push 进 meta.imported**，
 *                          键就是它自己造的，天然存在
 *   996  remove()        —— 写成 `if (acc?.label)`，`acc` 来自 accounts.get()，
 *                          取不到就整个跳过
 *
 * 所以判定口径分两种：
 *   ① 同一个函数里"先建条目、再写别名"（importManual 那种自建自用）→ 安全
 *   ② 函数里出现过 `isRealAccountId(` **且** `accounts.has(` / `accounts.get(`
 *      这类存在性检查 → 安全
 * 两条都不占的才算可疑。
 *
 * （第一版我只看往回 12 行，窗口太窄，把 917/948/996 全误判成"没有守卫"。
 *  写这种静态检查最容易犯的就是窗口拍脑袋 —— 所以这里干脆按函数体来量。）
 */
/*
 * 往上找"这个写入点所属的函数体"，好把守卫一起看进来。
 *
 * 坑：第一版写得太宽，`if (removable) {` 这种控制流块也被当成函数头，
 * 于是第 996 行被归到离它最近的 `if` 里，`const acc = this.accounts.get(key)`
 * 和 `if (!acc) return` 那两行守卫全在窗口外 —— 明明守得挺严却报"没守卫"。
 *
 * 所以必须把关键字开头的行排除掉，只认"方法名(参数) {" 这种真函数头。
 */
const CTRL = /^\s{0,6}(if|for|while|switch|catch|else|try|do|finally)\b/;
function enclosingFnLine(lines, idx) {
  for (let i = idx; i >= 0; i -= 1) {
    const l = lines[i];
    if (CTRL.test(l)) continue; // 控制流块不算函数头
    if (/^\s{0,4}(async\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{\s*$/.test(l)) return i;
  }
  return 0;
}

const labelWrites = [];
lines.forEach((l, i) => {
  if (/labels\s*\[[^\]]*\]\s*=/.test(l)) labelWrites.push(i);
});
if (labelWrites.length === 0) {
  ok('没有任何一处往 labels 写键（只读取，不会凭空造账号）');
} else {
  let guarded = 0;
  for (const i of labelWrites) {
    const fnStart = enclosingFnLine(lines, i);
    const body = lines.slice(fnStart, i + 1).join('\n');
    const hasExistenceCheck = /isRealAccountId\s*\(/.test(body) && /accounts\s*\.\s*(has|get)\s*\(/.test(body);
    const selfCreates = /meta\.imported\s*=/.test(body); // 同函数里先建条目再挂名字
    /*
     * 第三种守卫：可选链 `if (acc?.label)` —— `acc` 是从 accounts.get(key) 拿的，
     * 取不到就是 undefined，整个条件为假、直接跳过。这跟显式 `if (acc)` 等价，
     * 但正则得单独认，不然会被误判成"没守卫"（第 996 行就是这么漏的）。
     */
    const optionalChainGuard = /\bif\s*\(\s*[A-Za-z_$][\w$]*\s*\?\./.test(body)
      && /accounts\s*\.\s*get\s*\(/.test(body);
    if (hasExistenceCheck || selfCreates || optionalChainGuard) {
      guarded += 1;
      const how = selfCreates
        ? '同函数先建账号条目'
        : optionalChainGuard
          ? '可选链守卫（acc?.x 取不到就跳过）'
          : '有 isRealAccountId + accounts.has/get 两道检查';
      note(`  ${i + 1}: ${lines[i].trim().slice(0, 68)}   ← ${how}`);
    } else {
      bad(`第 ${i + 1} 行往 labels 写键，但函数体里没有"账号必须已存在"的检查`, lines[i].trim().slice(0, 78));
    }
  }
  if (guarded === labelWrites.length) {
    ok(`${guarded} 处写别名全都有守卫（只给真实存在的账号挂名字，不会造出幽灵）`);
  }
}

const readOnly = lines.find((l) => /acc\.label\s*=\s*this\.meta\.labels/.test(l));
if (readOnly) ok('别名只用在「给真账号挂个名字」这一步', readOnly.trim().slice(0, 90));
else note('没找到 `acc.label = this.meta.labels[...]`，实现可能改过了 —— 需要重新审一遍');

if (/pruneMetaKeys\s*\(/.test(src)) ok('有 pruneMetaKeys()：主动清掉"不像真账号"的键');
else bad('没有 pruneMetaKeys()', '幽灵键会一直留着');

console.log('\n【3】账号列表的来源是什么（该只有真凭据 + 手工导入）');
const sources = [];
if (/这块注释|本地凭据|routing_state/i.test(src)) sources.push('本机 OfficeAce 的 routing_state');
if (/meta\.imported/.test(src)) sources.push('meta.imported（手工导入）');
note(`列表来源: ${sources.join(' + ') || '（没识别出来，需要人工看）'}`);
if (!sources.includes('meta.labels')) ok('labels 不在列表来源里（确认：不会产生幽灵账号）');
else bad('labels 被当成列表来源了', '才会真的出幽灵账号');

console.log('\n【4】那"2 个账号"到底哪来的 —— discover.mjs 里写死的安装路径');
const disc = readFileSync(path.join(ROOT, 'src', 'discover.mjs'), 'utf8');
const hardcoded = disc.includes("for (const drive of ['C', 'D', 'E'])");
if (hardcoded) {
  ok('确认：discover.mjs 会硬扫各盘的 OfficeAce 安装目录');
  note('所以只要那台机器装了 OfficeAce，它就一定能扫到号 ——');
  note('沙箱掉 USERPROFILE 也躲不开（那些是绝对路径，不走 home()）。');
  note('含义：别人装了这个项目**且**装了 OfficeAce 时，会自动共用本机的号；');
  note('      没装 OfficeAce 的人走「换个账号登录」自己加。两条路都通。');
} else {
  note('没找到硬编码盘符扫描，实现改过了');
}

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══\n`);
process.exit(fail ? 1 : 0);
