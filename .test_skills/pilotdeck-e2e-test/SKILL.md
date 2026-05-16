---
name: pilotdeck-e2e-test
description: >-
  PilotDeck 端到端测试。支持 Vanilla（零外部插件）和 Full（含路由插件）两种模式。
  覆盖 npm install、build、gateway 启动、健康检查、WebSocket API 测试、
  Agent CLI 工具调用验证。Use when the user asks to test pilotdeck, run E2E tests,
  verify the gateway and agent pipeline, or check the pilotdeck deployment.
---

# PilotDeck 端到端测试

## 前置条件

- Node.js >= 22（`ui/.nvmrc` 指定）
- npm
- native 模块编译：`python3` + Xcode CLT（`xcode-select --install`），否则 `ui/` 的 `node-pty` / `better-sqlite3` 安装失败
- 一个可达的 LLM provider（OpenAI 兼容 / Anthropic / litellm），手头有 base URL + API key + model 名

## 测试模式选择

| 模式 | 插件 | 适用场景 |
|------|------|----------|
| **Vanilla** | 0 个外部插件 | 验证核心 gateway + agent + 工具链 |
| **Full** | 路由插件 + 其他 | 验证 tokenSaver / 编排 / 完整插件栈 |

默认使用 **Vanilla 模式**，除非用户明确要求测试路由或插件。

---

## Vanilla 模式（推荐）

### Step 1: 安装依赖

```bash
cd /Users/a1/Desktop/claw/PilotDeck
npm install

cd ui
npm install
cd ..
```

验证：exit code 0，`node_modules` 和 `ui/node_modules` 存在。

### Step 2: 构建内核 + UI

```bash
npm run build

cd ui
npm run build
cd ..
```

`npm run build` 等同 `rm -rf dist && tsc -p tsconfig.json`，耗时约 1-2 分钟。

构建成功的判据：
- `dist/src/cli/pilotdeck.js` 存在
- `ui/dist/` 目录存在（前端构建产物）

### Step 3: 停掉旧进程

端口 3001（ui bridge）和 18789（gateway）可能被旧进程占用：

```bash
kill $(lsof -ti :3001) 2>/dev/null || true
kill $(lsof -ti :18789) 2>/dev/null || true
sleep 2

lsof -i :3001 2>/dev/null || echo "Port 3001 is free"
lsof -i :18789 2>/dev/null || echo "Port 18789 is free"
```

### Step 4: 确保 Vanilla 配置

检查 `~/.pilotdeck/pilotdeck.yaml`，确保 `extension:` 段不加载外部插件：

```yaml
schemaVersion: 1
agent:
  model: <providerId>/<modelId>
model:
  providers:
    <providerId>:
      protocol: openai          # openai | anthropic | openai-responses | litellm
      url: https://...
      apiKey: sk-...
      timeoutMs: 120000
      models:
        <modelId>:
          displayName: My Model
```

同时确保 `~/.pilotdeck/extensions/` 下没有活跃插件目录：

```bash
ls ~/.pilotdeck/extensions/ 2>/dev/null
# 应为空或只有 *.disabled 目录
```

如果有活跃插件目录：

```bash
mv ~/.pilotdeck/extensions/some-plugin ~/.pilotdeck/extensions/some-plugin.disabled
```

### Step 5: 启动（模式 B' — 当前唯一生产路径）

```bash
cd ui && npm run start
```

用 `block_until_ms: 0` 后台运行，等待 10-15 秒后检查终端输出。

**期望日志**：

```
PilotDeck Server - Ready
[INFO] Server URL:  http://localhost:3001
[TIP]  Run "pilotdeck status" for full configuration details
[pilotdeck-config-watcher] watching /Users/<you>/.pilotdeck/pilotdeck.yaml
```

**注意**：模式 A（`node dist/src/cli/pilotdeck.js server --port 18789`）是目标架构但**当前未就绪**，不要用。UI 依赖的 REST 端点（`/api/config/*`、`/api/projects` 等）只在 ui bridge 中实现。

### Step 6: 健康检查

**ui bridge 健康检查**（主要入口）：

```bash
curl -s http://localhost:3001/api/health
```

期望返回 JSON，包含连接状态信息。

**gateway 健康检查**（如果 gateway 独立启动）：

```bash
curl -s http://localhost:18789/health
```

期望返回 `{"ok":true}`。

### Step 7: WebSocket API 测试

PilotDeck gateway 不暴露 `/v1/chat/completions` 等 REST 端点。模型交互通过 **WebSocket** (`/ws`) 进行。

测试方式有两种：

**方式 A：通过 ui bridge 的 WebSocket**

浏览器打开 `http://localhost:3001`，验证：
- 首页加载，连接状态显示 `connected`
- 创建新 session 成功
- 提交消息后收到流式回复

**方式 B：通过脚本连接 WebSocket**

连接 `ws://localhost:3001/ws`，发送 `hello` + token 完成认证，然后发送 `submit_turn` RPC：

```json
{
  "id": "test-1",
  "method": "submit_turn",
  "params": {
    "sessionId": "test-session",
    "projectKey": "/tmp",
    "messages": [
      { "role": "user", "content": [{ "type": "text", "text": "你好，请简单介绍一下你自己" }] }
    ]
  }
}
```

期望：收到一系列 gateway 事件（`turn_started`、`content_delta`、`turn_ended` 等）。

### Step 8: Agent CLI 测试（工具调用验证）

**基础测试**（纯对话）：

```bash
node dist/src/cli/pilotdeck.js --message "你好，请简单介绍一下你自己"
```

**工具调用测试**（验证 exec 等内置工具）：

```bash
node dist/src/cli/pilotdeck.js --message "请执行 date 命令获取当前时间"
```

Agent 命令需要 30-60 秒完成，设置 `block_until_ms: 0` 后台运行，然后轮询终端文件。

也可以使用 TUI 模式交互测试：

```bash
node dist/src/cli/pilotdeck.js tui
```

### Step 9: 验收清单

| 检查项 | 期望 |
|--------|------|
| 首页加载 | 连接状态 `connected` |
| 左侧 Projects | 至少包含当前 cwd |
| 创建 session | 成功，可选中 |
| 提交消息 | user message 立即出现，模型流式回复合并为单条 assistant message |
| Stop 按钮 | running 时可点击，点击后流终止 |
| 刷新页面 | 历史按时间顺序加载 |
| 工具调用 | 显示 `running` → `ok` / `error` |
| 权限工具 | 弹出黄色 banner，Allow / Deny 后 banner 消失 |
| Files / Git tab | 可见、未抛 500 |

---

## Full 模式（含路由插件）

在 Vanilla 模式基础上，额外执行以下步骤。

### 恢复插件目录

```bash
mv ~/.pilotdeck/extensions/some-plugin.disabled ~/.pilotdeck/extensions/some-plugin 2>/dev/null
```

### 更新 pilotdeck.yaml 路由配置

在 `~/.pilotdeck/pilotdeck.yaml` 中添加 `router:` 段：

```yaml
router:
  scenarios:
    default: <providerId>/<defaultModel>
  tokenSaver:
    enabled: true
    judge: <providerId>/<fastModel>
    defaultTier: MEDIUM
    judgeTimeoutMs: 5000
    tiers:
      SIMPLE:
        model: <providerId>/<cheapModel>
        description: 纯打招呼、yes/no
      MEDIUM:
        model: <providerId>/<mainModel>
        description: 大部分工作
      COMPLEX:
        model: <providerId>/<strongModel>
        description: 多步任务分解
      REASONING:
        model: <providerId>/<strongModel>
        description: 数学证明、深度分析
  stats:
    enabled: true
```

### 验证路由生效

重启 ui bridge 后，发送不同复杂度的请求，检查 `~/.pilotdeck/router/stats.json` 中：

- `global.perTier` 各 tier 计数是否合理
- `global.perModel` 模型分布是否符合预期
- `sessions` 按 session 分组的详细记录

### 验证插件加载

启动日志应包含已加载的插件信息。检查 `~/.pilotdeck/extensions/` 下插件的 `plugin.json` 是否被正确读取。

---

## 关键配置文件

| 文件 | 用途 |
|------|------|
| `~/.pilotdeck/pilotdeck.yaml` | 主配置（providers, agent, router, extension 等） |
| `~/.pilotdeck/extensions/` | 全局插件自动发现目录 |
| `~/.pilotdeck/router/stats.json` | TokenStatsCollector 持久化数据（Full 模式） |

## 关键源文件

| 文件 | 用途 |
|------|------|
| `ui/server/index.js` | 当前实际运行入口（Express + WebSocket + 内嵌 gateway） |
| `ui/server/pilotdeck-bridge.js` | 内嵌 gateway 桥 |
| `ui/server/services/pilotdeckConfig.js` | 配置加载 |
| `src/cli/pilotdeck.ts` | CLI 入口（server / tui / 默认 CliChannel） |
| `src/gateway/server/GatewayServer.ts` | Gateway HTTP + WebSocket 服务 |
| `src/router/RouterRuntime.ts` | 路由运行时（tokenSaver + orchestration） |

## 常见故障

| 现象 | 排查 |
|------|------|
| onboarding "Test Connection" 报 `Unexpected token '<'` | 访问的是 18789 不是 3001（模式 A 未就绪），切到 `http://localhost:3001` |
| Save 按钮一直 disabled | 同上，Test Connection 未成功 |
| `npm install` 报 node-gyp / node-pty | 装 `xcode-select --install` + `python3`；再跑 `cd ui && npm rebuild` |
| 5173 转发 502 | bridge 没起来；单跑 `cd ui && node server/index.js`，看 stderr |
| WS 不通 | `curl http://localhost:3001/api/health` 不通说明 bridge 没起 |
