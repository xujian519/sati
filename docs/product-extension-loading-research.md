# 产品扩展加载机制调研

> 核心问题：产品代码（如 EdgeClaw 的 token 统计、GPU 监控、计费对接）需要在 gateway 进程内运行 TypeScript 代码。当前的 plugin.json 声明式机制做不到这一点。怎么办？

---

## 1. 现状：三种已有的扩展机制

| 机制 | 能力范围 | 产品能用吗 | 限制 |
|------|---------|----------|------|
| **plugin.json 声明式** | MCP server、hooks 脚本、commands/skills markdown | 能 | 不能注册 TypeScript 函数 |
| **programmatic contributions** | `routerContributions`、`promptContributions`（TypeScript 函数） | 不能 | 仅限 builtin 和 test 注入 |
| **extraTools** | 在 `ToolRegistry` 里注册额外工具 | 不能 | 仅限核心子系统（cron、always-on） |

关键发现：

- `PilotDeckLoadedPlugin` 类型上**已经定义了** `routerContributions` 和 `promptContributions` 字段
- `PluginRuntime` 的 `lookupRouter()` 和 `loadSkillPrompt()` **已经会查询**这些字段
- 但**没有任何路径**让磁盘加载的插件或 builtin 插件填充这些字段
- 旧版 EdgeClaw 的 `clawxrouter` 用的是完全不同的机制（`definePluginEntry` + `OpenClawPluginApi`），PilotDeck 没有这套 API

---

## 2. 旧版 EdgeClaw 怎么做的（对照）

旧版 `extensions/clawxrouter/index.ts` 通过 `definePluginEntry` 注册一个 `register(api)` 函数，api 提供：

- `api.registerGatewayMethod(name, handler)` — 注册自定义 RPC
- `api.registerProvider(...)` — 注册模型提供商
- `api.registerHttpRoute(...)` — 注册 HTTP 路由
- `api.registerService(...)` — 管理后台服务生命周期
- `api.registerHooks(...)` — 注册生命周期钩子
- `setGlobalPipeline(...)` — 替换路由管线
- `setGlobalCollector(...)` — 替换统计收集器

这是一个**全能 API**：插件可以改 gateway 的方方面面。PilotDeck 没有这套东西。

---

## 3. 三条可行路径

### 方案 A：产品引导模块（推荐）

**思路**：在 `createLocalGateway` 的启动流程中，加一个"产品引导"钩子。产品提供一个 TypeScript 入口文件，gateway 启动时动态 import 它，它返回一组贡献（额外工具、gateway 方法、broadcast handler 等）。

```
启动流程：
  loadConfig()
    → loadBuiltinPlugins()
    → loadProductBootstrap()    ← 新增
    → createPluginRuntime()
    → createGateway()
```

**产品侧代码**（`products/edgeclaw/bootstrap.ts`）：

```typescript
import type { ProductBootstrap } from "../../src/extension/product/types.js";

export default {
  name: "edgeclaw",

  contributions: {
    tools: [/* PilotDeckToolDefinition[] */],

    gatewayMethods: {
      "edgeclaw.usage.summary": async (params, ctx) => { /* ... */ },
      "edgeclaw.usage.hourly": async (params, ctx) => { /* ... */ },
    },

    broadcastNamespaces: ["edgeclaw"],

    hooks: {
      onUsage: (event) => { /* 计费逻辑 */ },
      onSessionStart: (session) => { /* 审计日志 */ },
    },
  },
} satisfies ProductBootstrap;
```

**核心需要改什么**：

1. 定义 `ProductBootstrap` 类型（~30 行）
2. `createLocalGateway` 加载 bootstrap（~20 行）：
   - 读 config 中的 `product.bootstrap` 路径
   - `await import(bootstrapPath)`
   - 将 contributions 合并到 PluginRuntime / Gateway
3. `InProcessGateway` 或 `GatewayWsConnection` 支持动态方法分发（~50 行）
4. `broadcastNotification` 支持 namespace（~20 行）

**总改动量：~120 行核心代码**

**优点**：
- 产品代码是标准 TypeScript，享受类型检查、IDE 补全、单步调试
- 核心只暴露一个入口约定（`ProductBootstrap` 类型），不是一整套 API
- 产品代码可以 import 核心的类型定义（只 import type，不 import 实现）
- 和 BOUNDARY.md 的目录约定一致（产品代码在 `products/` 下）

**缺点**：
- 产品代码和核心跑在同一个进程里，buggy 的产品代码会崩 gateway
- 产品代码在编译时需要能 resolve 核心的类型（需要 tsconfig paths 或 workspace 配置）
- 需要约定产品代码的编译和部署方式

**兼容性影响**：
- `ProductBootstrap` 类型变了 → 产品代码 TypeScript 编译报错（可自动检测）
- 核心的 `GatewayMethodContext` 变了 → 产品的 gateway 方法编译报错（可自动检测）
- 核心内部实现变了但类型没变 → 产品不受影响

---

### 方案 B：扩展 builtin 插件机制

**思路**：让 `loadBuiltinPlugins()` 不仅扫描核心的 `src/extension/plugins/builtin/`，也扫描 `products/<name>/plugins/`，并且支持加载 `.ts`/`.js` 入口文件来填充 programmatic contributions。

```typescript
// products/edgeclaw/plugins/usage-dashboard/index.ts
import type { PilotDeckLoadedPlugin } from "../../../../src/extension/plugins/protocol/plugin.js";

export const plugin: PilotDeckLoadedPlugin = {
  name: "edgeclaw-usage",
  path: __dirname,
  source: "project",  // 或新增 "product" source
  manifest: { name: "edgeclaw-usage", version: "1.0.0" },
  routerContributions: [/* ... */],
  promptContributions: [/* ... */],
};
```

**核心需要改什么**：

1. `loadBuiltinPlugins()` 或新建 `loadProductPlugins()` 扫描 `products/` 目录
2. 对每个有 `index.ts` 的插件目录，动态 import 获取 `PilotDeckLoadedPlugin`
3. 合并到 `PluginRuntime` 的 `builtinPlugins`

**总改动量：~50 行核心代码**

**优点**：
- 改动最小——复用现有的 `PilotDeckLoadedPlugin` 类型和 `PluginRuntime` 查询逻辑
- `routerContributions` / `promptContributions` 的消费路径已经存在

**缺点**：
- `PilotDeckLoadedPlugin` 类型不够用——没有 `gatewayMethods`、`broadcastHandlers`、`usageHooks` 等字段
- 如果要加这些字段，就是在现有类型上不断膨胀，不如方案 A 干净
- 产品插件和 builtin 插件混在一起，边界不清晰

---

### 方案 C：MCP + 进程间通信

**思路**：产品所有功能都作为独立进程运行（MCP server 或 HTTP 微服务），gateway 通过标准协议通信。不需要进程内 TypeScript 代码。

```
gateway (核心进程)
  ├── MCP: thinkbase-server (知识库)
  ├── MCP: usage-collector (token 统计)
  ├── HTTP: resource-monitor (GPU 监控)
  └── HTTP: billing-proxy (LLMCenter 对接)
```

**核心需要改什么**：
- 几乎不改——MCP 通道已经存在
- 但需要把非工具类的能力（gateway RPC、广播、usage 钩子）也封装成 MCP tool 或 HTTP endpoint

**优点**：
- 产品代码完全独立进程，不影响 gateway 稳定性
- 语言无关——产品可以用 Python、Go 写
- 和 BOUNDARY.md 的 `plugin.json → mcpServers` 声明完全兼容

**缺点**：
- **很多功能做不了**：自定义 gateway RPC 方法、实时广播事件、拦截 model request 这些需要进程内访问
- 进程间通信开销大（序列化/反序列化）
- MCP 协议不支持"注册新的 gateway RPC 方法"这种元操作
- 产品 UI 页面需要的数据（用量统计）需要额外的 HTTP proxy 层

---

## 4. 推荐：方案 A，附带 C 的 MCP 能力

```
products/edgeclaw/
  bootstrap.ts              ← 进程内引导（方案 A）
  plugins/
    thinkbase/
      plugin.json           ← 声明式 MCP server（方案 C）
      mcp-server/
    resource-monitor/
      plugin.json           ← 声明式 MCP server
      mcp-server/
  config/
    pilotdeck.yaml
  brand/
```

分工：
- **需要进程内访问的功能**（gateway RPC、广播、usage 钩子、计费拦截）→ 放 `bootstrap.ts`（方案 A）
- **独立服务类功能**（ThinkBase 对接、GPU 采集）→ 放 MCP server（方案 C，plugin.json 声明）
- **声明式功能**（命令、技能、hooks 脚本）→ 放 plugin.json（现有机制）

这样产品的代码面分成三层，按耦合度递减：

| 层 | 耦合度 | 核心接口变了会怎样 | 代码位置 |
|---|--------|------------------|---------|
| bootstrap.ts | 高 | TypeScript 编译报错，需要适配 | `products/<name>/bootstrap.ts` |
| plugin.json 声明 | 低 | manifest 格式变了才受影响 | `products/<name>/plugins/` |
| MCP server 独立进程 | 极低 | MCP 协议变了才受影响 | `products/<name>/plugins/*/mcp-server/` |

原则：**能用声明式的用声明式，能用 MCP 的用 MCP，只有必须进程内的才放 bootstrap。**

---

## 5. `ProductBootstrap` 类型初步设计

```typescript
type GatewayMethodHandler = (
  params: unknown,
  context: {
    sessionKey?: string;
    broadcast: (namespace: string, event: string, payload: unknown) => void;
    config: PilotConfig;
  },
) => Promise<{ ok: boolean; data?: unknown; error?: string }>;

type UsageEventHandler = (event: {
  sessionKey: string;
  provider: string;
  model: string;
  usage: CanonicalUsage;
  timestamp: number;
}) => void | Promise<void>;

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

**设计原则**：

1. **ProductBootstrap 是纯数据 + 函数的静态结构**，不是 class。gateway 控制生命周期，产品不直接操作 gateway 实例。
2. **gatewayMethods 用 namespace 前缀**（如 `edgeclaw.*`），核心方法不允许被覆盖。
3. **broadcast 能力通过 context 注入**，产品不直接持有 WebSocket 连接。
4. **onUsage 是被动订阅**，不是主动查询。产品自己决定怎么存储和聚合。
5. **setup/teardown** 管理产品自己的资源（数据库连接、后台轮询等）。

---

## 6. 核心改动清单（方案 A 实施）

| 文件 | 改什么 | 行数 |
|------|--------|------|
| `src/extension/product/types.ts` | 新建，定义 `ProductBootstrap` 类型 | ~40 行 |
| `src/extension/product/loadProductBootstrap.ts` | 新建，动态 import `products/<name>/bootstrap.ts` | ~30 行 |
| `src/pilot/config/types.ts` | `PilotConfig` 加 `product?: { bootstrap?: string }` + `extensions?` | ~5 行 |
| `src/cli/createLocalGateway.ts` | 启动时加载 bootstrap，合并 tools/methods/hooks | ~40 行 |
| `src/gateway/server/GatewayWsConnection.ts` | `dispatchRequest` 支持动态方法分发 | ~30 行 |
| `src/gateway/server/GatewayServer.ts` | `broadcastNotification` 支持 namespace | ~15 行 |
| `src/router/stats/TokenStatsCollector.ts` | 暴露 onUsage 订阅点 | ~10 行 |
| **合计** | | **~170 行** |

---

## 7. 风险和缓解

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| 产品 bootstrap 代码崩溃导致 gateway 挂掉 | 高 | bootstrap 的 setup/handler 包 try-catch；产品代码 crash 只 log 不 propagate |
| 产品和核心的 TypeScript 编译耦合 | 中 | 产品 import 核心只用 `import type`；产品有独立的 tsconfig |
| `ProductBootstrap` 类型膨胀 | 低 | 保持类型扁平，不加嵌套 API；新能力加可选字段 |
| 多个产品的 bootstrap 冲突 | 低 | 当前只有一个产品；未来加 namespace 隔离 |

---

## 8. 下一步建议

1. **先补最小的 ⑤（`extensions` 配置节）**—— 零风险的 5 行改动
2. **实现 `ProductBootstrap` 类型 + 加载器** —— 这是其他接口的前提
3. **写一个最小 bootstrap 示例**（注册一个 `edgeclaw.ping` RPC 方法），验证端到端可行
4. **再逐步填充**：usage hook → gateway methods → broadcast
