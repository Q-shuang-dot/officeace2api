# ⚠️ 必读：关于 OfficeAce 桌面端依赖

## 核心前提

**本项目必须依赖 OfficeAce 桌面端才能正常工作。**

## 为什么需要桌面端？

本项目的设计定位是：**把本机 OfficeAce 客户端的模型网关反代成 OpenAI 接口**

核心机制：
1. 用户在 OfficeAce 桌面端登录账号（官方客户端，完整 OAuth 流程）
2. 桌面端将凭据存储在 `~/.office-claw/` 目录
3. officeace2api 服务读取这些凭据文件
4. 转换成 OpenAI 格式的 API 提供给其他客户端

**它不是独立的 API 服务，而是桌面端的"伴生服务"。**

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
