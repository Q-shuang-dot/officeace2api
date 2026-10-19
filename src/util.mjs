import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export function trimSlash(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

/**
 * 原子写：先写同目录下的临时文件，fsync 之后 rename 覆盖。
 *
 * 为什么不能直接 writeFileSync：那是原地截断再写。写到一半断电 / 进程被杀 /
 * 杀软锁文件，留下的就是半截 JSON；而读取方基本都「解析失败按空处理」，
 * 下一次保存就把整份状态（refresh_token 链、可用凭据）覆盖没了。
 *
 * rename 在同一分区上是原子的：读到的要么是完整旧内容，要么是完整新内容。
 */
export function writeFileAtomic(file, data, { mode = 0o600 } = {}) {
  // 空路径直接报错，别在 `path.dirname('')` 的怪结果上继续 ——
  // 那会造出一个名字像 `..32716.tmp` 的孤儿文件，而抛出来的错误却是
  // `rename '..32716.tmp' -> ''`，完全看不出是谁干的。
  if (!file) throw new Error('writeFileAtomic 需要一个真实路径');
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd); // 先落盘，再让它顶上，避免断电后留下个空文件
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 清不掉就算了 */ }
    throw err;
  }
  return file;
}

/**
 * 把文件权限收紧到「只有当前用户」。
 *
 * 别指望 writeFileSync 的 mode: 0o600 —— **Windows 直接忽略 POSIX mode**
 * （只映射只读位），而且 mode 只在「创建」时生效，覆盖已有文件不会重新收紧。
 * 实测 icacls data\refresh-state.json 是：
 *     NT AUTHORITY\Authenticated Users:(I)(M)   ← 能改
 *     BUILTIN\Users:(I)(RX)                     ← 能读
 * 而文件里是明文 refresh_token、secretAccessKey、securityToken、DPoP 私钥。
 * 所以 Windows 上额外用 icacls 摘掉继承、只授权自己。
 */
export function lockDownFile(file) {
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); return true; } catch { return false; }
  }
  const domain = process.env.USERDOMAIN;
  const user = process.env.USERNAME;
  if (!user) return false;
  // 先试「域\用户名」，不行再试裸用户名（本地账号两种写法都可能认）
  const candidates = [...new Set([domain ? `${domain}\\${user}` : null, user].filter(Boolean))];
  for (const who of candidates) {
    try {
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${who}:F`], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 15000,
      });
      return true;
    } catch {
      /* 换一种写法再试 */
    }
  }
  return false;
}

/** 写盘 + 收紧权限，一步到位 */
export function writeFileSecure(file, data, { mode = 0o600 } = {}) {
  writeFileAtomic(file, data, { mode });
  lockDownFile(file);
  return file;
}

export function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function readJson(file) {
  try {
    return safeJson(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function listDirs(parent) {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(parent, d.name));
  } catch {
    return [];
  }
}

export function home() {
  return process.env.OFFICEACE_HOME || os.homedir();
}

export function maskSecret(secret) {
  const s = String(secret || '');
  if (s.length <= 12) return '***';
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

/**
 * 从「越攒越多」的备份里挑出该删的那些（纯函数，便于测）。
 *
 * 两处在用：导入前的 `data/import-backup-<时间>/` 快照、导出时的 `accounts-backup/*.json`。
 * 两者都是**含明文凭据的副本** —— 攒着不删等于同一个号在盘上多躺几份，而且没人会记得清。
 * 做法和日志滚动一致：留最新的几份（默认 3）。
 *
 * 按 mtime 排，不解析文件名里的时间戳：文件名格式改过（`-locked` 后缀、机器名里带横线），
 * 解析容易出错，而 mtime 永远是真实年龄。
 *
 * @param {{name:string, mtimeMs:number}[]} entries
 * @param {number} keep 保留最新的几份
 * @returns {string[]} 要删的 name，**最老的在前**（打印出来更好读）
 */
export function pickStaleEntries(entries, keep = 3) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.name)
    .map((e) => ({ name: String(e.name), mtimeMs: Number(e.mtimeMs) || 0 }));
  // 新的在前；mtime 相同（同秒内两次操作）时按名字倒序，让时间戳大的那份排前面
  list.sort((a, b) => b.mtimeMs - a.mtimeMs || String(b.name).localeCompare(String(a.name)));
  return list.slice(Math.max(0, Number(keep) || 0)).map((e) => e.name).reverse();
}

export function randId(prefix = 'chatcmpl') {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/**
 * 该不该替用户把文件在资源管理器里"选中"？（纯函数，便于测）
 *
 * `tools/export-accounts.mjs` 在 Windows 上默认会弹一下资源管理器，省得双击的用户
 * 自己找路径 —— 这是好事。但只在**有人看着**的时候才是好事：
 *
 *   · 用脚本/计划任务/测试跑它时（stdout 不是终端），弹出来的窗口没人管；
 *     更糟的是自动化场景里那个目录常常马上就被删掉，资源管理器会弹一个
 *     「位置不可用 —— 如果该位置位于这台电脑上…」的报错框，看起来像程序坏了。
 *     实测就是这么被用户截图问上来的：用例在临时目录里跑完 export 顺手删了目录。
 *   · 所以：非交互环境默认不弹，除非用户明确 `--open`。
 *
 * @param {{explicitOpen?:boolean, explicitNo?:boolean, platform?:string, isTTY?:boolean, env?:object}} o
 */
export function shouldRevealInExplorer({
  explicitOpen = false,
  explicitNo = false,
  platform = process.platform,
  isTTY = false,
  env = process.env,
} = {}) {
  if (explicitNo) return false; // --no-open 一票否决
  if (String(env?.O2A_NO_OPEN || '') === '1') return false; // 脚本里常这么统一关掉
  if (explicitOpen) return true; // 明确点名要看，管道里也照看
  return platform === 'win32' && isTTY === true;
}

/* ---------------------------------------------------------- 「要不要扫这台机器」 */

/**
 * 「去不去读本机 OfficeAce 的凭据」的总开关，对应 `config.discover.enabled`（默认开）。
 *
 * 为什么需要它 —— 原先只有 `upstream.autoDiscover: false`，而它**只关掉定时重扫**，
 * 启动扫描照跑。于是：
 *   · 想把这项目当通用 OpenAI 反代用的人，本机装过 OfficeAce 的话，那些账号会被
 *     悄悄捞进号池（他本来就没打算用它们）；
 *   · 写测试时也没法隔离 —— 临时实例照样读得到本机真实账号，甚至会替它们续期，
 *     那是在动用户的真凭据（实测踩到过：临时实例扫到 3 个真号）。
 *
 * 开关放在这里而不是各模块各存一份，是因为 `accounts.mjs`（号池扫盘）和
 * `discover.mjs`（另一套读盘逻辑）必须认同一个值，两份状态迟早会漂。
 *
 * 关掉之后：`~/.office-claw`、各盘 `<盘>:\软件\OfficeAce\.office-claw`、
 * `OFFICEACE_INSTALL_DIR` 一律不再读；`data/oauth-accounts.json` 里自己登进来的
 * 账号、手工导入的账号、手工上游照旧工作。
 */
let machineScanEnabled = true;

/** @param {boolean} on 传 false = 不再扫描本机 */
export function setMachineScanEnabled(on) {
  machineScanEnabled = on !== false;
}

export function isMachineScanEnabled() {
  return machineScanEnabled;
}
