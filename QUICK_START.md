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
- `port`: 服务端口（默认 7864）
- `apiKeys`: API密钥列表（代理前端需要）

### 2️⃣ 启动服务

双击 **`start.cmd`** —— 这是主要入口！

服务会：
- 自动检查 Node.js 环境
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

## 常用命令

| 命令 | 作用 |
|------|------|
| `start.cmd` | 启动服务（推荐双击运行） |
| `stop.cmd` | 停止服务 |
| `status.cmd` | 查看服务状态 |
| `open-panel.cmd` | 打开网页控制面板 |
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

### 问题：端口 7864 已被占用

**解决：**
1. 编辑 `config.json`，修改 `port` 字段
2. 重启服务

### 问题：账号池显示为空

**原因：**
- 没有登录账号
- 本机没装 OfficeAce 桌面端

**解决：**
打开控制面板 → 「账号池」页 → 点「换个账号登录」→ 用你自己的账号登一次

## 更多信息

详见项目根目录的 [README.md](README.md)

---

**修复说明：**
- ✅ 禁用任务导致 60 秒白等的问题已修复（v1.1.0+）
- ✅ README 账号添加引导已改进
