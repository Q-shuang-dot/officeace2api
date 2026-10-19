# officeace2api 快速开始指南

## ⚠️ 重要提示

**必须先安装 OfficeAce 桌面端才能使用！**

- 获取方式：搜索「OfficeAce」或从华为应用市场下载
- 原因：本项目是桌面端的伴生服务，需要读取桌面端的账号凭据
- 如果不安装：控制面板的「换个账号登录」会提示「授权失败」

---

## 项目结构

```
officeace2api/
├── src/                      # Node.js 源代码
├── tools/                    # 工具脚本
├── config.example.json       # 配置文件示例
├── start.cmd                 # 启动脚本（主要入口）
├── stop.cmd                  # 停止脚本
├── status.cmd                # 查看状态
├── open-panel.cmd            # 打开网页控制面板
├── free-port.cmd             # 端口被占时双击它（会自动清掉占用者）
├── export-accounts.cmd       # 换电脑：导出全部账号凭证（旧机器用）
├── import-accounts.cmd       # 换电脑：导入账号凭证（新机器用，把文件拖进去）
├── install-autostart.cmd     # 设置开机自启
└── README.md                 # 完整文档
```

## 使用步骤

### 1️⃣ 初始化配置

```bash
# 复制配置文件模板
copy config.example.json config.json
```

编辑 `config.json`，主要配置项：
- `listen.port`: 服务端口（默认 7864）
- `apiKeys`: API密钥列表（代理前端需要）

### 2️⃣ 启动服务

双击 **`start.cmd`** —— 这是主要入口！

服务会：
- 自动检查 Node.js 环境
- **先检查并清理端口占用**（被占就自动清掉，详见下面「端口被占用」）
- 启动后台服务进程
- 等待服务就绪（30 × 2秒的健康检查）
- 显示成功消息和控制面板地址

**输出示例：**
```
[*] node : D:\node\node.exe  v22.22.2
[*] starting via scheduled task "officeace2api" ...
...
[OK] service is up

OpenAI base : http://127.0.0.1:7864/v1
Admin panel : http://127.0.0.1:7864/admin?token=...
API key     : see "apiKeys" in config.json  (default: sk-officeace)
```

### 3️⃣ 添加账号

**最简单的方法（推荐）：**

双击 **`open-panel.cmd`** → 打开网页控制面板 → 「账号池」页 → 点「换个账号登录」→ 用你自己的账号登录

> 如果本机装了 OfficeAce 桌面端，启动完服务后账号池会自动有号（无需手工操作）

### 4️⃣ 查看状态

```bash
# 双击这个查看服务状态
status.cmd

# 或者在浏览器直接访问
curl http://127.0.0.1:7864/healthz
```

### 5️⃣ 换电脑 / 重装系统：把账号搬过去

**不用挨个重新登录。**

| 步骤 | 在哪台机器 | 做什么 |
|---|---|---|
| 1 | 旧机器 | 双击 **`export-accounts.cmd`** → 输入一个口令（**建议设，留空就是明文**）→ 生成 `accounts-backup\officeace2api-accounts-<机器名>-<时间>-locked.json` |
| 2 | —— | 把这个文件拷到新电脑（U 盘 / 微信传给自己都行） |
| 3 | 新电脑 | 双击 **`import-accounts.cmd`** → **把文件拖进窗口** → 输入同一个口令 |
| 4 | 新电脑 | 双击 `start.cmd` → `open-panel.cmd` → 「账号池」里号都在；点「刷新积分」能读出余额就说明续期链是通的 |
| 5 | **旧机器** | **停掉这些号**（面板上停用，或整机 `stop.cmd`）—— 见下面的 `[!]` |

面板里也能做：「账号池」→「导出凭证」按钮；导入在「导入账号」弹窗底部「从文件导入」那一行。

命令行（等价，带 `--check` 可以先只看不写）：

```bash
node tools\export-accounts.mjs --pass 你的口令
node tools\export-accounts.mjs --pass 你的口令 --prune   # 顺手删掉目录里的旧搬运包（留最新 3 份）
node tools\import-accounts.mjs accounts-backup\officeace2api-accounts-xxx.json --pass 你的口令 --check
node tools\import-accounts.mjs accounts-backup\officeace2api-accounts-xxx.json --pass 你的口令
```

> `[!]` **refresh_token 是一次性的。** 同一个 token 被两台机器轮流用会撞 `STS5.1806`，
> 两边都得重新登录。「导出」是**搬家**，不是「复制一份两边一起用」；
> 想两台机器同时用同一个号，就在两边各登录一次。
>
> 导入时如果服务正在跑，会走接口（内存里的续期链是最新的）；服务没跑就直接写数据文件，
> 两种情况都会自动备份到 `data\import-backup-<时间>\`。
>
> 新机器如果本来就装了 OfficeAce 且登过号，导入不会把同一个号重复登记。

**关于那些备份文件**：`data\import-backup-<时间>\` 和 `accounts-backup\*.json` 里都是**凭据**
（明文或有口令的包），所以两边都只保留最新 3 份，多出来的自动删掉 —— 导入时顺手清，导出时加
`--prune` 清（不加就只列出旧的提醒你）。旧包在新电脑上导完就没用了。

## 常用命令

| 命令 | 作用 |
|------|------|
| `start.cmd` | 启动服务（推荐双击运行） |
| `stop.cmd` | 停止服务 |
| `status.cmd` | 查看服务状态 |
| `open-panel.cmd` | 打开网页控制面板 |
| `free-port.cmd` | 清理端口占用（启动不起来时先双击它） |
| `export-accounts.cmd` | 导出全部账号凭证（换电脑用，建议加口令） |
| `import-accounts.cmd` | 在新电脑导入凭证（把导出的文件拖到它上面） |
| `run-foreground.cmd` | 前台运行（调试用） |
| `run-bg.cmd` | 后台运行 |
| `install-autostart.cmd` | 设置开机自启 |
| `remove-autostart.cmd` | 移除开机自启 |

## API 接口

### 健康检查
```bash
curl http://127.0.0.1:7864/healthz
```

返回示例：
```json
{
  "status": "ok",
  "credentials": 2,
  "models": 28,
  "accounts": 2,
  "accountsUsable": 1,
  "creditsRemaining": 6350.67
}
```

### OpenAI 兼容接口
```bash
curl http://127.0.0.1:7864/v1/chat/completions \
  -H "Authorization: Bearer sk-officeace" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'
```

### 管理面板（需要 token）
```bash
curl http://127.0.0.1:7864/admin/api/state?token=YOUR_TOKEN
```

## 故障排查

### 问题：start.cmd 启动卡住（超过 60 秒）

**原因：** 
- 计划任务存在但被禁用
- 权限不足

**解决：**
1. 检查任务状态：`schtasks /query /tn "officeace2api"`
2. 如果状态是 `Disabled`，启用它：`schtasks /change /tn "officeace2api" /enable`
3. 重新运行 `start.cmd`

### 问题：找不到 Node.js

**原因：** 系统没有安装 Node.js 20+

**解决：**
1. 下载安装 [Node.js 20+](https://nodejs.org/)
2. 或者在 `data/node.txt` 中写入 node.exe 的完整路径

### 问题：端口被占用（服务起不来）

**现在启动时会自动清掉，不用手动处理。** `start.cmd` / `run-bg.cmd` / `run-foreground.cmd`
在拉起服务之前都会先跑一遍 `tools/free-port.ps1`，判断很保守：

| 端口上的情况 | 它会怎么做 |
| --- | --- |
| 空的 | 直接继续 |
| 一个**没退干净的本服务实例**（还占着端口但不响应） | 杀掉它，再启动 |
| **别的程序**占着（会打印程序名和 pid） | 杀掉它，再启动 |
| 一个**健康的本服务**（`/healthz` 通） | 不动它，直接用它 |
| 落在 Windows 保留端口范围里（Hyper-V / Docker 的 WinNAT 预留） | 杀进程没用，会直接告诉你怎么解决 |

想手动清一次，或者想看看到底是谁占着：双击 **`free-port.cmd`**
（需要管理员权限时它会自己弹 UAC 提权重跑）。所有动作都记在 `logs/port-clean.log`。

万一还是清不掉：

1. 右键 `start.cmd`（或 `free-port.cmd`）→ **以管理员身份运行**；
2. 或者按打印出来的 pid，在任务管理器 → 详细信息里结束那个进程；
3. 或者换端口：把 `config.json` 里 **`listen.port`** 改成 `7865` 之类没被占的端口，再双击 `start.cmd`。

> 端口字段是 `"listen": { "port": 7864 }`，不是顶层的 `port`。

### 问题：导入凭证时提示「管理员 token 无效」

这不是口令错了，是**端口上那个服务不是你这个目录的**：同一个人电脑上放了两份项目
（或者旧版还在 `7864` 上跑着）时会出现。现在的 `import-accounts.cmd` /面板都不会往
别人的服务上发导入，会打印一行
`注意 : 127.0.0.1:7864 上是另一个目录的服务（D:\...）` 然后直接写自己的数据文件 ——
看到这行就说明已经正确处理了，继续 `start.cmd` 即可。

如果确实想用接口方式导入（服务在跑、内存里的续期链最新），先把那份「别的目录」的服务停掉，
再在本目录 `start.cmd`。

### 问题：账号池显示为空

**原因：**
- 没有登录账号
- 本机没装 OfficeAce 桌面端

**解决：**
打开控制面板 → 「账号池」页 → 点「换个账号登录」→ 用你自己的账号登一次

### 问题：导入凭证时提示「口令不对（或者这个文件被改动过）」

1. 口令要跟导出时**完全一样**（大小写、空格都算）；忘了口令只能回旧机器重新导出，或者在新机器上重新登录；
2. 文件被记事本另存过、微信/邮箱转过格式、或者用文本编辑器改过，都会让校验失败 —— 重新拷一次原始文件；
3. 确认选对了文件：应该是 `officeace2api-accounts-...-locked.json`，不是 `data\` 目录里的 `accounts.json`。

### 问题：导入成功，但某个号显示「凭据已过期 / 只能转发」

那个号的包里没有 `refresh_token`（只带了 24 小时的临时凭据），新机器上没法自动续期。
在面板上给这个号重新登录一次就恢复了 —— 其余账号不受影响。

## 更多信息

详见项目根目录的 [README.md](README.md)

---

**修复说明：**
- ✅ 禁用任务导致 60 秒白等的问题已修复（v1.1.0+）
- ✅ README 账号添加引导已改进
