# ⚠️ 必读：OfficeAce 桌面端到底是不是必须的

## 先说结论

**不是必须的。** 装了更省事，不装也能满血用，只是少两条便利。

| 你想要 | 要桌面端吗 | 说明 |
|---|---|---|
| 加自己的号（浏览器里登录一次） | **不需要** | 面板「换个账号登录」，整条 OAuth 由本服务自己走完（`src/oauth.mjs`） |
| 自动发现本机已经登录过的号 | 需要 | 服务读 `~/.office-claw/` 里桌面端写下的凭据 |
| 面板里的「一键授权」入口 | 需要 | `/admin/api/auth/*` 是问桌面端要授权链接的老路 |
| 注册流水线注册完自动进池 | 需要（目前） | `register.mjs` 复用的就是上面那条；换成自助登录那条就能免掉 |
| 手工导入 `baseUrl` + `Authorization` | 不需要 | 面板「导入账号」 |
| 当通用 OpenAI 反代（接别的上游） | 不需要 | `config.json` 填 `upstream.baseUrl` + `upstream.authorization` |

## 桌面端存在的意义（以及它给的两条便利）

本项目的定位仍然是：**把模型网关反代成 OpenAI 接口**，只不过账号来源有两条 ——
一条是桌面端已经登录好的（读它的凭据文件），另一条是本服务自己登录的。

装了桌面端时能多拿到：

1. **自动发现**：桌面端把凭据存在 `~/.office-claw/`，服务启动就扫出来，不用手工加号；
2. **一键授权**：面板那个老入口让桌面端去换授权链接。

不装桌面端时，用面板「换个账号登录」一样能把号加进来 —— 两条路的授权链接参数是同一套
（`client_id=pdp5_for_agentarts`、`scope=openid`、云端 `redirect_uri`、PKCE + DPoP），
区别只是谁来拼这条链接。

> 2026-10 修正：本文档早先写的是「必须依赖桌面端才能正常工作」「它不是独立的 API 服务，
> 而是桌面端的伴生服务」，那是早期实现的实情，现在已经不准确 —— 自助登录这条路
> （`src/oauth.mjs` 的 LoginFlow）从不调用桌面端。

---

## 获取桌面端

**OfficeAce 桌面端**（华为云 DevEco Studio 助手）获取方式：

1. **搜索引擎**：搜索「OfficeAce」、「OfficeAce 下载」、「华为云 DevEco」
2. **应用市场**：华为应用市场、微软应用商店
3. **开发工具集成**：部分华为云开发工具（如 DevEco Studio）会集成此助手

**支持平台：**
- Windows 安装版（推荐）
- Windows 便携版
- macOS
- Linux

> 注：官方下载页面 officeace.cn/download 目前无法访问，建议通过上述渠道获取。

---

## 如果不安装桌面端会怎样？

### 问题1：「换个账号登录」失败

控制面板的「换个账号登录」按钮会触发 OAuth 授权流程，回调需要本机桌面端响应。

**错误提示：**
```
授权失败
欢迎使用OfficeAce，请返回客户端重新登录。
4s后自动关闭页面
```

### 问题2：账号池始终为空

服务启动时会扫描这些路径：
- `~/.office-claw/.jiuwenclaw/config/routing_state/users/`
- `~/.office-claw/relayclaw/jiuwenclaw/config/routing_state/users/`
- `C:/软件/OfficeAce/.office-claw/...`（便携版）

**如果没有桌面端，这些目录不存在 → 账号池为空 → API 无法转发请求。**

### 问题3：积分和健康度显示异常

即使通过其他方式添加了凭据，Token 刷新机制也依赖桌面端：
- 显示「密不可知」
- 显示「待续期」
- 积分查询失败

---

## 正确的使用流程

### 1. 安装桌面端
搜索「OfficeAce」下载并安装，或从华为应用市场获取

### 2. 在桌面端登录账号
打开 OfficeAce → 登录你的账号 → 发一条对话（确保凭据生效）

### 3. 启动 officeace2api 服务
```bash
cd D:/个人项目/officeace2api
双击 start.cmd
```

服务会自动扫描桌面端的凭据。

### 4. 查看账号池
```bash
双击 open-panel.cmd
```

在控制面板的「账号池」页，你应该能看到刚才在桌面端登录的账号。

---

## 常见问题

### Q: 我能不能不装桌面端？

**A:** 理论上可以，但需要：
1. 自己抓包获取 OfficeAce 的 `baseUrl` 和 `Authorization` header
2. 手工构造 `~/.office-claw/` 目录下的配置文件
3. 自己实现 token 刷新逻辑

**工作量很大，强烈不推荐。** 直接装桌面端只需 5 分钟。

### Q: 桌面端必须一直运行吗？

**A:** 不需要。
- 在桌面端登录后，凭据文件已经写入磁盘
- 关闭桌面端后，officeace2api 仍能读取这些文件
- 只有在凭据过期需要续期时，才需要再打开桌面端刷新

### Q: 我装了桌面端但账号池还是空的？

**A:** 可能原因：
1. 桌面端登录了但没发过对话（凭据未生效）
2. 桌面端安装在非标准位置（设置 `OFFICEACE_INSTALL_DIR` 环境变量）
3. 服务需要重启才能扫到（双击 `stop.cmd` 再 `start.cmd`）

### Q: 显示「授权失败」怎么办？

**A:** 确保：
1. 桌面端已安装并至少登录过一次
2. 在控制面板点「换个账号登录」前，桌面端处于运行状态
3. 或者直接在桌面端登录，然后重启 officeace2api 服务（更简单）

---

## 技术细节

officeace2api 读取的关键文件：

```
~/.office-claw/
├── .jiuwenclaw/
│   └── config/
│       └── routing_state/
│           └── users/
│               └── <账号ID>/
│                   ├── models.json       # 凭据和模型列表
│                   └── oauth-login.json  # OAuth token
└── users/
    └── <账号ID>/
        └── model.json  # 模型目录
```

这些文件由 OfficeAce 桌面端生成和维护，包含：
- OAuth access_token 和 refresh_token
- 模型网关的 baseUrl 和 Authorization header
- 账号的积分、模型列表等元数据

---

## 总结

**记住一句话：officeace2api 是桌面端的伴生服务，不是独立服务。**

先装桌面端，再用这个项目，才是正确的打开方式。
