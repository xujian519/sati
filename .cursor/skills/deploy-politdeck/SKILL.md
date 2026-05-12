---
name: deploy-politdeck
description: Clone, build, configure and run the PilotDeck repo end-to-end via the ui/server Express bridge on port 3001 (the only deployment path that currently serves the UI; the gateway-only `src/cli/pilotdeck.ts server` on port 18789 is the target architecture but not yet feature-complete). Use when the user asks how to deploy / run / start / 跑起来 / 部署 PilotDeck, brings up a fresh checkout, switches between dev mode and production mode, or hits startup errors around ports 3001 / 5173 / 18789, ~/.pilotdeck/pilotdeck.yaml, "Unexpected token '<', \"<!doctype ...\" is not valid JSON" on onboarding Test Connection, Save button stuck disabled, node-pty / better-sqlite3 native build, or vite proxy /api /ws.
---

# Deploy PilotDeck

PilotDeck 仓库里 **同时存在两条** 启动路径，但**当前只有模式 B 能跑通 UI**：

| 模式 | 入口 | 端口 | 当前状态 |
| --- | --- | --- | --- |
| **B. 分离开发** | `cd ui && npm run dev`（concurrently: server 3001 + vite 5173）| 3001 + 5173 | ✅ 当前可用，改 React 代码用，HMR 起作用 |
| **B'. ui 准生产** | `cd ui && npm run start`（build + server 3001）| 3001 | ✅ 当前可用，生产部署用这条 |
| **A. 一体化** | `node dist/src/cli/pilotdeck.js server` | 18789 | ⚠️ **目标态，尚未就绪** |

**为什么 A 还跑不通**：ui 代码依赖几十个 REST 端点（`/api/config/*`、`/api/projects`、`/api/auth/*`、`/api/git`、`/api/mcp`、`/api/memory`、`/api/skills`...），这些都只在 `ui/server/` Express bridge 里实现。`src/cli/pilotdeck.ts server` 启动的 PilotDeck gateway 只提供 `/ws` + `/api/web/*` 这两套（见 `docs/old-ui-adaptation/04-implementation-plan/01-web-ui-replication-development-guide.md`），未实现的 endpoint 全部 fallback 到 `ui/dist/index.html`。结果：前端 `fetch('/api/config').then(r => r.json())` 报 `Unexpected token '<', "<!doctype "...`，onboarding 测试连接失败，Save 按钮永远 disabled。

模式 A 要可用，必须先完成 `docs/old-ui-adaptation/04-implementation-plan/01-web-ui-replication-development-guide.md` 的全部 REST 端点复刻 + 让 ui 改成走 WebSocket / `/api/web/*`。当前阶段：**部署一律走 B 或 B'**。

## 先决条件

- macOS / Linux，node **v22**（`ui/.nvmrc`、根 `package.json`）
- `git`、`npm`
- 编译 native 模块需要：`python3` + Xcode CLT（`xcode-select --install`），否则 `ui/` 的 `node-pty` / `better-sqlite3` 安装失败
- 一个可达的 LLM provider（OpenAI 兼容 / Anthropic / litellm 等），手头要有 base URL + API key + model 名

## 1. 拉取代码

```bash
git clone git@github.com:Gucc111/PilotDeck.git
cd PilotDeck
nvm use            # 读 ui/.nvmrc → v22；没有 nvm 就自己装 node 22
```

## 2. 安装 + 编译内核（A 和 B 都要做）

```bash
# 根目录 — 编译 PilotDeck 内核到 dist/
npm install
npm run build      # 等同 rm -rf dist && tsc -p tsconfig.json

# 前端依赖
cd ui
npm install        # postinstall 会跑 scripts/fix-node-pty.js
cd ..
```

构建成功的判据：
- `dist/src/cli/pilotdeck.js` 存在
- `ui/node_modules/` 完整、`npm install` 退出码 0

## 3. 配置文件

只剩一个：**`~/.pilotdeck/pilotdeck.yaml`**。`ui/server/services/pilotdeckConfig.js` 直接读它，UI Settings 也直接读写它。`~/.edgeclaw/config.yaml` 已废弃（旧文件可删）。

最小化模板（按你的 provider 改）：

```yaml
schemaVersion: 1
agent:
  model: deepseek/deepseek-v4-pro       # 形如 "<providerId>/<modelId>"
model:
  providers:
    deepseek:                            # ← providerId，跟 agent.model 前缀一致
      protocol: openai                   # openai | anthropic | openai-responses | litellm
      url: https://api.deepseek.com/v1
      apiKey: sk-...
      timeoutMs: 120000
      headers: {}
      models:
        deepseek-v4-pro:                 # ← modelId，跟 agent.model 后缀一致
          displayName: DeepSeek V4 Pro
webui:                                   # ui/server 专用段，gateway 忽略它
  runtime:
    serverPort: 3001
    vitePort: 5173
  memory:
    enabled: true
```

写完 yaml 后第一次启动 ui server，浏览器 onboarding 步骤可跳过（已配好的话直接进主界面）。如果要改 provider/model，浏览器 Settings → Config tab 可直接编辑（背后写回同一份 yaml）。

## 4. 启动

### 模式 B' · ui 准生产单进程（**推荐 / 当前唯一生产路径**）

```bash
cd ui && npm run start     # = npm run build && node server/index.js (3001)
```

浏览器开 **`http://localhost:3001`**。

成功 banner：

```
PilotDeck Server - Ready
[INFO] Server URL:  http://localhost:3001
[TIP]  Run "pilotdeck status" for full configuration details
[pilotdeck-config-watcher] watching /Users/<you>/.pilotdeck/pilotdeck.yaml
```

### 模式 B · 开发模式（HMR，改 React 代码时用）

```bash
cd ui
npm run dev        # concurrently: node server/index.js (3001) + vite (5173)
```

浏览器开 **`http://localhost:5173`**。Vite 把 `/api` `/memory-dashboard` `/ws` `/shell` 反向代理到 `http://localhost:3001`（见 `ui/vite.config.js`）。

可选环境变量：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `SERVER_PORT` | 3001 | bridge 后端端口 |
| `VITE_PORT` | 5173 | Vite dev 端口 |
| `HOST` | 0.0.0.0 | 监听地址 |
| `CLOUDCLI_DISABLE_LOCAL_AUTH` | 1 | 设为 `0` 启用本地账号登录 |

### 模式 A · 一体化生产（**目标态，当前未就绪，不要用**）

```bash
# ⚠️ 这条目前会让 UI onboarding 抛 "Unexpected token '<', '<!doctype '..."
# 原因见 §0：gateway 当前不提供 ui 需要的 /api/config /api/auth /api/projects 等
# 等 docs/old-ui-adaptation/04-implementation-plan 完成后再考虑切到 A
node dist/src/cli/pilotdeck.js server --port 18789
```

## 5. 验收清单

按 `docs/old-ui-adaptation/04-implementation-plan/03-real-environment-runbook.md` 的精简版：

- [ ] 首页加载，连接状态显示 `connected`
- [ ] 左侧 Projects 至少包含当前 cwd
- [ ] 创建新 session，能选中
- [ ] composer 提交后 user message 立即出现，模型流式回复合并为单条 assistant message
- [ ] running 时 Stop 可点击，点击后流终止
- [ ] 刷新页面后历史按时间顺序加载
- [ ] 工具调用显示 `running` → `ok` / `error`
- [ ] 触发权限的工具弹出黄色 banner，Allow / Deny 后 banner 消失
- [ ] Files / Git tab 可见、未抛 500

## 6. 常见故障速查

| 现象 | 第一定位 |
| --- | --- |
| onboarding "Test Connection" 报 `Unexpected token '<', "<!doctype "...` | **你访问的是 18789 不是 3001**（即模式 A，gateway 不提供 onboarding 用的 REST），切到 `http://localhost:3001` |
| Save 按钮一直 disabled 不能点 | 跟上面同一个根因：Test Connection 没成功，`testStatus !== 'success'` |
| `npm install` 报 node-gyp / node-pty / better-sqlite3 | 装 `xcode-select --install` + `python3`；再跑 `cd ui && npm rebuild` |
| 5173 转发 502 | bridge 没起来；单跑 `cd ui && node server/index.js`，看 stderr |
| WS 不通 | `curl http://localhost:3001/api/health`；不通就是 bridge 没起 |
| favicon 还是旧 EC 图标 | 浏览器底层缓存。已加 `?v=pd1` cache-buster 应自动失效；不行就清 site data |
| Files 403 | URL 含 `..`，`resolveProject` 拒绝；用合法 projectKey |
| Cron / Always-On 不工作 | `~/.pilotdeck/pilotdeck.yaml` 是否声明 `cron:` / `alwaysOn:` 段 |
| 想暴露给局域网 | `HOST=0.0.0.0 node server/index.js`，注意 firewall |

## 7. 常用单条命令速记

```bash
# 全新检出 → 准生产跑起来（模式 B'，浏览器 http://localhost:3001）
git clone git@github.com:Gucc111/PilotDeck.git && cd PilotDeck \
  && npm install && npm run build \
  && cd ui && npm install && npm run build \
  && node server/index.js

# 全新检出 → 开发 HMR（模式 B，浏览器 http://localhost:5173）
git clone git@github.com:Gucc111/PilotDeck.git && cd PilotDeck \
  && npm install && npm run build \
  && cd ui && npm install && npm run dev

# 只重建前端
cd ui && npm run build

# 只重建内核
npm run build

# 重启 ui server（端口被占就先 kill）
PID=$(lsof -nP -iTCP:3001 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | head -1); [ -n "$PID" ] && kill "$PID"
cd ui && node server/index.js

# 健康探针
curl -s http://localhost:3001/api/health
```

## 8. 关键源文件索引

读这些文件确认行为，不要凭记忆：

- 当前实际运行入口：`ui/server/index.js`（Express + WebSocket + 内嵌 PilotDeck gateway）
- 内嵌 gateway 桥：`ui/server/pilotdeck-bridge.js`
- 配置加载：`ui/server/services/pilotdeckConfig.js`、`ui/server/load-env.js`
- 模式 A 入口（**当前未就绪**）：`src/cli/pilotdeck.ts`、`src/cli/pilotdeckServer.ts`、`src/cli/createLocalGateway.ts`
- vite 代理：`ui/vite.config.js`
- 复刻规划（"以后怎么让模式 A 可用"）：`docs/old-ui-adaptation/04-implementation-plan/01-web-ui-replication-development-guide.md`
- 运行验收清单：`docs/old-ui-adaptation/04-implementation-plan/03-real-environment-runbook.md`
