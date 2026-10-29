# officeace2api

**简体中文** | [English](README.en.md)

> 本项目在 [LINUX DO](https://linux.do) 社区发布与交流，感谢佬友支持。

把一个模型网关反代成一整套标准 **OpenAI 兼容 API**，并自带一个中文控制台。

**零依赖** —— 只用 Node.js 内置模块，不用 `npm install`。

> 💡 **账号来源**：面板里「换个账号登录」自己就能完成授权（PKCE + 华为云回调 + DPoP 换 token，
> 全在 `src/oauth.mjs` 里实现），**不需要装桌面端**。装了 **OfficeAce 桌面端**（华为云 DevEco
> Studio 助手）会更省事：服务能自动发现本机已登录的账号，老的「一键授权」入口也能用。

![控制台](docs/panel-accounts.png)

---

## 一、有什么功能

### API 层

| 能力 | 说明 |
|---|---|
| `/v1/chat/completions` | 流式 SSE + 非流式 |
| `/v1/models` | 模型列表 |
| Function Calling | 工具调用原样透传 |
| `reasoning_content` | 推理模型的思维链，单独字段返回 |
| `usage` | token 统计（含 `reasoning_tokens`、`cached_tokens`） |
| `X-Request-Id` / `Server-Timing` | 每个请求都有可复制的 ID；流式返回首包耗时，非流式返回总耗时 |

任何能填 Base URL 的客户端都能接：Cherry Studio、NextChat、LobeChat、Cline、Roo Code、
Continue、Cursor、Dify、沉浸式翻译、OpenAI SDK……

### 控制台（`http://127.0.0.1:7864/admin`）

> 控制台默认带**面板口令**校验（首次启动自动生成，见下面的「快速开始」）。
> 打开时地址要带 `?token=`，或者请求头带 `x-admin-token`。
> 想退回"本机自用不校验"，把 `config.json` 里的 `admin.token` 改成 `""` 即可。
> （`open-panel.cmd` 会自动带上口令，日常用不用手记。）

**本机自用建议**：把带口令的地址存成书签。面板前端会从 URL 读口令并发到每个请求上，
所以收藏夹里点开就直接进，不用每次去翻 `config.json`。

| 菜单 | 干什么 |
|---|---|
| **概览** | 一屏看运行状态、剩余积分、今日签到和最近调用 |
| **账号池** | 多账号的凭据、剩余积分、健康度一览；批量续期 / 签到 / 停用；**导出凭证**（换电脑用）/ 导入 |
| **用量** | 请求数、token 消耗、近 7 天走势、失败原因分类，按模型 / 按 API Key 分组 |
| **积分构成** | 每个账号还剩多少积分 —— 直接问云端，不是估算 |
| **模型与档位** | 模型清单、别名、隐藏、手工补录；自带测试台 |
| **接入信息** | 各种客户端该填什么，一键复制 JSON / .env / curl |
| **运行日志** | 实时日志，按级别过滤 |
| **配置** | 改端口、API Key、上游、刷新间隔，存回 `config.json` |

### 自动化

- **多账号号池**：首包延迟 + 在途数调度、会话黏性（长上下文尽量命中上游缓存）、满员短队列、限流指数退避、连续失败熔断、积分熔断（余额见底的号自动跳过）；冷却/熔断/黏性会落盘，重启不重置
- **模型兜底**：`models.fallback` 里配好备用模型，主模型 429/5xx 时自动换一个重试
- **凭据自动续期**：临时凭据到期前自动换新，不用管
- **换电脑搬家**：一键导出全部账号凭证（可加口令加密），新机器一键导入，不用重新登录
- **每日自动签到**：定时领积分
- **批量注册**：给一批手机号自动注册 + 开通（可选，要接短信验证码）
- **开机自启 + 看门狗**：注册成 Windows 计划任务，进程挂了自动拉起来

---

## 二、快速开始

### 1. 环境要求

- **Windows**（启动脚本是批处理；核心是纯 Node，非 Windows 可以 `node src/index.mjs` 直接起，但桌面端自动发现和 DPAPI 解密是 Windows 专属）
- **Node.js ≥ 20**

没装 Node 也行 —— 如果你装了 OfficeAce 桌面端，启动脚本会自动用它的
`<安装目录>\tools\node\node.exe`（版本 22+）。查找顺序是：
`data\node.txt` → PATH 上的 node → 各盘 `OfficeAce\tools\node\node.exe`。

### 2. 拉下来

```bash
git clone https://github.com/Q-shuang-dot/officeace2api.git
cd officeace2api
```

第一次启动会自动生成 `config.json` 和 `data\` 目录，不用手工建。

### 3. 启动

双击 **`start.cmd`**（临时启动，关窗口不影响）：

```
[OK] service is up

  OpenAI base : http://127.0.0.1:7864/v1
  Admin panel : http://127.0.0.1:7864/admin?token=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  API key     : see "apiKeys" in config.json  (default: sk-officeace)
  Log file    : logs\server.log
```

> 控制台地址后面那串 `?token=` 是**面板口令**，首次启动自动生成并写进 `config.json`。
> 别丢掉它 —— 没有它打开面板只会看到 401。（`open-panel.cmd` 会自动带上，不用手记。）

> ⚠️ **不要直接在命令行里 `node src/index.mjs` 然后就关窗口** —— 窗口一关进程跟着死，
> 浏览器会 `ERR_CONNECTION_REFUSED`。要临时用就双击 `start.cmd`。

### 4. 加账号（**第一步是必须做的**）

**先看一眼「账号池」页再决定走哪条路** —— 它可能是空的，也可能启动完就已经有号了：

- **装了 OfficeAce 桌面端**（本机版或便携版）：服务一启动就会自动扫到那上面的账号，
  `账号池` 页直接列出来，**不用手工加**。扫的位置是 `~\.office-claw\`、各盘的
  `<盘>:\软件\OfficeAce\.office-claw`（以及 `OFFICEACE_INSTALL_DIR` 指定的目录）。
  注意后几个是**绝对路径，不跟 `USERPROFILE` 走**。
- **没装的机器**：池子是空的，**反代转发不了任何请求**，得用下面三条路之一。

**① 面板自助登录（推荐，不需要装桌面端）**

打开控制台 →「账号池」页 → 点 **「换个账号登录」** → 浏览器里用你自己的账号登录一次，
账号自动进池、自动续期。这条链路是这个项目自己实现的：自己拼授权链接（PKCE）→ 华为云
回调 → 轮询云端取 code → DPoP 签名换 token（`src/oauth.mjs`），**全程不碰桌面端**。

**② 借用已经登录过的 OfficeAce 桌面端**

> 装了桌面端才有这条路（搜索「OfficeAce」或从华为应用市场获取）。

登录它、随便发一条对话，然后双击 `stop.cmd` 再 `start.cmd` —— 它会自动把凭据抠出来。

> 💡 面板里还有个老的「一键授权」入口（`/admin/api/auth/*`）和注册流水线里的自动授权，
> 那两条是让**本机桌面端**去换授权链接的，没装桌面端就用不了；用上面 ① 就够。

**③ 兜底：手工导入**

如果你有现成的 `baseUrl` + `Authorization`（从其他地方获取），到「账号池」页点「导入账号」直接贴进去。

> 控制台里能随时看到每个号的**剩余积分**和健康度。余额见底的号会被自动跳过（积分熔断）。

### 5. 打开控制台

双击 **`open-panel.cmd`** —— 它会从 `config.json` 现算地址（含面板口令），
服务没起还会先自动拉起来。

> ⚠️ 用 **`127.0.0.1`**，别用 `localhost`。服务只监听 IPv4，而浏览器解析 `localhost`
> 会优先试 IPv6 的 `[::1]`，那里没人接 → 直接连接被拒。

### 6. 接入客户端

| 项 | 填什么 |
|---|---|
| Base URL | `http://127.0.0.1:7864/v1` |
| API Key | `sk-officeace`（**给别人用之前请在控制台「配置」里改掉**） |
| Model | 点「接入信息」一键复制，或看 `/v1/models` |

---

## 三、后台常驻（开机自启）

双击 **`install-autostart.cmd`**，注册成 Windows 计划任务 `officeace2api`：

```
[OK] scheduled task 'officeace2api' installed
[OK] will start automatically at every logon
[OK] running: http://127.0.0.1:7864/healthz
```

好处：**不依赖任何命令行窗口**，关窗口、注销、重启都不会掉，每次登录自动拉起。
任务里还套了一层看门狗（`tools\watchdog.ps1`），进程无论怎么死都会被重新拉起。

不要自启了就双击 **`remove-autostart.cmd`** 卸载。

### 常用命令

| 双击 | 作用 |
|---|---|
| `start.cmd` | 启动（已装任务就走任务，没装就后台拉起） |
| `stop.cmd` | 停止 |
| `status.cmd` | 看健康状态 + 模型列表 |
| `open-panel.cmd` | 打开控制台（服务没起会先自动启动） |
| `free-port.cmd` | 清理端口占用（启动不起来时先双击它） |
| `export-accounts.cmd` | **导出全部账号凭证**（换电脑用，可加口令加密） |
| `import-accounts.cmd` | **在新电脑导入凭证**（把导出的文件拖到它上面） |
| `install-autostart.cmd` | 装成开机自启 |
| `remove-autostart.cmd` | 卸载自启 |

---

## 四、怎么加账号

五种方式，日常用第 ① 种就够；换电脑看第 ② 种。

### ① 面板自助登录（推荐）

控制台 →「账号池」→ 右上角 **「导入账号」** → 弹出对话框：

| 按钮 | 什么时候用 |
|---|---|
| **开始登录** | 给**已有**的号续授权（云端会话还在，不用重填密码） |
| **换个账号登录** | **再加一个新号**（第二个、第三个……会先登出再让你登新的） |

点完在浏览器里登录，**登录完自己就进号池了**，不用回来点任何按钮。

### ② 换电脑 / 重装系统：一键搬走全部凭证

**不用挨个重新登录。** 旧机器导出 → 拷一个文件 → 新机器导入，账号、别名、启停状态、续期链一起过去。

1. **旧机器**双击 `export-accounts.cmd`（或控制台「账号池」→ **「导出凭证」**）；
   输入一个口令（**强烈建议**，留空就是明文），生成
   `accounts-backup\officeace2api-accounts-<机器名>-<时间>-locked.json`
2. 把这个文件拷到新机器（U 盘、微信传给自己都行）
3. **新机器**双击 `import-accounts.cmd`，把文件**拖到窗口里**，输入同一个口令
4. 新机器双击 `start.cmd`，打开控制台看「账号池」——号都在，积分能读出来就完事了
5. **旧机器上把这个号停掉**（或整机 `stop.cmd`），别再让它续期，见下面 `[!]`

面板上也能做：控制台「账号池」→「导入账号」弹窗底部有「从文件导入」一行（选文件 + 填口令）。

> `[!]` refresh_token 是**一次性的**。同一个 token 被两台机器轮流使用会撞 `STS5.1806`，
> 两边都得重新登录。所以「导出」等于**搬家**，不是「复制一份两边一起用」。
> 想两台机器同时用同一个号，就在两边各登录一次（那是两条独立的授权链）。

包里有什么：账号档案（长期 Basic 鉴权）、24 小时临时 AK/SK、refresh_token、
DPoP 私钥、续期链（含已作废 token 的黑名单）、别名、启停状态。
加密用 AES-256-GCM + scrypt（口令不落盘，忘了就只能重新登录）。

### ③ 从别的机器搬**单个**账号（手工）

只想搬一个号、或者手上只有 `models.json`：

把 `models.json` 里的 `api_base` 和 `custom_headers.Authorization`
填进「导入账号 → 从别的机器搬账号」即可。

### ④ 批量注册

控制台 →「配置 → 授权 / 注册 → 批量注册」：给一批手机号，
服务自动注册华为云账号 + 开通 + 拉进号池。需要接一个短信验证码来源（手工填码或 HTTP 接口）。

### ⑤ 自动发现本机已登录的账号

如果你本机装过 OfficeAce 桌面端并登录过，启动时会自动把它的账号捞进号池，**零配置**。
（所以「换电脑」以后，只要新机器上也装了 OfficeAce 并登过号，两边会自动合并，不会重复。）

---

## 五、必须装 OfficeAce 客户端吗？

**加号不需要。** 只有两件事需要桌面端：自动抠本机已有账号的凭据、以及老的「一键授权」入口
（`/admin/api/auth/*`，注册流水线的自动授权也复用它）。

| 你的情况 | 要 OfficeAce 桌面端吗 | 要做什么 |
|---|---|---|
| 只想加自己的号（浏览器里登录一次） | **不需要** | 面板「换个账号登录」，见上面第 ① 条 |
| 本机已装桌面端且登过号 | 有就更省事 | 启动即用，自动发现，不用手工加 |
| 想用注册流水线，注册完自动进池 | 目前要（那条路走「一键授权」） | 装桌面端；或注册完用 ① 手工登一次 |
| 没装，但有现成的 `baseUrl` + `Authorization` | 不需要 | 面板「导入账号」贴进去 |
| 只想反代**别的** OpenAI 兼容服务 | **不需要**，华为账号也不用 | `config.json` 里填 `upstream.baseUrl` + `upstream.authorization` |

最后一种情况等于把它当一个通用的 OpenAI 兼容反代来用：

```json
{
  "upstream": {
    "autoDiscover": false,
    "baseUrl": "https://你的上游/v1",
    "authorization": "Bearer sk-xxxxxxxx"
  }
}
```

控制台「配置」页也有这两个输入框（手工上游地址 / 手工鉴权头），填完保存即可。

### 不想让它扫本机：`discover.enabled`

默认 `true` —— 启动时会扫 `~\.office-claw`、各盘 `<盘>:\软件\OfficeAce\.office-claw`
等位置，把本机 OfficeAce 上的账号收进号池。只想用手工导入 / 手工上游的账号，就关掉：

```json
{ "discover": { "enabled": false } }
```

关掉之后账号来源只剩三处：`data\` 里自己登进来的、面板手工导入的、`upstream` 手工上游。

> ⚠️ 别把它和 `upstream.autoDiscover: false` 搞混：后者**只关「每 45 秒的定时重扫」**，
> 启动扫描照跑。所以"只想当反代"的人如果本机装过 OfficeAce，账号会被悄悄收进号池 ——
> 那两个开关是两件事，都关才干净。

---

## 六、常见问题

**Q：浏览器打不开，`ERR_CONNECTION_REFUSED`？**
用 `127.0.0.1:7864`，别用 `localhost:7864`。服务只绑 IPv4，浏览器优先试 IPv6 会直接拒。

**Q：`status.cmd` 说服务挂了，怎么办？**
双击 `start.cmd`，或 `install-autostart.cmd` 交给计划任务托管。日志见 `logs\server.log`。

**Q：双击 `start.cmd` 没反应 / 起不来？**
最常见的原因是端口被占。**启动前会自动清一次**（`tools/free-port.ps1`）：
端口上是没退干净的本服务实例、或者别的程序，都会先被清掉再启动；如果上面已经有一个
**健康的本服务**在跑，它不会去动。清不掉或想知道是谁占着，双击 `free-port.cmd`；
全过程记在 `logs/port-clean.log`。

**Q：客户端返回空正文，但有 200？**
上游把 `max_tokens` 当成「推理 + 正文」的总预算。推理模型的思维链会先把预算吃光，
正文就空了。设 `config.json` 的 `models.minMaxTokens`（默认 1024）让服务自动补足预算。
详见 [技术笔记](docs/技术笔记.md)。

**Q：面板日志里一堆 `上游中断流 ... "error":"client disconnected"`，是不是号坏了？**
不是。`client disconnected` 是**调用方（客户端）在响应写完之前先断开**时，服务自己
abort 上游请求带出来的原因 —— 常见于客户端超时重试、用户点停止、切换会话/模型。
它和上游 RST / `upstream timeout` 是两回事，不会罚凭据、也不该记成上游故障。

现在这类事件记成 `INFO 客户端已断开...`，并带上 `request_id / seq / src / ua / elapsedMs`，方便看是
哪个客户端断的、对应客户端拿到的哪个 `X-Request-Id`。流式请求如果 3 秒还没等到首包，服务会先回 `200 + SSE 头` 并每 10 秒
发一个 `: ping` 注释帧，避免客户端在等 HTTP 头时超时；可用 `config.json` 的
`upstream.earlyHeaderMs` 调整（设 `0` 关闭，回到"等首帧再发头"）。

**Q：长上下文怎么尽量省钱/降延迟？**
同一个会话尽量固定到同一个账号，才能命中上游的 prefix cache。`config.json` 的
`pool.sessionTtlSeconds` 控制黏性时长（默认 1800 秒，设 0 关闭）；客户端如果支持，
也可以直接带 `x-session-id` 请求头。面板「用量」页会显示缓存命中率
（上游不返回 `cached_tokens` 时显示 0%，不影响请求）。

**Q：服务重启后，限流冷却和会话黏性会丢吗？**
不会。`data/pool-state.json` 会保存冷却、熔断等级、连续失败数、被拒模型和会话黏性，启动时只恢复仍在有效期内的条目。文件里**不存 Authorization、也不存原始会话 key**（只存不可逆哈希），删除该文件即可手动重置号池状态。状态超过 7 天会自动忽略，避免拿过期结论做调度。

**Q：某个号连续 5xx，会不会每个请求都先打它一次？**
不会。连续 `pool.breakerThreshold` 次（默认 3）账号级失败后，该号进入熔断：`pool.breakerCooldownMs` 起（默认 60 秒）按 2 倍递增，封顶 `pool.breakerMaxMs`（默认 15 分钟）；成功一次即清零。429 仍按 `quota.cooldownOnRateLimitMs` 起做指数退避，封顶 `quota.cooldownOnRateLimitMaxMs`（默认 10 分钟）。400/401/413 和客户端主动断开不会计进熔断。

**Q：客户端报错时怎么快速定位日志？**
每个响应都带 `X-Request-Id`，错误 JSON 里也有 `request_id`；把这一串贴到面板日志搜索/`logs\server.log` 里就能找到同一次请求。`Server-Timing` 还会给流式首包（`ttfb;dur=...`）或非流式总耗时（`total;dur=...`）。

**Q：主模型被限流，能自动换备用模型吗？**
可以，在 `config.json` 里配（默认关闭）：

```json
"models": {
  "fallback": {
    "deepseek-v4.1-flash": ["deepseek-v4.1-flash-1017", "glm-5.3-flash"]
  }
}
```

主模型在 429 / 5xx / 凭据耗尽时才会兜底；400/401/413 不换模型（换了也救不了）。成功时响应头 `X-Fallback-Model` 会标明实际用的备用模型。

**Q：模型列表里有些模型打不通？**
上游网关的目录 ≠ 每个都有权限。打不通的会返回 400 `model_not_available`，
具体哪些能用见 [技术笔记](docs/技术笔记.md)。

**Q：改了 `config.json` 要重启吗？**
端口/监听地址要重启；其余在控制台点「保存」即时生效。

**Q：换了电脑（或重装系统），账号要重新登录一遍吗？**
不用。旧机器双击 `export-accounts.cmd` 导出（建议设口令），把文件拷到新机器，
双击 `import-accounts.cmd` 把文件拖进去即可，见 [四、②](#-换电脑--重装系统一键搬走全部凭证)。
**记得在旧机器上停掉这些号**——refresh_token 是一次性的，两台机器抢同一份会撞 `STS5.1806`。

**Q：数据存在哪？会上传吗？**
全在本机：`data\`（账号状态、用量、积分历史）和 `logs\`。这两个目录已在 `.gitignore` 里，
不会进仓库。服务不做任何外部上报。

---

## 七、目录结构

```
officeace2api/
├── start.cmd / stop.cmd / status.cmd      启动、停止、查看
├── install-autostart.cmd                  装成开机自启
├── open-panel.cmd                         打开控制台
├── free-port.cmd                          清理端口占用（启动不起来先双击它）
├── export-accounts.cmd                    导出全部账号凭证（换电脑用）
├── import-accounts.cmd                    在新电脑导入凭证（把文件拖到它上面）
├── accounts-backup/                       导出的搬运包落这儿（不进仓库：里面是凭据！）
├── config.json                            配置（首次启动自动生成，不进仓库）
├── src/                                   服务本体
│   ├── index.mjs       入口
│   ├── server.mjs      HTTP 路由与 API 实现
│   ├── http-utils.mjs  请求 ID / SSE 头 / JSON 响应 / 背压
│   ├── routing.mjs     会话黏性 key / Retry-After 解析
│   ├── pool.mjs        号池与轮询
│   ├── quota.mjs       积分查询 / 签到 / 熔断
│   ├── refresh.mjs     凭据自动续期
│   ├── bundle.mjs      账号搬运包（换电脑：导出/导入 + 加密 + 合并规则）
│   ├── admin.html      控制台前端（单文件）
│   └── ...
├── tools/                                 排障脚本、回归测试、看门狗
│   ├── free-port.ps1   端口占用清理（start/stop/看门狗共用同一份判断）
│   ├── watchdog.ps1    计划任务的守护载荷（崩了自动拉起）
│   └── service.ps1     计划任务安装 / 启停 / 状态
├── docs/                                  控制台截图 + 技术笔记
├── data/                                  运行期数据（不进仓库）
│   └── register-tasks.json                注册队列落盘（重启不丢任务）
└── logs/                                  日志（不进仓库；server.log 与 server.err.log 都留 3 份）
                                           另有 port-clean.log 记端口清理动作
```

---

## 八、更多

- **[docs/技术笔记.md](docs/技术笔记.md)** —— 实现原理、OAuth/PKCE 链路、
  DPAPI 解密、V11-HMAC-SHA256 签名、推理模型 token 预算、踩过的坑，都在这里。
- `node tools/smoke-test.mjs` —— 端到端自测
- `node tools/test-routing.mjs` —— 路由纯函数（7 项：显式会话 ID / system 变化不破黏性 /
  Retry-After 秒数与 HTTP 日期）
- `node tools/test-http-utils.mjs` —— HTTP 头与请求 ID（7 项：SSE 不写假 `Server-Timing` /
  有 ttfb 才写 / JSON CORS 暴露头 / 请求 ID 不重复）
- `node tools/test-stream-e2e.mjs` —— 流式链路 E2E（17 项，假上游 + 真 `createApp`：
  正常 SSE / 主模型 429 兜底 / 客户端 abort 后归还号池在途 / 400 不罚号 / 请求 ID / Server-Timing）
- `node tools/test-pool-scheduler.mjs` —— 号池调度器（20 项：会话黏性 / EWMA /
  每模型 EWMA / 在途软上限 / 短队列 / Retry-After / 调度计数）
- `node tools/test-pool-persistence.mjs` —— 号池状态持久化与熔断（21 项：5xx 连败熔断 /
  指数退避 / 429 退避 / 跨实例恢复冷却与黏性 / 状态文件不含密钥 / 损坏与过期状态兜底）
- `node tools/test-usage-cache.mjs` —— 缓存 token 统计（5 项）
- `node tools/test-admin.mjs` —— 控制台接口自测（284 项，含配置卫生：死配置检测、
  日志时间用本机时区、周期发现只在变化时说话、面板轮询后台停打、口令换 Cookie、
  上游错误体装在 SSE 帧里也要能解析出 `code`/`message`、面板载荷不许把 `usage.recent`
  整份重复装一遍、日志增量接口只回新行）
- `node tools/test-dpapi.mjs` —— DPAPI 解密链（13 项，起子进程真解密：真 blob 往返 /
  缓存 / 连续失败进冷却）
- `node tools/test-register.mjs` —— 批量注册状态机（36 项，不碰网络：去重 / 暂停不跑 /
  `view()` 脱敏 / 落盘与恢复）
- `node tools/test-logger.mjs` —— 日志落盘与滚动（16 项：留 3 代历史 / 本机时间列 vs
  UTC 的 `ts` / `keepRecent` 裁剪 / debug 按级别挡 / 序号单调递增 /
  `getLogsSince()` 只回新行、无新增回空、序号倒退时回尾部）
- `node tools/test-tps.mjs` —— 日志里 `tps`（输出 token/秒）的算法（11 项：只用
  `completion_tokens` 不掺提示词 / 分母从首字算起 / 窗口太短给 `null` 而不是 0 / 缺数据不猜）
- `node tools/test-logfmt.mjs` —— 对话日志一行式格式（17 项：字段顺序 / 缺值一律 `-` /
  UA 里的换行与引号不许把一行拆开 / 超长截断 / `::ffff:` 前缀剥掉 / 重试才出现 `try=N`）
- `node tools/test-max-tokens.mjs` —— 推理预算改写规则的单元测试（71 项）
- `node tools/test-account-bundle.mjs` —— 账号搬运包（76 项，全在临时目录里跑：加密往返 /
  口令错与篡改都必须失败 / 过期凭据被丢掉 / 死名单并集 / 「本机有活链就不被覆盖」/
  「导回原机器不长出假身份」/ 老的 `oauth-accounts.json` 也能导 / 备份只留最新 3 份）
- `node tools/test-backup-prune.mjs` —— 搬运包与导入备份的清理（30 项，真跑两个 CLI：
  不超上限就一个都不删 / 刚写出来的那份必须保住（mtime 相同也保）/ 删的是最老的 /
  `--check` 一个字节都不写 / 非交互时不许弹资源管理器 / 真 `data\` 不许被碰）
- `node tools/test-discover-switch.mjs` —— 「要不要扫本机」开关 `discover.enabled`（12 项，
  正反两面对照：开着时假 home 里的号扫得出来 / 关掉后连本机真实安装目录也一个都不读 /
  关掉后 `/healthz` 说 0 个账号且手工上游照旧能转发 / 拨回去又能扫到）
- `node tools/test-models.mjs` —— 模型注册表的大小写与去重（14 项：大小写归一 / 上游给
  同一模型两个拼法时只留一条 / 未知名字不许被"造"出来 / 别名与隐藏也大小写不敏感）
- `node tools/test-exports.mjs` —— 源码卫生：`src` 里每个 `export` 都必须有人消费（9 项；
  含四个"这套判定本身还活着吗"的对照：一定被 import 的名字 / 编造的名字 /
  多行 import 里的名字 / 消费者索引规模）
- `node tools/test-model-probe.mjs` —— 模型可用性探测的单元测试（54 项，含 **4b**：
  号池没变时只复核"打不通"的那批 —— 上游后来开了权限要能自己放回 `/v1/models`）
- `node tools/test-authflow-poll.mjs` —— 一键授权的轮询节奏测试（27 项，把 `node:https` 换成假的**数请求次数**：
  未到点不碰云端 / 四路并发只发一次 / 被限流就指数退避到 60 秒封顶 / 「还没好」不许被记成事件）
- `node tools/stress-deep41.mjs` —— 大批量压测：长会话 / 长上下文 / 高并发 / 全模型混打（会真花额度，`--all` 拉满）
- `node tools/diag-empty-window.mjs` —— 撞「推理吃光预算、正文为空」那个窗口
- `node tools/diag-upstream-limits.mjs` —— 摸上游的两条上限：messages 5000 条 / token 窗口
- `node tools/diag-body-too-large.mjs` —— 超大请求体应该回 413 而不是 429
- `node tools/diag-admin-auth.mjs` —— 核对面板鉴权（不带 / 对 / 错口令，以及 ?token= 那条路）
- `node tools/diag-portability.mjs` —— 看 data/ 里的凭据形态（判断能不能拷贝给别人）
- `node tools/diag-local-daily.mjs` —— **本机日常自用体检**：七个菜单的真实接口 + 面板调的路径是否都存在
- `node tools/diag-panel-api.mjs` —— **把面板的 `api()` 抠出来真跑**（验 `{json:{…}}` 和 `{json:true, body}` 两种写法）
- `node tools/diag-fresh-clone.mjs` —— **模拟别人 clone 下来**：只拷 git 跟踪的文件到干净目录起服务
- `node tools/diag-ghost-accounts.mjs` —— 证明 `labels` 不会造出"幽灵账号"

---

## 九、参与贡献

欢迎改进本项目！三条路：

- **只是想问问题 / 聊玩法** → 去
  [Discussions](https://github.com/Q-shuang-dot/officeace2api/discussions)，
  不适合开 Issue 的内容放这里。
- **反馈 Bug / 提建议** → 直接开
  [Issue](https://github.com/Q-shuang-dot/officeace2api/issues/new/choose)，
  有对应模板，不用写代码。
- **想改代码** → 先读 **[CONTRIBUTING.md](CONTRIBUTING.md)**，再 Fork → 建分支 → 提 PR。

> ⚠️ 动手前务必确认三条硬规矩：**零 npm 依赖**、**`.cmd` 必须纯 ASCII 无 BOM**、
> **`data/` 和 `logs/` 不许进提交**。详见 CONTRIBUTING.md 第一节。

> 🔐 发现的是**安全漏洞**（凭据泄漏、鉴权绕过等）请走
> [私下报告](https://github.com/Q-shuang-dot/officeace2api/security/advisories/new)，
> 不要开公开 Issue。

---

## License

[MIT](LICENSE)
