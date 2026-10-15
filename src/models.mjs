/**
 * 模型注册表：合并「本机发现的目录」+「上游 /models 实时列表」+「配置里的额外模型/别名」
 */

const KNOWN_META = {
  'deepseek-v4.1-flash': { name: 'DeepSeek-V4.1-Flash', developer: 'DeepSeek', context: '1M', toolCall: true, vision: true },
  'deepseek-v4-flash': { name: 'DeepSeek-V4-Flash', developer: 'DeepSeek', context: '1M', toolCall: true },
  'deepseek-v4-pro': { name: 'DeepSeek-V4-Pro', developer: 'DeepSeek', context: '1M', toolCall: true },
  'deepseek-v4-flash-0731': { name: 'DeepSeek-V4-Flash-0731', developer: 'DeepSeek', context: '1M', toolCall: true },
  'deepseek-v3.2': { name: 'DeepSeek-V3.2', developer: 'DeepSeek', context: '128K', toolCall: true },
  'deepseek-r1-250528': { name: 'DeepSeek-R1-250528', developer: 'DeepSeek', context: '128K', reasoning: true },
  'glm-5.2': { name: 'GLM-5.2', developer: 'Zhipu AI', context: '198K', toolCall: true, reasoning: true },
  'glm-5.3': { name: 'GLM-5.3', developer: 'Zhipu AI', context: '198K', toolCall: true, reasoning: true },
  'glm-5.1': { name: 'GLM-5.1', developer: 'Zhipu AI', context: '198K', toolCall: true, reasoning: true },
  'kimi-k2.6': { name: 'Kimi-K2.6', developer: 'Moonshot', context: '256K', toolCall: true },
  'Kimi-K2.6': { name: 'Kimi-K2.6', developer: 'Moonshot', context: '256K', toolCall: true },
  'qwen3-32b': { name: 'Qwen3-32B', developer: 'Alibaba', context: '128K', toolCall: true },
  'qwen3-30b-a3b': { name: 'Qwen3-30B-A3B', developer: 'Alibaba', context: '128K', toolCall: true },
  'openpangu-2.0-pro': { name: 'openPangu-2.0-Pro', developer: 'Huawei', context: '128K', toolCall: true },
  'openpangu-2.0-flash': { name: 'openPangu-2.0-Flash', developer: 'Huawei', context: '128K', toolCall: true },
};

export class ModelRegistry {
  constructor({ alias = {}, hidden = [], extra = [] } = {}) {
    this.alias = { ...alias };
    this.hidden = new Set(hidden);
    this.extra = [...extra];
    this.discovered = new Map(); // id -> { id, baseUrl, account, ownedBy, created, source }
    this.upstream = new Map(); // id -> { id, ownedBy, created }
    this.lastRefreshAt = 0;
  }

  setDiscovered(items) {
    this.discovered = new Map();
    for (const item of items || []) {
      if (!item?.id) continue;
      const prev = this.discovered.get(item.id);
      if (!prev || (prev.baseUrl && prev.baseUrl !== item.baseUrl)) {
        this.discovered.set(item.id, { ...item, source: 'local' });
      }
    }
  }

  setUpstream(items) {
    this.upstream = new Map();
    for (const item of items || []) {
      if (!item?.id) continue;
      this.upstream.set(item.id, {
        id: item.id,
        ownedBy: item.owned_by || item.ownedBy || 'system',
        created: Number(item.created) || 0,
      });
    }
    this.lastRefreshAt = Date.now();
  }

  /** 面板保存后热更新 */
  apply({ alias, hidden, extra } = {}) {
    if (alias && typeof alias === 'object') this.alias = { ...alias };
    if (Array.isArray(hidden)) this.hidden = new Set(hidden);
    if (Array.isArray(extra)) this.extra = [...extra];
  }

  ids() {
    const set = new Set();
    for (const id of this.discovered.keys()) set.add(id);
    for (const id of this.upstream.keys()) set.add(id);
    for (const id of this.extra) set.add(id);
    for (const [from, to] of Object.entries(this.alias)) {
      set.add(from);
      set.add(to);
    }
    // hidden 也按大小写不敏感地匹配：配置里写 `kimi-k2.6` 也该把 `Kimi-K2.6` 藏掉
    // （不然它会一边从列表里消失、一边还能被精确名字请求到）。
    const hiddenLower = new Set([...this.hidden].map((x) => String(x).toLowerCase()));
    // 大小写去重：上游会**把同一个模型列成两种拼法**（实测 `Kimi-K2.6` 和 `kimi-k2.6`
    // 同时出现，两种拼法探测都返回 200）。不去重的话：客户端模型选择器里出现两条、
    // 每轮探测多打一次上游、而冷却和「拒绝过这个模型」的标记是按精确字符串记的，
    // 两种拼法各记一份、互相不生效。先出现的拼法为准（discovered → upstream → extra → 别名）。
    const byLower = new Map();
    for (const id of set) {
      const key = String(id).toLowerCase();
      if (hiddenLower.has(key)) continue;
      if (!byLower.has(key)) byLower.set(key, id);
    }
    return [...byLower.values()].sort();
  }

  /** 清单的「小写 → 清单里的拼法」索引，用于大小写不敏感地归一 */
  idIndex() {
    const map = new Map();
    for (const id of this.ids()) {
      const key = id.toLowerCase();
      if (!map.has(key)) map.set(key, id);
    }
    return map;
  }

  /** 大小写不敏感地归一成清单里的那个拼法；清单里没有就原样返回（绝不凭空造模型） */
  canonical(name) {
    const want = String(name || '').trim();
    if (!want) return '';
    return this.idIndex().get(want.toLowerCase()) || want;
  }

  /**
   * 把客户端请求的模型名解析为上游真实模型名。
   *
   * 别名先看，然后**按大小写不敏感**再看一遍 —— 上游网关本身对大小写不敏感
   * （实测 `Kimi-K2.6` 和 `kimi-k2.6` 两种拼法都返回 200），而客户端手写模型名时
   * 大小写经常跟清单不一致。以前这里只做精确匹配，于是 `KIMI-K2.6` 会一路走到
   * `checkModel()` 的 404「没有这个模型」：**同一个模型换个大小写就用不了**，
   * 而且报的是「模型不存在」这种最容易被当成上游抽风的错。
   *
   * 归一还有个副作用是好的：冷却、拒绝标记、探测结果都按返回的名字记账，
   * 归一之后两种拼法不会再各记一份。
   */
  resolve(requested) {
    const name = String(requested || '').trim();
    if (!name) return null;
    if (this.alias[name]) return this.canonical(this.alias[name]);
    const lower = name.toLowerCase();
    for (const [from, to] of Object.entries(this.alias)) {
      if (String(from).toLowerCase() === lower) return this.canonical(to);
    }
    return this.canonical(name);
  }

  has(id) {
    return this.ids().includes(this.canonical(id));
  }

  defaultModel() {
    const preferred = ['glm-5.2', 'deepseek-v4-flash-0731', 'deepseek-v3.2', 'Kimi-K2.6', 'kimi-k2.6'];
    const ids = this.ids();
    for (const p of preferred) if (ids.includes(p)) return p;
    return ids[0] || 'glm-5.2';
  }

  /** OpenAI /v1/models 结构 */
  toOpenAiList() {
    const created = Math.floor(Date.now() / 1000);
    return this.ids().map((id) => {
      const meta = KNOWN_META[id];
      const local = this.discovered.get(id);
      const up = this.upstream.get(id);
      return {
        id,
        object: 'model',
        created: up?.created || local?.created || created,
        owned_by: up?.ownedBy || local?.ownedBy || 'officeace',
        ...(this.alias[id] ? { alias_of: this.alias[id] } : {}),
        ...(meta ? { display_name: meta.name, developer: meta.developer, context_window: meta.context } : {}),
        ...(local?.baseUrl ? { upstream_base: local.baseUrl } : {}),
      };
    });
  }

  /** 面板用：带来源标记 */
  detailed() {
    const list = [];
    const all = new Set([...this.discovered.keys(), ...this.upstream.keys()]);
    for (const id of this.ids()) {
      const meta = KNOWN_META[id] || {};
      list.push({
        id,
        displayName: meta.name || id,
        developer: meta.developer || '-',
        context: meta.context || '-',
        toolCall: !!meta.toolCall,
        reasoning: !!meta.reasoning,
        inAppCatalog: all.has(id),
        source: this.alias[id] ? 'alias' : this.upstream.has(id) ? 'upstream' : this.discovered.has(id) ? 'local' : 'config',
      });
    }
    return list;
  }
}
