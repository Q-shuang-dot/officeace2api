/**
 * 测试/工具脚本共用的「面板口令」解析。
 *
 * 背景：`config.admin.token` 默认是空字符串，而路由里那条校验是
 *   if (isAdminRoute && config.admin?.token && ...)
 * —— **口令为空就等于完全不校验**。所以以前所有工具都能裸打 `/admin/api/*`。
 *
 * 现在服务第一次启动会自动生成一个口令（见 `config.mjs` 的 `ensureAdminToken`），
 * 空口令那条路就没了。工具要是还裸打，会集体 401。
 *
 * 解析顺序（先给显式指定的最高优先）：
 *   ① `O2A_ADMIN_TOKEN` 环境变量
 *   ② `ADMIN_TOKEN` 环境变量（短名字，方便手敲）
 *   ③ 仓库根的 `config.json` 里的 `admin.token`
 *
 * 都拿不到就返回空字符串 —— 这时请求头不会带 `x-admin-token`，
 * 在"口令为空"的老配置下照样能用，在"口令已设"的配置下会明确地 401
 * （好过静默用一个错的头）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根：这个文件在 tools/ 下面，往上一层就是根 */
export const ROOT = path.resolve(HERE, '..');

let cache = null;
let cachedFrom = null;

export function resolveAdminToken() {
  const env = process.env.O2A_ADMIN_TOKEN || process.env.ADMIN_TOKEN;
  if (env) return String(env).trim();
  if (cache !== null && cachedFrom === 'config.json') return cache;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    cache = String(cfg?.admin?.token || '');
    cachedFrom = 'config.json';
    return cache;
  } catch {
    cache = '';
    cachedFrom = 'config.json';
    return '';
  }
}

/** 面板接口要带的头。口令为空时不带这个键（保持和以前一样）。 */
export function adminHeaders(extra = {}) {
  const t = resolveAdminToken();
  return { ...(t ? { 'x-admin-token': t } : {}), ...extra };
}

/** 一次性打印当前用的是哪个口令（只打前后几位，别把口令打进日志） */
export function describeAdminToken() {
  const t = resolveAdminToken();
  if (!t) return '（空 —— 服务若已设口令，管理接口会回 401）';
  return `${t.slice(0, 4)}…${t.slice(-4)}（${t.length} 位）`;
}
