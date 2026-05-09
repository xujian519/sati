# PilotDeck Adapter / Gateway 重构代码开发文档

本文用于指导 PilotDeck 的 `gateway` 与 `adapters/` 两层落地。它定义入口拓扑、进程模型、Gateway 公共协议、WebSocket 帧协议、ChannelAdapter 协议、Session 路由规则，以及第一阶段实施范围。

本文遵循 `.cursor/skills/refactor-with-parity` 的要求：不能声称“与旧实现行为一致”，除非存在同一套共享场景同时运行 legacy 和 PilotDeck 实现，并比较归一化输出。本模块的特殊点是：`third-party/claude-code-main` 没有 gateway / adapter 概念，因此本文档不以 claude-code 为 parity 基准；而是把 `~/edgeclaw-opc/openclaw` 作为结构参考，并明确 PilotDeck 第一阶段不抄哪些复杂度。

## 1. 背景与边界

总方案 `docs/rewrite-plan/02-rewrite-project-report.md` 已经把 `gateway/` 和 `adapters/` 列为顶层模块，并规划了 `cli/`、`tui/`、`web/`（以及保留 `sdk/`、`remote/` 的占位）。本文细化这两层的具体形态。

`gateway` 的职责：

- 暴露稳定的 `Gateway` 接口（in-process 调用与 over-WebSocket 调用使用同一接口形状）。
- 持有 `SessionRouter`，把 `sessionKey` 映射到 `AgentSession` 实例，并管理生命周期、并发、idle 回收。
- 提供 WebSocket Server（Node 端）和 WebSocket Client（Node + 浏览器端）。
- 负责本地 token 鉴权（写入 `~/.pilotdeck/server-token`）。
- 不做远程访问、TLS、设备配对、多账户、launchd / systemd 自启动。

`adapters/` 的职责：

- 把不同 channel（CLI / TUI / Feishu / Web）的输入翻译成 `Gateway.submitTurn()` 调用。
- 把 `GatewayEvent` 流翻译回该 channel 的输出形态（stdout 文本、ink 渲染、飞书消息、浏览器 UI 渲染）。
- 负责 channel 特有的 sessionKey 推导规则（如飞书 chat → general / per-`/new` 映射）。
- 不持有 agent runtime；不直接调用 `agent` / `model` / `tool`。

依赖方向：

```text
adapters/channel/cli   ──┐
adapters/channel/tui   ──┼──> gateway ──> agent ──> ...
adapters/channel/feishu──┤
adapters/web (browser) ──┘  (over-WS)
```

任何 channel 的代码不允许直接 `import` `agent` / `model` / `session` 内部实现，只能通过 `Gateway` 接口。

## 2. Source Of Truth

| 类型 | 路径 | 用途 |
| --- | --- | --- |
| 总方案 | `docs/rewrite-plan/02-rewrite-project-report.md` | gateway / adapters 顶层归属 |
| Agent 接入点 | `docs/pilotdeck-agent-refactor-development-guide.md` | `AgentSession.submit()` 接口 |
| Session 接入点 | `docs/pilotdeck-session-refactor-development-guide.md` | sessionKey、project 存储、resume |
| Context 接入点 | `docs/pilotdeck-context-refactor-development-guide.md` | 输入/附件/记忆联动 |
| Agent 实现 | `src/agent/session/AgentSession.ts` | gateway 内部调用对象 |
| Session 存储 | `src/session/storage/`、`src/session/transcript/` | 历史 / 列表 / 解析 |
| 模型层 | `src/model/` | gateway 不直接调，但配置共享 |
| 配置 | `src/pilot/config/` | gateway 端口、token、UI 静态目录 |
| 结构参考（不抄复杂度） | `~/edgeclaw-opc/openclaw/src/gateway/` | server-impl / protocol / client / ws |
| 结构参考 | `~/edgeclaw-opc/openclaw/src/tui/gateway-chat.ts` | TUI 作为 WS 客户端的形态 |
| 结构参考 | `~/edgeclaw-opc/openclaw/ui/src/ui/gateway.ts` | 浏览器端 WebSocket 客户端 |
| 反面参考（不照抄） | `third-party/claude-code-main/proxy.ts` | 旧的 Anthropic→OpenAI 反向代理；不在本模块范围 |

## 3. 当前 PilotDeck 状态

当前已有：

| Module | 路径 | 状态 |
| --- | --- | --- |
| AgentSession | `src/agent/session/AgentSession.ts` | available |
| Session storage / list / resume | `src/session/` | available |
| Pilot config loader | `src/pilot/config/` | available |
| Model layer | `src/model/` | available |
| Gateway protocol types | `src/gateway/protocol/types.ts` | available |
| In-process gateway | `src/gateway/client/InProcessGateway.ts` | available |
| SessionRouter | `src/gateway/SessionRouter.ts` | available |
| Gateway public exports | `src/gateway/index.ts` | available |
| Gateway WS protocol | `src/gateway/protocol/frames.ts` / `src/gateway/protocol/version.ts` | available |
| Gateway server | `src/gateway/server/GatewayServer.ts` | available skeleton |
| Gateway WS client / RemoteGateway | `src/gateway/client/GatewayWsClient.ts` / `RemoteGateway.ts` | available skeleton |
| CLI channel | `src/adapters/channel/cli/` | available skeleton |
| TUI channel | `src/adapters/channel/tui/` | available Ink REPL |
| Feishu channel | `src/adapters/channel/feishu/` | available skeleton |
| Web static mount + UI skeleton | `src/adapters/web/` / `ui/` | available skeleton |
| Gateway config parsing | `src/pilot/config/parseGatewayConfig.ts` | available |
| Cron management surface | `src/cron/` + `Gateway.cron*` | available |

当前还没有：

- 独立 `bin/pilotdeck-server` 可执行入口（当前 `pilotdeck server` 子命令已由 `src/cli/pilotdeck.ts` 提供）。
- 生产级飞书 API 客户端（当前为 webhook + outbound send adapter skeleton）。
- TUI 高级能力：scrollback virtual list、history search、model/session picker、permission decision 回写 method。
- UI 构建依赖安装与完整页面功能（当前为 vite/react skeleton）。

## 4. 设计取舍：UI 约束驱动的拓扑

第一原则：**浏览器无法 in-process 调用 Node 模块，因此 web UI 必须连一个常驻 server**。这条事实推翻了“每个 channel 各自启动 PilotDeck 进程”的方案，原因有两点：

1. UI 是浏览器侧，无法启动 Node 进程，必须有一个 7×24 在线的 HTTP+WS 服务可以连接。
2. 多个 channel 各自起 in-process gateway 时，活跃 session 在不同进程的内存里，UI 看不见 CLI 进程内的 session 状态，飞书也看不见 UI 的 session 状态。session 在多个 channel 之间共享必须依赖一个共同进程。

因此 PilotDeck 选择 **常驻 server + 客户端混合** 拓扑：

```
                       ┌─── 浏览器 UI            (WebSocket 客户端)
                       │
   pilotdeck server ───┼─── pilotdeck            (CLI；默认 WS 客户端，无 server 时 in-process)
   （常驻进程，         │
    端口 18789）       ├─── pilotdeck tui        (TUI；默认 WS 客户端，无 server 时 in-process)
                       │
                       └─── 飞书 webhook plugin   (作为 server 内部模块运行，不独立成进程)
```

含义：

- `pilotdeck server` 是唯一持有 SessionRouter 的进程；UI、CLI、TUI、飞书都通过它访问 session。
- CLI/TUI 作为短跑客户端；当本地 server 不可达（用户没启）时退化为 in-process 模式，保证零配置可用。
- 飞书 webhook 必须常驻才能接收消息推送，所以直接作为 server 进程内的 plugin 注册，不再独立成进程。
- UI 的静态资源由 server 在同一端口提供（vite build 产物），浏览器访问 `http://127.0.0.1:18789`。

显式不做的事情（与 OpenClaw 的差异）：

- 不做 launchd / systemd / schtasks 自启动包装。
- 不做远程访问、TLS、设备配对、device-auth。
- 不做多账户、多设备、设备 presence。
- 不做复杂 RBAC、scope、rate limit；只做单 token + localhost 绑定。
- 不做 model 反向代理（`third-party/claude-code-main/proxy.ts` 那种 Anthropic 协议伪装在 PilotDeck 里没有用武之地，模型 provider 差异已经在 `src/model/providers/` 内部消化）。

以上能力在 `Section 13` 列入 `deferred` 或 `not_applicable`。

## 5. Target 结构

```text
src/
  gateway/
    protocol/
      types.ts                 GatewaySubmitTurnInput / GatewayEvent / SessionInfo / GatewayError
      frames.ts                WsHelloFrame / WsRequestFrame / WsResponseFrame / WsEventFrame
      version.ts               PILOTDECK_GATEWAY_PROTOCOL_VERSION
    Gateway.ts                 createGateway(deps) 工厂；定义 Gateway 接口
    SessionRouter.ts           sessionKey → AgentSession，含 idle 回收和并发约束
    SessionLifecycle.ts        abort、close、resume 集中处理
    server/
      GatewayServer.ts         HTTP + WebSocketServer（绑 127.0.0.1）
      GatewayWsConnection.ts   单条 WS 的 dispatch / event push
      authToken.ts             读写 ~/.pilotdeck/server-token
      staticAssets.ts          挂载 ui/dist/ 静态文件
    client/
      InProcessGateway.ts      实现 Gateway，直接调 SessionRouter
      RemoteGateway.ts         实现 Gateway，内部走 WS
      GatewayWsClient.ts       Node 端 WS 客户端
      probeServer.ts           探测本地 server 是否可达，决定走 In-Process 还是 Remote

  adapters/
    channel/
      protocol/
        ChannelAdapter.ts      ChannelAdapter 接口与启动 deps
        types.ts               ChannelAttachment / ChannelReply 等共享类型
      cli/
        CliChannel.ts          短跑：从 stdin/argv 读输入，渲染到 stdout
        cli-render.ts          GatewayEvent → 终端文本
      tui/
        TuiChannel.ts          短跑：基于 ink，使用 GatewayClient
        tui-render.ts          GatewayEvent → ink 组件状态
      feishu/
        FeishuChannel.ts       作为 server plugin 注册；webhook → submitTurn
        FeishuSessionMapper.ts chat → general / per-/new sessionKey
        feishu-render.ts       GatewayEvent → 飞书消息（流式 edit）
    web/
      static-mount.ts          server 启动时把 ui/dist/ 挂上
      browser-client/          （未来从 ui/ 引用的 npm-style 浏览器客户端，本阶段空目录）

ui/                            前端 web app
  package.json
  vite.config.ts
  src/
    main.ts
    gateway-browser-client.ts   浏览器版 GatewayClient
    components/
    routes/
```

依赖：

- `gateway/server/` 仅在 `pilotdeck server` 入口被引用。
- `gateway/client/InProcessGateway.ts` 直接依赖 `agent` / `session`。
- `gateway/client/RemoteGateway.ts` 不依赖 `agent` / `session`，只依赖 `gateway/protocol/`。
- `adapters/channel/*` 仅依赖 `gateway/Gateway.ts` 与 `gateway/protocol/`。

## 6. Public Protocol：Gateway 接口

`Gateway` 是所有 channel 的唯一调用面，在 in-process 与 over-WS 两种场景下形状一致。所有参数和返回值必须是可 JSON 序列化的纯数据：禁止传 callback、class instance、function reference。

```ts
export interface Gateway {
  submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent>;
  abortTurn(input: { sessionKey: string; runId?: string }): Promise<void>;
  listSessions(input: ListSessionsInput): Promise<ListSessionsResult>;
  resumeSession(input: { sessionKey: string }): Promise<{ sessionKey: string }>;
  newSession(input: NewSessionInput): Promise<{ sessionKey: string }>;
  closeSession(input: { sessionKey: string; reason?: string }): Promise<void>;
  describeServer(): Promise<GatewayServerInfo>;
  cronCreate(input: CronCreateInput): Promise<CronCreateResult>;
  cronList(input: CronListInput): Promise<CronListResult>;
  cronDelete(input: CronDeleteInput): Promise<CronDeleteResult>;
  cronStop(input: CronStopInput): Promise<CronStopResult>;
}

export interface GatewaySubmitTurnInput {
  sessionKey: string;
  channelKey: string;          // "cli" | "tui" | "feishu" | "web"
  message: string;
  attachments?: ChannelAttachment[];
  mode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  runId?: string;
}

export type GatewayEvent =
  | { type: "turn_started"; runId: string }
  | { type: "assistant_text_delta"; text: string }
  | { type: "assistant_thinking_delta"; text: string }
  | { type: "tool_call_started"; toolCallId: string; name: string; argsPreview?: string }
  | { type: "tool_call_finished"; toolCallId: string; ok: boolean; resultPreview?: string }
  | { type: "permission_request"; requestId: string; toolName: string; payload: unknown }
  | { type: "structured_output"; payload: unknown }
  | { type: "plan_mode_changed"; mode: "default" | "plan" | "acceptEdits" | "bypassPermissions" }
  | { type: "turn_completed"; usage: TurnUsage; finishReason: string }
  | { type: "error"; message: string; code?: string; recoverable: boolean };
```

要点：

- `submitTurn` 返回 `AsyncIterable<GatewayEvent>`。in-process 直接 yield；over-WS 时由 server 把 yield 序列化为 `WsEventFrame`，client 端 `RemoteGateway` 收到后还原成 iterable。channel 业务代码不感知传输形态。
- `runId` 由 channel 提供（缺省时 gateway 生成），后续 `abortTurn` 使用。
- `sessionKey` 是 channel 给定的稳定字符串，gateway 不解析其语义，只做映射缓存与并发约束。
- 并发约束：同一 `sessionKey` 同一时刻只有一个 in-flight turn。第二次 `submitTurn` 在前一个未完成时直接返回 `error/code: "session_busy"`，由 channel 决定排队、丢弃或回写忙碌信息。
- 不暴露 `AgentSession` 实例到外部；任何对话状态以 `sessionKey` 引用。

## 7. WebSocket 帧协议

OpenClaw 的协议复杂度（agents、devices、talk-config 等）是其多设备、远程访问场景的产物。PilotDeck 当前 WS protocol 保留 Gateway 所需的对话/session 方法，并加入 server 内 Cron 管理面：`submitTurn`、`abortTurn`、`listSessions`、`resumeSession`、`newSession`、`closeSession`、`describeServer`、`cronCreate`、`cronList`、`cronDelete`、`cronStop`，外加握手。

```ts
export const PILOTDECK_GATEWAY_PROTOCOL_VERSION = "1.0";

export type WsHelloFrame = {
  type: "hello";
  protocolVersion: string;
  clientName: "cli" | "tui" | "web" | "feishu" | "test";
  clientVersion: string;
  token: string;
};

export type WsHelloOk = {
  type: "hello_ok";
  protocolVersion: string;
  serverVersion: string;
  serverInfo: GatewayServerInfo;
};

export type WsRequestFrame = {
  type: "request";
  id: string;
  method:
    | "submit_turn"
    | "abort_turn"
    | "list_sessions"
    | "resume_session"
    | "new_session"
    | "close_session"
    | "describe_server"
    | "cron_create"
    | "cron_list"
    | "cron_delete"
    | "cron_stop";
  params: unknown;
};

export type WsResponseFrame = {
  type: "response";
  id: string;
  ok: true;
  result: unknown;
} | {
  type: "response";
  id: string;
  ok: false;
  error: { code: string; message: string };
};

export type WsEventFrame = {
  type: "event";
  id: string;          // 关联 request.id（用于 submit_turn 流式事件）
  seq: number;         // 单调递增
  final: boolean;      // 流末尾标记
  event: GatewayEvent;
};
```

握手流程：

1. 客户端连接 `ws://127.0.0.1:18789/ws`，立即发送 `WsHelloFrame`。
2. server 校验 `protocolVersion` 匹配、`token` 与 `~/.pilotdeck/server-token` 一致；不一致则关闭连接并返回 4001/4003。
3. server 回 `WsHelloOk`，连接进入工作状态。
4. 之后所有交互走 `request/response` 与 `event` 帧。

流式事件约定：

- `submit_turn` 不返回 `WsResponseFrame`；它的 `WsRequestFrame.id` 用作多个 `WsEventFrame` 的关联 id。
- 最后一个 `WsEventFrame` 的 `final: true` 标记结束；之后 server 不会再以该 id 发事件。
- 客户端 `RemoteGateway` 在 `final: true` 时关闭对应 iterator。
- 异常终止时 server 发一个 `event: { type: "error", ... }` 后立即 `final: true`。

## 8. SessionRouter 与 sessionKey 语义

`sessionKey` 是 channel 提供的稳定字符串，**约定 namespace 由 channel 决定**：

| Channel | sessionKey 模板 | 含义 |
| --- | --- | --- |
| CLI | `cli:project=<projectKey>:default` | 同一 project 默认共享一个 session |
| TUI | `tui:project=<projectKey>:default` | 与 CLI 不冲突 |
| TUI/CLI 用户执行 `/new` | `tui:project=<projectKey>:s_<uuid>` | 切换到独立 session |
| Feishu 默认 | `feishu:chat=<chatId>:general` | 同 chat 共享一个 general session |
| Feishu `/new` 之后 | `feishu:chat=<chatId>:s_<uuid>` | 直到下次 `/new`，该 chat 的后续消息走新 session |
| Web | `web:project=<projectKey>:s_<uuid>` | UI 自管 sessionKey；新建时由 UI 生成 uuid |

`projectKey` 当前按本地项目根目录解析。同一个 server 内部会按规范化后的 `projectRoot` 缓存独立 project runtime，包括项目级配置、模型 runtime、agent cwd 和 transcript 存储；如果请求没有提供 `projectKey`，server 使用启动时的默认项目根。

`SessionRouter` 负责：

```ts
class SessionRouter {
  async getOrCreate(sessionKey: string, ctx: { projectKey: string; channelKey: string }): Promise<AgentSession>;
  async abort(sessionKey: string, runId?: string): Promise<void>;
  async close(sessionKey: string): Promise<void>;
  async list(projectKey: string): Promise<SessionInfo[]>;
}
```

行为：

- 第一次见到 `sessionKey` → 通过 `src/session/storage/` 检查磁盘是否有同 key 的 transcript；有则 resume，无则新建。
- 内存缓存活跃 `AgentSession`；空闲超阈值（默认 30 分钟）后主动 `close` 并释放内存，状态以 transcript 持久化为主。
- 同 `sessionKey` 已有 in-flight turn 时拒绝并发提交。
- `abort(sessionKey)` 直接调用 `AgentSession.abort()`。

## 9. ChannelAdapter 协议

```ts
export interface ChannelAdapter {
  readonly channelKey: string;

  start(deps: ChannelStartDeps): Promise<ChannelHandle>;
}

export interface ChannelStartDeps {
  gateway: Gateway;
  config: PilotConfig;
  logger: Logger;
}

export interface ChannelHandle {
  stop(reason?: string): Promise<void>;
}
```

ChannelAdapter 不暴露同步操作；任何 channel 的输入路径最终都收敛到一次 `gateway.submitTurn()` 调用，输出路径是消费 `AsyncIterable<GatewayEvent>` 流。

## 10. Channel 设计

### 10.1 CLI

- 短跑进程：`pilotdeck "提示词"` 一次性问答；不带参数时进入交互式逐行模式直到 `Ctrl-D`。
- 启动时调用 `probeServer()` 探测 `127.0.0.1:18789`：可达则用 `RemoteGateway`；不可达则 `InProcessGateway`，提示一次“未连接 server，使用本地模式”。
- sessionKey：`cli:project=<projectKey>:default`，`projectKey` 取自当前 cwd 的 git root 或 cwd。
- 输出：`assistant_text_delta` 直接写 stdout；`tool_call_started` / `tool_call_finished` 输出为单行 status；权限请求在 stdout/stderr 提示并阻塞输入。

### 10.2 TUI

- 基于 ink；启动行为同 CLI。
- 显式支持 `/new`、`/resume <id>`、`/sessions` 三个命令；底层走 `gateway.newSession()` / `resumeSession()` / `listSessions()`。
- 渲染：单独面板显示 thinking 块，工具调用展示为可折叠卡片。

### 10.3 Feishu

- 仅在 `pilotdeck server` 进程内启动，作为 server 内部 plugin 注册。
- 通过飞书开放平台 webhook 接收事件；解析 `chat_id` 与文本，调用 `FeishuSessionMapper` 推导 sessionKey：
  - 默认 → `feishu:chat=<chatId>:general`。
  - 用户消息以 `/new` 开头 → 生成新 `s_<uuid>` 并更新 chat 的当前活跃 sessionKey 缓存（持久化到 `~/.pilotdeck/feishu-state.json`）。
- 输出：将 `assistant_text_delta` 累积，按节流（默认 800ms）`edit_message` 更新同一条飞书消息；`tool_call_*` 走简短状态行；最终消息固化展示。
- 不依赖外部 channel daemon；session 与 CLI/UI 共享。

### 10.4 Web UI

- 顶层 `ui/` 目录是独立的 vite 项目；构建产物 `ui/dist/` 由 `gateway/server/staticAssets.ts` 在同端口挂载。
- 浏览器 client `gateway-browser-client.ts` 实现 `Gateway` 的子集（仅 `submitTurn` / `abortTurn` / `listSessions` / `newSession` / `resumeSession`），通过 `WebSocket` 连 `ws://127.0.0.1:18789/ws`。
- 鉴权：UI 首次加载时从 `http://127.0.0.1:18789/auth/local-token`（仅 localhost 绑定，受 origin 校验）读取一次 token 注入 `localStorage`，后续 WS 握手使用。
- 第一阶段 UI 范围：session 列表、对话视图、新建会话、abort 按钮、流式 token 渲染。设置页、agent 配置、cron、devices 等不做。

## 11. 进程启动入口

```text
pilotdeck server          常驻；启动 GatewayServer + 飞书 plugin + UI 静态挂载
pilotdeck                 短跑 CLI；优先连 server，失败 fallback in-process
pilotdeck tui             短跑 TUI；同上
pilotdeck resume <id>     等价 `pilotdeck` + 自动 sessionKey 解析
```

`pilotdeck server` 启动时会输出端口、token 路径与可访问 URL。第一阶段不做后台化（用户自行用 `screen` / `tmux` / 终端 tab 持有进程）。

## 12. 配置

新增 `pilotdeck.yaml` 字段：

```yaml
gateway:
  port: 18789
  bindAddress: 127.0.0.1
  idleSessionTimeoutMinutes: 30
  staticAssetsPath: ./ui/dist

adapters:
  cli:
    autoConnectServer: true
  tui:
    autoConnectServer: true
  feishu:
    enabled: false
    appId:
    appSecret:
    encryptKey:
    verifyToken:
    defaultSessionLabel: general

cron:
  enabled: true
  timezone: UTC
  maxConcurrentRuns: 1
```

`gateway.bindAddress` 强制 `127.0.0.1`；写其他值时 `pilot/config` 校验阶段直接报错（防止误开公网监听）。

## 13. Feature Matrix

本模块没有传统的 legacy parity 关系（claude-code 没有 gateway 概念）。下表用 `compare` / `intentional_difference` / `deferred` / `not_applicable` 标识相对 OpenClaw 的取舍。

| 能力 | OpenClaw 行为 | PilotDeck 第一阶段 | Status | Notes |
| --- | --- | --- | --- | --- |
| 本地 WS gateway server | http+ws on 18789 | http+ws on 18789，localhost 绑定 | `compare` | 协议子集 |
| 协议帧（hello/request/response/event） | 复杂 schema + ajv 校验 | Gateway 对话/session method + Cron 管理 method，ajv 可选 | `intentional_difference` | 防止协议过早膨胀 |
| 浏览器 UI | lit + WebSocket | vite UI + WebSocket | `compare` | 框架由 PilotDeck 自选 |
| TUI 作为 WS 客户端 | gateway-chat.ts | 与 OpenClaw 同形态 | `compare` | API 接口对齐 |
| CLI 作为 WS 客户端 | acp-cli + gateway client | 同上 | `compare` | |
| Channel plugin（飞书等） | 注册到 daemon | 注册到 server 进程 | `compare` | 飞书内置在 server |
| WhatsApp / Slack / iMessage / Discord channel | 多 channel | 不实现 | `not_applicable` | 范围外 |
| launchd / systemd 自启动 | daemon 包装 | 用户手动启动 server | `deferred` | 第二阶段以后 |
| 远程访问 / TLS | server-tailscale / TLS / device-pairing | 仅 localhost | `deferred` | |
| 多设备 / device-auth | device-identity / pairing | 单机单 token | `deferred` | |
| 多账户 / RBAC / scope | role-policy / scopes | 单 token | `deferred` | |
| Rate limit | auth-rate-limit | 第一阶段不做 | `deferred` | |
| Model 反向代理（Anthropic 协议入口） | proxy.ts (claude-code) | 不做 | `not_applicable` | 模型差异由 `src/model/providers/` 内部消化 |
| Cron / scheduled jobs | server-cron | `src/cron` server 内 runtime + Gateway 管理面 | `compare` | 不引入独立 daemon |
| Tools-invoke HTTP / hooks-mapping HTTP | tools-invoke-http | 不做 | `deferred` | |
| Canvas-host | canvas-host | 不做 | `deferred` | |
| 浏览器扩展 / native bridge | extensions | 不做 | `deferred` | |
| Auto-reply | auto-reply module | 不做 | `deferred` | |
| Memory module（与 channel 联动部分） | 部分嵌入 channel-config | 已规划在 `src/context/memory/` | `compare` | 走 context |
| Session metadata（ai title / tag / mode） | session-utils | 已在 `src/session/metadata/` | `compare` | gateway 透传 |
| Session listing | server-sessions | 通过 `Gateway.listSessions` | `compare` | |
| Resume | server-sessions resume | `Gateway.resumeSession` | `compare` | |
| Session 并发约束 | server-lanes | SessionRouter 单 turn 互斥 | `compare` | |
| Idle session 回收 | server runtime | SessionRouter 30min 默认 | `compare` | |
| 权限请求转发到 channel | exec-approval-manager | `permission_request` event | `compare` | 第一阶段仅 CLI/TUI 阻塞输入；UI 弹窗 |
| 流式 thinking 块 | agent-event-assistant-text | `assistant_thinking_delta` | `compare` | 已通过 model layer |
| 结构化输出 / plan mode 事件 | n/a | `structured_output` / `plan_mode_changed` | `intentional_difference` | PilotDeck 显式事件化 |

## 14. 实施阶段

每个阶段都必须：（a）实现协议+实现+单测，（b）补 fixture，（c）跑 `npm run build` + `npm test` 通过。

### 阶段 A：Gateway Skeleton（无网络）

当前状态：已完成。`src/gateway/protocol/types.ts`、`src/gateway/SessionRouter.ts`、`src/gateway/Gateway.ts`、`src/gateway/client/InProcessGateway.ts` 和 `src/gateway/index.ts` 已落地；`tests/gateway/session-router.test.ts` 与 `tests/gateway/in-process-gateway.test.ts` 已覆盖缓存、并发、idle 回收和基础事件映射。

1. `src/gateway/protocol/types.ts`：`Gateway` 接口、`GatewaySubmitTurnInput`、`GatewayEvent`、`SessionInfo`、`GatewayError`、`GatewayServerInfo` 全部纯类型。
2. `src/gateway/SessionRouter.ts`：实现 `getOrCreate` / `abort` / `close` / `list`，使用 `src/session/storage/` 读写。
3. `src/gateway/Gateway.ts`：`createGateway(deps)` 工厂，组合 SessionRouter + 依赖注入。
4. `src/gateway/client/InProcessGateway.ts`：直接调 SessionRouter；产出 `AsyncIterable<GatewayEvent>`。
5. `src/gateway/index.ts`：公共导出。
6. 单测：`tests/gateway/sessionRouter.test.ts`、`tests/gateway/inProcessGateway.test.ts`。

### 阶段 B：CLI Channel（in-process 模式优先）

当前状态：已完成 skeleton。`CliChannel` 已实现 remote-first：默认先通过 `probeGatewayServer()` / `connectRemoteGatewayIfAvailable()` 连接本地 server，失败后才 fallback 到传入的 in-process gateway；`tests/adapters/channel-cli.test.ts` 覆盖 argv 输入、sessionKey 推导与事件渲染。

1. `src/adapters/channel/protocol/ChannelAdapter.ts`：`ChannelAdapter` 接口与启动 deps。
2. `src/adapters/channel/cli/CliChannel.ts`、`cli-render.ts`：从 stdin/argv 读输入；用 InProcessGateway 跑通端到端问答。
3. `bin/pilotdeck.ts`：CLI 入口，接 `pilotdeck "..."` 与交互模式。
4. 单测：`tests/adapters/cli.channel.test.ts`（mock gateway）。

### 阶段 C：Gateway WS Server + Client + 鉴权

当前状态：已完成 skeleton。已实现 `frames.ts` / `version.ts`、`GatewayServer`、`GatewayWsConnection`、`authToken`、`staticAssets`、`GatewayWsClient`、`RemoteGateway` 与 `probeServer`。`tests/gateway/remote-gateway.test.ts` 使用真实 HTTP+WebSocket server 验证 RemoteGateway 流式事件链路。

1. `src/gateway/protocol/frames.ts` + `version.ts`。
2. `src/gateway/server/authToken.ts`：第一次启动生成随机 token 并写入 `~/.pilotdeck/server-token` 0600。
3. `src/gateway/server/GatewayServer.ts`：`startGatewayServer({ port, host: "127.0.0.1" })`；HTTP 仅暴露 `/health`、`/auth/local-token`、UI 静态资源、WS 升级 `/ws`。
4. `src/gateway/server/GatewayWsConnection.ts`：握手、dispatch、把 `submitTurn` 的 iterable 推为 `WsEventFrame`。
5. `src/gateway/client/GatewayWsClient.ts`：Node 端 WS 客户端；
6. `src/gateway/client/RemoteGateway.ts`：实现 `Gateway` 接口，`submitTurn` 把 server 推回的事件还原成 iterable。
7. `src/gateway/client/probeServer.ts`：探测可达性（HTTP `/health` ping，超时 200ms）。
8. `src/cli/pilotdeck.ts`：`pilotdeck server` 入口。
9. 集成测：起 server → CliChannel 用 RemoteGateway 跑通完整 turn → server 退出 client 收到 error。

### 阶段 D：CLI/TUI 自动连接

当前状态：已完成可启动 Ink TUI。`CliChannel` 和 `TuiChannel` 均走 remote-first / fallback-in-process 路径；`TuiChannel` 已接入 `ink` + `react` + `ink-text-input`，采用与 `third-party/claude-code-main` 一致的 REPL 形态：轻量 header、空态 welcome card、真实消息 transcript、底部 `ink-text-input` prompt（自带可见 cursor 与 placeholder）、`⎿` assistant/tool 响应缩进、modal-style help。空态不再展示假对话、`Start here`、假 tool 状态或 idle/context 常驻行。全局快捷键由 `useInput` 处理（`Ctrl+C` abort/exit、`?` 切换 help、`Esc` 关弹窗），文本输入与回车提交由 `ink-text-input` 接管。品牌替换为 `PilotDeck ↗`，主题替换为深蓝。

1. `CliChannel` 在 start 时调 `probeServer()`：可达 → RemoteGateway，不可达 → InProcessGateway 并打 warning。
2. `src/adapters/channel/tui/TuiChannel.ts`：基于 ink 的最小可用 TUI，实现单 session 流式渲染。
3. 单测：probe fallback 路径、TUI render snapshot。

### 阶段 E：Web UI Skeleton

当前状态：已完成 skeleton。顶层 `ui/` 已建 vite/react 项目骨架，包含 `gateway-browser-client.ts` 和最小对话页面；`GatewayServer` 可通过 `staticAssetsPath` 挂载 `ui/dist/`。

1. 顶层新建 `ui/` 目录：`package.json`、`vite.config.ts`、`src/main.ts`、`src/gateway-browser-client.ts`。
2. `src/gateway/server/staticAssets.ts`：把 `ui/dist/` 挂在 `/` 路径。
3. UI 实现 session list、新建 session、对话流式渲染、abort 按钮。
4. UI 与 server 通过 WS 通信；token 通过 `/auth/local-token`（仅同 origin）取得。

### 阶段 F：Feishu Plugin

当前状态：已完成 skeleton。`FeishuChannel` 可作为 `GatewayServer` 的 `/feishu/webhook` handler 注册；`FeishuSessionMapper` 已实现默认 general session 和 `/new` 切换规则，`tests/adapters/channel-feishu-session-mapper.test.ts` 覆盖该规则。

1. `src/adapters/channel/feishu/FeishuChannel.ts`：注册到 server；监听飞书 webhook（路径 `/feishu/webhook`，由 `GatewayServer` 暴露）。
2. `FeishuSessionMapper.ts`：`/new` 切换 + 持久化 chat 当前活跃 sessionKey。
3. 单测：mock 飞书 webhook → 期望 sessionKey 选择 + edit_message 节流逻辑。

阶段 A、B 是阻塞前置；其余可并行推进。每阶段交付时同步更新本文档与 `docs/pilotdeck-adapter-test-maintenance-guide.md`。

## 15. 测试策略概要

详细测试规则见同步交付的 `docs/pilotdeck-adapter-test-maintenance-guide.md`。本文档只列原则：

- `gateway` 与 `adapters` 的单测必须可在不启动真实网络的情况下完成（用 `unix socket pair` 或 `node:net` 内存 stream 模拟 WS 是允许的）。
- 协议帧：必须有 round-trip 测试（构造 → JSON → 解析 → 反向相等）。
- SessionRouter：必须覆盖并发约束、idle 回收、resume vs new 路径。
- Channel：用 fake gateway 做 input → submitTurn 调用断言 + GatewayEvent 流 → 渲染断言。
- 端到端：`tests/integration/server-cli.e2e.test.ts` 起真实 server + CliChannel 以 RemoteGateway 跑通一次问答（mock model）。
- Parity：本模块无 legacy parity 适用；如未来引入 OpenClaw 协议互通需求，再补 dual parity fixtures。

## 16. Open Questions

1. UI 渲染框架：第一阶段是否锁定一个（vite + react / vite + lit / vite + svelte）？建议默认 React + 现有团队熟悉栈，但本文档保持框架无关。
2. 飞书 webhook 路径与签名校验：第一阶段是否需要支持飞书自建应用 + 加密 verify token + 用户 OAuth？默认仅自建 bot + verify token，OAuth 列入 deferred。
3. token 刷新与失效策略：第一阶段是否仅一次性 token？建议是；过期/失效需要用户手动删除 `~/.pilotdeck/server-token`。
4. 多个 server 进程同机器并存：是否需要支持？默认不支持（端口冲突即报错）；多 project 通过同一 server 进程共享。
5. UI 需要 session 内权限请求弹窗：UI 端 deferred 还是与第一阶段一起做？建议 UI 第一阶段做最简弹窗（`permission_request` → 弹模态 → 用户点击 → 通过 WS 反向 method 提交决定）；若不做，必须在 UI 中显式禁用需要权限的工具组合。
6. ui/ 目录仓位：是 PilotDeck 仓库内（推荐，便于一致版本号与 protocol 对齐）还是独立仓库（分离构建）？默认仓内。
