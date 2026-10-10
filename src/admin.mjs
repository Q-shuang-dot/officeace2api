/**
 * 管理面板：HTML 从同目录的 admin.html 读取
 *
 * 每次请求都看一下 mtime，改了文件刷新浏览器即可生效，不用重启服务。
 */

import fs from 'node:fs';

const FILE = new URL('./admin.html', import.meta.url);
let cache = { mtime: 0, html: '' };

const FALLBACK = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>officeace2api</title><style>body{background:#0e1013;color:#e7eaf0;font:14px "Microsoft YaHei",sans-serif;padding:40px}
code,pre{font-family:Consolas,monospace;background:#15181e;border:1px solid #252a35;border-radius:8px;padding:3px 7px;display:inline-block}
pre{padding:12px;display:block;white-space:pre-wrap}</style></head><body>
<h2>面板页面文件缺失</h2>
<p>请确认 <code>src/admin.html</code> 存在。服务本身不受影响，接口仍可用：</p>
<pre>GET  /healthz
GET  /v1/models
POST /v1/chat/completions
GET  /admin/api/state</pre>
</body></html>`;

export function adminHtml() {
  try {
    const stat = fs.statSync(FILE);
    if (stat.mtimeMs !== cache.mtime) {
      cache = { mtime: stat.mtimeMs, html: fs.readFileSync(FILE, 'utf8') };
    }
    return cache.html;
  } catch {
    return FALLBACK;
  }
}
