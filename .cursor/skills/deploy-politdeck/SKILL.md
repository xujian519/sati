---
name: deploy-politdeck
description: Clone, build, configure and run the PolitDeck repo end-to-end — both the gateway backend (src/cli/pilotdeck.ts server) and the web UI (ui/). Use when the user asks how to deploy / run / start / 跑起来 / 部署 PolitDeck, brings up a fresh checkout, switches between dev mode and production mode, or hits startup errors around ports 3001 / 5173 / 18789, ~/.pilotdeck/pilotdeck.yaml, ~/.edgeclaw/config.yaml, EDGECLAW_API_KEY, node-pty / better-sqlite3 native build, or vite proxy /api /ws.
---

# Deploy PolitDeck

PolitDeck 仓库里 **同时存在两条** 启动路径，必须先帮用户确认走哪条：

| 模式 | 入口 | 端口 | 何时用 |
| --- | --- | --- | --- |
| **A. 一体化** | `node dist/src/cli/pilotdeck.js server` | 18789 | 生产 / 演示 / 只想跑起来 |
| **B. 分离开发** | `cd ui && npm run dev`（concurrently: server 3001 + vite 5173）| 3001 + 5173 | 改 React 代码、要 HMR |
| **B'. ui 准生产** | `cd ui && npm run start`（build + server 3001）| 3001 | 还依赖 `ui/server/routes/*` 旧 REST |

模式 A 是 `docs/old-ui-adaptation/04-implementation-plan/` 系列文档的目标态，最终会替换 B；现阶段两条并存。

## 先决条件

- macOS / Linux，node **v22**（`ui/.nvmrc`、根 `package.json`）
- `git`、`npm`
- 编译 native 模块需要：`python3` + Xcode CLT（`xcode-select --install`），否则 `ui/` 的 `node-pty` / `better-sqlite3` 安装失败
- 一个可达的 LLM provider（OpenAI 兼容 / Anthropic / litellm 等），手头要有 base URL + API key + model 名

## 1. 拉取代码

```bash
git clone git@github.com:Gucc111/PolitDeck.git
cd PolitDeck
nvm use            # 读 ui/.nvmrc → v22；没有 nvm 就自己装 node 22
```

## 2. 安装 + 编译内核（A 和 B 都要做）

```bash
# 根目录 — 编译 PolitDeck 内核到 dist/
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

### 3.1 `~/.pilotdeck/pilotdeck.yaml`（A 必备，B 也走它做 model 调用）

最小化模板（按你的 provider 改）：

```yaml
agent:
  model:
    provider: openai            # openai | anthropic | litellm | ccr ...
    model: gpt-4o-mini          # 你的真实 model id
```

API key 走环境变量或 keychain，详见 `docs/pilot-config/`。

### 3.2 `~/.edgeclaw/config.yaml`（**仅 B / B' 需要**）

`ui/server/load-env.js` 会从这里读取并注入到 `process.env`。最低要求：

```yaml
EDGECLAW_API_BASE_URL: https://api.openai.com/v1
EDGECLAW_API_KEY: sk-...
EDGECLAW_MODEL: gpt-4o-mini
```

或者直接用 shell `export`（`vite.config.js` 的 `loadEnv` 会让 `process.env` 覆盖文件）。

## 4. 启动

### 模式 A · 一体化生产

```bash
# 先把前端打包到 ui/dist
cd ui && npm run build && cd ..

# 启动 gateway（默认 18789，可 --port 覆盖）
node dist/src/cli/pilotdeck.js server --port 18789
```

成功输出：

```
PilotDeck server listening: http://127.0.0.1:18789
WebSocket: ws://127.0.0.1:18789/ws
Token: <path>
```

浏览器访问 `http://127.0.0.1:18789`。

> 之后只改前端时：重跑 `cd ui && npm run build`，gateway 进程 **不需要重启**（只是静态文件 serve）。

### 模式 B · 开发模式（HMR）

```bash
cd ui
npm run dev        # concurrently: node server/index.js (3001) + vite (5173)
```

浏览器开 `http://localhost:5173`。Vite 把 `/api` `/memory-dashboard` `/ws` `/shell` 反向代理到 `http://localhost:3001`（见 `ui/vite.config.js`）。

可选环境变量：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `SERVER_PORT` | 3001 | bridge 后端端口 |
| `VITE_PORT` | 5173 | Vite dev 端口 |
| `HOST` | 0.0.0.0 | 监听地址 |
| `CLOUDCLI_DISABLE_LOCAL_AUTH` | 1 | 设为 `0` 启用本地账号登录 |

### 模式 B' · ui 准生产单进程

```bash
cd ui && npm run start     # = npm run build && node server/index.js (3001)
```

浏览器开 `http://localhost:3001`。

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
| A 浏览器 404 | `ui/dist/index.html` 是否存在；漏跑 `cd ui && npm run build` |
| A `PilotDeck server listening` 不打印 | `~/.pilotdeck/pilotdeck.yaml` 里 model/provider 缺失，看 stderr |
| A WS 立刻断 | provider key 无效或网络不通；server 终端会有 model error |
| B `npm install` 报 node-gyp / node-pty / better-sqlite3 | 装 `xcode-select --install` + `python3`；再跑 `cd ui && npm rebuild` |
| B 5173 转发 502 | bridge 没起来；单跑 `cd ui && npm run server`，看是否报 `Missing EdgeClaw config` → 写 `~/.edgeclaw/config.yaml` |
| B WS 不通 | `curl http://localhost:3001/api/health`；不通就是 bridge 没起 |
| Files 403 | URL 含 `..`，`resolveProject` 拒绝；用合法 projectKey |
| Cron / Always-On 不工作 | `~/.pilotdeck/pilotdeck.yaml` 是否声明 `cron:` / `alwaysOn:` 段；CLI 启动时 stderr 有 `[cron]` / `[always-on]` 行 |
| 想暴露给局域网 | A 已绑全网卡；B：`HOST=0.0.0.0 npm run dev` |

## 7. 常用单条命令速记

```bash
# 全新检出 → 一体化跑起来（模式 A）
git clone git@github.com:Gucc111/PolitDeck.git && cd PolitDeck \
  && npm install && npm run build \
  && (cd ui && npm install && npm run build) \
  && node dist/src/cli/pilotdeck.js server --port 18789

# 全新检出 → 开发模式（模式 B）
git clone git@github.com:Gucc111/PolitDeck.git && cd PolitDeck \
  && npm install && npm run build \
  && cd ui && npm install && npm run dev

# 只重建前端
cd ui && npm run build

# 只重建后端 + 重启 server
npm run build && node dist/src/cli/pilotdeck.js server --port 18789

# 健康探针（B/B'）
curl -s http://localhost:3001/api/health
```

## 8. 关键源文件索引

读这些文件确认行为，不要凭记忆：

- 入口：`src/cli/pilotdeck.ts`、`src/cli/pilotdeckServer.ts`、`src/cli/createLocalGateway.ts`
- 一体化静态资源挂载：`startPilotDeckServer({ staticAssetsPath: "ui/dist" })`
- bridge：`ui/server/index.js`、`ui/server/pilotdeck-bridge.js`、`ui/server/load-env.js`
- vite 代理：`ui/vite.config.js`
- runbook：`docs/old-ui-adaptation/04-implementation-plan/03-real-environment-runbook.md`
- 复刻规划：`docs/old-ui-adaptation/04-implementation-plan/01-web-ui-replication-development-guide.md`
