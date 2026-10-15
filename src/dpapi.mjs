/**
 * Windows DPAPI 解密
 *
 * OfficeAce 把安装密钥和 OAuth 账号档案加密落盘，文件格式是：
 *   OC-DPAPI-1
 *   <base64 的 DPAPI blob>
 *
 * Node 没有内置 DPAPI，这里借一次 PowerShell 调
 * System.Security.Cryptography.ProtectedData（CurrentUser 作用域，只有同一个
 * Windows 用户能解），进程内缓存结果，避免每次扫盘都起子进程。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createLogger } from './logger.mjs';

const log = createLogger('dpapi');

export const DPAPI_HEADER = 'OC-DPAPI-1';

const cache = new Map();

// ⚠️ 这里以前是一个一置就再也下不来的 `unavailable` 布尔值：
// 任何一次失败（一个截断的 blob、一次 20 秒超时、PowerShell 被策略拦、
// 从别的 Windows 用户那儿拷过来的档案）都会把整个进程的 DPAPI 通道
// 永久置为不可用 —— 之后**所有**账号档案（包括安装密钥）
// 全都读不出来，而且没有任何地方会去重置它。
//
// 现在改成「连续失败计数 + 冷却」：偶尔一个坏 blob 不影响别的档案，
// 真的是通道坏了也会在冷却后自己重试，不会一路坏到进程结束。
const FAIL_STREAK_LIMIT = 3;
const FAIL_COOLDOWN_MS = 60_000;
let failStreak = 0;
let lastFailAt = 0;

/** DPAPI 通道是否处于「暂时别试了」的状态 */
function temporarilyUnavailable() {
  if (failStreak < FAIL_STREAK_LIMIT) return false;
  if (Date.now() - lastFailAt >= FAIL_COOLDOWN_MS) {
    failStreak = 0; // 冷却结束，给它一次机会
    return false;
  }
  return true;
}

function psExe() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/**
 * 解密一个 base64 的 DPAPI blob，返回 Buffer；失败抛错。
 */
export function dpapiUnprotect(base64) {
  if (cache.has(base64)) return cache.get(base64);
  const script = [
    // 子进程的报错默认按控制台 OEM 编码（这机器上是 GBK）写出来，直接透出来就是乱码。
    // 先把它钉成 UTF-8，失败信息才读得懂 —— 这条链坏掉时，你手上只有这一行错误。
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8;',
    'Add-Type -AssemblyName System.Security;',
    '$b=[Convert]::FromBase64String($env:OC_DPAPI_B64);',
    '$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,',
    '[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
    '[Console]::Out.Write([Convert]::ToBase64String($p))',
  ].join('');
  // ⚠️ 这里用 spawnSync 而不是 execFileSync：`execFileSync` 在没指定 `stdio` 时
  // **stderr 是继承父进程的**，于是 PowerShell 的原始报错会绕过 logger 直接漏进服务的
  // stderr（`logs\server.err.log` 里那行读不懂的乱码就是它）。三股流全管起来之后：
  // 只认 stdout，stderr 收进异常信息里 —— 失败原因既看得见，也继续归 logger 管。
  const r = spawnSync(psExe(), ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, OC_DPAPI_B64: base64 },
    windowsHide: true,
    timeout: 20000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const hint = String(r.stderr || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error(`DPAPI 子进程退出码 ${r.status}${hint ? `：${hint}` : ''}`);
  }
  const out = String(r.stdout || '').trim();
  if (!out) throw new Error('DPAPI 返回空结果');
  const buf = Buffer.from(out, 'base64');
  cache.set(base64, buf);
  failStreak = 0; // 成功一次就清零
  return buf;
}

/**
 * 读一个 OfficeAce 的 OC-DPAPI-1 文件；不是该格式就当明文返回。
 * 解不开时返回 null，由调用方降级处理。
 */
export function readProtectedText(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return null;
  if (lines[0].trim() !== DPAPI_HEADER) return lines.join('\n');

  if (temporarilyUnavailable()) return null;
  try {
    return dpapiUnprotect(lines.slice(1).join('')).toString('utf8');
  } catch (err) {
    failStreak += 1;
    lastFailAt = Date.now();
    log.warn('DPAPI 解密失败', {
      error: String(err.message || err).slice(0, 200),
      file: file.split(/[\\/]/).pop(),
      streak: failStreak,
      giveUpForMs: failStreak >= FAIL_STREAK_LIMIT ? FAIL_COOLDOWN_MS : 0,
    });
    return null;
  }
}

/** 供面板展示：DPAPI 通道是否可用 */
export function dpapiStatus() {
  return {
    available: !temporarilyUnavailable(),
    cached: cache.size,
    failStreak,
  };
}

