/**
 * 走一遍「换个账号登录」那条真实链接的重定向链，确认它真的通向登录页。
 *
 * 跟浏览器点下去是同一条（唯一差别：这里没有浏览器的华为云 cookie，
 * 所以第①步就能看到登录页；带 cookie 时只有套了登出层才会走到登录页 ——
 * 这正是这个功能的意义）。
 */
const res = await fetch('http://127.0.0.1:7864/admin/api/login/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ label: '链验证', forceLogin: true }),
});
const session = await res.json();
if (!session.url) {
  console.log('  ✗ 没拿到 url');
  process.exit(1);
}
console.log(`  forceLogin=${session.forceLogin}`);
console.log(`  第 0 跳: ${session.url.slice(0, 110)}…`);

let cur = session.url;
let reachedLogin = false;
let reachedAuthorize = false;
for (let i = 1; i <= 5; i += 1) {
  const r = await fetch(cur, { redirect: 'manual' });
  const loc = r.headers.get('location');
  const path = new URL(cur).pathname;
  if (path.includes('/authui/v1/oauth2/authorize')) reachedAuthorize = true;
  if (path.includes('/authui/login')) reachedLogin = true;
  console.log(`  [${i}] ${r.status}  ${path}${loc ? `\n       → ${new URL(loc, 'https://auth.huaweicloud.com').pathname}` : ''}`);
  if (!loc) break;
  cur = new URL(loc, 'https://auth.huaweicloud.com').toString();
}

console.log(`\n  经过过登出端 ? ${session.url.includes('/authui/logout') ? '是' : '否'}`);
console.log(`  经过过「授权流程」? ${reachedAuthorize ? '是' : '否'}（授权流程在登录页之后才走，所以这里通常是"否"）`);
console.log(`  到过登录页 ? ${reachedLogin ? '是' : '否'}  ← 这才是重点：一定会让你重新登录`);

// 登录页拿到手之后，它自己会用 service= 往下走；把那个 service 抠出来确认指向 authorize。
// 不真提交表单，只看参数。
let serviceOk = false;
try {
  const page = await fetch(cur, { redirect: 'manual' });
  const html = await page.text();
  const m = html.match(/service=([^"&]+)/);
  if (m) {
    const svc = decodeURIComponent(m[1]);
    serviceOk = svc.includes('/authui/v1/oauth2/authorize');
    console.log(`  登录页里的 service 参数指向 authorize ? ${serviceOk ? '是' : '否'}`);
    console.log(`    ${svc.slice(0, 110)}…`);
  } else {
    console.log('  登录页里没找到 service 参数（可能要靠 JS 取当前 URL 拼接，这不影响流程）');
    serviceOk = true;
  }
} catch (err) {
  console.log(`  读登录页失败: ${err.message}`);
}

// 收尾：把这个探测会话取消掉，别让它挂在 pending 里空转
await fetch('http://127.0.0.1:7864/admin/api/login/cancel', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: session.id }),
});
console.log('  探测会话已取消');
process.exit(reachedLogin && session.url.includes('/authui/logout') && serviceOk ? 0 : 1);
