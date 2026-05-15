---
name: xiaohongshu-login
description: "小红书登录与会话管理技能。通过 PilotDeck 内置 browser-use MCP 打开小红书，完成扫码登录、验证登录状态、检测会话过期并引导重新登录。"
---

# 小红书登录技能

负责小红书账号的登录、会话验证与状态恢复，为其他小红书运营技能提供已登录的浏览器环境。

## 核心规则

- 所有浏览器操作通过 PilotDeck 内置 browser-use MCP（Playwright）完成。
- PilotDeck 中浏览器工具名带 `mcp__browser-use__` 前缀（如 `mcp__browser-use__browser_navigate`）。下方步骤使用简写，实际调用时请从可用工具列表中确认完整名称。
- 优先用 `browser_evaluate` 检测页面状态，关键节点才做 `browser_take_screenshot` 或 `browser_snapshot`。
- 每个动作最多重试 1 次，第二次失败切稳健路径并汇报用户。

## 1) 登录流程

### 1.1 启动浏览器并打开小红书

使用 browser-use MCP 导航到目标页面：

```
browser_navigate → url: "https://creator.xiaohongshu.com"
```

等待页面加载完成（最多 15 秒）。

### 1.2 判断登录状态

用 `browser_evaluate` 检测页面特征：

- **已登录**：页面包含用户昵称、创作者中心导航栏（笔记管理、数据看板等），URL 为 `creator.xiaohongshu.com` 且无登录弹窗。
- **未登录 / 会话过期**：出现扫码登录页面、登录弹窗，或被重定向到登录页。

### 1.3 已登录 → 提取账号信息

用 `browser_evaluate` 提取：

| 字段 | 来源 |
|------|------|
| 昵称 | 页面顶部或侧边栏用户名 |
| 小红书号 | 个人信息区域 |
| 粉丝数 | 数据概览 |
| 关注数 | 数据概览 |
| 获赞与收藏 | 数据概览 |

做一次 `browser_screenshot` 记录登录状态，作为确认证据。

输出格式：

```
✅ 登录状态正常
昵称: xxx
小红书号: xxx
粉丝: xxx | 关注: xxx | 获赞与收藏: xxx
```

### 1.4 未登录 → 引导扫码

1. 确认扫码二维码可见（`browser_screenshot` 截图发给用户）。
2. 明确告知用户：**"请用小红书 App 扫描屏幕上的二维码完成登录"**。
3. 每隔 10 秒用 `browser_evaluate` 检测页面是否已跳转到创作者中心（最多等待 120 秒）。
4. 检测到登录成功后，按 1.3 步骤提取账号信息并确认。
5. 超时未登录：告知用户"扫码超时，请重新触发登录流程"。

## 2) 会话验证（快速检查）

当其他技能需要确认登录态时调用，不执行完整登录流程：

1. `browser_navigate` → `https://creator.xiaohongshu.com`（复用已有 tab）。
2. `browser_evaluate` 检测是否存在用户昵称或创作者导航。
3. 有 → 返回 `✅ 会话有效`。
4. 无 → 返回 `❌ 会话已过期，需要重新登录`，并自动触发 1.4 扫码流程。

## 3) 故障处理

| 故障 | 处理 |
|------|------|
| 浏览器未启动 | browser-use MCP server 未配置，告知用户检查 `pilotdeck.yaml` 中的 MCP 配置 |
| 页面加载超时 | 等待 5 秒后重试一次，仍失败则报告网络问题 |
| 二维码无法显示 | `browser_screenshot` 截图给用户，建议刷新页面或检查网络 |
| browser-use MCP 不可用 | 告知用户"浏览器工具未启用"，引导在 `pilotdeck.yaml` 配置 browser-use MCP server |

## 4) 其他登录入口

除创作者中心外，以下页面也可用于登录验证：

- `https://www.xiaohongshu.com` — 小红书主站
- `https://creator.xiaohongshu.com/publish/publish` — 发布页（需已登录）

默认使用创作者中心作为登录入口，因为它登录后信息最完整、状态最直观。

## 5) 运行经验

### 浏览器启动时序

- browser-use MCP 首次调用时会启动 Playwright chromium 实例
- 首次启动可能需要额外 3-5 秒初始化
- 工具实际名称示例：`mcp__browser-use__browser_navigate`、`mcp__browser-use__browser_evaluate`、`mcp__browser-use__browser_take_screenshot`、`mcp__browser-use__browser_snapshot`

### 模型行为注意

- 使用 Opus 系模型时，login skill 的 evaluate/screenshot 调用可能被模型"省略"——模型输出"已检测登录状态"但实际没有调用工具
- **必须严格遵守"每步必须真实 tool call"约束**，不可在文本中假装完成了操作

### Session 与 Cookie 复用

- Playwright browser 的 cookie 在 browser-use MCP server 生命周期内持久化
- 长时间不操作后小红书 session 可能过期（通常 24-48 小时），需要重新扫码
