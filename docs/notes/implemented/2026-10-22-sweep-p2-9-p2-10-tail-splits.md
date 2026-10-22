# Agent Note: sweep P2.9/P2.10 尾部函数拆分与创造性图声明化（#646）

Status: implemented

## Problem

sweep 尾部三个超长函数，均已进 `metrics.md` 的 ≥300 行长函数榜：

1. `src/web/client/webMessage.ts:applyWebGatewayEvent`（**383 行**）——23 种 gateway 帧的巨型
   `switch`，每种分支就地拼装 `WebMessage`；新增帧种类时 `switch default` 静默吞掉。
2. `src/tool/execution/ToolRuntime.ts:execute`（**388 行**）——线性贯穿注册表修复、计划/询问
   模式拦截、输入校验、PreToolUse hook、权限决议、超时熔合、输出 schema 校验、PostToolUse、
   审计与证据闭环，读一处必须理解整条管线。
3. `src/patent/graph/domains/inventiveness.ts:buildInventivenessGraph`（**342 行**）——17 个
   `addNode` + 条件边 + 尾链开关全部平铺在构造函数体内，节点内容与装配逻辑混在一起。

通过判据（计划 P2.9/P2.10 原文）：前两者各 **≤200 行**；第三者「**图构建声明化**」。

## Decision

### P2.9a · webMessage：required Record 处理器表

- `WEB_EVENT_HANDLERS` 的键类型是 `WebGatewayEvent["type"]` 的 **required Record**（沿用
  P2.2/P2.3/P2.4 已验证模式）：未来新增帧种类时 **typecheck 强制处置**，静音帧显式写
  `ignoreEvent`（本批 8 种），不再依赖 `switch default` 的静默面。
- 公共消息拼装收进 `liveMessage(ctx, fields)`，文本/思考增量共用 `appendDelta`，消除
  10 处重复的 `id/sessionKey/projectKey/createdAt/provider/source` 样板。
- `applyWebGatewayEvent` 收缩为 **11 行**：查表 → 无处理器返回原 state → 调用。

### P2.9b · ToolRuntime：五阶段私有方法

`execute` 收缩为 **16 行**编排，阶段与顺序逐项保留：

1. `withNestedToolExecutor`（递归调用的共享 state map 注入，原样保留）；
2. `preflight`（注册表 resolve/repair、abort、not-found、plan/ask 模式、输入 schema、
   prompt 能力）；
3. `applyPreToolUseHooks`（PreToolUse 派发与事件、block/deny、updated input 复核、
   `tool.validateInput`、`planTodo` 门）；
4. `resolvePermission`（`decide` → PermissionRequest hook（含 `alwaysAsk` 只认交互式
   allow）→ 审计 → deny/cancel/ask 错误结果）；
5. `runTool`（超时熔合、outputSchema 校验、成败两路 PostToolUse、证据 Receipt、审计、
   `planTodo` 进度）。

两个模块外移使文件回到 **683 行**（R3 ≤800）：`toolErrorFormatting.ts`（69 行：
`flattenToolOutputText`/`formatToolErrorContent` 及私有 detail 格式化）与
`planModePreflight.ts`（77 行：`getPlanModeViolation` 及路径判定）。所有事件发射点保持
`this.eventEmitter?.({ ... })` 对象字面量，事件矩阵的生产者识别不变（仅行号位移）。

### P2.10 · inventiveness：节点表 + 边表

- `STAGE_NODES`：17 个 `{ name, create, include }` 条目，**顺序即 `addNode` 顺序**
  （provenance / `describe()` 依赖该顺序），节点定义全部提为模块级常量。
- `STAGE_EDGES`：`{ from, to, when }` 静态边表，按开关求值；表内顺序复刻旧版
  `addEdge` 调用序（含尾链 `conclude → (citation_gate) → (approval) → (rule_gate) → END`
  的全 8 种组合）。
- 开关决议抽为纯函数 `resolveGraphFlags` / `normalizeMaxRounds`；后者把
  `undefined`/负数/非整数统一归一为 2、`0` 禁用回路——旧版语义原样保留。
- `buildInventivenessGraph` 收缩为 **21 行**：解析开关 → 按表加节点 → 条件边 + `schema`
  → 按表加边。

## Alternatives considered

- **webMessage 保留 switch，只把每个 case 提取成函数**：函数本身仍是 383 行，直接违反
  ≤200 判据；且新增帧种类仍会落进 `default` 静默路径。否。
- **webMessage 用 `Partial<Record<...>>` 或普通对象 + 运行时兜底**：失去「新增帧种类必须
  处置」的编译期约束，正是本批要消除的静默面。否（选择 required Record）。
- **ToolRuntime 把阶段拆成独立的公共类/服务**：会扩大跨模块 API 面，且调用点需要改动；
  私有方法保持封装与调用契约不变，测试零改动。否。
- **ToolRuntime 只拆不管文件体积**：首版拆分后文件涨到 828 行，触发 R3 ≤800 架构门禁；
  因此把纯格式化和 plan-mode 路径判定外移，而不是压缩注释或放宽豁免。否（选择外移）。
- **inventiveness 引入通用图 DSL / builder 抽象**：只为单张图服务，抽象成本高于收益；
  两张常量表已满足「声明化」判据，且保持逐项可比。否。
- **inventiveness 把 11 个 LLM 节点的提示词也拆到独立文件**：超出本项判据，且会扩大
  diff 面；提示词原样保留在同一领域模块内。否。

## Verification

- `pnpm check` EXIT=0（freshness / typecheck / lint / format / 架构边界 / 事件矩阵 /
  techdebt-metrics / doc-claims 全链）。
- `pnpm test` **5880 例 / 5875 pass / 0 fail / 5 skip**。
- webMessage：42 事件 A/B 语料（覆盖全部处理器与分支）逐帧 `JSON.stringify` +
  `deepEqual` 42/42 字节一致；负控制把 `ok: event.ok` 翻成 `ok: true`，第 14 帧按预期失败。
- ToolRuntime：185 个定向测试全绿；负控制两条——`allowCounts` 恒真（alwaysAsk 声明式
  allow 用例 1 红）、去掉 deadline 后 timeout 归一（timeout 用例 1 红），均已恢复。
- inventiveness：对照 `main` 基线 14 种开关组合 `describe()` 全等、10 种运行场景
  state/degraded/interrupted/prompt 多重集全等；负控制 `maxRounds=0` 启用回路 → 1 条预期
  用例红，`citationGate=false` → 3 条预期用例红，均已恢复；patent domains 33/33 pass。
- 事件矩阵：`permission_denied`/`permission_requested`/`post_tool_execute`/`pre_tool_execute`
  仅行号位移，生产者/消费者集合零变化。
- metrics：三条 ≥300 行长函数条目消失；src TS 文件 1136 → 1138、行数 197608 → 197830
  （新增两个外移模块），`docs/code-facts.md` 已 `gen:doc-claims` 回填。
