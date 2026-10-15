/**
 * 「删掉的号还能继续发请求」这个 bug 的补丁层。
 *
 * 号池（AccountStore）和扫盘发现（discover.discover）是**两套互不相干的读盘逻辑**：
 *
 *   - 号池读的是 `~/.office-claw/.../routing_state/users/<id>/models.json`、
 *     安装目录里的加密 OAuth 档案、`users/<id>/model.json` —— 这三处在
 *     accounts.mjs 里被 `ensure()` 统一管着，`ignored` 名单就是在那里生效的。
 *   - `discover()` 是**另写一遍**的：它自己遍历同一批 models.json，把
 *     `custom_headers.Authorization` 抠出来当凭据，且**完全不知道 `ignored` 名单存在**。
 *
 * index.mjs 的 runDiscovery() 会把 discover() 的结果当作 `legacy` 凭据再补进连接池，
 * 于是「删除」只从面板和号池里消失了，凭据仍然躺在连接池里正常收发请求 ——
 * 用户看到的现象就是：**号明明删了，服务还在拿它算钱、积分也一直在动**。
 *
 * 修法：在凭据进池前统一过一遍这张名单（ID 的三种写法都要认，
 * 号池里的 id 是 `<accountId>:<userId>`，discover() 给的是目录名解出来的
 * `<accountId>:<userId>` 或者单独的 `<accountId>`）。
 */

/** 归一化账号 ID：目录名可能是 URL 编码过的 */
function normalizeAccountId(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 把面板上的忽略名单摊平成一堆可比对的 ID（全 ID / accountId / userId） */
export function buildIgnoredIdSet(ids = []) {
  const set = new Set();
  for (const raw of ids) {
    const id = normalizeAccountId(raw);
    if (!id) continue;
    set.add(id);
    const [accountId, userId] = id.split(':');
    if (accountId) set.add(accountId);
    if (userId) set.add(userId);
  }
  return set;
}

/** 这条凭据属于被忽略（删掉）的号吗？ */
export function isIgnoredCredential(cred, ignoredIds) {
  if (!cred || !ignoredIds || ignoredIds.size === 0) return false;
  const candidates = [cred.userId, cred.accountId, cred.id];
  for (const c of candidates) {
    const id = normalizeAccountId(c);
    if (!id) continue;
    if (ignoredIds.has(id)) return true;
    const [accountId, userId] = id.split(':');
    if (accountId && ignoredIds.has(accountId)) return true;
    if (userId && ignoredIds.has(userId)) return true;
  }
  return false;
}

/**
 * 被忽略名单拦下的那批凭据的「签名」—— 变了才值得说一句。
 *
 * ⚠️ 签名**必须带条数前缀**。凭据对象上没有稳定主键：`discover()` 返回的是
 * `id / userId / baseUrl / headers / ...`，`key` 是进连接池时才算出来的（池外
 * 的那份对象根本没有这个字段）。所以只拼标识的话，「拦下 1 条、且标识取不到」
 * 会拼出一个**空串** —— 而空串正好等于「还没说过话」的初始状态，于是第一句
 * 永远打不出来。真踩过：启动时那条「忽略名单拦下已删除账号的凭据」直接消失，
 * 看着像保护没生效（实际拦下了，只是没说）。
 *
 * 带上条数前缀之后，空标识也拼不出空串。
 */
export function ignoredSignature(creds = []) {
  const ids = (creds || [])
    .map((c) => c?.userId || c?.accountId || c?.id || String(c?.baseUrl || ''))
    .sort();
  return `${ids.length}|${ids.join(',')}`;
}
