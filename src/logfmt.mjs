/**
 * 对话日志的一行式格式。
 *
 * 目标长这样（字段顺序固定，缺的字段用 `-`）：
 *
 *   #909 15:18:25 deepseek-v4.1-flash | stream | 200 | GT-shuanghsuang(148c97d7) |
 *   TTFB=1947ms | tok=230 | 61.5tok/s | effort=- | total=5.7s | src=::1 ua="deepseek-harness/0.2.0"
 *
 * 为什么不用 JSON：这行是给人扫的。一屏能看到 30 多个请求的"谁、多快、多少 token"，
 * 而 JSON 一屏只有 8 个，还得逐个找字段。机器可读的数据本来就有另一份去处
 * （`usage.record()` 落进统计，面板「用量」页在读它），不必让日志兼任数据库。
 *
 * 几个刻意的处理：
 *  · `TTFB` / `tok` / `tok/s` 算不出来时写 `-`，**不写 0**。0 会被读成"很快"或"没有输出"，
 *    而实际是"没测到"，两者含义完全不同。
 *  · `tok` 只算输出 token（`completion_tokens`）。提示词动辄十万，混进去会让 `tok/s` 虚高。
 *  · `ua` 里的引号、换行、控制字符一律清掉，长度封顶 —— 日志是一行一世界的格式，
 *    一个带换行的 UA 就能把后面几十行搅乱。
 *  · `src` 去掉 IPv4 映射前缀（`::ffff:127.0.0.1` → `127.0.0.1`），否则本机请求看着像 IPv6。
 */

/** 本机时间 HH:MM:SS（和日志前缀同一个时区，别用 toISOString） */
export function hhmmss(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 缺值统一写 `-`，别写 0 / null / undefined */
function dash(v) {
  if (v === null || v === undefined || v === '') return '-';
  return v;
}

/** 精确到 0.1 的数字，整数也带一位小数（`61.5` / `358.0`）。null/undefined 必须返回 null ——
 *  直接 `Number(null)` 会得到 0，于是非流式请求会打出 `tok/s=0.0`，看着像"慢得没动"。 */
function oneDecimal(n) {
  if (n === null || n === undefined || n === '') return null;
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  return (Math.round(num * 10) / 10).toFixed(1);
}

/** 毫秒 → `5.7s`；不足 1 秒给 `680ms`，免得满屏 `0.7s` 这种不直观的值。同样的 null 陷阱。 */
function humanMs(ms) {
  if (ms === null || ms === undefined || ms === '') return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

/** 账号短标识：`accountId:userId` 取前 8 位，和面板里 `short` 一致 */
export function shortAccount(accountId) {
  const s = String(accountId || '').split(':')[0].trim();
  return s ? s.slice(0, 8) : '';
}

/** 清掉会破坏单行结构的字符，并封顶长度 */
function cleanUa(ua, max = 64) {
  const s = String(ua || '')
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/"/g, "'")
    .trim();
  if (!s) return '-';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** `::ffff:127.0.0.1` → `127.0.0.1`；`::1` 保持原样 */
export function cleanIp(ip) {
  const s = String(ip || '').trim();
  if (!s) return '-';
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

/**
 * 组装对话日志行。
 *
 * @param {object} f
 * @param {number} [f.seq]        请求序号（进程内自增，重启归零）
 * @param {number} f.startedAt    请求进来的时刻
 * @param {string} f.model        模型名
 * @param {boolean} f.stream      是否流式
 * @param {number} [f.status]     HTTP 状态
 * @param {string} [f.label]      账号备注名
 * @param {string} [f.accountId]  账号 id（含 `:userId`）
 * @param {number} [f.ttfbMs]     首字节延迟
 * @param {number} [f.outTokens]  输出 token
 * @param {number} [f.tps]        输出 token / 秒
 * @param {string} [f.effort]     推理强度（请求里带的那个，没带就是 `-`）
 * @param {number} f.totalMs      总耗时
 * @param {string} [f.src]        客户端 IP
 * @param {string} [f.ua]         客户端 User-Agent
 * @param {number} [f.attempt]    第几次尝试（>1 时才追加 `try=N`）
 * @returns {string}
 */
export function formatChatLine(f = {}) {
  const parts = [];

  if (Number.isFinite(Number(f.seq)) && Number(f.seq) > 0) parts.push(`#${Number(f.seq)}`);
  parts.push(hhmmss(f.startedAt));
  parts.push(String(dash(f.model)));

  const seg = [
    f.stream === true ? 'stream' : 'json',
    String(dash(f.status)),
  ];

  const short = shortAccount(f.accountId);
  const who = short ? (f.label ? `${f.label}(${short})` : `(${short})`) : '-';
  seg.push(who);

  const ttfb = humanMs(f.ttfbMs);
  seg.push(`TTFB=${ttfb === null ? '-' : ttfb}`);

  const outTok = Number(f.outTokens);
  seg.push(`tok=${Number.isFinite(outTok) && outTok > 0 ? outTok : '-'}`);

  const tps = oneDecimal(f.tps);
  seg.push(`tok/s=${tps === null ? '-' : `${tps}`}`);

  const effort = String(f.effort ?? '').trim();
  seg.push(`effort=${effort || '-'}`);

  const total = humanMs(f.totalMs);
  seg.push(`total=${total === null ? '-' : total}`);

  // 只有重试过才显示，正常请求保持干净
  const attempt = Number(f.attempt);
  if (Number.isFinite(attempt) && attempt > 1) seg.push(`try=${attempt}`);

  // `src=` 和 `ua=` 是**同一段**里的两个键：用空格分隔，不是两个 `|` 段。
  // 一开始我把它俩各推一段，日志里就变成 `| src=::1 | ua="..."`，扫读时多一个竖线。
  seg.push(`src=${cleanIp(f.src)} ua="${cleanUa(f.ua)}"`);

  return `${parts.join(' ')} | ${seg.join(' | ')}`;
}
