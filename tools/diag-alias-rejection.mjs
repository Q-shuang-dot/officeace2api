/**
 * 排障：别名改了之后，「模型不行」的旧标记到底有没有清掉。
 *
 * 复现那条真踩到的坑：`gpt-4o` 先指向打不通的模型 → 被标"不行" →
 * 改指能用的模型 → 旧标记是否还挡着它？
 *
 * 全程只用公开接口，不改任何数据（最后会把别名还原成空）。
 */
const base = 'http://127.0.0.1:7864';
const H = { Authorization: 'Bearer sk-officeace', 'Content-Type': 'application/json' };

const j = async (p, opt) => {
  const r = await fetch(base + p, { headers: H, ...opt });
  const t = await r.text();
  try { return { status: r.status, json: JSON.parse(t) }; } catch { return { status: r.status, text: t }; }
};
const setAlias = (alias) => j('/admin/api/models', { method: 'POST', body: JSON.stringify({ alias, hidden: [], extra: [] }) });
const models = () => j('/v1/models');
const state = () => j('/admin/api/state');

const show = async (label) => {
  const m = await models();
  const s = await state();
  const ids = (m.json?.data || []).map((x) => x.id);
  const un = s.json?.health?.modelsUnavailable || [];
  console.log(`  ${label}`);
  console.log(`    /v1/models: ${ids.length} 个   含 gpt-4o? ${ids.includes('gpt-4o')}`);
  console.log(`    modelsUnavailable: ${un.length} 个   含 gpt-4o? ${un.includes('gpt-4o')}`);
  console.log(`    config.models.alias: ${JSON.stringify(s.json?.config?.models?.alias)}`);
  return { ids, un };
};

console.log('\n══ 别名「模型不行」标记作废验证 ══\n');

await setAlias({});
await show('① 起点（无别名）');

await setAlias({ 'gpt-4o': 'glm-5.2' });
const a = await show('② 别名 → glm-5.2（能用的）');
if (a.ids.includes('gpt-4o')) console.log('     ✓ gpt-4o 出现了\n');
else console.log('     ✗ gpt-4o 没出现 —— 这一步就该出现\n');

// 真打一次，确认它是通的（通的话就不会有标记）
const r1 = await fetch(base + '/v1/chat/completions', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: '回一个字' }], max_tokens: 8 }),
});
console.log(`  ③ 真打一发 gpt-4o：HTTP ${r1.status}`);
await r1.text();

await setAlias({ 'gpt-4o': 'glm-5.3-zx' });
const b = await show('④ 改指 glm-5.3-zx（打不通的）');
const r2 = await fetch(base + '/v1/chat/completions', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: '回一个字' }], max_tokens: 8 }),
});
const t2 = await r2.text();
console.log(`  ⑤ 真打一发 gpt-4o：HTTP ${r2.status}  ${t2.slice(0, 90)}\n`);
void b;

await setAlias({ 'gpt-4o': 'glm-5.2' });
const c = await show('⑥ 改回 glm-5.2（能用的）—— 这一步 gpt-4o 必须回来');
if (c.ids.includes('gpt-4o')) console.log('     ✓ 回来了，标记作废生效\n');
else console.log('     ✗ 还是被挡着，标记没清\n');

await setAlias({});
await show('⑦ 还原');

console.log('\n══ 完 ══\n');
