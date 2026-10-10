## 这个 PR 做了什么

<!-- 一句话说清。关联的 Issue 用 #编号 引用，例如 Closes #12 -->

Closes #

---

## 改动类型

<!-- 勾选一项 -->

- [ ] 🐛 Bug 修复（不改行为、只修错的）
- [ ] ✨ 新功能
- [ ] 📝 文档
- [ ] ♻️ 重构（不改外部行为）
- [ ] ⚡ 性能优化
- [ ] 🔧 其他

---

## 硬性约束自查（**必填**）

<!-- 详见 CONTRIBUTING.md 第一节。这几条违反会导致功能只在你的机器上正常 -->

- [ ] **没有引入任何 npm 依赖** —— `package.json` 的 `dependencies` 仍为空
- [ ] **`.cmd` 文件仍是纯 ASCII + 无 BOM**（改了批处理的话）
- [ ] **没有把 `data/` 或 `logs/` 下的内容带进提交**
- [ ] 没有把本机凭据、面板口令、账号 ID 写进代码或文档

### 批处理文件字节校验（改了 `.cmd` 就贴结果）

```
# node -e "const b=require('fs').readFileSync('start.cmd');const bad=[...b].filter(x=>x>127);console.log(bad.length?'✗ 非 ASCII 字节: '+bad.length:'✓ 纯 ASCII')"
（粘贴输出）
```

---

## 跑了哪些自测

<!-- 详见 CONTRIBUTING.md 第三节。没跑通请说明原因 -->

- [ ] `node tools/smoke-test.mjs`
- [ ] `node tools/test-admin.mjs`
- [ ] `node tools/test-max-tokens.mjs`
- [ ] `node tools/test-model-probe.mjs`
- [ ] `node tools/diag-local-daily.mjs`
- [ ] 未跑（原因：）

```
（粘贴关键输出）
```

---

## 怎么验证这个改动

<!-- 给维护者一份能照着复现的步骤。越具体越好 -->

1.
2.
3.

**改前表现：**

**改后表现：**

---

## 有没有破坏向后兼容

- [ ] 没有，老 `config.json` 直接能用
- [ ] 有，需要用户迁移（迁移方式写在下面）

<!-- 改了 config.json 字段名 / 接口返回结构 / 启动脚本行为的话，这里一定要写清楚 -->

---

## 其他要说明的

<!-- 截图、日志、取舍理由、暂时没做的部分…… -->
