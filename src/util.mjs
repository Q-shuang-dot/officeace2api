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

export function shortId(id, len = 10) {
  const s = String(id || '');
  return s.length > len ? `${s.slice(0, len)}…` : s;
}

export function maskSecret(secret) {
  const s = String(secret || '');
  if (s.length <= 12) return '***';
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

export function randId(prefix = 'chatcmpl') {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}
