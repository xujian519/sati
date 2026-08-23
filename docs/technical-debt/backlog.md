# Sati 技术债务活账本（backlog）

> 唯一事实源。审计/修复时在此登记与更新条目。清分级、条目 Schema、保持新鲜规则见 `README.md`。
> 快速状态：`metrics.md`（最新基线 2026-08-23）作为数字事实源；本账本按模块给带 `file:line` 证据的条目。
> 标注「**自动化扫描命中**」的条目来自脚本 `node scripts/measure-techdebt.mjs --json`。

---

## 0. 自动化扫描命中（Phase 1）与复核更正

> ⚠️ **重要复核更正（2026-08-23 B1 批次）**：Phase 0 用 `\bany\b` grep 出的「any 103 处」**存在大量误报**——多数命中的是注释/字符串里的英文单词 "any"。经人工复核，`src/agent`、`src/router`、`src/tool`、`src/session` 真实类型位 `any` 均为 **0**；修正后的脚本（只匹配 `: any / as any / <any> / any[] / @ts-expect-error / @ts-ignore`）全源码剩 **1 处**。真正的类型债是**强转**：`as never`（gateway 43 处）、`as string[]`（router）、`as XResult`（RemoteGateway 30 处）、`!` 非空断言。

### 类型安全（已修正，B1+B2 复核）
- **TD-TYPE-001** · `any`/`@ts-expect-error` 误报修正：**全源码真实 `any` 逃逸≈0**
  - 位置：agent/router/tool/session/context/model 六模块人工复核均确认为 0；`metrics.md` 中的「1 处」实为注释/字符串里的英文单词 "any" 误报。
  - 影响：类型卫生整体优秀；**真正要治理的是类型强转与断言**（见 TD-TYPE-002）。
  - 工作量：S · 严重级：P3 · 状态：triaged
- **TD-TYPE-002** · 强转/断言债（`as never` / `as XResult` / `as unknown as X` / `as string[]` / `!`）
  - 位置：`gateway/GatewayWsConnection.ts`（43 处 `as never`）、`gateway/client/RemoteGateway.ts`（30 处 `as XResult`）、`model/streaming/streamModel.ts:355-361` 与 `providers/google/request.ts:107`（`as unknown as X` 双强转）、`patent/provenance/provenance-store.ts:250` 与 `evidence/receipt.ts:224`（`as unknown as X`）、`router/config/parseRouterConfig.ts`（4 处 `as string[]`）
  - 影响：让入参/结果/DB 行在编译期失去形状校验，字段错名/类型错位运行时才暴露。
  - 工作量：L · 严重级：P1 · 状态：triaged

### 错误&可观测
- **TD-CONSOLE-001** · 裸 `console.*` 267 处，`cli` 191 处最热
  - 位置：`src/cli/sati.ts`、`createLocalGateway.ts` 等；次热 `patent`(15) `agent`(13) `model`(11)
  - 建议：收束到 `src/telemetry/` wrapper；先 `sati.ts` → `createLocalGateway.ts`。
  - 工作量：L · 严重级：P2 · 状态：new
- **TD-CATCH-001** · 静默吞错 catch（体仅注释/空白）151 处，`adapters` 40 · `always-on` 15 · `tool` 14
  - 影响：异常被吞且无注释，属隐患。逐条补注释或改结构化错误。
  - 工作量：L · 严重级：P2 · 状态：new

### Arch/分层
- **TD-BOUND-001** · `ui/server → src` 深层导入 14 处
  - 位置：`ui/server/sati-bridge.js`、`routes/config.js`、`routes/commands.js` 等
  - 建议：改走 `src/<module>/index.ts` barrel（纯防御，不动架构）。
  - 工作量：M · 严重级：P2 · 状态：new
- **TD-BOUND-002** · `ui/server/routes/memory.js:14` 直连 `edgeclaw-memory-core/lib/index.js` 编译产物
  - 决策：既有注释说明为受支持路径（`technical-debt-report.md` 2026-08-17 复核维持）。状态：**wontfix**。
  - 证据：脚本命中 1 处。

### 体积/复杂度（God function & 大文件）
- **TD-GOD-001**（P1）· UI 层巨无霸函数（贡献大于后端）
  - `useChatComposerState` 1433（`chat/hooks/`）· `PdfDocumentPreview` 1138 · `SidebarV2` 1017 · `useChatSessionState` 941 · `MessagesPaneV2` 937 · `FilesV2` 877 · `MessagesPaneV2.render.test.tsx` 842
  - 建议：按 hook/组件拆分 + 子组件提取；涉及 UI 须浏览器验证。工作量：L（每组件）· 状态：new
- **TD-GOD-002**（P2）· 后端巨无霸函数：`createRouterRuntime` 877（`router/`）· `main` 635（`cli/sati.ts`）· `createReadFileTool` 509（`tool/readFile.ts`）
  - 细分见各模块节。工作量：L · 状态：new
- **TD-SIZE-001** · 大文件：`SkillsV2.tsx` 2503 · `createLocalGateway.ts` 2437 · `AgentLoop.ts` 2305 · `sati-bridge.js` 2055 · `routes/taskmaster.js` 1888 · `PdfDocumentPreview.tsx` 1861 · `WeComChannel.ts` 1761
  - 工作量：L · 严重级：P2 · 状态：new

### 测试
- **TD-TEST-001** · 主链路核心缺直接单测（见各模块节 *_GATEWAY* / *_ROUTER*）。工作量：M · 严重级：P1 · 状态：new
- **TD-TEST-002** · 极薄模块（1 测试文件）：`fs` `lifecycle` `network` `status` `browser`。工作量：S ×5 · 严重级：P3 · 状态：new

### 文档漂移
- **TD-I18N-001** · `teamPanel` namespace 缺 2 个 zh key / 1 个 en key。工作量：S · 严重级：P3 · 状态：new
- **TD-DOC-001** · 网关协议版本文档漂移：`version.ts`=**1.4**，但 `CLAUDE.md` 仍写「当前协议 **1.2**」
  - 位置：`src/gateway/protocol/version.ts:31` ↔ `CLAUDE.md`
  - 建议：同步 `CLAUDE.md` 及变更表。工作量：S · 严重级：P2 · 状态：new

> **自动化命中清单结束。** 以下为 Phase 2 逐模块人工审阅结果（B1–B6 全部完成）。

---

## 1. agent（主链路 · B1 ✅）

**模块概况**：67 文件 / ~9k 行；`tests/agent/` 39 spec（覆盖相对好）；类型安全良好（0 处 `@ts-ignore`，仅 1 处缓解型双重 cast `toolContext.ts:250-251`）。最需注意 `handleModelError` 单函数承载约 10 条模型错误恢复路径。

- **TD-AGENT-101** · `AgentLoop.handleModelError` 371 行 god function
  - 类别：A · 严重级：P1 · 工作量：M · 状态：new
  - 位置：`src/agent/loop/AgentLoop.ts:795-1165`
  - 影响：单函数承载流中断恢复/思维缺失重试/工具结果投影/json 自纠/reactive 恢复/输出上限调整等约 10 条互斥路径，分支深、易漏测。
  - 建议：按恢复路径拆成独立策略方法并统一调度口串联。
  - 证据：`handleModelError@795`→`handleNoToolCalls@1166`；`809/888/923` 多个独立分支并列。
- **TD-AGENT-102** · `TurnRunner.run()` ~197 行且失败路径重复
  - 类别：A · 严重级：P1 · 工作量：M · 状态：new
  - 位置：`src/agent/turn/TurnRunner.ts:149-345`
  - 影响：转录失败/UserPromptSubmit 阻断/未请求模型三条失败路径各自重复「createErrorResult→recordErrorResult→finishArtifacts→recordFailureStatus→yield」样板。
  - 建议：抽 `emitEarlyFailure(options, error, messages)` 统一收口。证据：`181-192`/`210-224`/`229-243` 三处结构重复。
- **TD-AGENT-103** · `assembleAndRecover` 272 行
  - 类别：A · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/agent/loop/AgentLoop.ts:523-794`
  - 影响：消息组装与错误恢复判定混在一处，嵌套深。建议：拆出错误恢复判定/重试计数。
- **TD-AGENT-104** · 静默吞错 catch
  - 类别：C · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/agent/turn/TurnRunner.ts:158,165,334-335,501,523`；`src/agent/team/scheduler/lock.ts:19`
  - 影响：`recordTurnResult`/`reappendTail`/`FileArtifactCollector` 失败被静默丢弃。建议：走统一 logger 或显式注释 best-effort。
- **TD-AGENT-105** · 裸 `console.warn/error` 而非结构化日志
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`AgentLoop.ts:129,378,628,2009,2020,2234`；`TurnRunner.ts:169,376,386,462`；`member-scanner.ts:81,138`；`roleFromSkill.ts:49`
  - 建议：统一走既有 logger 并注入 sessionId/turnId。
- **TD-AGENT-106** · 重复的 usage 合并逻辑与私有 `add()` helper
  - 类别：F · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`AgentSessionState.ts:34-45,51-56` 与 `loop/misc.ts:144-153,157-161`
  - 建议：收敛成单一 `mergeCanonicalUsage`（如落 `src/model`）。
- **TD-AGENT-107** · `misc.ts` 为「杂物抽屉」模块（259 行、~13 个互不相关导出）
  - 类别：D · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/agent/loop/misc.ts:1-259`
  - 建议：按领域拆（toolSchema/usage/permission/lifecycle）。
- **TD-AGENT-108** · `runtime/` 核心逻辑缺直接单测
  - 类别：E · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/agent/runtime/modelContextWindow.ts:12`（`resolveRoutedModelMaxContextTokens`）；`PlanTodoState.ts:186`（`createPlanTodoStateManager`）
  - 建议：补分支/状态推进用例。

**审计结论**：测试与类型安全整体强于指标预期；债务集中在体积/复杂度与错误可观测性。未发现 `src/agent/` 内 team 子模块循环依赖。

---

## 2. router（主链路 · B1 ✅）

**模块概况**：26 文件 + 13 spec；负责模型分流/分级（judge）、fallback、zero-usage/瞬时重试、多模态降级、cache-aware 切换。类型面干净（`any` 为 0，`RouterRuntime.ts:631/645/983/1036` 命中均为注释 "any"）；主路径职能过度集中。

- **TD-ROUTER-001** · `createRouterRuntime` 877 行 god function
  - 类别：A · 严重级：P1 · 工作量：L · 状态：new
  - 位置：`src/router/RouterRuntime.ts:90-966`
  - 影响：单闭包承载 config 归一、session store/health cache、决策、执行、重试、编排、统计。
  - 建议：按职责拆 `decision.ts`/`execution.ts`/`sticky.ts`/`media.ts`，入参收敛为 `RuntimeDeps` 注入。证据：`:90` 函数起 `:966` 闭合，内部 `decide :255-466`、`execute :488-898` 均为嵌套闭包。
- **TD-ROUTER-002** · `execute()` 嵌套巨型异步生成器（~410 行）
  - 类别：A · 严重级：P1 · 工作量：M · 状态：new
  - 位置：`src/router/RouterRuntime.ts:488-898`
  - 影响：fallback/transient-retry/zero-usage 三套重试分支与「已产出内容是否可重放」状态机咬合紧密。建议：抽单 attempt 执行器 + 重试判定纯函数。
- **TD-ROUTER-003** · `decide()` 决策函数 ~211 行含多层嵌套分支
  - 类别：A · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/router/RouterRuntime.ts:255-466`
  - 建议：拆为组合式纯函数 + 谓词表驱动 `resolvedFrom` 溯源。
- **TD-ROUTER-004** · 生产路径残留裸 `console.log` 未走 `debugLog` 门控
  - 类别：C · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`RouterRuntime.ts:421`；`orchestrate/applyOrchestration.ts:21,42`
  - 建议：改用 `src/shared/debug.js` 的 `debugLog`。对照 `classifyAndRoute.ts:150` 已用 `debugLog`。
- **TD-ROUTER-005** · 静态大对象/规则表与运行时解析函数混布
  - 类别：D · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`config/schema.ts:110-208,222-269`；`utils/modelPricing.ts:10-78`
  - 建议：`resolveProviderRef` 移出 schema；提示词、默认 tier 规则、定价表抽到 `assets/` 由 config 加载。
- **TD-ROUTER-006** · `parseRouterConfig.ts` 单文件多长函数带 `as string[]` 断言
  - 类别：B · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/router/config/parseRouterConfig.ts`（`parseTokenSaver:263-431`、`parseAutoOrchestrate:434-563`；断言 `:338,465,492,505`）
  - 建议：拆 `config/parsers/*.ts`；用窄化守卫替换断言。
- **TD-ROUTER-007** · 死代码：`RouterConfigError`/`RouterRuntimeError` 从未被构造
  - 类别：F · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/router/protocol/errors.ts:1-24`；`index.ts:28-29`
  - 证据：全 `src/` grep 仅命中定义与 re-export，无构造点。建议：删除或补齐实例化。
- **TD-ROUTER-008** · 主路径（decide/execute）无直接单测
  - 类别：E · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`tests/router/` 无 `RouterRuntime.spec.ts`；`tests/test-support/llm-replay.spec.ts:117-122` 仅 passthrough
  - 建议：为 decide（resolvedFrom 溯源）/execute（fallback/zero-usage/媒体降级）补确定性 spec，LLM 走重放 seam。

---

## 3. tool（主链路 · B1 ✅）

**模块概况**：111 文件，24 内置工具 + 执行/注册/调度基础设施；注册表 `requireOutputSchema` 已开启、`ToolRuntime` 错误归一/审计闭环较完整。债务集中在 `readFile.ts` 与 `createBuiltinRegistry.ts` 两个超大函数、模式约束名单重复、静默吞错。
> ⚠️ 更正：`TD-TYPE-002`（tool 17 处 any、planMode 6 处）**无法复现**——`src/tool` 无任何类型位 any/`@ts-expect-error`。仅存的非严格收窄是 `userInteractionConstraints.ts:39` 的 `{} as never` 与 `readFile.ts:116` 的 `as ReadFileInput`。

- **TD-TOOL-001** · `createReadFileTool` god function（~508 行）
  - 类别：A · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/tool/builtin/readFile.ts:43-551`
  - 建议：按读取类型拆独立 handler（image/pdf/notebook/text）+ 共享工具函数。证据：`:43` 起 `:169` execute `:184` markRead `:503` shrinkToBudget `:551` 收尾。
- **TD-TOOL-002** · `ToolRegistry.clone()` 静默丢弃 `requireOutputSchema`
  - 类别：B · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/tool/registry/ToolRegistry.ts:109-118`
  - 影响：克隆体上注册未声明 outputSchema 的工具不再 fail-loud。建议：`new ToolRegistry(this.options)` 复制选项。
- **TD-TOOL-003** · 模式白名单工具名两份手写重复
  - 类别：D · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`planModeConstraints.ts:11-30` vs `askModeConstraints.ts:9-25`
  - 建议：抽公共只读工具集合 `READ_ONLY_TOOL_NAMES` 作单一来源。
- **TD-TOOL-004** · `createBuiltinRegistry` 巨型顺序注册函数
  - 类别：A · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/tool/registry/createBuiltinRegistry.ts:245-392`
  - 影响：~60 个 `registry.register(...)` 直线汇编进单函数，且文件自注「creator 自标 domain 时来源会不一致」构成脆弱契约。建议：按 domain 分组抽子函数。
- **TD-TOOL-005** · `requiresPromptCapability` 吞掉交互谓词异常
  - 类别：C · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/tool/userInteractionConstraints.ts:9-13`
  - 影响：`requiresUserInteraction` 抛错被当"无需交互"，可能静默跳过人工确认/审批。建议：catch 时记录告警并 fail-loud。
- **TD-TOOL-006** · `validateSpecification` 抽检失败静默降级
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/tool/builtin/validateSpecification.ts:153-156`
  - 影响：RDKit/SMILES 抽检异常被 `return []` 吞掉，失败无日志/遥测。建议：catch 记录 warning 并附 `degraded` 标记。
- **TD-TOOL-007** · `patentPdfDownload` 内嵌 ~90 行 JS 驱动脚本模板
  - 类别：A/G · 严重级：P3 · 工作量：M · 状态：new
  - 位置：`src/tool/builtin/patentPdfDownload.ts:855-949`
  - 建议：抽为独立 `.js` 源文件纳入类型/格式检查，或改结构化生成并补用例。
- **TD-TOOL-008** · `patentKgQuery` 缓存构造失败静默返回 null
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/tool/builtin/patentKgQuery.ts:84-90`
  - 影响：KG 库打开失败被当"未配置"，无法区分损坏/权限 vs 缺失。建议：catch 中区分并记录 warning。

---

## 4. gateway（主链路 · B1 ✅）

**模块概况**：InProcess/Remote 两实现 + 手写 WS 帧协议 + 服务端连接；已从 2341 行拆出 6 个下沉模块，现 `InProcessGateway.ts` 1103 行；`tests/gateway/` 25 文件。分层清晰，但类型强转（`as never`）、安全关键帧解析的测试空白、「方法清单多处同步」为包袱。

- **TD-GATEWAY-001** · InProcessGateway 1103 行是否还需再拆
  - 类别：A · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/gateway/client/InProcessGateway.ts:1-1103`（复杂块 `:314-621`）
  - 建议：不再整体拆分；仅把 submitTurn 内 telemetry/timeout/permission 脚手架抽成辅助函数。
- **TD-GATEWAY-002** · 分发器 `frame.params as never` 使全部入参失去类型校验
  - 类别：B · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/gateway/server/GatewayWsConnection.ts:150,230-385`（43 处 `as never`）；`client/RemoteGateway.ts:92-278`（~30 处 `as XResult`）
  - 建议：per-method 类型守卫或按 method 窄化 `params`；替换 `as never`。
- **TD-GATEWAY-003** · 热路径重复序列化（active-turn 重放缓冲）
  - 类别：I · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/gateway/client/InProcessGateway.ts:1082-1095`
  - 影响：每事件 `structuredClone` + 2 次 `JSON.stringify`（维护可能无人读的重放缓冲），叠加 WS 发送 1 次，长 text_delta 流下每事件约 3 次序列化。建议：惰性/近似字节估算，或仅在存在消费者时维护。
- **TD-GATEWAY-004** · 手写 WS 帧解析与 16MB DoS 守卫零直接单测
  - 类别：E · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/gateway/server/websocket.ts:78-119,146-194`
  - 影响：掩码强制、64 位长度、认证前缓冲上限是安全关键路径却无用例直接覆盖（现有测试 `as unknown as` mock 掉真实解析）。建议：补 `readClientFrame`/`handleData` 直接单测。
- **TD-GATEWAY-005** · submitTurn 核心路径与重放/截断逻辑无直接测试
  - 类别：E · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/gateway/client/InProcessGateway.ts:314-621,1082-1095`
  - 建议：补附件构建/syntheticMessages/telemetry/runId 归属及重放 buffer「500 事件 / 256KB」截断边界用例。
- **TD-GATEWAY-006** · 网关方法清单三处/六处手动同步、无编译期穷尽检查
  - 类别：D · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`protocol/frames.ts:22-65` ↔ `GatewayWsConnection.ts:229-396` ↔ `Gateway.ts`
  - 影响：新增方法需同步改多处；`default: throw` 兜底下 union 增成员时 TS 无 `never` 穷尽检查，漏接即静默 `gateway_request_failed`。建议：`satisfies`/never 检查强制覆盖全部成员。
- **TD-GATEWAY-007** · `agent_status` 自由字符串扁平化削弱事件面类型安全
  - 类别：B · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/gateway/protocol/types.ts:290`；`eventMapping.ts` 多处自由字符串
  - 建议：为高频子事件定义 `event` 字面量联合与 per-event detail 类型。
- **TD-GATEWAY-008** · 网关协议版本文档漂移（1.2 vs 1.4）
  - 类别：H · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/gateway/protocol/version.ts:31`（=1.4）↔ `CLAUDE.md`（写 1.2）
  - 建议：同步 `CLAUDE.md` 及变更表。

---

## 5. session（主链路 · B1 ✅）

**模块概况**：34 文件——append-only JSONL 转录 + 增量读取/投影缓存 + 孤儿 turn 合成 + 跨进程续算（TaskResumeScanner）+ J-Space 账本（workspace/）。类型安全 0 真实 any（`AbortSignal.any` 误报）。性能债集中在账本持久化 O(entries) 每轮重建与全量快照增长。

- **TD-SESSION-N01** · `WorkspaceLedgerStore.read()` 每轮（每次模型调用）全量重扫 transcript 重派生账本
  - 类别：I · 严重级：P1 · 工作量：M · 状态：new
  - 位置：`src/session/workspace/WorkspaceLedgerStore.ts:34-40`；`WorkspaceLedgerReader.ts:15-21`
  - 影响：账本每次模型调用前重新注入，长会话 O(entries) 重扫 + clone。建议：按尾部衔接键缓存最新 workspace_state。对应 `performance-review.md` B 类「每轮全量重建」。
- **TD-SESSION-N02** · `recordWorkspaceState` 每笔写入附加账本全量快照，transcript 单调增长
  - 类别：A · 严重级：P2 · 工作量：L · 状态：new
  - 位置：`src/session/transcript/JsonlTranscriptWriter.ts:232-241`
  - 影响：Reader 只取最新一条，先前全量快照成为死重，transcript 无界增长。建议：只落增量/最新状态。
- **TD-SESSION-N03** · `TaskResumeScanner.scan()` 空 catch 静默吞单会话失败，结果面无失败计数
  - 类别：C · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/session/resume/TaskResumeScanner.ts:98-100`；`42-49`
  - 影响：单会话读盘/提交异常被静默跳过，`TaskResumeScanResult` 无 failed/errored 字段。建议：结果加失败计数并透出首个错误。
- **TD-SESSION-N04** · `WorkspaceLedger` 持久化边界（Store/Reader）无直接单测
  - 类别：E · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/session/workspace/WorkspaceLedgerStore.ts`（read/write）、`WorkspaceLedgerReader.ts`
  - 影响：账本从 transcript 重派生、每次模型注入的 I/O 路径及 in-memory 回退边界均无测试。建议：补 file-backed 与 in-memory 两路径 behavior spec。
  - 备注：`TaskResumeScanner` 与 `WorkspaceLedger` 纯状态机已有直接 spec（不列为缺失）。
- **TD-SESSION-N05** · resume 路径合成 turn_result 为 fire-and-forget
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/session/transcript/interruptedTurn.ts:119-127`；`resume/resumeAgentSession.ts:83-96`
  - 影响：`void recordTurnResult(result)` 丢弃持久化副作用；落盘失败成 unhandled rejection，且内存投影与 transcript 背离、下次 resume 会再次合成。建议：派发落盘错误并让回放序列在落盘前标记 pending。
- **TD-SESSION-N06** · 同名 helper `getPilotProjectChatDir` 经两处 barrel 引源
  - 类别：D · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`search/searchChatHistory.ts:5`（自 `shared/paths`）vs `storage/SessionList.ts:3`、`ProjectSessionStorage.ts:2`、`resume/TaskResumeScanner.ts:2`（自 `pilot`）
  - 建议：统一收敛到 `shared/paths`。
- **TD-SESSION-N07** · `SessionList` 以正则抽取 JSON 字段，`unescapeJsonString` 无异常保护
  - 类别：B · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/session/storage/SessionList.ts:428-457`
  - 影响：超大行截断（head 64KB）或畸形行可让捕获串 `JSON.parse` 抛错，沿 `readSessionInfo→listProjectSessions` 冒泡，单个会话文件即可带崩整列表。建议：用已 parse 的 entry 类型守卫取值，或至少包 try/catch 降级。

---

## 6. context（主链路 · B2 ✅）

**模块概况**：约 81 源 TS 文件（含 edgeclaw-memory-core 子包 src/ 36 个）；测试 39 个；类型面干净（无真实 any / `@ts-expect-error`）。最需注意：记忆检索热路径 `ReasoningRetriever.retrieve` ~480 行单体方法 + 缓存未命中时阻塞模型调用至 30s。
> ⚠️ 更正：`performance-review.md` B 类「`EdgeClawMemoryProvider.retrieve` 无缓存」「`projectToolResults` 每轮全量重建」已**过时**——现状是已有 TTL 缓存 + in-flight 并发去重（`EdgeClawMemoryProvider.ts:80-138`）；真正遗留是缓存未命中时检索链仍阻塞模型调用（见 TD-CONTEXT-N03）。

- **TD-CONTEXT-N01** · `ReasoningRetriever.retrieve` ~480 行单体方法
  - 类别：A · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/context/memory/edgeclaw-memory-core/src/core/retrieval/reasoning-loop.ts:345-826`
  - 影响：单方法串联路由判定/项目候选/语义 RRF 融合/manifest 选择/文件加载/trace 构建六段。
  - 建议：拆为 route/manifest/semantic/record 多个私有协作者，trace 组装收口。
- **TD-CONTEXT-N02** · `DreamReview.run` ~520 行单体方法
  - 类别：A · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/context/memory/edgeclaw-memory-core/src/core/review/dream-review.ts:521-1045`
  - 影响：Dream 主编排承担 snapshot/聚类/meta 合并/取舍/汇总，分支极多。建议：按 categoryDream/generalMerge/manifestReview 拆子方法。
- **TD-CONTEXT-N03** · 检索链阻塞模型调用，缓存未命中时最高 30s
  - 类别：I · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/context/DefaultContextRuntime.ts:199-201`（`await memoryPromise`）、`:95`（`DEFAULT_MEMORY_RETRIEVAL_TIMEOUT_MS = 30_000`）
  - 建议：memory 注入改「到期即有则注入、超时降级为空」非阻塞回退或降为 background + 下轮注入。
- **TD-CONTEXT-N04** · 性能文档与现状脱节
  - 类别：H · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/context/memory/EdgeClawMemoryProvider.ts:80-138`；`src/context/projection/MessageProjector.ts:29`
  - 建议：更新 `performance-review.md` B 类条目与行数（retrieve 已有缓存；reasoning-loop 现 ~830 行）。
- **TD-CONTEXT-N05** · `loadVectorRows` 读取/解析失败全部静默降级为空
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/context/vector/jsonl-store.ts:28-30,40-42`
  - 影响：读错误返回 `[]`、损坏行静默跳过且无 warn/遥测，语义召回在索引失效时被无声关闭。
  - 建议：首个非空失败记录 warn 或上抛诊断。
- **TD-CONTEXT-N06** · 自动压缩事件绕过日志抽象直用 `console.warn`
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/context/DefaultContextRuntime.ts:685-696`
  - 建议：改经注入 logger，除去冗余 try/catch。
- **TD-CONTEXT-N07** · `MessageProjector` 无直接单测
  - 类别：E · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/context/projection/MessageProjector.ts:29`、`:151-183`
  - 影响：工具配对安全滑窗 + 孤儿 tool_result 修复向模型投喂占位 `tool_result` 属正确性关键路径，却无直接用例。
  - 建议：为 `toolPairSafeTruncate`/`repairToolResultPairing` 补边界单测。
- **TD-CONTEXT-N08** · 父模块以编译产物消费 edgeclaw 子包
  - 类别：D · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/context/memory/createEdgeClawMemoryProviderFromConfig.ts:20`；`edgeclaw-memory-core/package.json:8-13`
  - 影响：`exports` 映射 `./lib/index.js` 而源码在 `src/core/**`、`lib/` 被 gitignore；改源码须先重跑其 build 才被上层感知，存在构建顺序漂移风险。建议：明确跨包构建时序或在根 build 串接子包 tsc。

---

## 7. model（主链路 · B2 ✅）

**模块概况**：约 67 文件；provider 协议适配（catalog + anthropic/google/openai/openai-responses + embedding）、canonical 协议、请求构建、流式归一与重试状态机、能力解析。类型面干净（`any` 全为注释/正则误报），类型债集中在 `as unknown as` 双强转与 `as Record` 逃逸。

- **TD-MODEL-N01** · `providers.ts` 巨无霸目录 + 模型条目千篇一律样板
  - 类别：A · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/model/catalog/providers.ts:7-187`、`:189-1593`
  - 影响：1593 行每个模型条目重复抄写 `capabilities` 9 字段 + `multimodal` 六项列表，改字段口径易漏改/串改。建议：抽 `capabilities()`/`multimodal()` 构造器或共享常量合并同能力模型。
- **TD-MODEL-N02** · `streamModel.ts` 流式热路径 god function + 三处重试循环重复
  - 类别：A · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/model/streaming/streamModel.ts:128-330`、`:365-470`、`:75-123`
  - 影响：`complete`/`streamModel`/`streamGoogleProviderRequest` 三处各自实现 `calculateRetryDelay`+`emitModelRetryProgress`+`buildLiteLLMContinuationRequest`。建议：抽统一 retry 驱动骨架供三路复用。
- **TD-MODEL-N03** · 生产热路径裸 console 日志
  - 类别：C · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`assembleModelMessage.ts:127`；`streamModel.ts:345`；`openai/response.ts:95`；`openai-responses/response.ts:94`；`anthropic/stream.ts:176`
  - 影响：`[text-tool-call-fallback]` 每次触发即 stdout，无 env 门控。建议：走统一 logger/遥测通道（门控+级别+结构化）。
- **TD-MODEL-N04** · `as unknown as X` 双强转逃逸类型检查
  - 类别：B · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/model/streaming/streamModel.ts:355-361,402`；`src/model/providers/google/request.ts:107`
  - 建议：为 `buildModelRequest` 提供 per-protocol 带类型 build 入口或 narrowing，去掉双强转。
- **TD-MODEL-N05** · `parseTextToolCalls.ts` 5 格式解析器堆叠
  - 类别：A · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/model/streaming/parseTextToolCalls.ts:300-307`、`:40-73`、`:565-606`
  - 影响：`name as string`/`input as unknown` 逃逸；qwen/dsml/hermes/mistral/llama 五个解析器相似、`classifyIncomplete*` 各写一遍。建议：统一 `JsonToolBlock` 类型收窄 + 抽共享「JSON 块收集+detag+未完成分类」骨架。
- **TD-MODEL-N06** · openai/openai-responses/anthropic 三处重复 JSON-repair 逻辑
  - 类别：F · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`openai/response.ts:86-105`；`openai-responses/response.ts:85-105`；`anthropic/stream.ts:168-179`
  - 建议：抽共享 `parseToolCallArguments(raw, provider, protocol)`。
- **TD-MODEL-N07** · anthropic/google/openai-responses provider 适配器缺直接单测
  - 类别：E · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/model/providers/{anthropic,google,openai-responses}/{request,response,stream}.ts`
  - 影响：per-protocol 流式归一/响应解析无 `tests/model` 直接用例，仅被 googleClientFactory 与 llm-replay fixture 间接覆盖。建议：各补一套基于 SSE/JSON fixture 的解析直测。
- **TD-MODEL-N08** · 空 catch 静默吞错（resolveModelInfo / embedding healthCheck）
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/model/resolveModelInfo.ts:49-57`；`src/model/embedding/client.ts:128-133`
  - 建议：只捕获预期错误码/类型，其余 rethrow 或上报诊断。

---

## 8. patent（业务核心 · B2 ✅）

**模块概况**：约 147 文件 / 20.5K 行，最大业务域；`tests/patent` 95 文件覆盖最深，故本节聚焦**代码结构/重复/可观测性/性能**债（省略"缺测试"类）。

- **TD-PATENT-N01** · `graph/` 与 `workflow/` 双轨实现重复（阶段执行/回退清理/降级语义两套并存）
  - 类别：D · 严重级：P1 · 工作量：M · 状态：new
  - 位置：`src/patent/graph/adapter.ts:104`（`makeStageNode`/`makeRetryRouter`）
  - 影响：同一「运行一个阶段」语义在主输出键解析/retry 回退清 state+atom 键/降级文本在 graph 与 workflow 两条路径各实现一遍，改一处易漏另一处。建议：收敛到共用执行原语。
  - 证据：`graph/adapter.ts:110-121`↔`workflow/executor.ts:78-86`；`:172-183`↔`workflow.ts:313-328`；`:126`↔`workflow/executor.ts:102-109`。
- **TD-PATENT-N02** · `evidence/engine.ts` 的 `parseRuleSet` ~87 行手写 YAML→类型解析器
  - 类别：B · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/patent/evidence/engine.ts:454-541`
  - 影响：字段缺失/改名不报错仅静默回退默认值，且 `as` 绕过类型系统掩盖坏数据。建议：用声明式 schema（zod 或自研守卫）校验 YAML 资产。
- **TD-PATENT-N03** · `evidence/engine.ts` 内嵌中英双语领域关键词表，与「权重走 YAML 资产」设计相悖
  - 类别：F · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/patent/evidence/engine.ts:355-408`
  - 建议：把指标词表移入 YAML 资产或独立常量模块。对比本模块 `:119-124`（DEFAULT_WEIGHTS）与 `:560`（loadRules 走 YAML）。
- **TD-PATENT-N04** · 危险断言散落：`as unknown as X`、非空 `!`、`JSON.parse as X`
  - 类别：B · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`provenance/provenance-store.ts:250`（`as unknown as AgentRow[]`）；`evidence/receipt.ts:224,232`；`evidence/engine.ts:783-784`（`weights[i]!`）；`graph/adapter.ts:97`（`manifest.stages[0]!.id`）；`evidence/date.ts:114`
  - 建议：为 DB 行/账本行加显式 row-mapper 或边界守卫。
- **TD-PATENT-N05** · 审计/审批关键路径直接用 `console.warn/error`，未走结构化日志/遥测
  - 类别：C · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/patent/output-gate.ts:148,207,234,263,273,276,310,346,349`（12 处）；`provenance/collector.ts:57`、`approval-store.ts:64`、`evidence/receipt.ts:184,216`、`atoms/handlers/builtin/mapper.ts:209`、`chemistry/smiles.ts:57`
  - 建议：统一路由到 logger，携带 `sessionId/turnId/pendingIndex` 结构化字段。
- **TD-PATENT-N06** · `data/nuo/mapper.ts` 静默吞掉专利元数据坏 JSON
  - 类别：C · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/patent/data/nuo/mapper.ts:36`（`parseJsonArray`，`:41` `catch { return [] }`）
  - 影响：inventor/assignee/classifications/引证 JSON 解析失败直接 `[]`，静默变空无告警，掩盖 vendor 字段漂移。建议：失败记录一次 warn（含字段名+样本截断）或结构化降级。
- **TD-PATENT-N07** · `patent_workflow_run` 工具入口很长，manifest 与 graph 两路径重复装配 ctx/溯源
  - 类别：D · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/tool/builtin/patentWorkflowRunTool.ts:240-427`；`execute`~187 行、`executeGraphRun`~170 行
  - 影响：`buildWorkflowRunContext(...)` 在两路径逐字重复（`:279-286`↔`:531-537`），改 provider/ctx 装配要改两处；`input.graph!` 非空断言。建议：抽共享 `buildRunContext`/provider 装配。
- **TD-PATENT-N08** · `ipc-classifier.ts` 779 行绝大多数是内联双语领域数据表
  - 类别：A · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/knowledge/patent/ipc-classifier.ts:32-438`（`IPC_DOMAINS`）、`:444-716`（`IPC_DETAIL_DOMAINS`）；逻辑 `classifyIpc` 仅 `:718-730`
  - 影响：A-H 关键词 + `inventivenessFocus` 散文写死在代码，与 `ipc-standards.yaml` 资产并存，难评审易漂移；被 `flexible-plan.ts:27` 与 `graph/domains/inventiveness.ts:22` 直接消费。建议：数据表外置为 YAML 资产并一次性加载。
- **TD-PATENT-N09** · `patent_pdf_download` 内嵌 JS 备份与资产权威源需手工保持一致
  - 类别：F · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/tool/builtin/patentPdfDownload.ts:50-69`（`PDF_LINK_EXTRACT_JS`）、`:77-95`
  - 影响：`assets/patent/pdf-link-extract.js` 与内嵌备份双份逻辑，注释要求一致却无校验，改动资产不更新备份即静默回退旧逻辑。建议：删备份或构建期内联资产字节。
- **TD-PATENT-N10** · `graph/engine.ts` 每个超步对全量 state 做一次 `structuredClone` 深拷贝
  - 类别：I · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/patent/graph/engine.ts:195`（`runSuperSteps` 内 `snapshot = cloneState(state)`）；`graph/state.ts:15-18`
  - 影响：10–15 超步每步全量深拷贝 state（含 prior_art 数组/结论报告）；`structuredClone` 失败 JSON 往返兜底且静默丢不可序列化键。建议：写时复制/结构化共享，或仅对超步间并发读做不可变引用。

---

## 9. adapters（B3 ✅）

**模块概况**：102 文件；`channel/` 21 渠道（Channel+SessionMapper+render 模板）+ `protocol/` 共享层 + `web/` 桥；`protocol/` 已抽渲染/交付/交互/命令共享组件（组合复用方向正确）。渠道类间脚手架重复高，负载集中在 wecom(1761)/weixin(1492)/feishu(1333) 与 TUI。
> 复核更正：历史报告所标 WhatsApp/Sms/Discord/Slack「单函数 god function」**已不复存在**（均已拆为 start/dispatch/handleIncoming/processMessage/sendReply）。类型面较干净（大量 `as Record<string,unknown>`，无 `@ts-ignore`/`: any`）。

- **TD-ADAPTERS-N01** · 渠道间「dispatch + submitTurn 处理循环」脚手架高度重复，未抽公共基类/组合
  - 类别：D · 严重级：P1 · 工作量：M · 状态：new
  - 位置：`channel/{whatsapp,sms,slack,discord,…}/*Channel.ts`
  - 影响：21 渠道各自复制「elicitation→permission→activeChats→mapper→processMessage」控制流与几乎相同的 `submitTurn` 渲染循环，改公共逻辑须逐渠道同步。建议：把 processMessage 三元循环与 deliverCronResult 提为共享 turn-processor 组合函数。
  - 证据：`whatsapp/WhatsAppChannel.ts:248-266`、`sms/SmsChannel.ts:248-268`、`slack/SlackChannel.ts:208-228`、`discord/DiscordChannel.ts:198-218`（循环体逐字同构）。
- **TD-ADAPTERS-N02** · `TuiApp.tsx` 的 `useInput` ~290 行单函数键盘状态机
  - 类别：A · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/adapters/channel/tui/app/TuiApp.tsx:317-604`
  - 影响：权限放行/帮助面板/侧栏导航/滚动聚焦全塞一个回调，难单测。建议：拆 handlePermissionKey/handleHelpKey/handleSidebarKey/handleNavigationKey。
- **TD-ADAPTERS-N03** · wecom/weixin/feishu 三个渠道类超大类，单一职责稀释
  - 类别：A · 严重级：P2 · 工作量：L · 状态：new
  - 位置：`wecom/WeComChannel.ts`、`weixin/WeixinChannel.ts`、`feishu/FeishuChannel.ts`
  - 影响：每文件混入网络传输/消息解析/媒体上传/路径沙箱/Markdown 掩码等无关职责。建议：把纯函数（`isDeniedDeliverablePath`/`maskProtectedDeliverableSpans`/`tryParseUrl`）与 sendable 职责拆到独立模块。
- **TD-ADAPTERS-N04** · 传输重负载渠道类测试覆盖极薄（全模块仅 3 个直测）
  - 类别：E · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`tests/adapters/`（仅 channel-render/feishu-permission-reply/im-permission-helper）
  - 影响：wecom/weixin/feishu 分发/轮询/媒体上传生命周期无单测。建议：为 Weixin pollLoop、WeCom onSocketData、WhatsApp dispatch 补分支测试（clientFactory/webSocketCtor 注 seam）。
- **TD-ADAPTERS-N05** · weixin 登录流程用裸 `console.log/error`，绕过 ChannelLogger
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`weixin/WeixinChannel.ts:315-318,334,344,361,369,424`
  - 建议：替换为 `this.logger?.info?./error?.()`。
- **TD-ADAPTERS-N06** · 共享的 `resolveIncomingMessage` 采用不一致（少数渠道内联）
  - 类别：D · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`whatsapp/WhatsAppChannel.ts:224-233`、`slack/SlackChannel.ts:185-190` vs `sms/SmsChannel.ts:217`、`discord/DiscordChannel.ts:178`
  - 建议：统一改用 `resolveIncomingMessage`（`protocol/ChannelCommandRegistry.ts:363-379`）。
- **TD-ADAPTERS-N07** · 21 个渠道 render 文件 19 个是 3-6 行同质薄包装
  - 类别：A · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`channel/{whatsapp,telegram,signal,slack,sms,discord,matrix,…}/*-render.ts`
  - 建议：调用点直接用 `renderPlainTextEvent`，或改为按 channelKey 配置的 options 表，消除 19 个文件。
- **TD-ADAPTERS-N08** · 错误处理密度全仓最高，少数真正吞错无日志
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`qq/qqbot-gateway.ts:307`（access token 刷新被 `.catch(()=>{})` 静默，后续可能间歇 401）；`protocol/ChannelStatePersistence.ts:36`；`protocol/ChannelRuntimeStatus.ts:48`
  - 建议：token 刷新失败加 logger/重试；`load`/`readSnapshot` 区分「不存在」与「解析失败」并告警。
- **TD-ADAPTERS-N09** · 少数双强转/未类型化配置上的无界 `as`
  - 类别：B · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`weixin/WeixinChannel.ts:157`（`as unknown as WeixinIlinkClient`）；`protocol/resolveWebSocketImpl.ts:34`；`channel/loadEnabledChannels.ts:118` 等多处
  - 建议：为 `PilotPlatformAdapterConfig['extra']` 定义强类型，收敛 clientFactory 类型。
- **TD-ADAPTERS-N10** · `loadEnabledChannels` 渠道注册表未覆盖全部渠道
  - 类别：D · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/adapters/channel/loadEnabledChannels.ts:8-111`
  - 影响：`CHANNEL_LOADERS` 仅 20 项，缺 feishu/weixin/wecom/qq/cli/tui 等已存在渠道，新增/遗漏需人工维护两处。建议：改由渠道目录自注册或生成清单。

---

## 10. always-on（B3 ✅）

**模块概况**：38 文件；常驻后台执行（Discovery 计划/报告/工作周期/workspace 隔离 + 4 个 always_on_* 工具）。核心编排 1252 行 `runtime/DiscoveryFire.ts`；职责边界清晰但复制与未接线配置显著。
> 复核更正：本模块无真实 TODO/FIXME 注释（4 处命中均为 prompt/契约里「拒收含 fuzzy 'TODO'」的业务语义，非债）。静默吞错 ~21 处 `.catch(()=>undefined)`，多数为 best-effort cleanup 可接受。

- **TD-ALWAYSON-N01** · `DiscoveryFire` god class，`run`/`rerunPlan` 近乎全量复制
  - 类别：A · 严重级：P1 · 工作量：L · 状态：new
  - 位置：`src/always-on/runtime/DiscoveryFire.ts:598`（run）与 `:314`（rerunPlan）
  - 影响：两方法从 workspace→execution→report→写 plan/state/history 几乎逐行相同（~250-280 行）且各带 5 个 `.catch(()=>undefined)` finally 清理块，修一处须改两处。建议：抽 `private runPipeline(plan, baseHistory)`。
  - 证据：`:598-1010` 与 `:314-597` 语义逐段对应；`runWorkspacePhase` 被两者共同调用 `:739`/`:360`。
- **TD-ALWAYSON-N02** · `web/DiscoveryPlanService` 重写一套存储层，与 core 存储双轨并存
  - 类别：D · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/always-on/web/DiscoveryPlanService.ts:626-635`、`:215-269`、`:639-663`
  - 影响：本地 `WorkCycleRecord` 类型 + 自建 readPlanStore/writePlanStore 读同一磁盘 JSON，与 `DiscoveryPlanStore`/`WorkCycleStore` 双轨解析契约可独立漂移。建议：web 层复用 `DiscoveryPlanStore`/`WorkCycleStore`。
- **TD-ALWAYSON-N03** · `execution.*` 与 `workspace.gitLfs` 配置被解析/校验但从未接线
  - 类别：F · 严重级：P2 · 工作量：S · 状态：**done（已修复 2026-08-23）**
  - 修复：`drainTurn`（DiscoveryFire.ts）调用 `gateway.submitTurn` 时接线 `maxTurns: config.execution.maxTurns` 与 `timeoutMs: config.execution.timeoutMinutes*60*1000`（submitTurn 支持这两个限制，使常驻执行受步数/墙钟防护）。`maxToolCalls` 与 `workspace.gitLfs` 因 gateway/workspace 管线暂无对应消费点，改为解析时提交 `ALWAYS_ON_EXECUTION_MAX_TOOL_CALLS_IGNORED`/`ALWAYS_ON_WORKSPACE_GIT_LFS_IGNORED` 告警诊断，不再静默失效。新增 `tests/always-on/config/parseAlwaysOnConfig.spec.ts` 两用例。typecheck/lint/biome/always-on 测试 183 全绿。
  - 位置：`src/always-on/config/parseAlwaysOnConfig.ts:30-32,375-385,343`；`src/always-on/runtime/DiscoveryFire.ts:1138`
  - 影响：`alwaysOn.execution.maxTurns/maxToolCalls/timeoutMinutes` 与 `alwaysOn.workspace.gitLfs` 全仓无任何消费点（`drainTurn` 调 `gateway.submitTurn` 时未传），用户配置这些字段实际不生效。建议：要么接线，要么删除并标记 deprecated。
  - 证据：跨仓 grep `maxTurns|maxToolCalls|timeoutMinutes|gitLfs` 仅命中 parse 文件，`always-on` 内无消费。
- **TD-ALWAYSON-N04** · 事件落盘静默吞错，削弱可观测性
  - 类别：C · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`DiscoveryFire.ts:229`（emitEvent）、`:1157-1158`（appendRunEvent）、`:1164`（closeRun）
  - 建议：对事件持久化失败至少 `logger.warn`。
- **TD-ALWAYSON-N05** · 类型安全：产物双重 `as unknown as` 强转 + web 层大量未校验 `as string`
  - 类别：B · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`DiscoveryFire.ts:1157`；`web/AlwaysOnRunHistoryService.ts:116,309-310,435,488,599` 等
  - 建议：用类型守卫替代 `as`；`GatewayEvent` 走显式映射而非双 `as`。
- **TD-ALWAYSON-N06** · 文档漂移：注释引用不存在的 `DiscoveryFire.ensureWorkspace`
  - 类别：H · 严重级：P3 · 工作量：XS · 状态：new
  - 位置：`src/always-on/runtime/DiscoveryGates.ts:19`
  - 建议：改为引用实际入口 `ensureActiveWorkCycle`/`runWorkspacePhase`。
- **TD-ALWAYSON-N07** · 核心编排器无直接测试
  - 类别：E · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`DiscoveryFire.ts:598,314,252`；`tests/always-on/runtime/scheduler.spec.ts:134`
  - 建议：补 `DiscoveryFire` 直接测试（注入 `DiscoveryFireDependencies`），覆盖 execution/report 失败回退、rerunPlan 复用、runApplyPhase 事件序列。
- **TD-ALWAYSON-N08** · 跨文件重复工具函数
  - 类别：F · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`web/AlwaysOnRunHistoryService.ts:114,119` vs `web/DiscoveryPlanStatus.ts:162,177`
  - 建议：统一收敛到 `DiscoveryPlanStatus.ts` 的共享助手。

---

## 11. knowledge（B3 ✅）

**模块概况**：约 44 TS + 1500+ wiki md 卡；kg-store/legal-search 已拆纯件、38 测试覆盖深。债务在**检索编排重复**、**法规 LIKE 降级未对齐**、**DB 行强转与全局缓存**。`ipc-classifier.ts` 数据内联已由 TD-PATENT-N08 登记，不重复。

- **TD-KNOWLEDGE-N01** · FTS5 探测+降级编排在 3 个检索引擎近乎逐字重复
  - 类别：D · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`legal/legal-search.ts:119-150`、`legal/knowledge-law-search.ts:166-196`、`case-law/case-law-search.ts:351-384`
  - 建议：抽共享 `runFtsThenLikeFallback` 编排原语，把 data-mapper/降级打点作策略参数传入。
- **TD-KNOWLEDGE-N02** · `KnowledgeLawSearch`(knowledge.db 法规) 的 LIKE 降级仍走「每行 UDF 解压」单阶段，未移植 case-law 两阶段/扫描上限
  - 类别：I · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`legal/knowledge-law-search.ts:98-107,303-317`
  - 影响：FTS5 不可用（桌面端默认降级路径）时 LIKE 逐行 `sati_uncompress` 最长 chunk（~4ms/行 × 数千行，无命中最坏数十秒同步阻塞），正是 case-law 明确废弃的「分钟级卡点」模式。建议：把两阶段 + likeScanCap 信号移植过来，JS 层解压绕开 UDF。
- **TD-KNOWLEDGE-N03** · SQLite 行结果 `as X` 强转遍布（29 处），无运行时 schema 校验
  - 类别：B · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`shared/kg-store.ts:103`；`case-law-search.ts:163,308,400,470`；`legal-search.ts:59,162`；`knowledge-law-search.ts:208,242`；`shared/knowledge-embeddings.ts:123,203` 等
  - 建议：为 COUNT/PRAGMA/行读取加轻量 row-mapper 或断言守卫。
- **TD-KNOWLEDGE-N04** · `errorMessage` 辅助函数三处重复 + `buildKnowledgeResolvers` 单函数过长（含 7 段 try/catch + 3 个后台 setTimeout）
  - 类别：A · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/knowledge/assemble.ts:248-250`、`legal/legal-memory-provider.ts:238-240`、`patent/patent-memory-provider.ts:458-460`；`assemble.ts:58-248`
  - 建议：收敛到 shared `errorMessage`；把后台任务登记为可取消句柄并汇总可观测性。
- **TD-KNOWLEDGE-N05** · `knowledge-embeddings` 模块级全局缓存 `instanceCache` 无上限且每项持有打开的 DB 句柄
  - 类别：D · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/knowledge/shared/knowledge-embeddings.ts:71-87,183-198,284-299`
  - 影响：`instanceCache` 是无界 Map，每项持一个 `DatabaseSync` 句柄，按项目/会话产生不同 dbPath 时句柄累积（与 matrixCache 上限 4 的 LRU 不一致）。建议：加 LRU 上限或改为不可变值对象。
- **TD-KNOWLEDGE-N06** · `WikiCardLoader` 冷启动同步扫描 1548 张 md 卡 + 语义 warmup 二次全量读正文
  - 类别：I · 严重级：P3 · 工作量：M · 状态：new
  - 位置：`patent/wiki-card-loader.ts:292-315,134-150,270-282`；`patent/wiki-card-vector-index.ts:55-58`
  - 建议：目录 watcher 增量，或头部元数据与正文分离。
- **TD-KNOWLEDGE-N07** · 引用/元数据解析的静默降级缺可观测性
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`shared/kg/row-mapper.ts:54-61`；`case-law-search.ts:516-519`；`assemble.ts:239-241`
  - 建议：降级路径统一记录一次结构化 warn；空 catch 收敛为带日志的降级。

---

## 12. mcp（B3 ✅）

**模块概况**：16 文件（client/6 + runtime/5 + protocol/2 + config/2）；McpClient 已拆为 connection/operations/toolSpec/transport/errors 六模块 + 13 个 spec。残留为并发敏感生命周期重复、**非法路径读文件**、分层间静默吞错与类型契约漂移。

- **TD-MCP-N01** · 连接失效/重建 teardown 序列在 `reconnect()` 与 `recycleTransportAfterTimeout()` 中重复
  - 类别：F · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/mcp/client/connection.ts:179-197` 与 `:199-222`
  - 影响：两份几乎一致的「同步置空→close→cleanupSessionDir」属并发安全关键路径，单边改动易引入竞态。建议：抽 `private teardown()`。
- **TD-MCP-N02** · `marshalMcpContent` 的 Markdown 图片链接解析存在路径穿越，可把任意磁盘文件读入模型上下文
  - 类别：G（安全）· 严重级：P2 · 工作量：S · 状态：**done（已修复 2026-08-23）**
  - 修复：在 `extractFileImages` 中 `resolvePath` 后加 `relativePath(cwd, absPath)` 包含校验，越界（`..`/跨盘）即跳过；新增 `tests/mcp/runtime/PluginToToolBridge.spec.ts` 的「rejects markdown-linked image files outside cwd (path traversal)」用例。typecheck/lint/biome/测试全绿。
  - 位置：`src/mcp/runtime/PluginToToolBridge.ts:157-201`
  - 影响：`resolvePath(cwd, relPath)` 无路径包含校验，`IMAGE_LINK_RE`(`:175`) 允许 `../` 前缀，恶意/第三方 MCP server 返回带 `![x](../../../.ssh/id.png)` 即可读取跨目录任意文件并以 base64 注入模型上下文（有外发风险）。建议：resolvePath 后校验 `rel` 仍在 `cwd` 内（`path.relative`+`!startsWith("..")`），越界即跳过。
- **TD-MCP-N03** · `McpRuntime.listResources`/`listAllTools` 空 `catch {}` 静默吞错，`readResource` 抛裸 `Error`
  - 类别：C · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/mcp/runtime/McpRuntime.ts:85-92,112-121,99-104`
  - 建议：catch 至少 `console.warn`/聚合到错误面板；裸 `Error` 换为 `McpClientError`。
- **TD-MCP-N04** · `peekInstructions` 双强转读取 SDK 私有字段 `_instructions`/`_serverInstructions`
  - 类别：B · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/mcp/client/connection.ts:110-118`
  - 影响：耦合 `@modelcontextprotocol/sdk` 内部实现，SDK 升级改名即静默失效。建议：对 `getInstructions()` 缺失时降级空串并移除内部字段访问。
- **TD-MCP-N05** · 选项类型 `McpClientOptions` 与 `TransportBuildOptions` 结构重复且各自漂移；`LRU_TTL_MS` 文档与实现不符
  - 类别：F/H · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`McpClient.ts:41-49` vs `transport.ts:22-29`；`McpClient.ts:20-22` vs `operations.ts:16`
  - 建议：`McpClientOptions` 复用/重导出 `TransportBuildOptions`；对齐注释与真实常量。
- **TD-MCP-N06** · `callTool` 对 `args: unknown` 直接 `as Record<string,unknown>`，且空 schema 默认值不一致
  - 类别：B · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`operations.ts:49`；`toolSpec.ts:28` vs `PluginToToolBridge.ts:225-229`
  - 建议：先判 `typeof args === "object"`；统一空 schema 默认值为同一常量。

---

## 13. rule（宪法规则 · B3 ✅）

**模块概况**：11 TS + 9 测试；YAML（`rules/**`）经 RuleLoader 校验 → RuleEngine 确定性评估 → RuleOutputGate / policy-bridge。已落地分层规则包与输出门禁 HITL 审批闭环；债在**缓存失效键、未接线的 policy-bridge、YAML↔代码约定耦合**。

- **TD-RULE-N01** · `rule_check(pack)` 缓存失效键只覆盖清单 mtime，层规则文件修改不致源
  - 类别：I · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/tool/builtin/ruleCheck.ts:54-66`、`src/rule/runtime/rule-pack.ts:162-169`
  - 影响：长驻进程内只改 base/domains/overrides 任一规则文件而未改顶层 `.sati/rules.yaml` 时，`rule_check(scope:"pack")` 返回陈旧规则集。建议：缓存键改为清单 mtime + 各已装载层规则文件 mtime 集合/内容摘要。
- **TD-RULE-N02** · policy-bridge 工具拦截通道未接入生产路径
  - 类别：F · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/rule/runtime/policy-bridge.ts:12-17`
  - 影响：`action:"block"` 目前只在输出层降级为强制审批，`rulesToPolicyDenyRules` 从不注入 `PermissionContext`，并未真正拦截工具调用，与宣称不符。建议：在 `PermissionRuntime` 初始化处接线，或明确标注未启用。
- **TD-RULE-N03** · `evaluateText` 的 domain 过滤为测试专用，线上从不生效
  - 类别：D · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/rule/runtime/RuleEngine.ts:148-153`
  - 影响：`options.domain` 过滤分支无生产调用方传参（rule_check 与输出门禁均不传），规则 `domain` 元数据运行时闲置。建议：按域过滤在 rule_check 暴露 domain 入参透传，或标注测试专用。
- **TD-RULE-N04** · `selectGateRules` 把规则资产 id 前缀与检查类型约定硬编码进代码
  - 类别：D · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/rule/runtime/patent-compliance.ts:151-154`
  - 影响：输出门禁子集由代码内 `type==="keyword_blocklist" && !id.startsWith("PAT-")` 决定，改 YAML 命名约定需改代码，属 code↔assets 漂移风险。建议：抽为可配置门禁谓词或由 YAML 侧显式声明 gate 参与标记。
- **TD-RULE-N05** · 加载/解析路径依赖 `as` 强制转换与非空断言
  - 类别：B · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/rule/runtime/RuleLoader.ts:111-119,235,239`、`text-utils.ts:114-117`
  - 建议：用 `isRuleSeverity`/`isRuleAction` 窄化守卫替代 `as`；中文数字改 Map 查找+窄化去 `!`。
- **TD-RULE-N06** · 评估路径对运行期正则异常静默吞错
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/rule/runtime/RuleEngine.ts:71-74,97-99`
  - 建议：空 catch 内至少 `console.warn` 或收集进评估结果。

---

## 14. workflow（B3 ✅）

**模块概况**：11 TS + 4 测试；DAG（FlowGraph/DagExecutor）+ SafeEvaluator + InputResolver + checkpoint 双实现 + persistence + worker resolver + SubAgentSession 桥。**已移植未接线**：src/ 内仅 `FlowGraph`/`FlowNodeType` 被 `src/patent/workflow-dag.ts` 借用。

- **TD-WORKFLOW-N01** · 引擎整体未接线，仅 FlowGraph 被生产消费（与 patent 双轨重复）
  - 类别：F · 严重级：P1 · 工作量：M · 状态：new
  - 位置：`src/workflow/runtime/WorkflowEngine.ts:10-15`；`src/patent/workflow-dag.ts:15`
  - 影响：engine/SafeEvaluator/InputResolver/checkpoint/persistence/workerResolver/subagentFactory 及 DagExecutor 在 src/ 内零生产调用方，仅被 tests/ 覆盖，属未接线平行实现，与 `src/patent/workflow`+`graph` 双轨重复（呼应 TD-PATENT-N01）。建议：要么接线沉淀为唯一引擎，要么降级为基线并标注生命周期；至少删除纯死码 DagExecutor。
- **TD-WORKFLOW-N02** · 失败 wave 不取消兄弟步骤，AbortSignal 通道未使用
  - 类别：I · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/workflow/runtime/WorkflowEngine.ts:344-355,395,453`；`protocol/types.ts:109`
  - 影响：`runReadySteps` 用 `Promise.allSettled(workers)` 整批收尾，任一步失败须等整 wave 跑完才判定失败，浪费兄弟步骤 LLM token 并可能产生副作用；`WorkflowAgentFactory.prompt` 声明 `signal?` 但两处调用均未传。建议：失败后经 AbortController 向在飞兄弟步骤广播 signal。
- **TD-WORKFLOW-N03** · maxParallel worker 池（信号量）无针对性测试
  - 类别：E · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`WorkflowEngine.ts:341-355`；`tests/workflow/WorkflowEngine.test.ts:111-155`
  - 影响：现有测试只跑 2 个并行步骤（默认 maxParallel=4 从不触顶），无用例断言超上限并发被压住及边界。建议：补 `maxParallel:2` 超上限并发计数测试。
- **TD-WORKFLOW-N04** · `workflow_failed.error` 载荷错误（用 `ready[0]` 而非实际失败步骤）
  - 类别：C · 严重级：P2 · 工作量：S · 状态：**done（已修复 2026-08-23）**
  - 修复：`WorkflowEngine` 收集失败步骤 id 到 `failedStepIds`，`workflow_failed.error` 上报 `failedStepIds[0]`（首个实际失败步骤），而非恒取波内首步 `ready[0]`。新增 `tests/workflow/WorkflowEngine.test.ts` 的「workflow_failed reports the actual failed step, not the first ready step」回归用例（成功步骤在前 + 失败步骤在后）。typecheck/lint/biome/测试全绿。
  - 位置：`src/workflow/runtime/WorkflowEngine.ts:285-301`
  - 影响：失败判定用 `ready[i]!.id` 定位真实失败步骤（`:289`），但 `:301` `workflow_failed.error = ready[0]?.id` 恒取波内首步；失败者非首个就绪步骤时上报错误步骤 id。建议：收集失败步骤 id 到局部变量。
- **TD-WORKFLOW-N05** · 双份手写点路径解析器重复
  - 类别：A · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`SafeEvaluator.ts:214-228`；`InputResolver.ts:23-52`
  - 建议：抽为共享 resolver。
- **TD-WORKFLOW-N06** · 非空断言 `!` 与 `as unknown as X` 双强转依赖不变量
  - 类别：B · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`WorkflowEngine.ts:285,289,348,572,521`；`DagEngine.ts:177`
  - 建议：显式取值并断言，或对 find 失败抛 `WorkflowPlanError`。

## 15. extension（B4 ✅）

**模块概况**：57 文件；插件/技能装载、生命周期 hooks、7 种贡献点、Skill CRUD/校验/迁移；含 SkillManager 904 行、PluginRuntime、hooks 五类执行器；`tests/extension/` 10 文件。类型卫生良好（无 any/`@ts-ignore`/非空断言）。

- **TD-EXTENSION-N01** · `SkillManager.ts` 单文件巨类，职责重叠
  - 类别：A/D · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/extension/skills/SkillManager.ts:66-412` + `:764-899`
  - 建议：把 `validateFromDisk`/`validateFromManifest`/`walkDir` 抽到独立 `validation.ts`。
- **TD-EXTENSION-N02** · 磁盘/清单两套校验流程近乎重复
  - 类别：F · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`SkillManager.ts:765-800` 与 `:855-899`
  - 建议：抽共享 `pushSizeIssues`/`pushExtIssues` 收口。
- **TD-EXTENSION-N03** · 插件/技能装载失败被静默丢弃
  - 类别：C · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`plugins/runtime/PluginRuntime.ts:317-318`；`plugins/loading/PluginLoader.ts:55-57,67`
  - 影响：任一 plugin.json 损坏或 SKILL.md 引用不在时，该插件/技能从 snapshot 无痕消失，用户无任何诊断。建议：在 `PluginRefreshResult`/`snapshot` 暴露 load-failure 列表并告警。
- **TD-EXTENSION-N04** · 重复的 `e as NodeJS.ErrnoException` 错误收窄
  - 类别：B · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`SkillManager.ts:189,220,250,267,285,381,675`；`migrateSkills.ts:251`
  - 建议：抽 `isErrno(e, "ENOENT")` 类型守卫统一收窄。
- **TD-EXTENSION-N05** · `SkillRoleConfig.knowledge` 声明并消费却从未被解析
  - 类别：H · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`skills/types.ts:41`、`skills/roleConfig.ts:8-19`；消费 `agent/sub/roleFromSkill.ts:108`
  - 影响：`knowledge:` 特性（cards/requireCaseSearch/requireLawSearch）在类型与消费方声明，但唯一解析器 `parseRoleConfig` 不产出该字段，SKILL.md `knowledge:` 永不生效、功能静默失效。建议：补 `knowledge` 嵌套解析或移除字段与文档。
- **TD-EXTENSION-N06** · skills 扫描/校验的静默吞错无观测
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`SkillManager.ts:598-603,630-636,695,814-815,839-840`
  - 建议：改用收集警告而非静默返回。

---

## 16. permission（B4 ✅）

**模块概况**：7 文件；`PermissionRuntime.decide` 串联 deny Guard 链、会话/用户/项目规则与 plan/bypass 模式、`ToolGuardRegistry`、`settings.ts` 持久化。`policy` 来源规则接线缺口已由 TD-RULE-N02 收录。

- **TD-PERMISSION-N02** · 配置读取失败/损坏时静默回退默认，且默认 `skipPermissions: true`
  - 类别：C · 严重级：**P1** · 工作量：S · 状态：**done（已修复 2026-08-23）**
  - 修复：`readPermissionSettings` 区分 ENOENT（缺失→合法默认）与其他读取错误/JSON 损坏（→ `skipPermissions:false` 容错并 `console.warn` 诊断，不再静默放大为绕过权限）。更新 `tests/permission/settings.spec.ts` 的「missing file defaults, corrupt file fails safe」用例。typecheck/lint/biome/测试全绿。
  - 位置：`src/permission/settings.ts:41-49`、`:18`
  - 影响：`readPermissionSettings` 的 `catch {}` 把「文件不存在」与「JSON 损坏/读失败」一律回退到 `DEFAULT_PERMISSION_SETTINGS`（其中 `skipPermissions: true`），损坏文件**静默放大为绕过全部权限**且无日志。建议：区分「缺失」（合法默认）与「损坏」（上报 warning 并 fail-safe 到 `skipPermissions:false`）。
- **TD-PERMISSION-N01** · `decide()` 单方法过长、嵌套过深
  - 类别：A · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/permission/decision/PermissionRuntime.ts:30-157`
  - 建议：把各来源规则解析与模式分支抽成独立纯函数。
- **TD-PERMISSION-N03** · `writePermissionSettings` 非原子写、无 fsync
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/permission/settings.ts:59-64`
  - 影响：`writeFileSync` 直写目标路径，崩溃/断电可能截断 `permissions.json`，触发 N02 的损坏→静默放宽。建议：temp+rename 原子替换。
- **TD-PERMISSION-N04** · 用 `as` 断言做运行时字段探测而非 `isRecord` 守卫
  - 类别：B · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`PermissionRuntime.ts:375,397`；`policy/matchPermissionRule.ts:98,123`
  - 建议：改用 `isRecord()` 守卫后再访问。

---

## 17. pilot（B4 ✅）

**模块概况**：14 文件；`loadPilotConfig` 编排 15+ 子 parser 生成冻结快照，`PilotConfigStore` 缓存/热重载/`lastGoodFacts`/失败计数，辅以合并/脱敏/变更分类。

- **TD-PILOT-N02** · 校验错误走两套通道：结构化诊断 vs 直接 `throw PilotConfigError`
  - 类别：C · 严重级：**P1** · 工作量：M · 状态：new
  - 位置：`src/pilot/config/loadPilotConfig.ts:681`；`parseMemoryConfig.ts:452`
  - 影响：值校验器直接 throw，且 `loadPilotConfig` 仅对 `parseModel` 包了 try/catch（`575-590`），首载时此类 throw 直接冒泡不进诊断数组；`PilotConfigStore.reload` 捕获后因这些 Error 未携带 `diagnostics`，无法向 UI 呈现可读错误。建议：统一让值校验器 push diagnostic，或顶层捕获转成 fatal diagnostic。
- **TD-PILOT-N01** · `loadPilotConfig.ts` ~784 行单函数编排 monolith
  - 类别：A · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/pilot/config/loadPilotConfig.ts:35-165` + 全文件 784 行
  - 建议：按子系统拆parse+assemble，或拆为 `parse`+`assemble` 两纯函数。
- **TD-PILOT-N03** · `warmOllamaProviders` fire-and-forget 无错误处理（未捕获拒绝）
  - 类别：C · 严重级：P2 · 工作量：S · 状态：**done（已修复 2026-08-23）**
  - 修复：`warmOllamaModels` 与 `getCachedOllamaModels`（stale-while-revalidate 后台刷新）的 fire-and-forget 调用加 `.catch(() => {})`（预热为 best-effort，ollama 不可达时忽略，不再 unhandledRejection）；`warmOllamaModels` 增可选 `options.fetchImpl` 透传以便注入失败 fetch。新增 `tests/model/ollamaConfig.spec.ts` 的「warmOllamaModels swallows unreachable-ollama rejection」用例（监听 unhandledRejection 断言不触发）。typecheck/lint/biome/测试全绿。
  - 位置：`loadPilotConfig.ts:599`；`src/model/ollama/probe.ts:159-186`
  - 影响：`warmOllamaModels` 是 `void` 丢弃 promise，`probeOllamaModelsCached` 无 `.catch`，每次加载若 ollama 不可达即 unhandledRejection。建议：在 `probe.ts` 链尾加 `.catch(()=>{})`。
- **TD-PILOT-N04** · reload 失败仅 `console.warn`，无结构化上报
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`PilotConfigStore.ts:117-128`
  - 建议：接入 telemetry/诊断通道或发布 reload 失败事件。
- **TD-PILOT-N05** · 每次 reload 全量递归 diff 配置
  - 类别：I · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`classifyChanges.ts:3-5,73-100`
  - 建议：先比较 `previousSnapshot.contentHash !== nextSnapshot.contentHash`，同则短路返回。

---

## 18. cron（B4 ✅）

**模块概况**：18 文件、五层结构（config/protocol/runtime/storage/tool）+ 4 个 `cron_*` 工具；9 个测试文件，覆盖相对扎实。

- **TD-CRON-N01** · `CronTaskStore` 整文件写放大 + 读改写仍存在
  - 类别：I · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/cron/storage/CronTaskStore.ts:159-196`（`writeTaskFile`/`mutateTaskFile`）
  - 影响：每次 put/update/delete 都整文件读+全量序列化+temp+rename，一个 recurring 任务每跑一次触发 2 次整文件重写。建议：按 project 内存缓存任务数组，去掉美化序列化与「读回再用」。
- **TD-CRON-N02** · 损坏 tasks.json 被静默清空，store 无 logger
  - 类别：C · 严重级：P2 · 工作量：S · 状态：**done（已修复 2026-08-23）**
  - 修复：`readTaskFile` 解析/形状校验失败时把损坏文件 `rename` 为 `tasks.json.corrupt-<ts>` 并 `console.warn`（fail-closed，不再静默返回空数组留下被覆盖的隐患），随后按空任务表降级。新增 `tests/cron/storage/cron-task-store.spec.ts` 的「损坏的 tasks.json 备份为 .corrupt-<ts>，而非静默清空数据」用例（含后续 putTask 正常落盘 + 备份保留断言）。typecheck/lint/biome/测试全绿。
  - 位置：`src/cron/storage/CronTaskStore.ts:137-156`
  - 影响：`readTaskFile` 对解析失败统一 catch 返回空数组，下一次 mutation 即把空数组写回，未备份损坏文件无告警。建议：解析失败先备份成 `.corrupt-<ts>` 并 fail-closed。
- **TD-CRON-N03** · `normalizeTask`/`normalizeRun` 对每条记录二次调用 + 非空断言
  - 类别：F · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`CronTaskStore.ts:110-113,152-153`
  - 建议：先 `const norm = normalizeX(parsed);` 再判空，去掉 `!`。
- **TD-CRON-N04** · 调度器用「处理前」快照重算下一次唤醒 → 每批后一次冗余 250ms 唤醒
  - 类别：I · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`CronScheduler.ts:111-118`、`:102-104`
  - 建议：fire 后刷新 `lastTasks` 或 tick 末尾重新 `listTasks()`。
- **TD-CRON-N05** · `listRuns` 每次全量读取并解析整份 run-history.jsonl
  - 类别：I · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`CronTaskStore.ts:97-118`；`CronRuntime.ts:488-492`
  - 影响：`recoverInterruptedRuns` 以 `Number.MAX_SAFE_INTEGER` 全量拉取构建 terminal 集合，append-only 历史随后累积 O(运行总数)。建议：仅读末尾若干字节/行或建索引。
- **TD-CRON-N06** · cron 表达式解析器只支持数字子集，非法/特殊字段一律笼统报错
  - 类别：B · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`CronSchedule.ts:112-145`（`parseField`）；`CronRuntime.ts:216-217,286-287`
  - 建议：对不支持的语法显式报「不支持字段 X」或给出定位。

---

## 19. literature（B4 ✅）

**模块概况**：13 文件；免费无 key 学术检索——Connector 契约 + Registry + 双工具（paper_search/paper_list_sources），首批 arXiv/OpenAlex/Crossref/Semantic Scholar；限速与 GET 缓存集中 `runtime/http.ts`。

- **TD-LITERATURE-N01** · 四连接器重复实现 authors / toHit / limit 钳制
  - 类别：F · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`runtime/connectors/{arxiv,openalex,crossref,semanticScholar}.ts`；`paperSearch.ts:128`
  - 建议：把 limit 钳制/authors 聚合/toHit 骨架抽到 `shared/`。
- **TD-LITERATURE-N02** · JSON 连接器未传 looksValid，200-HTML 错误页可进缓存并污染 5 分钟
  - 类别：C/I · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`runtime/http.ts:170-206`；`{openalex,crossref,semanticScholar}.ts`（未传 looksValid）
  - 影响：源返回 200+HTML 错误页时被当健康 2xx 缓存进 LRU，随后同 URL 命中重复 `JSON.parse` 失败→连续 5 分钟失败，且归为 `tool_execution_failed`。建议：JSON 连接器传 `looksValid` 或在 `getJSON` 内置最小形状校验。
- **TD-LITERATURE-N03** · JSON 连接器对「意外 200 形状」默认 `?? []` → 静默零结果
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`{openalex,crossref,semanticScholar}.ts`（`?? []`）
  - 影响：源改版/错误封套退化为「无结果」而非「源出错」，掩盖上游回归。建议：缺 `results`/`message.items`/`data` 时抛 `SatiToolRuntimeError`。
- **TD-LITERATURE-N04** · 双工具 checkPermissions 恒为 ask 且 reason/request 字面量重复
  - 类别：F · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`tool/paperSearch.ts:95-118`、`paperListSources.ts:66-82`
  - 建议：抽 `buildPermissionRequest(toolName, message)` 复用。
- **TD-LITERATURE-N05** · `raw()` 与 `getJSON` 的宽泛 `as` 断言
  - 类别：B · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`shared/text.ts:55`；`http.ts:228`
  - 建议：`raw` 输入收窄为 `object`；连接器侧补最小运行时校验。

---

## 20. methodology（B4 ✅）

**模块概况**：16 文件；注册表 + 9 个纯规则组件（仅 identify/execute 生成 prompt，无 LLM 调用）；triz 为确定性查表。测试仅 3 文件（薄）。

- **TD-METHODOLOGY-N01** · triz 确定性查表为 O(n²) 组合，可产生语义存疑配对行并致 prompt 膨胀
  - 类别：A · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`components/triz.ts:105-143`（`buildLookupLines`）
  - 影响：goal 含较多参数时可产生 n(n-1) 行（n≤39 → 1482 行）挤占 context，且注入「运动物体重量→静止物体重量」等非真实矛盾对。建议：去重收敛、限制注入行数，仅注入唯一矛盾对。
- **TD-METHODOLOGY-N02** · triz 数据经 `as number[][][]`/`as TrizPrinciple[]` 裸断言
  - 类别：B · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`components/triz.ts:39,57`
  - 建议：`JSON.parse` 后做 `Array.isArray`+边界断言，或引入轻量 schema 校验。
- **TD-METHODOLOGY-N03** · pdca/fishbone/first-principles/six-hats 无任何直接单测
  - 类别：E · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`components/{pdca,fishbone,first-principles,six-hats}.ts`；`tests/methodology/`（仅 3 文件）
  - 建议：为这 4 个组件补 identify/execute 快照测试 + injectMethodology 分支用例。
- **TD-METHODOLOGY-N04** · `injectMethodology` 使用非空断言 `matches[0]!`
  - 类别：B · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`MethodologyInjector.ts:48`
  - 建议：`const top = matches[0]; if (!top) return ...` 消除 `!`。

---

## 21. shared（B4 ✅）

**模块概况**：11 文件；ttl-cache、debug.ts（`SATI_DEBUG` 门控 debugLog）、sqlite.ts（prepare 缓存）、retry、env、paths/。均为进程内小工具。

- **TD-SHARED-N01** · path 解析的安全逻辑与 pilotPaths 无专项测试，ttl-cache 测试错位在 tests/knowledge
  - 类别：E · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`paths/{findGitRoot,resolveCanonicalRoot,findCanonicalProjectRoot,pilotPaths}.ts`；`resolveCanonicalRoot.ts:70-99`；`tests/shared/` 仅 env+retry
  - 影响：`resolveCanonicalRoot` 含两条防目录穿越安全校验（worktree 布局 + back-link）却零回归保护。建议：安全/路径用例归位 `tests/shared/paths/`；ttl-cache 测试迁回 `tests/shared/`。
- **TD-SHARED-N02** · `prepareCached` 缓存生命周期交由调用方，无自动失效易致 StatementSync 悬空
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/shared/sqlite.ts:10-20`
  - 建议：改为随 db 连接绑定生命周期的封装（或 WeakMap 键控 db）。
- **TD-SHARED-N03** · `TtlCache` 按插入序 FIFO 淘汰，`get()` 不刷新 recency
  - 类别：I · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/shared/ttl-cache.ts:28-46`
  - 影响：高频命中键可能先于低频键被淘汰（对比 `LRUMap.ts:18-25` 会刷新 recency）。建议：`get` 命中时刷新 recency 或改 LRU。

---

## 22. web（B4 ✅）

**模块概况**：12 文件；Web 消息投影三件套（webMessageFlatten/readSessionMessages/injectWebMessages）+ 客户端 reducer/帧映射 + server 工具（forkSession/listProjects/sessionTokenUsage）。

- **TD-WEB-N01** · `cloneMessage` 用 JSON 序列化深拷贝 + `as CanonicalMessage` 裸断言，位于每请求历史重建热路径
  - 类别：B · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/web/server/readSessionMessages.ts:477-479`
  - 影响：缓存 miss 时对每条消息 `JSON.parse(JSON.stringify(...))`，丢弃 `undefined`、对 BigInt/循环引用抛错并拖慢长会话全量重建（O(N×M) 卡点）。建议：改成结构化浅/深拷贝。
- **TD-WEB-N02** · live reducer 与帧映射各自维护一套重复的工具别名/错误归一/失败事件集/预览上限
  - 类别：F · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`webMessage.ts:12-27,29-44,45-69,157-166,564-567` vs `eventMapping.ts:29-45,50-66,93-113`；`injectWebMessages.ts:249-252`
  - 建议：抽共享事件集/别名/预览截断常量到单一源。
- **TD-WEB-N03** · 历史展示对广泛异常静默降级，`listProjects.summarizeProject` 把一切失败折叠为 sessionCount=0
  - 类别：C · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/web/server/listProjects.ts:78-87`
  - 影响：`listProjectSessions` 因权限/IO 失败时项目被静默显示为「0 会话」、丢弃 lastActivity，无日志。建议：至少 `console.warn` 或区分「未找到」与「读取失败」。
- **TD-WEB-N04** · `forkSession.ts`（490 行）无任何直接测试
  - 类别：E · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/web/server/forkSession.ts:1-490`（`retargetCopiedSubagentTranscripts:330-379`；`:356-369` 行 `JSON.parse(line) as AgentTranscriptEntry` 无 shape 校验）
  - 建议：补 fork 端到端/单元测试，行解析做 shape 判别。

---

## 23. task·telemetry·lifecycle·fs·browser·network·status·test-support（small-modules · B4 ✅）

**模块概况**：task 4 文件/2 spec · telemetry 5/2 · lifecycle 8/1 · fs 1/1 · browser 6/1 · network 2/1 · status 2/1 · test-support 7/4。类型卫生良好（无 `@ts-expect-error`），风险集中在**后台任务驻留**、**遥测故障不可观测**、**llm-replay 保真度**。

- **TD-SMALL-N01** · `BackgroundTaskRuntime.entries` 永不回收 → 完成任务驻留内存（task）
  - 类别：I · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/task/runtime/BackgroundTaskRuntime.ts:101`（`entries` Map）
  - 影响：每次 `start` 的条目（含 TaskOutputStore，默认每任务至多驻留 1MB ring buffer）在完成后仍留在 Map，长驻 agent 下无界增长。建议：完成路径按需 evict + TTL。
- **TD-SMALL-N02** · telemetry `TelemetrySender.flush` 上传失败静默吞没（telemetry）
  - 类别：C · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/telemetry/sender.ts:84-99`（`sendBatch` 抛错 `:133`）
  - 建议：catch 内 `console.warn` 或结构化日志带 status/原因，并在 metrics 暴露 `lastErrorAt/lastErrorStatus`。
- **TD-SMALL-N04** · llm-replay `record` 中途抛错流被落成「无标记截断流」（test-support）
  - 类别：F · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/test-support/llm-replay/record.ts:63-87`
  - 影响：`stream` 的 `finally` 在 `inner.stream` 抛错时仍把已产出部分事件落盘为完整记录，fixture 无法区分真错误与截断成功，重放时误以为成功掩盖真实回归。建议：记录 `error`/`aborted` 标记，重放时据此抛错。
- **TD-SMALL-N03** · telemetry 上下文解析同步 `execFileSync("git")` ×2 阻塞启动（telemetry）
  - 类别：I · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/telemetry/context.ts:73-85,119-129`
  - 建议：两处合并为一次同步调用，或异步化/优先读环境变量。
- **TD-SMALL-N05** · llm-replay `complete`/`getCapabilities` 透传 base，非 fixture 覆盖（test-support）
  - 类别：D · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/test-support/llm-replay/replay.ts:100-108`
  - 影响：`complete`/`getCapabilities`/`getMultimodal` 委托 `base`（真实 runtime），若重放测试触发 `complete` 会绕过 fixture 直击底层网络/基础 runtime。建议：确认重放回路只走 `stream`，否则也建立 fixture 或明示局限。
- **TD-SMALL-N06** · `isRetryableNetworkCode` 对非瞬态码全量退避重试 + 错误分类依赖子串启发式（network）
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/network/fetch.ts:207-209`、`:180-205`
  - 建议：区分瞬态/持久错误位（connection_refused/proxy_error 降低重试或直接失败），错误分类收敛为基于 `code`/`cause.code` 映射。
- **TD-SMALL-N07** · jsonl-run-writer append 与空闲回收存在 fd 竞争，写/关错误被静默吞（fs）
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/fs/jsonl-run-writer.ts:47-62,80-91`
  - 建议：append 校验句柄有效性或把 close 与 write 合入同一串行链；静默吞错改计数/告警。
- **TD-SMALL-N08** · `sanitizeProperties` 按 key 子串丢弃，误伤合法字段（telemetry）
  - 类别：D · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/telemetry/collector.ts:36,211-222`
  - 影响：`PATH_LIKE_KEY = /path|cwd|root|dir|file/i` 按子串匹配 key 直接丢弃，会静默丢弃 `fileType`/`profile_name`/`rootCause` 等合法字段。建议：按精确 key 名单或整词/值形态校验，并给丢弃加可观测计数。

## 24. ui/src · chat/code-editor（B5 ✅）

**模块概况**：聊天栈由 `chat/`（共享 hooks + 消息/工具渲染原子）与 `chat-v2/`（`ChatInterfaceV2` 展示层，唯一消费方）组成；核心难点在 `CodeEditorBinaryFile`(1523)/`PdfDocumentPreview`(1138) 两个巨型预览组件与 `useChatComposerState`/`useChatSessionState`/`MessagesPaneV2` 三个 God hooks。i18n 在消息/编辑器已较规范走 `useTranslation`。

- **TD-UI-CHAT-N01** · `useChatComposerState` 为巨型 God hook（函数体 ~1430 行）
  - 类别：A · 严重级：P1 · 工作量：L · 状态：new
  - 位置：`ui/src/components/chat/hooks/useChatComposerState.ts:179`
  - 影响：一个 hook 承担草稿持久化/斜杠命令/文件提及/附件上传/拖拽/忙碌队列/会话生命周期/思维模式编排。建议：拆 `useComposerInput`/`useAttachmentUpload`/`useSlashCommandExecute`/`useSessionSubmit`。证据：`:810-1107`（handleSubmit 单回调 ~300 行）、`:364-549`（handleBuiltInCommand 9+ 分支 switch）。
- **TD-UI-CHAT-N02** · `useChatSessionState` God hook + 恒为 false 的死状态 `isLoadingMoreMessages`
  - 类别：A/F · 严重级：P2 · 工作量：L · 状态：new
  - 位置：`useChatSessionState.ts:236`（hook）、`:251`（死状态）
  - 影响：`isLoadingMoreMessages` 从未被 setter 赋值、恒 false，却被透传门控「加载更多」UI。建议：删除该死状态（`isLoadingMoreRef` 已是真实信号），分页/滚动定位抽出独立 hook。
- **TD-UI-CHAT-N03** · `MessagesPaneV2` 巨型组件 + 手写消息虚拟化
  - 类别：A/I · 严重级：P1 · 工作量：L · 状态：new
  - 位置：`ui/src/components/chat-v2/MessagesPaneV2.tsx:314`（文件 1252 行）
  - 影响：同时承担虚拟滚动/进程分组/子代理详情/fork/搜索/可展开行渲染；虚拟化全手写（估算高度 + ResizeObserver + 多条 RAF/前缀和缓存）。建议：窗口计算/高度测量抽独立 hook，拆 LiveProcess/Subagent/Fork 子组件。
- **TD-UI-CHAT-N04** · `MessageComponent` 巨型单消息渲染器（812 行）
  - 类别：A · 严重级：P2 · 工作量：L · 状态：new
  - 位置：`ui/src/components/chat/view/subcomponents/MessageComponent.tsx:158`
  - 影响：同时渲染 user/assistant/tool/error/thinking/interactive/system 及工具结果/权限/审批/图片/markdown 多形态，props 达 13 个。建议：按消息类型拆 `MessageBubble`/`ToolResultBlock`/`PermissionBlock`。
- **TD-UI-CHAT-N05** · chat 与 chat-v2 子代理渲染重复实现
  - 类别：F · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`chat-v2/SubagentCard.tsx:27` vs `chat/tools/components/SubagentContainer.tsx:63`
  - 建议：统一为单一 `SubagentRenderer`。
- **TD-UI-CHAT-N06** · 工具配置/渲染器大量 `any`，违反 strict/no-any 规范
  - 类别：B · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`chat/tools/configs/toolConfigs.ts:1,19-55,646-783`；`chat/tools/ToolRenderer.tsx:108-109`
  - 影响：工具协议契约以 `any` 表达，改 inputSchema/结果结构无编译期守护。建议：引入结构化联合类型，逐步以 `unknown`+收窄替换 `any`。
- **TD-UI-CHAT-N07** · `PdfDocumentPreview` 巨型组件（1138 行）
  - 类别：A · 严重级：P2 · 工作量：L · 状态：new
  - 位置：`code-editor/view/subcomponents/PdfDocumentPreview.tsx:723`
  - 影响：约 20 个 useState + 12 useRef，承担 PDF 加载/缩放/旋转/导航/搜索/区域选择/大纲/缩略图。建议：抽 `usePdfViewerState`，缩略图/大纲/搜索拆独立组件。
- **TD-UI-CHAT-N08** · `CodeEditorBinaryFile` 巨型文件（1523 行）+ 内联 8 hooks 分派器
  - 类别：A · 严重级：P3 · 工作量：M · 状态：new
  - 位置：`code-editor/view/subcomponents/CodeEditorBinaryFile.tsx:1386`
  - 建议：按预览类型拆分文件，hook 移入独立模块。
- **TD-UI-CHAT-N09** · 跨 hook 共享可变 ref（`pendingViewSessionRef`）协调会话时序
  - 类别：D · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`chat-v2/ChatInterfaceV2.tsx:180,258` 透传三个 hook
  - 影响：乐观气泡/会话创建/竞态规避依赖跨 hook 共享可变 ref + 大量时序不变式注释，脆弱难推理。建议：收敛为单一 owner 的会话创建状态机。
- **TD-UI-CHAT-N10** · 巨型组件测试覆盖薄弱，错误可观测依赖裸 console
  - 类别：E/C · 严重级：P3 · 工作量：M · 状态：new
  - 位置：`MessageComponent.tsx`（仅 2 测）、`MessagesPaneV2.tsx`（仅 render.test）、`PdfDocumentPreview.tsx`/`CodeEditorBinaryFile.tsx`（各 1 测）
  - 建议：补虚拟化窗口/审批/工具错误行为测试，引入结构化错误上报。

---

## 25. ui/src · app-shell/面板/stores（B5 ✅）

**模块概况**：UI 壳层与状态层。`app-shell/`（SidebarV2/AppShellV2）、`main-content(-v2)/`、`stores/useSessionStore.ts`（会话消息单例）、`hooks/useProjectsState.ts`、`contexts/`、i18n。集中 UI 最大体积与 i18n 违规痛点。

- **TD-UI-APP-N01** · `SkillsV2.tsx` 全仓最大组件且内嵌 854 行 `ImportFromFolder`
  - 类别：A · 严重级：P1 · 工作量：L · 状态：new
  - 位置：`main-content-v2/SkillsV2.tsx:120`（主组件）、`:1414-2268`（ImportFromFolder）
  - 影响：单文件 2503 行；`ImportFromFolder` 一个函数 ~40 state/effect + 两套几乎相同的模型/校验 fetch 逻辑。建议：按 `skills/import/` feature-folder 拆出（picked/typed/batch 三模式）。
- **TD-UI-APP-N02** · `useSessionStore.ts` ~1440 行，流式/子代理族高度重复
  - 类别：A · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`stores/useSessionStore.ts:632`
  - 影响：`updateStreaming`/`updateStreamingThinking`/`updateSubagentDetailStreaming` 及各自 finalize 共 8 个近同函数；`fetchFromServer`/`fetchMore`/`refreshFromServer` 三处重复拼接 `URLSearchParams`。建议：抽 `streamingPatch`/`finalizeStream`/`buildSessionQuery`。
- **TD-UI-APP-N03** · `AppShellV2` 删除确认弹窗整段硬编码英文，未走 i18n
  - 类别：H · 严重级：P1 · 工作量：S · 状态：**done（已修复 2026-08-23）**
  - 修复：两个删除弹窗全部文案改为 `useTranslation("common")` 的 `t()`，新增 `deleteDialogs.*`（含复数 `_one/_other` 的 `projectSessionsRemovedCount` 与 `projectFilesOnDisk*` 三段拆分保留内联强调）。父组件错误文案（errorDeleteProject/errorDeleteSession）一并提取，`useCallback` 依赖补 `t`。新增 `app-shell/deleteDialogs.i18n.test.ts` 断言 en/zh-CN 的 key 解析与 `{{count}}`/`{{projectName}}` 插值。en/zh-CN common.json key 对齐（428/428）；ui typecheck/lint/biome/全量测试 578 通过。
  - 位置：`app-shell/AppShellV2.tsx:770-839`（DeleteProjectDialog）、`:848-908`（DeleteSessionDialog）
  - 影响：用户可见文案（"Delete project?"/"Cancel"等）全部硬编码，违反「UI 文案必须提取到 locales」铁律。建议：改用 `useTranslation()` 并补 common/settings key。
- **TD-UI-APP-N04** · `LlmConfigurationStep.tsx` 全屏硬编码英文 + 多重 YAML cast 改写 + 重复模型拉取
  - 类别：H · 严重级：P1 · 工作量：M · 状态：done
  - i18n 已修复（2026-08-23）：全屏硬编码文案改为 `useTranslation("settings")` 的 `t()`，新增 `settings.llmSetup.*`（含内联 `<span>` 的三段拆分保留 font-mono；协议/默认 URL 用 `protocolLabel`/`defaultUrlLabel` 标签+值拆分避免插值转义）。新增 `onboarding/view/subcomponents/llmSetup.i18n.test.ts` 断言 en/zh-CN key 解析与插值。en/zh-CN settings key 对齐（1043/1043）。ui typecheck/lint/biome/全量测试 582 通过。
  - 结构修复（2026-08-23）：YAML 组装抽为纯函数 `llmConfigBuilder.ts`（`buildLlmConfig`，无 `as`；补默认值、按模型 id 合并、清理 legacy key）；三条模型拉取路径（两个自动 effect + 手动按钮）合并为单一 `loadModels`（`llmModelLoading.ts` 纯函数 `modelUsesRemoteDefault`/`resolveNextModels`/`resolveLoadErrorKind`），并移除按 `selectedModelId` 的重复 refetch。新增 `llmConfigBuilder.test.ts`、`llmModelLoading.test.ts`。ui typecheck/lint/biome/onboarding 测试通过。
  - 位置：`onboarding/view/subcomponents/LlmConfigurationStep.tsx:376-717`（硬编码，已修）、`:290-346`（YAML cast）、`:122-196`（重复 fetch）
  - 影响：用户可见文案（"LLM Provider Setup"/"Test Connection"等）全部硬编码，违反「UI 文案必须提取到 locales」铁律。建议：改用 i18n、typed builder 组装 YAML、合并两效应。
- **TD-UI-APP-N05** · `useGitPanelController.ts` 各 git 操作近乎复制粘贴，错误上报不一致
  - 类别：F · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`git-panel/hooks/useGitPanelController.ts:309-465,565-630`
  - 影响：7 个操作函数同构；`handlePublish`/`discardChanges`/`deleteUntrackedFile` 仅 `console.error`，`handleFetch`/`handlePull`/`handlePush` `setOperationError`，`createInitialCommit` 直接 `throw`——契约不一致。建议：统一错误处理。
- **TD-UI-APP-N06** · 文件树与会话树均未虚拟化，大项目/大会话列表存在 DOM 膨胀
  - 类别：I · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`main-content-v2/FilesV2.tsx:54-85,718-839`；`app-shell/SidebarV2.tsx:323,697-908`
  - 建议：接入 `@tanstack/react-virtual`。
- **TD-UI-APP-N07** · `ThemeContext.jsx` 等 contexts 未类型化，消费端靠 `as { isDarkMode }` 兜底
  - 类别：B · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`contexts/ThemeContext.jsx:6`；`main-content-v2/SkillsV2.tsx:122`
  - 建议：contexts 统一为 `createContext<T>()` + `.tsx`。
- **TD-UI-APP-N08** · `useProjectsState` `projectsHaveChanges` 的 `includeExternalSessions` 参数恒为 true，死参数
  - 类别：F · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`hooks/useProjectsState.ts:59-90`；调用点 `161,315,670`
  - 建议：删参数，抽 `mapProjectsAndSelected(apply)` helper。
- **TD-UI-APP-N09** · `SplitBody`（MainContent）~546 行布局 god 组件，双份拖拽 resize 逻辑
  - 类别：A · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`main-content/view/MainContent.tsx:527-1073`、`:668-706`、`:724-749`
  - 建议：抽 `useResizablePanel` 通用 hook。
- **TD-UI-APP-N10** · `DashboardV2.tsx` 1352 行单文件 + 项目匹配谓词重复 + 不安全合成对象
  - 类别：A · 严重级：P3 · 工作量：M · 状态：new
  - 位置：`main-content-v2/DashboardV2.tsx:328-333`、`:349-355`、`:112-116`
  - 建议：抽 `isProjectMatch(proj, filter, fullPath)` 单函数并类型化占位对象。

---

## 26. ui/server（B5 ✅）

**模块概况**：约 101 个手写 JS（routes 28 + services 27 + utils 22 + websocket 3）。Express 桥连 gateway 属**有意设计**（决策保留）。最大 `sati-bridge.js` 2055 / `routes/taskmaster.js` 1888 / `routes/git.js` 1490。深 `src/` 导入 12 处（对应 TD-BOUND-001）、`memory.js:14` 直连 `lib/index.js` 维持 TD-BOUND-002 wontfix。
> 复核结论：历史「同能力多套实现」中 getProjects/WebSocketServer/repairToolName 三项均已统一收口。

- **TD-UISERVER-N01** · `sati-bridge.js` 成为 god-module（2055 行，桥接+统计+缓存混合）
  - 类别：A · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`ui/server/sati-bridge.js`（`runChatViaGateway :671-888`、`getRouterDashboardData :1706-1821`、`getRouterStatsSummary :1918-1956`）
  - 建议：拆 `gateway-client.js`/`event-mapper.js`/`router-stats.js`。
- **TD-UISERVER-N02** · bridge 内 4 个 per-session 内存缓存无 LRU/容量上限
  - 类别：I · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`sati-bridge.js:1237`（`_sessionTitleCache`）、`:1319`（`_userQueriesCache`）、`:1435`（`_toolSequenceCache`）、`:1529`（`_subagentPromptCache`）
  - 建议：为各缓存加 LRU/TTL 上限。
- **TD-UISERVER-N03** · `routes/git.js` 错误响应状态码不一致（6 处返回 HTTP 200 + `{ error }`）
  - 类别：D · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`routes/git.js:439,512,678,802,831,1117`
  - 建议：统一改 `res.status(4xx/5xx).json({ error })`（对照同文件其余 15+ 处已 `res.status(500)`）。
- **TD-UISERVER-N04** · `routes/git.js /commits` 逐 commit 串行 spawn（N+1 子进程）
  - 类别：I · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`routes/git.js:788-795`
  - 影响：limit 上限 100 时最多 100 次串行 `git` 子进程。建议：改用单次 `git log --stat` 一次聚合。
- **TD-UISERVER-N05** · PRD 模板数据在同一文件内双份且内容漂移
  - 类别：F · 严重级：P2 · 工作量：M · 状态：**done（已修复 2026-08-23）**
  - 修复：把 4 个模板（web-app/api/mobile-app/data-analysis）收敛为唯一数据源——`/prd-templates` 路由改为 `const templates = await getAvailableTemplates();`，完整数组移入 `getAvailableTemplates()`；删除旧的单模板短数组。`/prd-templates` 与 `/apply-template` 现共用同一模板源，不再漂移。`node --check`/biome/ui-eslint 全绿。
  - 位置：`routes/taskmaster.js:1320-1762`（`/prd-templates` 内联多模板）vs `:1848-1888`（`getAvailableTemplates()`）
  - 影响：`/apply-template` 写盘的 `web-app` 是较短版本，与 UI 呈现不一致。建议：抽单一模板数据源，两路径共用。
- **TD-UISERVER-N06** · 广播 fan-out 双机制 + `taskmaster-websocket.js` 4 个近同函数冗余（含 2 个死导出）
  - 类别：F · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`utils/taskmaster-websocket.js:15,46,76,106` vs `websocket/broadcast.js:80-107`
  - 建议：收敛为单一 `broadcastMessage(wss,message)`，任务类改走 `broadcastToSessionWatchers`，删除 2 个死导出。
- **TD-UISERVER-N07** · child-process 输出捕获逻辑三处重复且跨平台行为不一致
  - 类别：F · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`routes/git.js:11`（spawnAsync）vs `routes/taskmaster.js:28,40`（spawnCli/runCliProcess）
  - 建议：抽共享 `runCommand(command,args,opts)`。
- **TD-UISERVER-N08** · 项目相关端点碎片化 + 鉴权中间件应用层级不一致
  - 类别：D · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`index.js:99` vs `routes/project-sessions.js:26-128`
  - 建议：项目端点收敛到同一文件/挂载前缀，鉴权统一为 mount 级。
- **TD-UISERVER-N09** · `ui/server → src/` 深层导入复核（对应 TD-BOUND-001）
  - 类别：D · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`sati-bridge.js:50,51,60,61,68` · `routes/config.js:31-32` · `routes/commands.js:13-14` · `projects.js:25,32` · `services/satiConfig.js:6`
  - 建议：核对 `check-ui-server-boundary` 白名单，逐步收敛为 barrel 导入（注意 `sati-bridge.js:49-51` 避开 `src/cli/index.ts` 是刻意取舍，防连带加载 gateway+agent 全树）。
- **TD-UISERVER-N10** · 「API key」两套鉴权来源 + SSE 头部三处冗余
  - 类别：D · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`middleware/auth.js:8-20`（env API_KEY）vs `routes/agent.js:25-57`（DB api_keys 表）；SSE 头部 `routes/agent.js:64-69` 与 `routes/project-sessions.js:142`、`routes/projects.js:482`
  - 建议：补注释区分或统一；抽共享 SSE 头部 helper。

---

## 27. tests+scripts（B5 ✅）

**模块概况**：`tests/`（465 *.ts 镜像 src，分布极不均：patent 95 / tool 58 / agent 40 vs fs/lifecycle/network/status/browser 各 1）+ `scripts/`（50+）。核心类（AgentLoop/ToolRuntime/GatewayWsConnection）**已有直测**，残留历史伪测试、空洞断言、脚本重复。

- **TD-TESTNSCRIPT-N01** · 历史「伪测试」仍存活：gateway weixin 运行时流
  - 类别：E · 严重级：P1 · 工作量：S · 状态：**done（已修复 2026-08-23）**
  - 修复：删除 5 组用 `readFileSync`+正则扫描源码字符串的伪测试；保留唯一真实行为断言——`InProcessGateway.prepareWeixinLogin` 委托注入回调透传 + 未注入时 `unsupported` 降级。测试现不再因格式化/重构改源码即红。typecheck/lint/biome/测试全绿。
  - 位置：`tests/gateway/weixin-settings-runtime-flow.spec.ts:7,24,43,53,65`
  - 影响：5 组用例用 `readFileSync`+正则扫描 `ui/server/routes/gateway.js` 等**源码字符串**而非断言行为，格式化器改引号即红。建议：改行为断言或删除。
- **TD-TESTNSCRIPT-N02** · `install.sh` 内嵌整块 `bin/sati` 副本，重定义 10 个同名函数
  - 类别：F/D · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`install.sh:1176-1444`（副本）vs `install.sh:302-476,763-785`（正文）
  - 影响：`version_at_least`/`find_free_port` 等约 130 行两处各一份，改一处另一处漂移。建议：公共 shell 逻辑抽单一份 `lib` 由 heredoc 引用。
- **TD-TESTNSCRIPT-N03** · llm-replay 起草用例是「空洞测试」：引用夹具不存在，测试静默通过
  - 类别：E · 严重级：P2 · 工作量：S · 状态：**done（已修复 2026-08-23）**
  - 修复：`if (!existsSync(...)) return;` 改为显式 `t.skip("fixture 未录制…；提交后自动生效")`，fixture 缺失时不再以「通过」掩盖零断言；fixture 提交后仍走真实重放断言（`assertAllConsumed`/`completed`/文本产出）。测试运行显示为 skipped 而非 pass。typecheck/lint/biome/测试全绿。
  - 位置：`tests/test-support/llm-replay-drafting.spec.ts:93-96`
  - 影响：`FIXTURE_DIR` 指向 `tests/fixtures/llm-replay/patent-drafting`（未提交），用例首行 `if (!existsSync(...)) { return; }` 直接 return，**零断言**地以「通过」结束，掩盖 `patent_drafting_v1` 全链路重放从未真正跑过。建议：改 `t.skip` + 提交夹具，或删除。
- **TD-TESTNSCRIPT-N04** · `update.sh` 偏离仓库工具链并强制 reset
  - 类别：H/D · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`scripts/update.sh:69,74-79`
  - 影响：依赖用 `pnpm install` 但构建用 `npm run build`（与 corepack pnpm 标准混用）；fast-forward 失败即 `git reset --hard`，叠加 `git stash` 强置丢弃。建议：统一 `corepack pnpm`，避免 reset --hard 兜底。
- **TD-TESTNSCRIPT-N05** · `build-knowledge-vectors.ts` 已标注 deprecated 但仍保留为孤儿脚本
  - 类别：F · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`scripts/build-knowledge-vectors.ts:1-10`
  - 建议：迁移文档后删除或归档到 `docs/notes`。
- **TD-TESTNSCRIPT-N06** · 附图基准脚本提交了硬编码本地绝对路径，与其自述「不进入仓库」矛盾
  - 类别：H/I · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`scripts/figure-benchmark/prepare-local-dataset.sh:8-12`
  - 影响：`SOURCE_BASE="/Users/xujian/工作/01_专利申请"` 等个人本地路径，他人运行必挂。建议：参数化/读 env，或移出产物集。
- **TD-TESTNSCRIPT-N07** · fs/lifecycle/network/status/browser 五模块单文件级覆盖
  - 类别：E · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`tests/fs/`、`tests/lifecycle/`、`tests/network/`、`tests/status/`、`tests/browser/`（各 1 文件）
  - 建议：为浏览器后端/lifecycle runtime 等核心路径补行为单测后再收敛密度。
- **TD-TESTNSCRIPT-N08** · 附图 PDF 提取「单一事实源」一致性用例靠正则扫源码，跨构建跳过
  - 类别：E · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`tests/patent/tool/patentPdfDownload-extractjs.spec.ts:67-90`
  - 建议：改为运行时读取内嵌常量导出并对比，或明确 skip。

---

## 28. apps/desktop（B5 ✅）

**模块概况**：Electron 壳（macOS DMG arm64 + Windows NSIS x64/arm64，Linux 不维护）：9 TS（main/preload/server-manager/onboarding/splash）+ 27 发布脚本。安全基线良好（三窗口 `contextIsolation+sandbox+nodeIntegration:false`、导航白名单）。债务集中在**跨平台构建产物一致性、进程管理误杀邻近进程、文档漂移**。

- **TD-DESKTOP-N01** · 运行时包布局的符号链接接线在 3 处重复实现
  - 类别：D · 严重级：P1 · 工作量：M · 状态：new
  - 位置：`src/server-manager.ts:716-766`；`scripts/lib/packaged-runtime.sh:62-81`；`scripts/verify-dmg.sh:243-278`
  - 建议：抽共享 `linkRuntimeLayout`，三处引用同一实现。
- **TD-DESKTOP-N02** · release.sh 与 build-win.bat 的 bundle 配方已分叉（排除清单 + 产物内容不一致）
  - 类别：F · 严重级：P1 · 工作量：M · 状态：new
  - 位置：`scripts/release.sh:450-524,551-559`；`scripts/build-win.bat:318-399`
  - 影响：mac 的 sati-main bundle 带 `dist/assets/`（`render_patent_document` 运行时需它）`skills/` 等，而 win 的 `build-win.bat:397` 仅打 `src dist\src scripts node_modules vendor package.json tsconfig.json`——Windows 打包缺运行资产，专利文书渲染可能失效。建议：收敛为单一共享 bundle 清单。
- **TD-DESKTOP-N03** · `ensurePortFreeForGateway` 对 gateway 端口监听者不做身份校验直接优雅→强杀
  - 类别：G · 严重级：P2 · 工作量：S · 状态：**done（已修复 2026-08-23）**
  - 修复：抽出纯谓词 `isSatiRuntimeCommandLine`（导出供测），`ensurePortFreeForGateway` 仅对识别为 Sati 进程的占用者兜底杀，非 Sati 进程放行并 `console.warn`（交给 spawn 报 EADDRINUSE）。新增 `tests/desktop/server-manager.spec.ts` 的 `isSatiRuntimeCommandLine` 正/反用例。typecheck/lint/biome/测试全绿。
  - 位置：`src/server-manager.ts:982-994`（调用点 `:1182`）
  - 影响：对占住 19789 端口的**任意**进程 `killPidGracefully`→`forceKillPid`（SIGKILL/taskkill /T），可能误杀无关进程。建议：先走 `isSatiRuntimeProcess(pid)` 校验，非 Sati 进程改为 fail-explicit 报 EADDRINUSE。
- **TD-DESKTOP-N04** · IPC 处理器未校验 `event.senderFrame` 来源
  - 类别：G · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/main.ts:415-424`；`src/onboarding-window.ts:81-100`
  - 影响：缺纵深防御——若本地 UI 出现 XSS，renderer 可越权调用 `onboarding:save`（覆写 `~/.sati/sati.yaml`）。建议：handler 内校验 `event.senderFrame.url` 属预期来源。
- **TD-DESKTOP-N05** · Electron 主进程在启动/关停路径残留 `execSync` 阻塞事件循环
  - 类别：I · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/server-manager.ts:523-530`（rm -rf/PowerShell，timeout 30-60s）、`:289-292`
  - 建议：改为 `promisify(execFile)` 或 `fs.rm` 重试，主线程不阻塞。
- **TD-DESKTOP-N06** · `release.sh` 注释声称 `window.sati.getBuildInfo()`，但 preload 未暴露该方法
  - 类别：H · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`scripts/release.sh:341`；`src/preload.ts:13-22`
  - 建议：删除或改写该注释，或若确需补 `getBuildInfo` 桥。

---

## 29. 横切收口（B6 ✅）

> 本节是对 B1–B5 已登记条目的**跨模块聚合**与**修复排期**，不再新增逐模块条目。数字依据 `metrics.md`（2026-08-23）与各模块节条目。

### A. 横切主题与聚合量

| 主题 | 聚合 | 关键分布 | 代表性条目 |
|---|---|---|---|
| 类型强转/断言（`as X`/`as never`/`as unknown as`/`!`） | 全源码 **>90 处**（真实 any≈0） | gateway `as never` 43 · RemoteGateway `as XResult` ~30 · knowledge 29 处 `as X`(DB 行) · model/patent/always-on 的 `as unknown as` | TD-TYPE-002 / GATEWAY-002 · MODEL-N04 · PATENT-N04 · KNOWLEDGE-N03 |
| 裸 `console.*` | **267**（src） | cli 191 · patent 15 · agent 13 · model 11 · adapters 11 | TD-CONSOLE-001 + 各模块裸 console 条目 |
| 静默吞错 catch（体仅注释/空白） | **151** | adapters 40 · always-on 15 · tool 14 | TD-CATCH-001 + AGENT-104 / GATEWAY… 等 |
| God function / 巨型文件 | **60 个单函数 >300 行**（多在前端） | 前端 useChatComposerState 1433 · PdfDocumentPreview 1138 · SkillsV2 2503 | TD-GOD-001/002 + UI-CHAT-* / UI-APP-* |
| 分层/双轨重复 | 多处两套实现 | graph↔workflow · knowledge 三引擎 FTS 编排 · tool 模式名单 · adapters 21 渠道脚手架 · model retry 三份 · literature limit 钳制 | PATENT-N01 · WORKFLOW-N01 · KNOWLEDGE-N01 · ADAPTERS-N01 · MODEL-N02 |
| 未接线实现/配置 | 5 处 | workflow 引擎(无生产调用) · policy-bridge(block 未拦截) · always-on execution.*/gitLfs · permission policy 规则 · skill roleConfig knowledge | WORKFLOW-N01 · RULE-N02 · ALWAYSON-N03 · EXTENSION-N05 |
| 文档漂移 | 5+ 处 | protocol 1.4 vs CLAUDE 1.2 · performance-review 已过时 · ensureWorkspace · release.sh getBuildInfo · roleConfig knowledge | TD-DOC-001 · CONTEXT-N04 · ALWAYSON-N06 · DESKTOP-N06 · EXTENSION-N05 |
| i18n 违规/缺 key | 多处 | AppShellV2 弹窗整屏硬编码英文 · LlmConfigurationStep 整屏硬编码 · teamPanel 缺 2 zh/1 en · FilesV2 `t("loading")` 指向不存在 key | UI-APP-N03/N04 · TD-I18N-001 |
| 测试债 | 伪/空洞/薄 | weixin 运行时流伪测试 · llm-replay-drafting 空洞(引用不存在 fixture) · 5 模块单文件级 · forkSession/WorkspaceLedger Store/router decide-execute/gateway WS 解析缺直测 | TESTNSCRIPT-N01/N03/N07 + 各模块 E 类条目 |
| 安全 | 5 处 | mcp 路径穿越读盘 · permission 损坏→权限绕过 · desktop 端口误杀邻近进程 · desktop IPC 未校验 senderFrame · gateway WS 帧解析/16MB 无直测 | MCP-N02 · PERMISSION-N02 · DESKTOP-N03/N04 · GATEWAY-N04 |
| 性能 | 多热路径 | WorkspaceLedgerStore.read O(entries)/每模型调用 · 记忆检索阻塞 30s · cron 写放大/全量读 · bridge 缓存无上限 · telemetry execFileSync git ×2 · 手写虚拟化 | SESSION-N01 · CONTEXT-N03 · CRON-N01 · UISERVER-N02 · SMALL-N03 |

### B. 健康面（避免误判为"烂项目"）

- **真实 `any` 逃逸 ≈ 0**（B1–B5 六模块人工复核 + 修正后脚本仅 1 处注释误报）；`src → ui` 导入 0；无 `@ts-ignore`。
- 分层质量：mcp/cron/rule/always-on/agent 多为 `protocol/runtime/config` 三层 + barrel；新模块规范。
- 测试**断言普遍真实**（assert 具体行为非空壳）；核心类（AgentLoop/ToolRuntime/GatewayWsConnection）**已有直测**。
- edgeclaw 子包已入 workspace、`lib/` 不入库；`.reasonix` 已 untrack；品pair双轨已收尾；CI 串行无并发竞态。
- 门禁强：`pnpm check` 覆盖 typecheck/lint(event-matrix/patent-sop/patent-workflow-docs/html-templates/skills)/format 全绿。

### C. 修复排期建议（Phase 3 → Phase 4）

**立即（P0–P1，短平快，优先做）** — ✅ 1–3 已全部落地（2026-08-23）
1. 安全：`mcp` 路径穿越读盘（MCP-N02）→ resolvePath 加 `cwd` 包含校验；`permission` 损坏→权限绕过（PERMISSION-N02）→ 损坏时 fail-safe 到 `skipPermissions:false`；`desktop` 端口误杀（DESKTOP-N03）→ 先 `isSatiRuntimeProcess` 校验。✅
2. 数据一致性：`workflow_failed.error` 用错步骤 id（WORKFLOW-N04）；`ui/server` PRD 模板双份漂移（UISERVER-N05）；`cron` 损坏 tasks.json 被清空（CRON-N02）。✅
3. 测试可靠性：删除/改写 weixin 伪测试（TESTNSCRIPT-N01）、llm-replay-drafting 空洞测试（TESTNSCRIPT-N03）。✅

**短期（P2，1-2 天/项）**
4. 前端巨无霸：拆分 `useChatComposerState`(UI-CHAT-N01)、`MessagesPaneV2`(N03)、`SkillsV2/ImportFromFolder`(UI-APP-N01)、`PdfDocumentPreview`(N07)；删除 `useChatSessionState` 死状态 `isLoadingMoreMessages`(N02)。UI 改动须浏览器验证。
5. i18n：AppShellV2 弹窗（UI-APP-N03）、LlmConfigurationStep（N04）提取到 locales。✅ N03 完成；N04 的 i18n 已完成（YAML cast / 重复拉取保留为 in_progress）。
6. 未接线实现：policy-bridge（RULE-N02）、workflow 引擎接线或降级（WORKFLOW-N01）、always-on execution.*（ALWAYSON-N03）。
7. 可观测性：收束裸 console（TD-CONSOLE-001，先 `cli`）、静默吞错逐条补注释/结构化（TD-CATCH-001）。

**中期（P2–P3，专项 Sprint）**
8. 类型强转收敛：gateway `as never`、knowledge DB `as X`、model/patent `as unknown as`——用类型守卫替代（TD-TYPE-002 系列）。
9. 双轨收敛：graph↔workflow（PATENT-N01）、knowledge 三引擎 FTS 编排（KNOWLEDGE-N01）、adapters 21 渠道脚手架（ADAPTERS-N01）。
10. 文档漂移：CLAUDE.md 协议 1.2→1.4（TD-DOC-001）、performance-review 过时段（CONTEXT-N04）更新。

**持续（跨 Sprint）**
11. 每季度重跑 `node scripts/measure-techdebt.mjs --update` 刷新趋势；新功能引入新债顺手登记；修复项标注 `done` + commit/PR。
12. 每个非平凡修复按 AGENTS.md 铁律 7 在 `docs/notes/` 记一条 note（含 `## Alternatives considered`）。
