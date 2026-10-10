/**
 * 验一下「登出 → 再授权」这条路能不能真的换账号。
 *
 * 逻辑（不提交表单，只看重定向链和页面特征）：
 *   未登录时 /authui/v1/oauth2/authorize → 302 /authui/login?service=…
 *   已登录时 同一个地址 → 直接 302 回 redirect_uri 带 code（这就是"直接给我登录了"的成因）
 *
 * 所以「换账号」要靠 /authui/logout?service=<authorizeUrl>：先清掉当前会话，
 * 再回授权流程 —— 那时就没有会话可复用了，必须重新输账号密码。
 */
const AUTH = 'https://auth.huaweicloud.com';
const authorize = (extra = '') =>
  `${AUTH}/authui/v1/oauth2/authorize?client_id=pdp5_for_agentarts&code_challenge=probe&code_challenge_method=SHA-256` +
  `&state=probe&scope=openid` +
  `&redirect_uri=${encodeURIComponent('https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/auth/callback')}` +
  `&response_type=code${extra}`;

async function chain(label, url, max = 4) {
  console.log(`\n  ── ${label} ──`);
  let cur = url;
  for (let i = 0; i < max; i += 1) {
    let res;
    try {
      res = await fetch(cur, { redirect: 'manual' });
    } catch (err) {
      console.log(`    [${i}] 请求失败 ${err.message}`);
      return;
    }
    const loc = res.headers.get('location');
    console.log(`    [${i}] ${res.status}  ${cur.slice(0, 96)}`);
    if (!loc) {
      const body = res.status === 200 ? await res.text() : '';
      const hasForm = /<form/i.test(body);
      const hasJs = /window\.location/.test(body);
      console.log(`         → 终点（${body.length} 字节，含 form=${hasForm}，含 JS 跳转=${hasJs}）`);
      return;
    }
    console.log(`         → ${loc.slice(0, 130)}`);
    cur = loc.startsWith('http') ? loc : AUTH + loc;
    if (cur.includes('/v1/claw/auth/callback')) {
      console.log('         ⚠️ 直奔回调了 —— 说明**会话被复用了**，没有要求重新登录');
      return;
    }
  }
}

await chain('① 裸 authorize（当前浏览器会话下）', authorize());
await chain('② authorize + prompt=login', authorize('&prompt=login'));
await chain('③ 登出后再授权：/authui/logout?service=<authorize>', `${AUTH}/authui/logout?service=${encodeURIComponent(authorize())}`);
await chain('④ 登出后裸 authorize', authorize());
