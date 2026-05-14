# PilotDeck 双线开发协议

> 本文档定义开源核心（`src/`）和产品定制（`products/`）之间的 7 个接口。
> 读者：新团队成员、AI coding agent。读完后应能独立编写产品插件，且不改动核心代码。

---

## 背景：为什么需要这个文档

PilotDeck 有两条开发线：

- **开源核心**（`src/`）：快速迭代，和行业无关，任何人都能贡献
- **产品定制**（`products/<customer>/`）：为特定客户/行业做的功能，不随开源发布

两条线由同一个团队（和 AI）开发，住在同一个仓库的同一个分支里。

**核心问题**：开源每天都在改代码，产品代码怎么不被改坏？

**答案**：产品代码只通过下面 7 个接口和核心交互。只要这些接口不变（或变化被检测到），产品代码就不会被开源更新破坏。

### 有这 7 个接口 vs 没有

| | 有接口 | 没接口 |
|--|-------|-------|
| 产品加新功能 | 写插件，放 `products/`，不碰 `src/` | 直接改 `src/`，和开源代码搅在一起 |
| 开源发新版 | TypeScript 编译一下，过了就没事 | 手动比对每个改动是否影响产品 |
| AI 写产品代码 | 只需读本文档 + 接口类型定义（~200 行） | 要读整个 `src/` 才能下手（~50000 行） |
| 新人上手产品线 | 读本文档 15 分钟，开始写插件 | 先理解整个核心架构 |
| 两个 AI agent 并行 | 一个改 `src/`，一个改 `products/`，互不冲突 | 两个 AI 改同一批文件，合并冲突 |

---

## 产品代码的三种形态

产品代码按耦合度分三层。**能用低耦合的就不用高耦合的**：

| 层 | 形态 | 耦合度 | 核心改了会怎样 | 适合什么功能 |
|---|------|--------|-------------|------------|
| **声明式** | plugin.json + hooks 脚本 + markdown | 极低 | manifest 格式变了才受影响 | 工具、命令、技能、MCP server |
| **独立进程** | MCP server（TypeScript/Python/任意语言） | 低 | MCP 协议变了才受影响 | 知识库对接、GPU 采集等独立服务 |
| **进程内引导** | `bootstrap.ts`（TypeScript 函数） | 中 | TypeScript 编译报错，需适配 | gateway RPC、实时广播、计费拦截 |

```
products/<customer>/
  bootstrap.ts              ← 进程内引导（gateway RPC、广播、usage 钩子）
  plugins/
    thinkbase/
      plugin.json           ← 声明式 MCP server
      mcp-server/
    audit-hooks/
      plugin.json           ← 声明式 hooks
      hooks/
  config/
    pilotdeck.yaml          ← 产品配置
  brand/
    logo.svg, theme.json    ← 品牌资产
```

## 接口总览

```
产品代码 (products/<customer>/)
  │
  ├─ ① plugin.json → 插件声明（工具、钩子、命令、MCP）     [已稳定]
  ├─ ② hooks/      → 生命周期钩子脚本                      [已稳定]
  ├─ ⓪ bootstrap.ts → 进程内产品引导                        [待补 · P0]
  ├─ ③ gateway 自定义 RPC 方法（通过 bootstrap 注册）        [待补 · P0]
  ├─ ④ WebSocket 自定义广播事件（通过 bootstrap 注册）       [待补 · P0]
  ├─ ⑤ 自定义配置节                                         [待补 · P0]
  ├─ ⑥ Usage 事件订阅（通过 bootstrap 注册）                 [待补 · P1]
  └─ ⑦ Web UI 自定义页面                                    [待补 · P2]
          │
          ▼
核心代码 (src/)
```

**① ② 已稳定**，产品可以直接用。**⓪ 是 ③④⑥ 的前提**——bootstrap 机制补齐后，③④⑥ 自然可用。**⑤ 是零成本补齐项。⑦ 短期用 iframe 绕过。**

---

## 接口 ①：插件声明（已稳定）

### 它解决什么问题

产品想给 AI agent 加新工具（如知识库查询）、新命令（如 `/audit`）、新技能。

### 怎么用

在 `products/<customer>/plugins/<name>/plugin.json` 里声明：

```json
{
  "name": "edgeclaw-thinkbase",
  "version": "1.0.0",
  "description": "ThinkBase 知识库集成",
  "mcpServers": {
    "thinkbase": {
      "command": "node",
      "args": ["./mcp-server/index.js"],
      "env": { "THINKBASE_HOST": "http://localhost:8080" }
    }
  },
  "commands": ["commands/kb-query.md"],
  "skills": ["skills/kb-ingest.md"]
}
```

部署时将插件目录软链接到 `~/.pilotdeck/plugins/` 或项目级 `.pilotdeck/plugins/`。

### 核心接口（类型定义）

```
文件: src/extension/plugins/protocol/manifest.ts  → PilotDeckPluginManifest
文件: src/extension/plugins/protocol/plugin.ts    → PilotDeckLoadedPlugin
文件: src/extension/protocol/contribution.ts      → PilotDeckExtensionContributionKind
```

产品代码**不需要 import 这些类型**——只需要写 JSON 文件，核心自动解析。

### 兼容性规则

- 核心新增 manifest 字段 → 产品不受影响（新字段可选）
- 核心删除 manifest 字段 → **breaking**，产品用了该字段的插件会加载失败
- 核心改变插件发现路径 → **breaking**，插件找不到了

### AI 检查清单

写完 plugin.json 后确认：
- [ ] `mcpServers` 里的 command 路径相对于 plugin.json 所在目录
- [ ] `commands/skills` 里的 .md 文件存在且格式正确
- [ ] 没有 import 任何 `src/` 下的 TypeScript 模块

---

## 接口 ②：生命周期钩子（已稳定）

### 它解决什么问题

产品想在核心流程的特定时机插入自定义逻辑。比如：
- 发送前检查余额（`UserPromptSubmit`）
- 工具执行前做审计日志（`PreToolUse`）
- 配置变更时刷新产品缓存（`ConfigChange`）

### 可用的钩子事件

```
PreToolUse, PostToolUse, PostToolUseFailure,
UserPromptSubmit, PreModelRequest,
SessionStart, SessionEnd, Stop,
SubagentStart, SubagentStop,
PreCompact, PostCompact,
PermissionRequest, PermissionDenied,
Setup, ConfigChange, InstructionsLoaded,
WorktreeCreate, WorktreeRemove,
Elicitation, ElicitationResult
```

### 怎么用

`products/<customer>/plugins/<name>/hooks/hooks.json`：

```json
{
  "hooks": [
    {
      "matcher": { "event": "UserPromptSubmit" },
      "hooks": [
        { "type": "command", "command": "bash ./hooks/check-balance.sh" }
      ]
    }
  ]
}
```

钩子脚本通过 stdin 接收 JSON 输入（包含事件类型、session 信息等），通过 stdout 返回 JSON 结果（可注入系统消息、阻止操作等）。

### 核心接口

```
文件: src/extension/hooks/protocol/events.ts → PILOTDECK_HOOK_EVENTS（事件名枚举）
文件: src/extension/hooks/protocol/settings.ts → PilotDeckHooksSettings
文件: src/lifecycle/LifecycleRuntime.ts → 事件 payload 格式
```

### 兼容性规则

- 核心新增事件类型 → 产品不受影响（不监听的事件不触发）
- 核心删除事件类型 → **breaking**，但极罕见
- 核心改变 payload 字段 → 可能 breaking，钩子脚本需要容忍未知字段

### AI 检查清单

- [ ] hooks.json 的 `event` 值在上面的事件列表里
- [ ] 钩子脚本能处理 stdin JSON，失败时返回非零退出码
- [ ] 钩子脚本不依赖核心的 node_modules（自带依赖或用 bash）

---

## 接口 ⓪：产品引导模块 bootstrap.ts（待补 · P0）

### 它解决什么问题

有些产品功能必须在 gateway 进程内运行 TypeScript 代码——自定义 RPC 方法、实时广播事件、LLM 调用计费拦截。plugin.json 声明式机制做不了这些（当前 `PilotDeckLoadedPlugin` 明确限制 programmatic contributions 仅限 builtin/test）。

bootstrap.ts 是产品代码进入 gateway 进程的**唯一入口**。

### 怎么用

`products/<customer>/bootstrap.ts`：

```typescript
import type { ProductBootstrap } from "../../src/extension/product/types.js";

export default {
  name: "edgeclaw",

  gatewayMethods: {
    "edgeclaw.usage.summary": async (params, ctx) => {
      const stats = await queryUsageStats(params, ctx.config);
      return { ok: true, data: stats };
    },
    "edgeclaw.ping": async () => {
      return { ok: true, data: { status: "alive" } };
    },
  },

  broadcastNamespaces: ["edgeclaw"],

  onUsage: (event) => {
    billingService.recordUsage(event);
  },

  setup: async ({ config }) => {
    await billingService.connect(config.extensions?.edgeclaw?.billing);
  },

  teardown: async () => {
    await billingService.disconnect();
  },
} satisfies ProductBootstrap;
```

`pilotdeck.yaml` 中指定加载路径：

```yaml
product:
  bootstrap: "products/edgeclaw/bootstrap.ts"

extensions:
  edgeclaw:
    billing:
      llmCenterHost: "https://llm.example.com"
```

### 核心接口（类型定义，待实现）

```typescript
// src/extension/product/types.ts（约 40 行）
type ProductBootstrap = {
  name: string;
  gatewayMethods?: Record<string, GatewayMethodHandler>;
  broadcastNamespaces?: string[];
  onUsage?: UsageEventHandler;
  tools?: PilotDeckToolDefinition[];
  promptContributions?: PromptContribution[];
  routerContributions?: RouterContribution[];
  setup?: (context: { config: PilotConfig; logger: Logger }) => Promise<void>;
  teardown?: () => Promise<void>;
};
```

### 加载时机

```
gateway 启动流程：
  loadConfig()
    → loadBuiltinPlugins()
    → loadProductBootstrap(config.product?.bootstrap)  ← 新增
    → createPluginRuntime({ builtinPlugins: [...builtins, ...bootstrapContribs] })
    → createGateway({ extraMethods: bootstrap.gatewayMethods, ... })
```

### 设计原则

1. **bootstrap 是纯数据 + 函数**，不是 class。gateway 控制生命周期，产品不直接操作 gateway。
2. **gateway 方法用 namespace 前缀**（如 `edgeclaw.*`），核心方法不允许被覆盖。
3. **broadcast 能力通过 context 注入**，产品不直接持有 WebSocket 连接。
4. **产品代码的 import 只用 `import type`**——不 import 核心的实现代码，只 import 类型。

### 兼容性规则

- `ProductBootstrap` 类型新增可选字段 → 产品不受影响
- `ProductBootstrap` 类型删除字段 → **breaking**，产品 TypeScript 编译报错
- `GatewayMethodHandler` 的 context 参数变化 → **breaking**，产品方法编译报错
- 核心内部实现变化但类型不变 → 产品不受影响

### AI 检查清单

- [ ] bootstrap.ts 用 `satisfies ProductBootstrap` 确保类型安全
- [ ] 所有 gateway 方法名以产品 namespace 开头（`edgeclaw.*`）
- [ ] import 只用 `import type`，不 import 核心运行时代码
- [ ] setup/teardown 里有错误处理，不会因为外部服务不可用而阻塞 gateway 启动
- [ ] handler 里的异常被 catch，不 propagate 到 gateway 主流程

### 补齐成本

约 170 行核心代码改动，分布在 7 个文件中。详见 `docs/product-extension-loading-research.md`。

---

## 接口 ③：Gateway 自定义 RPC 方法（待补，通过 ⓪ 实现）

### 它解决什么问题

产品想在 Web UI 里加自己的功能页面（如 Token 用量仪表盘、设备资源监控），需要自己的后端 API。

### 实现方式

通过 bootstrap.ts 的 `gatewayMethods` 字段注册（见接口 ⓪）。前端通过 WebSocket 调用 `{ method: "edgeclaw.usage.summary", params: {...} }`。

### 有/没有这个接口的区别

| | 有 | 没有 |
|--|---|------|
| 产品加 API | bootstrap.ts 里声明 handler | 改 `InProcessGateway.ts` 加方法 |
| 开源重构 gateway | 产品 handler 自动迁移 | 产品代码和核心方法混在一起，rebase 冲突 |

---

## 接口 ④：WebSocket 自定义广播事件（待补）

### 它解决什么问题

产品后端想主动推送实时事件给前端。比如：
- 安全路由检测到敏感内容 → 推送 `edgeclaw.detection` 给 UI 弹确认框
- GPU 使用率变化 → 推送 `edgeclaw.resource.update` 刷新监控浮窗

### 当前状态

Gateway 有 `WsNotificationFrame` 机制，但只有核心事件（`config_changed`）。
`GatewayEvent` 联合类型是封闭的（`turn_started | assistant_text_delta | ...`），产品无法扩展。

### 需要什么

```typescript
// 产品侧代码（在自定义 RPC handler 或 hook 中）
context.broadcast("edgeclaw", "detection", { 
  sessionKey, level: "S2", redactedContent: "..." 
});
```

前端通过 namespace 过滤监听：

```typescript
// 产品侧前端
gateway.onBroadcast("edgeclaw", (event, payload) => {
  if (event === "detection") showSecurityDialog(payload);
});
```

### 核心需要改什么

- `GatewayEvent` 增加一个泛型扩展槽：`{ type: "extension_event"; namespace: string; event: string; payload: unknown }`
- 或在 `WsNotificationFrame` 中支持 namespace 分发

---

## 接口 ⑤：自定义配置节（待补）

### 它解决什么问题

产品有自己的配置项（定价基线、外部服务地址、安全规则等），想放在统一的 `pilotdeck.yaml` 里管理。

### 当前状态

`PilotConfig` 是强类型的封闭结构。产品要加新字段必须改 `src/pilot/config/types.ts`。

### 需要什么

在 `PilotConfig` 中加一个开放的扩展字段：

```typescript
type PilotConfig = {
  // ...现有字段不动
  extensions?: Record<string, unknown>;
};
```

产品在 `pilotdeck.yaml` 中写：

```yaml
extensions:
  edgeclaw:
    thinkbase:
      host: "http://localhost:8080"
    billing:
      llmCenterHost: "https://llm.example.com"
    pricing:
      cloudTokenBaseline: 0.00003
```

产品代码读取：`config.extensions?.edgeclaw?.billing?.llmCenterHost`

### 核心需要改什么

- `PilotConfig` 类型加 `extensions?: Record<string, unknown>`
- `PilotRawConfig` 加 `extensions?: unknown`
- `loadPilotConfig` 透传 `extensions` 字段，不做校验
- 配置变更检测照常工作（`contentHash` 自动包含 extensions）

**改动量：~10 行。** 这是最小成本、最高收益的补齐项。

---

## 接口 ⑥：Usage 事件订阅（待补）

### 它解决什么问题

产品想对每次 LLM 调用做计费、审计、统计。比如：
- 把 token 用量发送给外部计费系统（LLMCenter）
- 累积统计数据供仪表盘查询
- 余额不足时拦截请求

### 当前状态

`CanonicalUsage` 类型定义清晰。`TokenStatsCollector` 收集路由级统计。
但这些是核心内部组件，产品代码无法订阅。

`turn_completed` 事件携带 `usage: TurnUsage`，前端能看到。但产品后端拿不到每次 model request 级别的用量。

### 需要什么

两层方案：

**轻量级**（用现有钩子）：通过 `PostToolUse` 或新增的 `PostModelRequest` 钩子事件，把 usage 数据传给钩子脚本。产品钩子可以据此做计费。

**完整版**（新增事件总线）：

```typescript
type UsageEvent = {
  sessionKey: string;
  provider: string;
  model: string;
  usage: CanonicalUsage;
  timestamp: number;
  routeDecision?: string;
};

// 产品侧注册
gateway.onUsage((event: UsageEvent) => {
  billingService.record(event);
});
```

### 建议

先用钩子方案快速交付，需要更细粒度再补事件总线。

---

## 接口 ⑦：Web UI 自定义页面（待补，最复杂）

### 它解决什么问题

产品想在 Web UI 里加自己的页面：Token 用量仪表盘、设备资源监控、安全设置、充值入口等。

### 当前状态

Web UI (`ui/`) 有 `plugin:${string}` tab 类型的设计意图，但未完全打通。
目前添加新页面需要改 `ui/src/` 下的核心组件代码。

### 需要什么

产品声明自己的 UI 页面：

```json
{
  "name": "edgeclaw-ui",
  "uiTabs": [
    {
      "id": "edgeclaw-usage",
      "label": "用量统计",
      "icon": "chart",
      "component": "./ui/UsageDashboard.tsx"
    },
    {
      "id": "edgeclaw-resources",
      "label": "资源监控",
      "icon": "cpu",
      "component": "./ui/ResourceMonitor.tsx"
    }
  ]
}
```

核心 UI 的导航栏自动读取注册的 tab，动态加载组件。
产品 UI 组件通过标准 props 获取 gateway client 和 config。

### 复杂度说明

这是 7 个接口中**最复杂**的，因为：
- React 组件的动态加载需要构建时配合（lazy import / module federation / iframe）
- 产品 UI 组件对核心 UI 库（组件、样式、hooks）有隐式依赖
- UI 迭代速度快，组件 props 变化频繁

### 短期替代方案

在 Web UI 扩展机制成熟之前，产品 UI 页面可以用 **iframe** 嵌入独立的 SPA。核心只需要在导航栏加一个 iframe slot，产品页面自己跑独立的 dev server，通过 gateway WebSocket 获取数据。

这样产品 UI 和核心 UI 完全解耦，代价是风格一致性需要手动维护。

---

## 当前状态与实施优先级

| # | 接口 | 状态 | 补齐成本 | 优先级 |
|---|------|------|---------|--------|
| ① | 插件声明 | **已稳定** | - | - |
| ② | 生命周期钩子 | **已稳定** | - | - |
| ⑤ | 自定义配置节 | 待补 | ~10 行 | **立即做** |
| ⓪ | 产品引导模块 bootstrap | 待补 | ~170 行 | **P0（③④⑥ 的前提）** |
| ③ | Gateway 自定义 RPC | 待补（通过 ⓪） | 含在 ⓪ 中 | P0 |
| ④ | WebSocket 自定义广播 | 待补（通过 ⓪） | 含在 ⓪ 中 | P0 |
| ⑥ | Usage 事件订阅 | 待补（通过 ⓪） | 含在 ⓪ 中 | P1 |
| ⑦ | Web UI 自定义页面 | 待补 | 大（先用 iframe） | P2 |

**建议顺序**：⑤ → ⓪（一次性打通 ③④⑥）→ ⑦

⑤ 是零风险的 10 行改动。⓪ 是关键路径——170 行核心代码改动打通产品进程内扩展能力，③④⑥ 自然解决。⑦ 短期用 iframe。

### 技术细节

⓪ 的 170 行改动分布（详见 `docs/product-extension-loading-research.md`）：

| 文件 | 改什么 |
|------|--------|
| `src/extension/product/types.ts` | 新建 `ProductBootstrap` 类型定义 |
| `src/extension/product/loadProductBootstrap.ts` | 新建 bootstrap 加载器 |
| `src/pilot/config/types.ts` | `PilotConfig` 加 `product?` + `extensions?` |
| `src/cli/createLocalGateway.ts` | 启动时加载 bootstrap，合并贡献 |
| `src/gateway/server/GatewayWsConnection.ts` | 动态方法分发 |
| `src/gateway/server/GatewayServer.ts` | namespace 广播 |
| `src/router/stats/TokenStatsCollector.ts` | usage 订阅点 |

---

## AI 兼容性检查流程

当开源核心有新的 PR 合并到 `main` 时，AI 运行以下检查：

```
1. 编译检查
   cd products/<customer>/ && tsc --noEmit
   → 如果产品代码有直接 import src/ 类型，编译错误说明接口变了

2. 插件加载检查
   遍历 products/*/plugins/*/plugin.json
   → 验证 manifest 格式仍然合法（字段没被删除）

3. 钩子事件检查
   遍历 products/*/plugins/*/hooks/hooks.json
   → 验证 matcher.event 仍在 PILOTDECK_HOOK_EVENTS 列表中

4. 配置检查
   加载 products/*/config/pilotdeck.yaml
   → 验证核心配置字段没被重命名（extensions 字段不校验）

5. 自定义 RPC 检查（③ 补齐后）
   启动 gateway，验证注册的自定义方法能响应
```

如果任何检查失败：
- AI 读取 git diff 理解核心改了什么
- 读取本文档理解接口约定
- 自动生成产品侧的适配代码
- 提交为 PR，人类 review

---

## 给 AI 的决策树

写产品功能时，按这个顺序决策：

```
这个功能需要什么能力？
│
├─ 给 agent 加新工具 → 用接口 ①（MCP server in plugin.json）
├─ 在核心流程中插入逻辑 → 用接口 ②（hooks）
├─ 需要自定义后端 API → 用接口 ③（gateway RPC）
├─ 需要实时推送事件到前端 → 用接口 ④（broadcast）
├─ 需要产品配置项 → 用接口 ⑤（extensions config）
├─ 需要 LLM 调用的用量数据 → 用接口 ⑥（usage 钩子）
├─ 需要在 Web UI 加页面 → 用接口 ⑦（UI tab / iframe）
│
└─ 以上都不够？
   → 先在 src/ 补一个新接口（只加接口定义，不加业务逻辑）
   → 更新本文档
   → 再在 products/ 中使用新接口
```

**绝对不要做的事**：
- 直接修改 `src/` 下的实现代码来满足产品需求
- 在 `products/` 的代码中深度 import `src/` 的内部模块
- 在 plugin.json 中引用 `src/` 的 node_modules 路径

---

## 附录：核心类型速查

产品代码可能需要了解（但不应直接 import）的核心类型：

```typescript
// Gateway 事件流（产品通过 WebSocket 或 hook 接收）
type GatewayEvent = 
  | { type: "turn_started"; runId: string }
  | { type: "turn_completed"; usage: TurnUsage; finishReason: string }
  | { type: "tool_call_started"; toolCallId: string; name: string }
  | { type: "tool_call_finished"; toolCallId: string; ok: boolean }
  | { type: "permission_request"; requestId: string; toolName: string; payload: unknown }
  | { type: "error"; message: string; recoverable: boolean }
  | ...

// Token 用量（随 turn_completed 事件传递）
type CanonicalUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  nativeCost?: number;
};

// 记忆系统接口（如果产品需要替换记忆实现）
type MemoryResolver = {
  retrieve(input: MemoryRetrieveInput): Promise<MemoryRetrieveResult>;
  captureTurn(input: MemoryCaptureTurnInput): Promise<void>;
};

// 钩子事件（产品 hooks.json 中的 matcher.event 取值）
type PilotDeckHookEvent =
  | "PreToolUse" | "PostToolUse" | "UserPromptSubmit"
  | "PreModelRequest" | "SessionStart" | "SessionEnd"
  | "ConfigChange" | "PermissionRequest" | ...
```

完整类型定义见对应源文件（本文档顶部已标注路径），但产品代码应通过 JSON/WebSocket 协议交互，而非直接 import。
