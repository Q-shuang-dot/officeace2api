# 贡献指南

感谢你有兴趣改进 officeace2api！本文档说明本项目的**硬性约束**和**提交流程**。
动手前请先读完「一、改之前必须知道的」，那几条不是建议，是硬规矩 —— 违反会导致
功能在你的机器上正常、在别人机器上直接崩。

---

## 一、改之前必须知道的

### 1. 零依赖 —— 不许引入任何 npm 包

这是本项目最大的卖点，也是**不可妥协的约束**：

```bash
# 正确：只用 Node.js 内置模块
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

# 禁止：任何形式的第三方依赖
import express from 'express';        # ✗
import axios from 'axios';            # ✗
```

`package.json` 里的 `dependencies` **必须永远为空**。PR 里出现新的 npm 依赖会直接被拒。

> 原因：用户 clone 下来双击就能跑，不需要联网、不需要 `npm install`、
> 不会有供应链投毒风险。这个项目会接触云端凭据，第三方依赖是重大风险面。

### 2. `.cmd` 文件必须是纯 ASCII

`cmd.exe` 按 **OEM 代码页（简体中文机器上是 936）** 读取 `.cmd` 文件。
文件里写了 UTF-8 中文注释，会被拆成乱码命令，脚本直接炸。

所以 **`start.cmd` / `stop.cmd` / `status.cmd` / `run-bg.cmd` 等所有批处理的注释都用英文**。

改完批处理必须验一遍字节数：

```bash
node -e "const b=require('fs').readFileSync('start.cmd');const bad=[...b].filter(x=>x>127);console.log(bad.length?'✗ 有非 ASCII 字节: '+bad.length:'✓ 纯 ASCII')"
```

同时**不要加 BOM** —— 开头是 `EF BB BF` 的话，第一行 `@echo off` 会变成乱码。

### 3. `data/` 和 `logs/` 永远不进仓库

```
data/                     → 面板口令、明文 AK/SK、refresh_token、DPoP 私钥
config.local.json         → 本机 apiKeys
logs/                     → 日志
```

这三类已在 `.gitignore` 里。**提交前务必确认没有把凭据带进去**：

```bash
git diff --cached --name-only | Select-String "data/|logs/|config.local"
```

`.mjs` 会把本机密码/密钥写进 `data/`，其余文件只读不写 —— 别破坏这个约定。

### 4. 注释和文档用中文

面向的用户是中文用户。代码里的注释、控制台文案、文档都用中文。
变量名、函数名用英文。

---

## 二、开发环境

```bash
git clone https://github.com/你的用户名/officeace2api.git
cd officeace2api
```

**不需要 `npm install`。** 只需要 Node.js ≥ 20：

```bash
node -v
```

启动调试模式（前台运行，日志直接打在终端）：

```bash
node src/index.mjs
```

或者在 Windows 上双击 `run-foreground.cmd`。

---

## 三、提交前必须做的自测

本项目的测试脚本全在 `tools/` 下，**不依赖任何测试框架**，直接 `node` 跑：

| 命令 | 测什么 |
|---|---|
| `node tools/smoke-test.mjs` | 端到端冒烟：起服务 → 发请求 → 验证响应 |
| `node tools/test-admin.mjs` | 控制台接口（223 项） |
| `node tools/test-max-tokens.mjs` | 推理预算改写规则（47 项单元测试） |
| `node tools/test-model-probe.mjs` | 模型可用性探测（41 项单元测试） |
| `node tools/diag-admin-auth.mjs` | 面板鉴权（无口令 / 对口令 / 错口令 / `?token=`） |
| `node tools/diag-local-daily.mjs` | 七个菜单的真实接口 + 面板调的路径是否都存在 |

**改了哪块就至少跑对应用例。** 涉及面板的改动，`test-admin.mjs` 和
`diag-local-daily.mjs` 必须跑通。

> ⚠️ `tools/stress-deep41.mjs` 会**真花积分**，不是必跑的，别在 PR 里长期开着。

---

## 四、提 PR 的流程

### 1. Fork

打开 https://github.com/Q-shuang-dot/officeace2api ，点右上角 **Fork**。

### 2. 建分支

**不要直接改 `main`。**

```bash
git checkout -b fix/面板保存不生效
```

分支命名建议：

| 前缀 | 用途 | 例子 |
|---|---|---|
| `fix/` | 修 bug | `fix/task-disabled-hang` |
| `feat/` | 新功能 | `feat/account-import-qr` |
| `docs/` | 只改文档 | `docs/english-readme` |
| `refactor/` | 重构，不改行为 | `refactor/pool-rotation` |

### 3. 提交

提交信息建议**中文**，格式：

```
<类型>: <一句话说明>

<为什么这么改，可选>
```

类型用 `fix` / `feat` / `docs` / `test` / `refactor` / `chore`。

```bash
git commit -m "fix: 计划任务被禁用时 start.cmd 白等 60 秒

schtasks /run 失败时旧代码忽略了退出码，直接进 30 次健康轮询。
现在检查 errorlevel 并立刻回退到 run-bg.cmd。"
```

### 4. 推到你自己的 fork

```bash
git push origin fix/面板保存不生效
```

### 5. 开 PR

GitHub 会自动弹出 **Compare & pull request** 横幅，点它，按模板把信息填全。

---

## 五、PR 的合并判断标准

维护者会重点看：

1. **有没有引入 npm 依赖** —— 有就直接拒
2. **有没有把 `data/` 或 `logs/` 里的东西带进来** —— 有就要求清理
3. **批处理文件是不是还是纯 ASCII** —— 不是就要求改
4. **相关自测脚本有没有跑通** —— 没跑通会要求补
5. **改动范围** —— 一个 PR 只做一件事，别把三个不相干的修改混在一起
6. **有没有破坏向后兼容** —— 改了 `config.json` 的字段名要说明迁移方式

---

## 六、只提 Issue 也行

不会写代码完全没问题。反馈问题和提建议同样是贡献：

- **报 Bug** → 用 [Bug 报告](https://github.com/Q-shuang-dot/officeace2api/issues/new?template=bug_report.md) 模板，
  里面要求的信息（`status.cmd` 输出、`logs\server.log` 片段、复现步骤）尽量填全，
  否则很难定位。
- **提建议** → 用 [功能建议](https://github.com/Q-shuang-dot/officeace2api/issues/new?template=feature_request.md) 模板。

> 💡 报 bug 时**务必先脱敏**：`logs\server.log` 和 `config.json` 里可能有
> 面板口令、账号 ID、网关地址。贴出来之前先把这些替换成 `xxx`。

---

## 七、报告安全问题

如果发现的是**安全漏洞**（比如凭据泄漏、鉴权绕过、路径穿越），
**请不要开公开 Issue** —— 那等于把漏洞告诉了所有人。

请通过 GitHub 的
[Private vulnerability reporting](https://github.com/Q-shuang-dot/officeace2api/security/advisories/new)
私下报告，或者发邮件给维护者。

---

再次感谢！🎉
