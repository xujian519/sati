# Sati 技术债务活账本（backlog）

> 唯一事实源。审计/修复时在此登记与更新条目。清分级、条目 Schema、保持新鲜规则见 `README.md`。
> 快速状态：`metrics.md`（2026-09-20 复核时的最新基线）作为数字事实源；本账本按模块给带 `file:line` 证据的条目（各节数字为时间点快照，见下方「数字口径」）。
> 标注「**自动化扫描命中**」的条目来自脚本 `node scripts/measure-techdebt.mjs --json`。

---

## 0. 自动化扫描命中（Phase 1）与复核更正

> **数字口径（2026-09-20，docs↔code 一致性审计）**：本账本各节的行数/计数是**逐节时间点快照**，不保证随代码更新；**机器校验的当前基线在 `docs/technical-debt/metrics.md`**（`pnpm check:techdebt-metrics` 保真、`pnpm measure:update` 刷新）。已实测确认过期的样例：`useChatComposerState` 1433 → **558**、`PdfDocumentPreview` 1138 → **306**（已迁 `ui/src/components/code-editor/view/pdf/`）、`SkillsV2.tsx` 2503 → 现路径已变、`sati-bridge.js` 2055 → **2346**、`InProcessGateway.ts` 1103/1350 → **1488**、`ProjectRuntimeRegistry.ts` 642 → **642** ✓。审计未逐条复算本账本全部数字（避免以未核数字替换未核数字）；引用数字前请先查 `metrics.md` 或现测。

> ⚠️ **重要复核更正（2026-08-23 B1 批次）**：Phase 0 用 `\bany\b` grep 出的「any 103 处」**存在大量误报**——多数命中的是注释/字符串里的英文单词 "any"。经人工复核，`src/agent`、`src/router`、`src/tool`、`src/session` 真实类型位 `any` 均为 **0**；修正后的脚本（只匹配 `: any / as any / <any> / any[] / @ts-expect-error / @ts-ignore`）全源码剩 **1 处**。真正的类型债是**强转**：`as never`（gateway 43 处）、`as string[]`（router）、`as XResult`（RemoteGateway 30 处）、`!` 非空断言。

### 类型安全（已修正，B1+B2 复核）
- **TD-TYPE-001** · `any`/`@ts-expect-error` 误报修正：**全源码真实 `any` 逃逸≈0**
  - 位置：agent/router/tool/session/context/model 六模块人工复核均确认为 0；`metrics.md` 中的「1 处」实为注释/字符串里的英文单词 "any" 误报。
  - 影响：类型卫生整体优秀；**真正要治理的是类型强转与断言**（见 TD-TYPE-002）。
  - 工作量：S · 严重级：P3 · 状态：triaged
- **TD-TYPE-002** · 强转/断言债（`as never` / `as XResult` / `as unknown as X` / `as string[]` / `!`）
  - 位置：`gateway/GatewayWsConnection.ts`（43 处 `as never`）、`gateway/client/RemoteGateway.ts`（30 处 `as XResult`）、`model/streaming/streamModel.ts:355-361` 与 `providers/google/request.ts:107`（`as unknown as X` 双强转）、`patent/provenance/provenance-store.ts:250` 与 `evidence/receipt.ts:224`（`as unknown as X`）、`router/config/parseRouterConfig.ts`（4 处 `as string[]`）
  - 影响：让入参/结果/DB 行在编译期失去形状校验，字段错名/类型错位运行时才暴露。
  - 工作量：L · 严重级：P1 · 状态：**in_progress（2026-08-23 partial）**
  - 2026-08-23 清理结果（分步见 `docs/type-assertion-cleanup-plan.md`）：
    - ✅ 已消除：`gateway/client/RemoteGateway.ts` 30 处 `as XResult` → `request<T>` 泛型化（新增 `GatewayWsClient.request<T>`）；`model/providers/google/request.ts:107` 与 `model/streaming/streamModel.ts:355-361` 两处 `as unknown as X` 双强转。
      - ⚠️ 隐性收益：`google/request.ts` 原 `as unknown as thinkingConfig` 会把小写 `"low"|"medium"|"high"` 直接发给 Gemini 2.5 API，而 SDK 期望大写枚举 `ThinkingLevel.LOW/MEDIUM/HIGH`；已改为显式映射 `GOOGLE_THINKING_LEVEL`，修正了实际序列化值。
    - 🟡 已消除（2026-08-23 B2 批次）：`GatewayWsConnection.ts` 43 处 `as never` → `as GatewayMethodParams<"...">`（从 `Gateway` 接口推导首参类型的具名断言；消除底部类型滥用，`typecheck` 即自验证，见 `tests/gateway/server/dispatch.spec.ts`）。运行期参数校验仍未接线（见 TD-GATEWAY-002，后续按 method 建守卫）。
    - 🔒 **保留为必要收窄（won't-fix，非可消除债）**：`knowledge/**` 40 处 `as X[]`（node:sqlite `all()/get()` 无泛型，驱动边界收窄）；`provenance-store.ts:250` 与 `evidence/receipt.ts:224`（`JSON.parse` 断言 + 字段 typeof 守卫，属防御性收窄）；`parseRouterConfig.ts` 4 处 `as string[]`（前置 `Array.isArray + typeof` 守卫后的必要收窄）；`askModeConstraints.ts`/`userInteractionConstraints.ts`/`createLocalGateway.ts`/`proxy.ts` 的 `as never`（存在性探测或跨库/跨泛型边界收窄）。
    - 结论：本次收敛聚焦**真正可消除且每处有安全收益**的断言；被判定为边界必要收窄的点不强行"消除"（避免把 `as` 挪进 helper 藏起来，或引入新抽象——自身即新的 accidental complexity）。

### 错误&可观测
- **TD-CONSOLE-001** · 裸 `console.*` 267 处，`cli` 191 处最热
  - 位置：`src/cli/sati.ts`、`createLocalGateway.ts` 等；次热 `patent`(15) `agent`(13) `model`(11)
  - 建议：收束到 `src/telemetry/` wrapper；先 `sati.ts` → `createLocalGateway.ts`。
  - 工作量：L · 严重级：P2 · 状态：new
  - **2026-08-27 复核**：总量已降至 **153**（logger 收敛生效，cli 191→137，`createLocalGateway.ts` 已清零）。剩余 cli 命中抽样 ~14/15 属 CLI 合法用户输出（向导 TUI、banner、用法报错），建议改判 mostly won't-fix；焦点转向 **ui/server 桥**：`routes/git.js` 等桥文件新增 `console.log("[sati-bridge] submitTurn runMode=...")`（`sati-bridge.js:713,731`，每条用户消息触发）应走 debugLog 门控或服务端 logger。次热现为 `telemetry`(8)。
  - **2026-09-11 终审**：✅ **done（C39，2026-09-08）**。收束 `ui/server` 408→0、`ui/src` 116→0——建两处纯转发入口 `ui/server/utils/consoleLogger.js` 与 `ui/src/utils/logging.ts`（不改输出文本，逐字节不变）；`src/` 剩余 143 处按设计豁免（CLI 交互 / 登录二维码 / `debug.ts` / telemetry 入口），即 2026-08-27 复核所述的「mostly won't-fix」部分。按 2026-09-11 对齐口径，`src + ui/server` 实测**上界 158**（含注释掉的调用等同名文本），远低于目标 <300。
- **TD-CATCH-001** · 静默吞错 catch（体仅注释/空白）151 处，`adapters` 40 · `always-on` 15 · `tool` 14
  - 影响：异常被吞且无注释，属隐患。逐条补注释或改结构化错误。
  - 工作量：L · 严重级：P2 · 状态：done（2026-09-11，C41）
  - **2026-09-11 终审（含口径更正）**：✅ **done（C41）**。**本条原始定义有误**——「体仅注释/空白」把**已在函数 JSDoc 说明意图的防御式**与**真无任何说明的静默回退**混计（这也是「151 处」的来源）。按修正后口径（**无注释的无参 catch**；判定「有注释」认 catch 行内 / catch 上一行 / 体内独立注释行或行尾注释三种形态），`src + ui/src` 产品代码 = 总计 **518** / 无注释 **37** / 已注释 **481**。C41 为 107 处真静默吞错补体内意图注释（统一「失败模式 → 回退语义」形态）、18 处登记不重复（已由函数级 JSDoc 或体内自述式告警承载），**隐患类 125 → 37**；零行为变化以编译级证明（`transpileModule({removeComments:true})` 79/79 逐字节相同）。口径定义见 `docs/technical-debt/README.md` §指标口径说明，决策见 `docs/notes/implemented/2026-09-11-c41-catch-todo-governance.md`。
  - **2026-09-16 口径变更（#390 · TD-METRIC-003）**：catch 口径纳入 `ui/server`，同时 vendored 子包整体移出文件级指标 ⇒ 同一形态的计数变为 总计 **684** / 无注释 **124** / 已注释 **560**（`ui/server` 持 175 / 84 / 91；vendored 移出 8 处，均已带注释）。C41 的结论（37）在 `src + ui/src` 口径下仍成立，只是**不再是全仓数字**；新口径下的残留治理见 #353。
  - **2026-09-18 第一段交付（#353 · PR #432）**：`ui/server` 段 **72 → 0**（全仓无注释 114 → **42**）。72 处/28 文件各补一行「失败模式 → 回退语义」注释，**只增注释、零代码改动**（+74/−1 行，唯一非注释新增是 `utils/plugin-loader.js` 空体 `} catch {}` 的展开括号）。同 PR 用 AST 复核了度量判据的准确度：正则判「有注释」547 vs AST 判 545 ⇒ **假阳性 2 处**（`src/context/budget/ToolResultBudget.ts:203` 上一行注释属 try 体；`src/tool/builtin/executeCode.ts:700` 嵌套 catch 的注释被记到外层）、**假阴性 0 处**——后者说明「无注释」集合是准确的。114 处形态：静默 89 / 错误转译 21 / 已落日志 3 / 空体 1。指标副作用已披露：`空 catch {}` 1 → 0 系正则形态效应（补注释后不再匹配空体正则），非删除。决策见 `docs/notes/implemented/2026-09-18-catch-intent-comments.md`。
  - **2026-09-18 第二段交付（#353 · PR #433）**：`src` 36 处 + `ui/src` 6 处 = **42 处 / 30 文件**补齐，**只增注释、零代码改动**（+42/−0 行，无单行 catch 需展开）。至此全仓「无注释的无参 catch」**114 → 0**（`metrics.md`：无注释 114 → **0**、已注释 547 → **661**、总计 661 不变，+114/−114 闭合）。两道独立证明同段一：AST 叶子 token 比对 30/30 一致、`transpileModule({removeComments:true})` 编译产物 30/30 逐字节相同；`pnpm check:event-matrix` 为 fresh（段二文件中唯一在事件矩阵带 `file:line` 的 `src/model/providers/openai-responses/stream.ts` 矩阵记 `:131`，注释插在 `:209/:214`，不影响条目）。
  - **2026-09-18 载体收口**：`TD-SESSION-N12`（`TranscriptReader.ts` 两处）由段二注释直接还清；**`TD-TEAM-N11` 不属于本判据**——`src/cli/teamSubsystem.ts` 的 `runMemberScan` 外层是 **promise 链上的 `.catch()`** 而非 `catch {}` 子句，既不被「无注释的无参 catch」口径统计，补注释也修不了「整次启动扫描失败被静默吞掉 ⇒ 冷恢复失效而队长侧零信号」，故按 #353 的「场景 B：失败应被观测」单独补 `logger.error` 处置（PR #434），不混进纯注释变更。

### Arch/分层
- **TD-BOUND-001** · `ui/server → src` 深层导入 14 处
  - 位置：`ui/server/sati-bridge.js`、`routes/config.js`、`routes/commands.js` 等
  - 建议：改走 `src/<module>/index.ts` barrel（纯防御，不动架构）。
  - 工作量：M · 严重级：P2 · 状态：new
- **TD-BOUND-002** · `ui/server/routes/memory.js:14` 直连 `edgeclaw-memory-core/lib/index.js` 编译产物
  - 决策：既有注释说明为受支持路径（`technical-debt-report.md` 2026-08-17 复核维持）。状态：**wontfix**。
  - 证据：脚本命中 1 处。
- **TD-BOUND-003** · src 运行时值循环依赖 3 组 SCC + ~54 个纯类型环（2026-08-27 类型感知复扫发现；修正 `next-batches-schedule.md` §7「模块级依赖环 0」的旧结论）
  - 类别：D/R5 · 严重级：P2 · 工作量：M（前三刀均 S）· 状态：**in_progress（2026-08-27 切割①②③已落地：SCC 3→0，见分支 refactor/dep-cycles-wiki-dup）** · 意图：[accidental]
  - Pain×Spread：2×3=6
  - 证据（运行时值 SCC，类型纯导入已剔除）：
    - **SCC-1（16 文件，横跨 tool↔patent↔workflow↔agent，barrel 介导宏环）**。唯一真运行时闭环边 E1：`src/agent/loop/projectToolResults.ts:2` 经 `tool/index.js` barrel 引 `toCanonicalToolResultBlock`（实际定义于 `src/tool/protocol/result.ts:57`）；静态闭环边 E5a：`AgentLoop.ts:19`（type-only）。其余闭环边：E2 `patent/workflow-dag.ts:15`→workflow barrel（值引 `FlowGraph`，即 PATENT-N01 双轨的具体化）；E3 `workflow/index.ts:56-58` re-export 无生产消费方的 `createSubagentWorkflowAgentFactory`（呼应 WORKFLOW-N01）；E4 `SubagentWorkflowAgentFactory.ts:8`→agent/sub/SubAgentSession.ts:18。madge 报 59 链多为 barrel/type-only 幻影，无文件级两两互环、无当日初始化序 bug，但 patent/workflow 任一侧引入副作用初始化即成地雷。
    - **SCC-2（5 文件，patent/graph/domains 内部注册表-barrel 环）**：`domains/{inventiveness.ts:16,enablement.ts:11,novelty.ts:12}` 从 `../index.js` 反向值引 `GraphBuilder`（定义在 `graph/engine.js`，index 第 26 行才 re-export）。
    - **SCC-3（2 文件）**：`TuiApp.tsx:6` 从 `../TuiChannel.js` 引常量 `defaultTuiSessionKey` 造成反向值边。
  - 影响：改一处域函数可能牵动四个模块的编译面；阻塞未来把 TuiApp 复用为桌面宿主、把 workflow-dag 校验路径接线。
  - 建议（最便宜切割优先）：① 移动 `defaultTuiSessionKey` 至叶子模块 → 消灭 SCC-3（S）；② domains 三文件 `../index.js` 改深引 `../engine.js`/`../types.js` → 消灭 SCC-2（S）；③ `projectToolResults.ts:2`+`AgentLoop.ts:19`+`SubAgentSession.ts:25` 由 barrel 改深引 `tool/protocol/*.js` → 移除 SCC-1 唯一运行时闭环（S）；④ 从 `workflow/index.ts` 删除 SubagentWorkflowAgentFactory re-export（与 WORKFLOW-N01 接线决策同批，M）；⑤ graph↔workflow 双轨归一后余下跨模块值边自然消失（归属 PATENT-N01/WF-N01，L）。
  - 附注（高扇出复核）：`adapters/index.ts`(66)/`createLocalGateway.ts`(49) 为合法编排层豁免；`createBuiltinRegistry.ts`(58) 中 `:3` 横向构造 gateway 域的 `KanbanBoardManager` 属方向性异味，建议随 tool-pack SPI 化收敛（M/L，与 TD-SIZE/TD-GOD 族联动）。

### 体积/复杂度（God function & 大文件）
- **TD-GOD-001**（P1）· UI 层巨无霸函数（贡献大于后端）
  - `useChatComposerState` 1433（`chat/hooks/`）· `PdfDocumentPreview` 1138 · `SidebarV2` 1017 · `useChatSessionState` 941 · `MessagesPaneV2` 937 · `FilesV2` 877 · `MessagesPaneV2.render.test.tsx` 842
  - 建议：按 hook/组件拆分 + 子组件提取；涉及 UI 须浏览器验证。工作量：L（每组件）· 状态：new
- **TD-GOD-002**（P2）· 后端巨无霸函数：`createRouterRuntime` 877（`router/`）· `main` 635（`cli/sati.ts`）· `createReadFileTool` 509（`tool/readFile.ts`）
  - 细分见各模块节。工作量：L · 状态：new
  - **2026-08-27 复核补充（`createLocalGateway.ts` 结构债，jscpd 盲区——重复为小型接线模式而非文本克隆）**：(a) 模块为三件无关架构钉合：CLI 引导工厂 `:309-820` + 巨类 `ProjectRuntimeRegistry` `:904~2090`（`resolve`≈245 行、`prepareSessionRuntime`≈430 行，失败域横跨插件系统+MCP 生命周期+browser 工具）+ 无关自由工具函数 `:2215-2461`（browser proxy env 解析）；(b) 工厂内 team 成员回收闭包双实现——`runMemberScan :601-612` vs wakeMember 回调 `:682-688`，注释自承「与 scanner 冷恢复路径同款」；(c) browser-use 专属逻辑（mkdirSync 截图目录、逐 spec 参数改写 `:1663-1689`）泄漏进通用会话装配。建议拆出 `TeamReclaimCoordinator`、以 `SessionToolProvisioner` 承接 browser-use/MCP 装配、迁走 proxy env 工具函数。工作量：M×3 子项。
    - **2026-09-12 进展**：两次逐字迁移已落地（决策见 `docs/notes/implemented/2026-09-11-createlocalgateway-helper-extraction.md`、`2026-09-12-projectruntimeregistry-module-extraction.md`）——(a) 模块级 helper 外置为 `src/cli/{browserLaunchArgs,routerDefaults,gatewaySupport}.ts`；(b) `ProjectRuntimeRegistry` 类整体迁出为 `src/cli/ProjectRuntimeRegistry.ts`（1664 行），`createLocalGateway.ts` 2437 → 804 行。**未完成**：(b) 工厂内 team 成员回收闭包双实现、(c) browser-use 逻辑泄漏进会话装配。
    - **2026-09-12（第三刀）**：`new InProcessGateway(router, {...})` 的 22 字段网关选项（17 个闭包回调，其中 team 面板快照/特权直调、配置热重载、回合收尾等）抽到 `src/cli/gatewayRuntimeOptions.ts`，组合根 803 → 634 行；决策见 `docs/notes/implemented/2026-09-12-gateway-runtime-options-builder.md`。剩余 team 子系统 builder（约 226 行）压 ≤600，browser-use 泄漏随会话装配 builder 处置。
    - **2026-09-12（第四刀）：组合根收口达成**——团队子系统（teams.db / 队长审批转发 / 成员冷恢复扫描 / stranded 回收 / 调度器 / 启动扫描编排，约 190 行）抽到 `src/cli/teamSubsystem.ts`（`buildTeamSubsystem(deps)` + `startStartupScan()` 句柄保时序），`createLocalGateway.ts` 635 → **448 行**（P4a 验收线 `≤600`）。决策见 `docs/notes/implemented/2026-09-12-team-subsystem-builder.md`；剩余为类内拆分（`ProjectRuntimeRegistry.ts` 1663 行）与 browser-use 泄漏。
    - **2026-09-12（第五刀，类内拆分）**：(c) **browser-use 泄漏已处置**——`prepareSessionRuntime` 的会话工具面阶段（113 行：每会话 MCP + unattended excludeTools + always_on 剥离 + 可用性过滤 + 成员角色裁剪，含截图目录 mkdir 与逐 spec 参数改写）抽到 `src/cli/sessionToolSurface.ts`（`provisionSessionTools(input)`），registry 1663 → 1563 行；决策见 `docs/notes/implemented/2026-09-12-session-tool-surface-extraction.md`。剩余：(b) 工厂内 team 成员回收闭包双实现 + 类内其余巨方法（`prepareSessionRuntime` 余两段 / `resolve` 249 / `createAgentConfig` 127）。
    - **2026-09-12（第六刀，类内拆分）**：专利输出门禁构造（167 行，每会话 `PatentOutputGate` + HITL 审批闭环 + 决策溯源旁路 + policy-bridge deny 编译 + 决策反馈回流）抽到 `src/cli/patentOutputGateFactory.ts`（`buildPatentOutputGate(deps)`，gateway/teamDb/sessionOverrides 以 accessor 延迟取数），registry 1563 → 1384 行；决策见 `docs/notes/implemented/2026-09-12-patent-output-gate-factory.md`。
  - **2026-08-27 新增上帝函数 2 个**：`GatewayWsConnection.dispatchRequest`（316 行 switch，见 TD-GATEWAY-002）、kanban `ui/src/components/kanban/hooks/useBoardState.ts::useBoardState`（398 行，见 TD-UI-CHAT-N14）。
- **TD-SIZE-001** · 大文件：`SkillsV2.tsx` 2503 · `AgentLoop.ts` 1133 · `ProjectRuntimeRegistry.ts` 642（2026-09-12 由 `createLocalGateway.ts` 2437 拆出后经八刀类内拆分：会话工具面 / 专利输出门禁 / 会话依赖装配 / Agent 配置构造 / 项目运行时构造 / 会话权限 lifecycle，组合根降至 448） · `sati-bridge.js` 2055 · `routes/taskmaster.js` 1888 · `PdfDocumentPreview.tsx` 1861 · `WeComChannel.ts` 1761
  - 工作量：L · 严重级：P2 · 状态：partial
  - **2026-09-14 进展（AgentLoop 第 5 刀）**：turn 出口与中止捕获（`emitStatus`/`createAbortStatus`/`captureTurn`/`terminateTurn`/`captureAbortedPartial`/`abortTurn`）外迁 `src/agent/loop/turnExit.ts`，共享恢复策略（`continueWithTransientPrompt`/`emitEmptyOutputTokenBump`/`recoverFromMaxOutputBump`/`recoverFromEmptyResponse`）外迁 `src/agent/loop/recoveryStrategies.ts`，AgentLoop.ts 2433 → 2130 行；决策见 `docs/notes/implemented/2026-09-14-agentloop-turn-exit-extraction.md`。
  - **2026-09-14 进展（AgentLoop 第 6 刀）**：`handleModelError` 本体（365 行，约 10 条互斥恢复路径）拆为 `src/agent/loop/modelErrorRecovery.ts` 的具名步骤函数 + `recoverFromModelError` 调度入口，AgentLoop.ts 2130 → 1733 行（TD-AGENT-101 同批结清）；决策见 `docs/notes/implemented/2026-09-14-agentloop-model-error-recovery-extraction.md`。
  - **2026-09-14 进展（AgentLoop 第 7 刀）**：`assembleAndRecover` 本体（201 行）与 `repairTextExtractedToolNames` 迁入 `src/agent/loop/responseAssembly.ts`（装配 + 三条具名处置步骤），AgentLoop.ts 1733 → 1485 行（TD-AGENT-103 同批结清）；决策见 `docs/notes/implemented/2026-09-14-agentloop-response-assembly-extraction.md`。
  - **2026-09-14 进展（AgentLoop 第 8 刀）**：请求装配（`createModelRequest` 147 行 / `createBudgetEvaluator` 57 行 / `readWorkspaceLedgerBlock` 15 行）外迁 `src/agent/loop/modelRequest.ts`，压缩执行器（`runAutoCompact` 68 行 / `persistCompactSnapshot` 34 行）外迁 `src/agent/loop/compactionExecutor.ts`（`AutoCompactOptions`/`AutoCompactRunner` 随迁成为唯一归属），AgentLoop.ts 1485 → 1133 行；八刀累计 2433 → 1133（−53%）；决策见 `docs/notes/implemented/2026-09-14-agentloop-model-request-compaction-extraction.md`。

### 测试
- **TD-TEST-001** · 主链路核心缺直接单测（见各模块节 *_GATEWAY* / *_ROUTER*）。工作量：M · 严重级：P1 · 状态：new
- **TD-TEST-002** · 极薄模块（1 测试文件）：`fs` `lifecycle` `network` `status` `browser`。工作量：S ×5 · 严重级：P3 · 状态：new
- **TD-TEST-003** · `tests/patent/figuregen/dot.spec.ts` 的两个「真机集成」用例按 `resolveDotBinary()`（PATH 扫描）在**注册期**决定 skip，而本机默认 shell PATH 不含 `/opt/homebrew/bin`（brew 前缀）——同一份 `dist` 在带/不带该前缀的 shell 下 skip 数在 4/6 之间跳（2026-09-13 用探针用例定位：load-time PATH 无前缀 → 两用例 skip）。建议 `resolveDotBinary()` 兜底探测常见 brew 前缀或优先读 `SATI_GRAPHVIZ_DOT`。工作量：S · 严重级：P3 · 状态：new
- **TD-TEST-004** · 测试用**固定 sleep** 同步 fire-and-forget 副作用（已致 `main` CI 变红）
  - 类别：E · 严重级：P2 · 工作量：S（单点）/ M（同类普查）· 状态：new
  - 位置：`tests/gateway/client/eventMapping.spec.ts`（已修）；仓内另有约 40 处 `setTimeout(_, N)` 式固定等待，分布于 25 个 spec，未按「是否在断言异步副作用已完成」分类
  - 影响：2026-09-15 `main` 的 push CI（run `34923087975` / `cb58aa6db`）因该用例变红，而同内容的 pull_request run 为绿（同树异果 ⇒ 非确定性）。机制：`mapAgentEvent` 的落盘是 fire-and-forget（同步返回 `resultPath`、写盘在其后的 async IIFE，`catch` 静默），测试却用固定 100 ms 预算断言文件存在；失败信息只有「tmp 文件应实际写入」，**与「产品写盘失败」不可区分**，把一次调度停顿伪装成产品缺陷。
  - 处置（2026-09-15）：该点改有界轮询 `waitForFile(path, 5000)`，失败信息附路径与两种可能；决策见 `docs/notes/implemented/2026-09-15-fire-and-forget-test-sync.md`。**剩余**：其余 ~40 处按上述口径分类，危险项同样改轮询。
  - 建议：新增测试断言异步完成一律用轮询 helper（可抽共享 `waitFor`），不要用固定 sleep。

### 文档漂移
- **TD-I18N-001** · `teamPanel` namespace 缺 2 个 zh key / 1 个 en key。工作量：S · 严重级：P3 · 状态：done（2026-09-11 复核：现为 en 44 / zh 43，仅余 `pill.teamCount_one` —— i18next 的 zh 复数类别只有 `other`，该 key 在 zh 侧按设计不存在，非缺陷；C35 已修 `pill.teamCount` → `pill.teamCount_other` 并加复数回归用例）
- **TD-DOC-001** · 网关协议版本文档漂移：`version.ts`=**1.4**，但 `CLAUDE.md` 仍写「当前协议 **1.2**」
  - 位置：`src/gateway/protocol/version.ts:31` ↔ `CLAUDE.md`
  - 建议：同步 `CLAUDE.md` 及变更表。工作量：S · 严重级：P2 · 状态：done（2026-08-23：设计文档 `docs/design/gateway-protocol-versioning.md` 版本表/状态更新至 1.4；本地 `CLAUDE.md` 同步至 1.4（`CLAUDE.md` gitignored 不入库））

- **TD-DOC-002** · 文档**引用失效**：`community-agent-teams-research.md` §2 现状表引用已删除模块与过时五代的协议版本
  - 位置：`docs/community-agent-teams-research.md:101`（列 `src/workflow/`：DAG + SafeEvaluator + worker-contract，**该目录已随 #150 删除**，现仅存专利域 `src/patent/workflow/`）；`:106`（写「gateway 协议 1.3」，实为 **1.8**，`src/gateway/protocol/version.ts:53`）
  - 影响：§2「Sati 现状」是外部读者了解本仓能力的入口，失效引用会让人误以为该模块仍存在。
  - **与 TD-DOC-001 及 §31 那批文档漂移成因不同**：那批是「迭代后未回填」（代码已改、文字停在旧态），本项是「引用了已删除的对象」——需不同的预防手段（文档路径引用存在性检查，而非「改代码时同步文档」的约定）。
  - 建议：修正两处；可对 `docs/` 的 `src/**` 路径引用加脚本化校验（本次审计用 `grep` + `[ -e ]` 批量校验，可直接脚本化）。
  - 工作量：S · 严重级：P3 · 状态：new（issue #369）
  - 备注：同文档 §1.x 引用的 `src/members.ts`/`src/scheduler.ts`/`src/state.ts`/`src/tools.ts`/`src/client/ActivityPanel.tsx`/`scripts/stress-verify.mjs` 是**被调研项目 dsh-agent-teams 的路径**，非本仓引用，**不属失效**（已核实）。

### 度量工具（2026-09-11 C42 登记）

- **TD-METRICS-001** · `measure-techdebt.mjs` 指标口径与文档不一致，且 `any` 正则双向失真
  - 位置：`scripts/measure-techdebt.mjs`、`docs/technical-debt/README.md`、`docs/technical-debt/metrics.md`
  - 影响：① 全部指标此前一律只扫 `src/`，与 `docs/code-refinement-plan.md` §六 基线表声明的 `src + ui/server`（console）、`src + ui/src`（any/catch）、`src + ui + ui/server + tests`（TODO）不一致——C40/C41 两张横切卡都因此被迫自建一次性扫描重建口径；② `any` 用裸正则 `: any | as any | <any> | any[]`，**既高估**（注释/字符串里的英文单词 "any"）**又低估**（泛型位 `Record<string, any>` 的文本是 `, any>`，不含 `: any`）；③ `catchSilent` 把已注释的防御式计为静默吞错。
  - 修复：作用域按基线表对齐并输出 `scopes` 字段；`any` 改 TS AST（类型位 `AnyKeyword` + `@ts-*` 指令），实测 3 处且与 C40 逐处 `SAFETY` 登记清单完全一致；废弃 `catchSilent` 改用「无注释的无参 catch」（以 C41 独立验证分类做等价性校验，逐数相同）；console 豁免两处 C39 收束入口；`metrics.md` 按新口径重生成（顶部带「指标口径」表）。
  - 工作量：M · 严重级：P2 · **状态：done（2026-09-11，C42）** · 决策见 `docs/notes/implemented/2026-09-11-c42-final-report.md`

> **自动化命中清单结束。** 以下为 Phase 2 逐模块人工审阅结果（B1–B6 全部完成）。

---

## 1. agent（主链路 · B1 ✅）

**模块概况**：67 文件 / ~9k 行；`tests/agent/` 39 spec（覆盖相对好）；类型安全良好（0 处 `@ts-ignore`，仅 1 处缓解型双重 cast `toolContext.ts:250-251`）。最需注意 `handleModelError` 单函数承载约 10 条模型错误恢复路径。

- **TD-AGENT-101** · `AgentLoop.handleModelError` 371 行 god function
  - 类别：A · 严重级：P1 · 工作量：M · 状态：**done（2026-09-14）**
  - 位置（结清时）：`src/agent/loop/modelErrorRecovery.ts`（原 `AgentLoop.ts:795-1165`）
  - 影响：单函数承载流中断恢复/思维缺失重试/工具结果投影/json 自纠/reactive 恢复/输出上限调整等约 10 条互斥路径，分支深、易漏测。
  - 建议：按恢复路径拆成独立策略方法并统一调度口串联。
  - 证据：`handleModelError@795`→`handleNoToolCalls@1166`；`809/888/923` 多个独立分支并列。
  - **2026-08-27 复核（范围扩大）**：债不止于单函数过长——**恢复策略被复制进姊妹函数**，拆分 `handleModelError` 单独完成会留下孪生体。Pair A（max-output 状态机）：`assembleAndRecover :659-694` ↔ `handleModelError :1097-1132`（`resolveOutputTokenRetryBump→setTransientTokenCap→yield token_cap_adjusted→yield turn_continued→continueWithTransientPrompt` 全同）；Pair B（连空响应状态机）：`assembleAndRecover :726-759` ↔ `handleNoToolCalls :1189-1225`（含 `hasAttemptedEmptyRetry` 首重分支与穷尽路径）。改重试上限/提示词/事件载荷须同步 2–3 处（R2/R3）。建议先抽 `recoverFromMaxOutputBump(...)` 与 `recoverFromEmptyResponse(...)` 策略方法供三处复用，再做既有拆分。类别：A/F · Pain×Spread：3×2=6 · 严重级维持 P1。
  - **2026-09-14 进展（孪生体已收口为独立模块）**：Pair A/B 的策略方法在早前轮次已抽取并三处复用；本日进一步外迁为 `src/agent/loop/recoveryStrategies.ts`（连同 `continueWithTransientPrompt`/`emitEmptyOutputTokenBump`），共享关系由模块结构而非注释保证，`TokenCapManager` 经 `TurnExitDeps` 显式注入。
  - **2026-09-14 结清**：`handleModelError` 本体（365 行）与 `tryReactiveRecover` 迁入 `src/agent/loop/modelErrorRecovery.ts`，按恢复路径拆为 9 个具名步骤函数（输出上限自愈 / 流中断恢复与耗尽 / 推理内容缺失重试 / 工具结果补齐 / JSON 自纠 / reactive 四决策 / 输出触顶 / 兜底错误面），由 `recoverFromModelError` 显式排序调度（`unhandled` 才落到下一步）；同批补 22 条直测（含「reactive 探针必须在工具结果补齐之后」的顺序锁定），AgentLoop.ts 2130 → 1740 行。决策见 `docs/notes/implemented/2026-09-14-agentloop-model-error-recovery-extraction.md`。
- **TD-AGENT-102** · `TurnRunner.run()` ~197 行且失败路径重复
  - 类别：A · 严重级：P1 · 工作量：M · 状态：**done（已修复 2026-09-15，PR #381）**
  - 修复：复核发现实际是**四条**路径（原记三条，漏了 `run()` 末尾的 loop 抛错 catch）且彼此**不同构**——差异点是「是否把结果落盘」「是否有产物采集器」「是否做 metadata 收尾」，故抽成带可选参数的私有异步生成器 `emitEarlyFailure({options,error,messages,finishArtifacts?,recordResult?,finalizeMetadata?})`，四处改为 `return yield* this.emitEarlyFailure({...})` 并只声明各自差异。**事件矩阵自证收口**：`turn_completed` / `turn_failed` 在 `TurnRunner.ts` 的生产点由各 4 个降为各 1 个，`file_artifacts` 由 4 降为 2。
  - 一并拉齐的**顺序约定**：产物收尾恒在结果落盘之前（与成功路径一致，`tests/session/turn-file-artifacts.spec.ts:75-78` 断言的正是这条）；原「UserPromptSubmit 阻断」与「未请求模型」两条路径顺序是反的。事件流本身不变，变的只是转录条目顺序。
  - 契约：`turn_result` / `turn_failed` / `turn_completed` 事件形状未变（`docs/event-producer-consumer.md` 已在同 PR 重新生成，逐事件生产/消费集合与位移前一致）。
  - 测试：新增 `tests/session/turn-early-failure.spec.ts`（5 例，逐条锁定四条路径的差异点与顺序约定）；负控制——把 helper 内顺序对调后 3 例转红。
  - 决策记录：`docs/notes/implemented/2026-09-15-turnrunner-early-failure-unification.md`
  - 位置（结清时）：`src/agent/turn/TurnRunner.ts`
- **TD-AGENT-103** · `assembleAndRecover` 272 行
  - 类别：A · 严重级：P2 · 工作量：M · 状态：**done（2026-09-14）**
  - 位置（结清时）：`src/agent/loop/responseAssembly.ts`（原 `AgentLoop.ts:577-777`）
  - 影响：消息组装与错误恢复判定混在一处，嵌套深。建议：拆出错误恢复判定/重试计数。
  - **2026-09-14 进展**：其调用的两条共享恢复策略与终止出口已外迁（`recoveryStrategies.ts` / `turnExit.ts`），本方法内只剩编排与 Phase C 兜底。
  - **2026-09-14 结清**：方法整体迁入 `src/agent/loop/responseAssembly.ts`，内部按"装配 + 有序处置"分层——装配（usage 归并 / 文本回退工具名修复 / finalMessage / transient 过期 / doomLoop 记录）与三条具名处置步骤（半截文本工具调用 / 修补后截断 / 空响应），装配产物收进 `AssembledResponse` 在各步骤间传递；`repairTextExtractedToolNames` 随迁为导出纯函数；`StageOutcome`/`unhandled` 上移 `turnExit.ts` 与恢复链共用。AgentLoop.ts 1733 → 1485 行，同批补 22 条直测。决策见 `docs/notes/implemented/2026-09-14-agentloop-response-assembly-extraction.md`。
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

**模块概况**：33 文件 + 17 spec；负责模型分流/分级（judge）、fallback、zero-usage/瞬时重试、多模态降级、cache-aware 切换。类型面干净（`any` 为 0）；主路径职能过度集中——2026-09-15 已把 `createRouterRuntime` 闭包按职责拆开（#384），`RouterRuntime.ts` 只剩装配 190 行。

- **TD-ROUTER-001** · `createRouterRuntime` 877 行 god function
  - 类别：A · 严重级：P1 · 工作量：L · 状态：done（#384）
  - 位置：原 `src/router/RouterRuntime.ts:94-978`（885 行）
  - 影响：单闭包承载 config 归一、session store/health cache、决策、执行、重试、编排、统计。
  - 处置：入参收敛为 `RouterDecisionDeps` / `RouterExecutionDeps` 两个显式对象，闭包体按职责拆到
    `decision/` `execution/` `sticky/` `media/` `retry/` 五个目录；`RouterRuntime.ts` 1230 → 190 行，
    只留装配与 `stream`/`invalidateSticky`/`shutdown`。`createRouterRuntime` 已退出最大方法榜。
  - 证据：`docs/notes/implemented/2026-09-15-router-runtime-decomposition.md`（31 段已审计编辑的精确重建全等 + 负控制四类漂移均转红）。
- **TD-ROUTER-002** · `execute()` 嵌套巨型异步生成器（~410 行）
  - 类别：A · 严重级：P1 · 工作量：M · 状态：done（#384）
  - 位置：原 `src/router/RouterRuntime.ts:499-909`（411 行）
  - 影响：fallback/transient-retry/zero-usage 三套重试分支与「已产出内容是否可重放」状态机咬合紧密。
  - 处置：两条建议均落地——「抽单 attempt 执行器」→ `execution/streamAttempt.ts`（含流错误归类与
    可中止延时）；「重试判定纯函数」→ `retry/retryGates.ts`（`shouldTransientRetry` /
    `shouldZeroUsageRetry`，判据表达式逐字搬走、短路顺序不变）。嵌套与「不可测」两处根因消除。
  - **残留**：`executeRouterDecision` 本体仍有 429 行（比原 411 行**更大**，因判据改走谓词多出调用与
    实参行），两套重试分支的「发事件 + 算退避 + 等待」编排未拆 ⇒ 已另立 **TD-ROUTER-009**。
- **TD-ROUTER-003** · `decide()` 决策函数 ~211 行含多层嵌套分支
  - 类别：A · 严重级：P2 · 工作量：M · 状态：done（#384）
  - 位置：原 `src/router/RouterRuntime.ts:257-480`（实测 224 行；台账 2026-08-27 复核记 `:257-473` ≈217 行）
  - 处置：抽为 `decision/decideRouterDecision.ts` 的 `decideRouterDecision(input, deps)`，`resolveCustom`
    同文件私有；`RouterDecisionDeps` 显式声明 10 项依赖。分支本身未重写（谓词表驱动的 `resolvedFrom`
    溯源仍属理想终局，见 `TD-ROUTER-002` 的「一次性重写」备选），但已可逐分支单测。
  - 证据：`tests/router/router-runtime-decide.spec.ts` 15 条（`resolvedFrom` 五个取值 + 粘性 +
    cache-aware 切/留 + 媒体重路由 + 编排门控 + 无默认场景抛错 + `invalidateSticky`）。
- **TD-ROUTER-004** · 生产路径残留裸 `console.log` 未走 `debugLog` 门控
  - 类别：C · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`RouterRuntime.ts:421`；`orchestrate/applyOrchestration.ts:21,42`
  - 建议：改用 `src/shared/debug.js` 的 `debugLog`。对照 `classifyAndRoute.ts:150` 已用 `debugLog`。
  - **2026-09-15 复核（#384）**：`src/router/` 全量 grep 已无任何 `console.*`；且原引用的
    `RouterRuntime.ts:421` 在拆分**前**即为 `scenarioType,`（位置早已漂移，非本次引入）。
    `applyOrchestration.ts:21,42` 现为 `logger.info`。本条疑已由他处修复，**待确认后关闭**，
    本次不代为判 done。
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
  - 类别：E · 严重级：P2 · 工作量：M · 状态：done（#384）
  - 位置：`tests/router/` 原无 `RouterRuntime` 主路径 spec；`tests/test-support/llm-replay.spec.ts:117-122` 仅 passthrough
  - 处置：补 32 条确定性用例，只经公开入口 `createRouterRuntime(...).decide/.execute` 驱动（不 mock 模块）：
    `router-runtime-decide.spec.ts` 15 条（`resolvedFrom` 溯源、粘性、cache-aware 切换/保留、媒体重路由、
    编排门控、无默认场景抛错、`materializeRequest`、`invalidateSticky`）、`router-runtime-execute.spec.ts` 11 条
    （fallback、已产出内容后不重试 + 终态错误、transient retry、zero-usage retry、全失败回放、
    媒体降级重发、子代理预算、取消）、`retry/retry-gates.spec.ts` 6 条（两谓词真值表 + 内容门控优先）。
  - 覆盖前：`sati_router_fallback` / `zero_usage_retry` / `transient_retry` / `execute_failed` 四个事件
    在 `tests/` 下零命中（全量套件的 router 一律 `enabled: false` 直通）。
  - 注：这些用例是**重构前**先写、对旧闭包跑绿的，抽取后断言一行未改仍全绿 ⇒ 同时充当等价性证据。
- **TD-ROUTER-009** · `executeRouterDecision` 429 行，两套重试分支副作用编排未拆
  - 类别：A · 严重级：P3 · 工作量：M · 状态：new
  - 位置：`src/router/execution/executeRouterDecision.ts` 的 `executeRouterDecision`（429 行，当前 `src/` 最大函数）
  - 来源：`TD-ROUTER-002` 拆分后的残留（#384）。原 `execute` 为 411 行，抽走单 attempt 执行器与重试谓词后
    因调用与实参行反而增至 429 行。
  - 代价：它是「候选分档 + 逐 attempt 编排 + 三套重试的 emit/退避/等待 + 用量统计」的合集，仍然是
    「读一遍才能改一处」；两套重试分支的副作用块（发 `sati_router_transient_retry` /
    `sati_router_retry_progress` / `sati_router_zero_usage_retry` + telemetry + `abortableDelay`）各占 40–50 行。
  - 建议：① 把「候选分档 + 重试参数归一」抽成纯函数 `planAttempts(decision, request, config, modelRuntime, now)`
    （全纯，可直测多模态分区逻辑）；② 把两套重试分支的 emit+退避抽成 `emitTransientRetry` / `emitZeroUsageRetry`；
    ③ 可选：内容门控循环抽成二级生成器（`pending` 缓冲 + 哨兵）。三者均不改变 `continue outer`/`break outer` 语义。
  - 触发条件：下次调整路由策略或重试判定之前先做 ① ②；或本函数再增长超过 450 行时立项。

---

## 3. tool（主链路 · B1 ✅）

**模块概况**：111 文件，24 内置工具 + 执行/注册/调度基础设施；注册表 `requireOutputSchema` 已开启、`ToolRuntime` 错误归一/审计闭环较完整。债务集中在 `readFile.ts` 与 `createBuiltinRegistry.ts` 两个超大函数、模式约束名单重复、静默吞错。
> ⚠️ 更正：`TD-TYPE-002`（tool 17 处 any、planMode 6 处）**无法复现**——`src/tool` 无任何类型位 any/`@ts-expect-error`。仅存的非严格收窄是 `userInteractionConstraints.ts:39` 的 `{} as never` 与 `filesystem/read-file/validate.ts:24` 的 `as ReadFileInput`。

- **TD-TOOL-001** · `createReadFileTool` god function（~508 行）
  - 类别：A · 严重级：P2 · 工作量：M · 状态：**done（2026-09-14，issue #152）**
  - 位置：`src/tool/builtin/readFile.ts:43-551`（改后该文件 127 行，四条读取路径移入 `src/tool/builtin/filesystem/read-file/`）
  - 建议：按读取类型拆独立 handler（image/pdf/notebook/text）+ 共享工具函数。证据：`:43` 起 `:169` execute `:184` markRead `:503` shrinkToBudget `:551` 收尾。
  - 已做：`constants`/`types`/`kinds`/`validate`/`text`/`image`/`pdf`/`notebook` 八件拆分，入口路径与 `description`+`inputSchema` 逐字保持不变（llm-replay 请求键不受影响）；新旧实现 28 场景差分对拍结果完全一致；补 `tests/tool/read-file-kinds.spec.ts` 11 条（image/pdf/notebook 分支此前直接覆盖为零）。见 `docs/notes/implemented/2026-09-14-readfile-god-function-split.md`。
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
  - 类别：A/G · 严重级：P3 · 工作量：M · 状态：**partial（2026-09-14）**
  - 位置：`src/tool/builtin/patent-pdf-download/browserScripts.ts`（2026-09-14 由 `patentPdfDownload.ts:855-949` 平移；`buildDownloadScript` 另在 `browserDriver.ts`）
  - 建议：抽为独立 `.js` 源文件纳入类型/格式检查，或改结构化生成并补用例。
  - 已做（issue #152 拆分副产物）：三段模板与 `escapeTemplateContent`、`pdf-link-extract.js` 热加载集中到单模块，工具文件不再内嵌 JS。
  - **未做（本条主因）**：模板仍是 TS 内的 `String.raw` 字符串，**未**纳入类型/格式检查。把探测/点击两段也改成 `assets/patent/*.js` 热加载会改变运行期行为（多一次文件 IO + 版本标记契约 + 回退路径），须作独立变更评估。
- **TD-TOOL-008** · `patentKgQuery` 缓存构造失败静默返回 null
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/tool/builtin/patentKgQuery.ts:84-90`
  - 影响：KG 库打开失败被当"未配置"，无法区分损坏/权限 vs 缺失。建议：catch 中区分并记录 warning。

### 2026-09-14 处置追加（issue #152「审视 800–1000 行的工具文件」）

- **已做（PR #321）**：TD-TOOL-001（`createReadFileTool` god function）——`readFile.ts` 891 → 127 行，四条读取路径与共享 helper 移入 `src/tool/builtin/filesystem/read-file/`。工具契约（`description` + `inputSchema`）逐字未变，llm-replay fixture 无需重录；新旧实现 28 场景差分对拍一致；补 11 条 image/pdf/notebook 直测。见 `docs/notes/implemented/2026-09-14-readfile-god-function-split.md`。
- **已做（本 PR）**：`patentPdfDownload.ts` **953 → 164 行**——按职责拆入 `src/tool/builtin/patent-pdf-download/`（constants/types/browserScripts/browserDriver/fetchFallback/manifest/reporting/outputPaths/validate/execute）。入口路径与导出面不变（registry 与 9 个 spec 无需改导入）；工具契约段逐字未变；新旧实现 32 场景差分对拍一致（含生成的浏览器脚本字符串、落盘文件清单、埋点 JSONL）。副产物：TD-TOOL-007 转为 partial（模板已集中到单模块，但仍未纳入类型/格式检查）。见 `docs/notes/implemented/2026-09-14-patent-pdf-download-split.md`。
- **本轮实测行数**（`wc -l`，2026-09-14）：`patentPdfDownload.ts` **953 → 164** · `readFile.ts` **891 → 127**（PR #321）· `patentWorkflowRunTool.ts` **818 → 149**（本 PR）· `kanban.ts` 815 · `executeCode.ts` 774 · `SkillManager.ts` 621（2026-09-11 已拆）。
- **仍待做（机会型，触发条件不变「下次改这些文件时顺带拆」）**：
  - `kanban.ts`（815）、`executeCode.ts`（774）：未达 800 阈值但同量级，拆分方案未成形，暂不登记新条目。
- **判定：本议题已达"审视并处置"目的**：四个 ≥800 行文件已逐一处理（`readFile.ts`/`patentPdfDownload.ts`/`patentWorkflowRunTool.ts` 拆分，`SkillManager.ts` 2026-09-11 已拆），余下两个未达阈值的同量级文件不构成该条目的原始范围。

### 2026-09-14 处置追加（二）：`patentWorkflowRunTool.ts`

- **已做（本 PR）**：`patentWorkflowRunTool.ts` **818 → 149 行**——按执行面拆入 `src/tool/builtin/patent-workflow-run/`（types/provenance/manifestRun/graphRun/judges）。入口保留契约与分派，`openProvenanceCollector`、`buildJudgeSection` 与两个类型由入口转出（既有 spec 导入路径不变）。工具契约段与类型块逐字未变；新旧实现 22 场景差分对拍一致（manifest 全流程/持久化/放行、三张领域图中断与检查点、judgeModels 共识、buildJudgeSection 六配置、溯源四组合），仅掩蔽调度抖动量。见 `docs/notes/implemented/2026-09-14-patent-workflow-run-split.md`。
- **判定：不做的部分**：`SkillManager.ts` 已于 2026-09-11 拆分（915→623）并销 TD-EXTENSION-N01/N02 主因，本轮复核**不再重复拆分**；`readFile.ts` 残余的 `as ReadFileInput`（现位于 `read-file/validate.ts` 空 `pages` 归一分支）属类型收窄小项，未混入本次纯搬移。

---

## 4. gateway（主链路 · B1 ✅）

**模块概况**：InProcess/Remote 两实现 + 手写 WS 帧协议 + 服务端连接；已从 2341 行拆出 6 个下沉模块，现 `InProcessGateway.ts` 1103 行；`tests/gateway/` 25 文件。分层清晰，但类型强转（`as never`）、安全关键帧解析的测试空白、「方法清单多处同步」为包袱。

- **TD-GATEWAY-001** · InProcessGateway 1103 行是否还需再拆
  - 类别：A · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/gateway/client/InProcessGateway.ts:1-1103`（复杂块 `:314-621`）
  - 建议：不再整体拆分；仅把 submitTurn 内 telemetry/timeout/permission 脚手架抽成辅助函数。
  - **2026-08-27 复核**：文件增至 **1350 行**，增量 ~220 行全部为 kanban 可选域薄委托块（`:1149-1349` 共 17 个 `kanban*` 方法，同一「未配置守卫→resolveKanbanProjectRoot→getRuntime→转发」三步脚手架复制；`submitTurn` 核心实测稳定 ≈298 行），**本轮无认知深度恶化、不升级拆分**；但本类已吸收第 4 个可选域（cron/skills/always-on/team/kanban）——预授权在第 5 个域接入前抽取可选域 facade（`KanbanMethods`/`SkillMethods` mixin 对象挂接），工作量 M，维持 P3~P2 边界。
- **TD-GATEWAY-002** · 分发器 `frame.params` 缺运行时校验（`as never` 已消除，2026-08-23）
  - 类别：B · 严重级：P2 · 工作量：M · 状态：**partial（2026-08-23）**
  - 位置：`src/gateway/server/GatewayWsConnection.ts:153,233-388`（43 处 `as never` → 已改 `as GatewayMethodParams<"...">`）；`client/RemoteGateway.ts:92-278`（~30 处 `as XResult`，已在 TD-TYPE-002 消除）
  - 已做：`as never` 底部类型滥用消除，改用具名断言（编译期类型正确、可读、随 `Gateway` 接口漂移）；补分发回归测试 `tests/gateway/server/dispatch.spec.ts`。
  - 待做：`frame.params` 来自 WS 线上 `JSON.parse`，仍是 `unknown` 未经运行时校验——按 method 建参数守卫（`isRecord`/typeof）在边界收窄并回结构化 `gateway_request_failed`，堵住"客户端畸形入参直通 gateway 方法内部"。属方案 B，另批排期。
  - **2026-08-27 复核（紧迫度上升）**：缺失校验现在有了具体受害者路径——新 god method `dispatchRequest :247-562`（316 行 switch ~90 case）仅 `kanban_subscribe/unsubscribe :533-557` 两处做 `typeof projectId!=="string"` 边界校验；其余 case 的 `frame.params as GatewayMethodParams<"...">` 纯编译期。远端发 `{method:"kanban_get",params:{}}` 即穿透全部守卫，至 `InProcessGateway.resolveKanbanProjectRoot :1164-1169` 触发对客户端不可诊断的裸 TypeError。建议与 TD-GATEWAY-006 合并为一个 PR：建 `METHOD_GUARDS: Record<WsMethod, Guard>` 表同时获得穷尽性检查（一表解两债）。
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
  - **2026-08-27 复核（恶化实证）**：kanban 一个功能周期即新增 **18 个 `kanban_*` case**（`GatewayWsConnection.ts:449-557`）+17 个 InProcessGateway 方法 + frames/Gateway 两处清单，四文件手工同步的维护税已兑现；`default` 兜底不变。建议与 TD-GATEWAY-002 待做半合并为守卫表 PR（`satisfies Record<WsMethod, Guard>`）。
- **TD-GATEWAY-007** · `agent_status` 自由字符串扁平化削弱事件面类型安全
  - 类别：B · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/gateway/protocol/types.ts:290`；`eventMapping.ts` 多处自由字符串
  - 建议：为高频子事件定义 `event` 字面量联合与 per-event detail 类型。
- **TD-GATEWAY-008** · 网关协议版本文档漂移（1.2 vs 1.4）
  - 类别：H · 严重级：P3 · 工作量：S · 状态：done（2026-08-23，与 TD-DOC-001 同批处理）
  - 位置：`src/gateway/protocol/version.ts:31`（=1.4）↔ `CLAUDE.md`（写 1.2）
  - 建议：同步 `CLAUDE.md` 及变更表。

---

## 5. session（主链路 · B1 ✅）

**模块概况**：34 文件——append-only JSONL 转录 + 增量读取/投影缓存 + 孤儿 turn 合成 + 跨进程续算（TaskResumeScanner）+ J-Space 账本（workspace/）。类型安全 0 真实 any（`AbortSignal.any` 误报）。性能债集中在账本持久化 O(entries) 每轮重建与全量快照增长。

- **TD-SESSION-N01** · `WorkspaceLedgerStore.read()` 每轮（每次模型调用）全量重扫 transcript 重派生账本
  - 类别：I · 严重级：P1 · 工作量：M · 状态：**done（2026-09-15，PR #378）**
  - 位置：`src/session/workspace/WorkspaceLedgerStore.ts`（`read()`）；`WorkspaceLedgerReader.ts`
  - 影响：账本每次模型调用前重新注入，长会话 O(entries) 重扫 + clone。建议：按尾部衔接键缓存最新 workspace_state。对应 `performance-review.md` B 类「每轮全量重建」。
  - **2026-09-15 处置（PR #378）**：`WorkspaceLedgerReader` 新增 `scanLatestWorkspaceState(entries, cursor?)`，游标记 `scanned`（上轮覆盖的前缀长度）+ `anchor`（该前缀最后一条 entry 的**对象引用**），下轮只扫新增尾部，常见路径 O(1)。失效判据用对象身份而非数组长度：`readTranscript` 返回元素共享数组，transcript 被替换/回滚时 `readFullAndCache` 会产出全新对象，锚必然不匹配 → 从头重扫；长度型守卫恰漏「等长覆盖」（`cp -p` / 同长度原地改写）这一 reader 自己专门设头部指纹兜底的场景（负控制已验证：去掉身份判据后 `workspace-ledger-store.spec.ts` 的等长重写用例返回旧值）。同批修掉 TD-WORKSPACE-N01 的克隆放大。决策见 `docs/notes/implemented/2026-09-15-workspace-ledger-read-path.md`。
- **TD-SESSION-N02** · `recordWorkspaceState` 每笔写入附加账本全量快照，transcript 单调增长
  - 类别：A · 严重级：P2 · 工作量：L · 状态：new
  - 位置：`src/session/transcript/JsonlTranscriptWriter.ts:232-241`
  - 影响：Reader 只取最新一条，先前全量快照成为死重，transcript 无界增长。建议：只落增量/最新状态。
- **TD-SESSION-N03** · `TaskResumeScanner.scan()` 空 catch 静默吞单会话失败，结果面无失败计数
  - 类别：C · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/session/resume/TaskResumeScanner.ts:98-100`；`42-49`
  - 影响：单会话读盘/提交异常被静默跳过，`TaskResumeScanResult` 无 failed/errored 字段。建议：结果加失败计数并透出首个错误。
- **TD-SESSION-N04** · `WorkspaceLedger` 持久化边界（Store/Reader）无直接单测
  - 类别：E · 严重级：P2 · 工作量：S · 状态：**done（2026-09-15，PR #378）**
  - 位置：`src/session/workspace/WorkspaceLedgerStore.ts`（read/write）、`WorkspaceLedgerReader.ts`
  - 影响：账本从 transcript 重派生、每次模型注入的 I/O 路径及 in-memory 回退边界均无测试。建议：补 file-backed 与 in-memory 两路径 behavior spec。
  - 备注：`TaskResumeScanner` 与 `WorkspaceLedger` 纯状态机已有直接 spec（不列为缺失）。
  - **2026-09-15 处置（PR #378）**：新增 `tests/session/workspace/workspace-ledger-store.spec.ts`（9 条）覆盖游标复用 / 锚失效 / 数组回退 / file-backed 往返（含克隆语义）/ 等长重写后读到新账本 / 超限 `unavailable`（不回退陈旧态 + 诊断去重一次）/ 未写过账本为空态而非失败 / 无路径内存态；`tests/tool/builtin/workspace/workspace-note.spec.ts` 的 `MemProvider` 适配新签名并补「不可读时拒绝写入且既有账本不变」。
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
  - 类别：H · 严重级：P3 · 工作量：S · 状态：done（2026-08-23：`performance-review.md` 的「retrieve 无缓存」条目更正为已实现 TTL 缓存 + 并发去重，并注明 reasoning-loop ~828 行）
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
  - 类别：D · 严重级：P1 · 工作量：M · 状态：**done（已修复 2026-09-15，PR #382）**
  - 修复：抽出 `src/patent/workflow/stage-primitives.ts` 作为**唯一实现**——`resolveStageOutput`（主输出键解析 / 非字符串 JSON 序列化 / 空输出回退 `state[stage.id]` / 已放行审批门占位 `APPROVED`）、`clearStageOutputs`（删 stage-id 键 + atom `outputSchema` 全部键）、`isApprovalGateStage`（容空包装）。三处（`graph/adapter.ts` 的 `makeStageNode`/`makeRetryRouter`、`workflow/executor.ts`、`workflow.ts`）改为调用，差异参数化（兜底取值源、清理范围）而非强行归一。**漂移随之消除**：图路径原缺审批门占位分支 ⇒ 同一 manifest 两条链路 `state[gateStageId]` 不同（`""` vs `"APPROVED"`），现两路径一致。
  - **口径修正（核码）**：① issue 称「图路径不写占位 → 可能被标记 degraded」不成立——图路径降级只来自 `degradationSummary`（`<key>__degradation`），空输出不被标记，真实差异仅是输出文本；② issue 未列的**第三处漂移**：`makeStageNode` 的 `delta[`<id>__degraded`] = true` 是写而无人读的死键（`degradationSummary` 只认 `__degradation` 后缀），使无人值守路径上「阶段无可执行体」被静默报成成功；`DegradationReason` 里早已声明 `not_implemented` 却零生产者。已改为走引擎已消费的降级通道（`markDegraded(..., "not_implemented", ..., "critical")`），与 manifest 路径 `degraded: true` 判定同向。
  - 证据：新增 `tests/patent/workflow/stage-primitives.spec.ts`（14 例，直接钉住两个原语的各输入形态）+ `tests/patent/graph/adapter.spec.ts` 新增 2 例跨链路用例（已放行审批门两路径输出/降级判定一致；无执行体阶段走降级通道）；**负控制**：摘掉图路径放行判据 → 前者转红；把死键写回 → 后者转红。`tests/patent/**` 1090 例全绿。
  - 决策记录：`docs/notes/implemented/2026-09-15-patent-stage-primitives.md`
  - 位置：`src/patent/graph/adapter.ts`（`makeStageNode`/`makeRetryRouter`）；`workflow/executor.ts`；`workflow.ts`
  - **残留（已写进 `src/patent/graph/README.md` 的「已知差异」）**：错误重试的表示（`[WORKFLOW_DEGRADED]` 文本 vs `node_failed` 标记）、阶段级 `degraded`/`completed` 通道（图路径 `completed` 不看降级标记）、executor 分支是否写 `state[stage.id]`。**新发现待立项**：图路径放行是全局 state 键（永不清理）⇒ 一次 `grantApproval` 会让同一 run 内后续所有审批门静默放行；`patent_drafting_v1` 有六门，经 `manifestToGraph` 跑时需复核。**（已由 #393 修复，见下「验证面」条）**
  - **验证面 + 上条「新发现」的处置（issue #358 · done 2026-09-16 · PR #393）**
    - **核账更正（issue 正文已过期两处）**：① issue 表格所指的 `approvedGate` 缺失分叉**已随 #382 消除**，且已有判据（`tests/patent/graph/adapter.spec.ts`「已放行审批门——两路径占位输出一致（#345 漂移修复）」，`7e6d35d96` 引入）；② issue 称「没有任何测试断言两条链路产出一致」**亦已过期**（`adapter.spec.ts` 有 6 条等价性用例）。**真实缺口是另外两处**：多审批门场景**零覆盖**；上条「新发现待立项」的放行泄漏**确实是活的**——实测「只批 gate1 ⇒ 整条链路跑完、gate2 静默 `APPROVED`」，同时 manifest 路径正确停在 gate2（`workflow/executor.ts` 头注释记录的正是同型历史事故）。
    - 修复：放行由「共享 state 的全局布尔」改为**门粒度授权集合**——新增 `APPROVAL_GRANTED_NODES_KEY`（值 = 被批准检查点的 `activeNodes`，由 `grantApproval` 写入）与 `isGateApproved(state, nodeName)`（`atoms/handlers/builtin/gate.ts`）；节点经新增的 `GraphNodeContext.nodeName`（`graph/engine.ts` 单点注入）自知其名，`graph/adapter.ts`（按 `stage.id`）与 `graph/domains/shared.ts`（按节点名）各自把 `APPROVAL_GRANTED_KEY` 注入**执行态拷贝**，共享 state 永不含全局放行布尔；批准**非门**检查点不放行任何门（fail-closed）。
    - **爆炸半径提示（核码时发现）**：域图（`domains/{novelty,inventiveness,enablement}.ts`）的审批门一律带 `params`（`{ review_context: ... }`）⇒ 执行态本就是拷贝，此前能放行是**沾了共享 state 的光**；改为门粒度后必须由 `handlerNode` 自己注入，漏掉即「`grantApproval` 形同虚设、门在 resume 时再次中断」。故两套节点工厂都必须有判据。
    - 证据：新增 `tests/patent/graph/link-consistency.spec.ts`（11 例）——9 个代表性 manifest 的跨链路比对 + **差异登记表 ↔ 用例表两向一致**（出现未登记差异 / 登记了却无人实证 / 差异消失，三种都转红，清单不会腐烂）；`adapter.spec.ts` 该用例改用门粒度传态并新增「共享 state 不得残留全局放行布尔」断言；`checkpoint.spec.ts` HITL 用例加「放行记录 = 被批准检查点待执行节点」与「引擎注入 `nodeName`」断言，并新增 fail-closed 用例。
    - **负控制（9 条，逐条核对红名单 + 相邻用例仍绿）**：① 门粒度判定忽略门 id ⇒ link#4 + checkpoint fail-closed 转红；② 完整复现历史全局布尔（写入端 + 读取端 + 适配器三处）⇒ adapter「占位输出」/「共享 state 无全局布尔」+ checkpoint HITL/fail-closed + link#4 共 4 条转红；③ 放行写进 delta（泄漏回共享 state）⇒ adapter + link#4；④ `grantApproval` 写空集合 ⇒ checkpoint HITL/fail-closed；⑤ 引擎不注入 `nodeName` ⇒ checkpoint HITL；⑥ 登记表加僵尸条目 ⇒ link#10；⑦ 登记表删 `stage-output` ⇒ link#10；⑧ 图路径降级投影退回「按降级消息子串匹配阶段 id」⇒ link#7/#8；⑨ `domains/shared.ts` 不注入放行标记 ⇒ **首轮未转红 = 判据缺口**，已补「手建域图」用例（link#5）后转红。另有**一条无效负控制**已记录：把 `resolveStageOutput` 的 `fallbackValue` 由 `execState[stage.id]` 改回 `state[stage.id]` 不转红 ⇒ 该行非本 issue 承重点（HEAD 原值即 `execState`，本次未改它），已还原，**不做无判据的行为变更**。
    - 决策记录：`docs/notes/implemented/2026-09-16-patent-link-consistency-fixture.md`
  - **2026-08-27 复核补充**：双轨在导入面上具体化为跨模块循环边——`patent/workflow-dag.ts:15` 值引 `../workflow/index.js` 的 `FlowGraph`（类定义在 `src/workflow/runtime/DagEngine.ts:23`）；且 `manifestToFlowGraph` 在 src 内除专利 barrel re-export 外零消费方（校验路径双重未接线）。若归一选择保留 workflow FlowGraph，则 patent 应深引 `../workflow/runtime/DagEngine.js` 以免传递性抱住含 agent 适配器的整个 workflow barrel。详见 TD-BOUND-003 SCC-1 边 E2。**（该部分已随 #150 闭环：`src/workflow/` 与 `patent/workflow-dag.ts` 均已删除，此处仅存历史。）**
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
  - 类别：C · 严重级：P2 · 工作量：S · 状态：done（2026-08-27：`parseJsonArray` 新增 `field`+可注入 `onError`，缺省走结构化 `createLogger("nuo-mapper").warn`（含字段名+压缩空白截断到 80 字符样本），坏 JSON 不再静默；新增回归测试（纯结构契约 + N06 告警）。边界确认：`src/patent/data/nuo/` 为纯结构适配层、无领域业务逻辑散落，见 `docs/notes/implemented/2026-08-27-nuo-mapper-adapter-boundary.md`）
  - 位置：`src/patent/data/nuo/mapper.ts:36`（`parseJsonArray`，`:41` `catch { defaultWarn... }`）
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

### 2026-09-11 复核追加（issue #151 / #153）

- **#151 复核结论：不存在需要拆分的结构性耦合**（69% 耦合在模块内闭合、跨模块仅 31%、文件级与目录级 SCC 均为 0、无双向边、52% 跨边流入零扇出叶子件）。且 issue 前提「最高频变更面」按文件数归一化后属**最低区间**——完整度量见 `docs/patent-coupling-and-data-layer-review.md`。
- **TD-PATENT-N10** · 进程级可变全局注册表 `globalStageHandlerRegistry` 的隐式初始化顺序（未先 `registerBuiltinAtoms` 的图运行会静默降级）
  - 类别：D · 严重级：P2 · 工作量：S · 状态：new
  - 位置：定义 `src/patent/atoms/handler.ts:130`；注册 `atoms/index.ts:110-114`；消费 `graph/adapter.ts:16`、`graph/domains/{novelty:16,inventiveness:21,enablement:15}.ts`、`evaluate/runner.ts:13`
  - 建议：由 graph/evaluate 显式接收 `StageHandlerRegistry`（`graph/adapter.ts:15-16` 参数面已可注入），把隐式顺序变成显式契约。
- **TD-PATENT-N11** · barrel 绕过 19 条（目标目录已有 barrel 且已 re-export 同一符号）
  - 类别：A · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`atoms/handlers/builtin/mapper.ts:20-22`、`provenance/collector.ts:13,14`、`graph/domains/shared.ts:15`、`guard/evidenceComplianceGuards.ts:18`、`atoms/handlers/builtin/draft.ts:14`、`evaluate/runner.ts:11`、`flexible-plan.ts:29`
  - 建议：改为经 barrel 导入（机械、无行为变更）；同时补两处 barrel 缺口（`claim-chart/index.ts` 增 `validatePinCiteFormat`、`workflow/index.ts` 增 `signalMatches`）。
- **TD-PATENT-N12** · 引证同族维度被 flatten（领域信息失真）
  - 类别：C · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/patent/data/nuo/mapper.ts:44-45,83-90`（`*_no_family` 与 `*_yes_family` 合并为单数组）；被 `tests/patent/data/nuo/mapper.spec.ts:150-160` 锁为契约
  - 影响：同族/非同族在 A22.2/A22.3 与 FTO 语境含义不同。建议由产品侧决定形状后再改（属跨模块契约变更）。
- **TD-PATENT-N13** · 专利号归一化口径发散
  - 类别：C · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/patent/data/nuo/egoSession.ts:257-263`（自建，剥 `-` `:`）vs vendor 同名导出（不剥，`vendor/nuo-patent/dist/index.d.ts:766`）；键口径见 `src/tool/builtin/patentPdfDownload.ts:653` 与 `src/patent/data/nuo/patentCache.ts:133`
  - 影响：同号不同形会重复打源。建议先以日志确认是否已发生，再选「改用 vendor 实现」或「保留严格版 + 缓存键同归一化」。
- **TD-PATENT-N14** · TTL 分层内嵌法律状态词表且语义过宽
  - 类别：D · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/patent/data/nuo/patentCache.ts:137-138`（`无效` 同时命中「无效宣告」程序）
  - 建议：词表移出具名领域词表或收紧为状态词；意图需业务确认。
- **TD-PATENT-N15** · `egoSession.ts` 位置错放
  - 类别：D · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/patent/data/nuo/egoSession.ts`（通用浏览器执行封装，无 nuo 数据源逻辑；消费方 `src/tool/*` 与 `src/browser/backend/egoBackend.ts:1`）
  - 建议：移至 `src/browser/`；7 个深引调用点同步改路径（无事件面变更）。
- **复核证伪一条疑似缺陷**：`patentCache.ts:117-120` 的缓存判据对取消路径**已正确处理**（取消落入 vendor 的 `检索失败: <message>` 分支并被既有正则覆盖），本次未改动该文件。

## 9. adapters（B3 ✅）

**模块概况**：102 文件；`channel/` 21 渠道（Channel+SessionMapper+render 模板）+ `protocol/` 共享层 + `web/` 桥；`protocol/` 已抽渲染/交付/交互/命令共享组件（组合复用方向正确）。渠道类间脚手架重复高，负载集中在 wecom(1761)/weixin(1492)/feishu(1333) 与 TUI。
> 复核更正：历史报告所标 WhatsApp/Sms/Discord/Slack「单函数 god function」**已不复存在**（均已拆为 start/dispatch/handleIncoming/processMessage/sendReply）。类型面较干净（大量 `as Record<string,unknown>`，无 `@ts-ignore`/`: any`）。

- **TD-ADAPTERS-N01** · 渠道间「dispatch + submitTurn 处理循环」脚手架高度重复，未抽公共基类/组合
  - 类别：D · 严重级：P1 · 工作量：M · 状态：**done（2026-09-14，两刀）**——`submitTurn` 渲染循环侧抽为 `protocol/ImTurnProcessor.ts`（14 渠道 15 段循环，净 −309）；dispatch 前置抽为 `protocol/ImInboundDispatch.ts`（13 渠道 33 行 ×13 → 1 处，净 −288）。**收口复核**：本条曾登记「一并抽 `deliverCronResult`」，实测 13 个渠道的该实现**全部已是 3–5 行薄委托**到共享 `protocol/ImCronDelivery.ts#deliverChatCronResult`（无自实现），差异仅剩各渠道自己的回复函数——不可再减，与 render 薄包装同属「薄包装保留」判例；6 个语义不同渠道（webhook/wecom/weixin/feishu/api-server/tui）的分派与轮次路径不适用既有 helper，理由见两刀 note 的 Alternatives considered。
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
  - 类别：E · 严重级：P2 · 工作量：M · 状态：🔶 部分完成（2026-09-13：企微回调模式 4 个契约测试落地，`tests/adapters/wecom-callback-contract.spec.ts` 走真实 HTTP 回调 + 企微 AES/签名闭环；余 weixin pollLoop/媒体 AES-ECB、WeCom onSocketData、WhatsApp dispatch 与 Feishu webhook）
  - 位置：`tests/adapters/`（现 6 spec：channel-render / feishu-permission-reply / im-permission-helper / wecom-attachments / api-server-content-object / wecom-callback-contract）
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

### 2026-09-11 处置追加（issue #149）

- **已完成**：13 个渠道的 `*SessionMapper.ts`（归一化后逐字相同的 36 行 ×13）收敛为共享 `src/adapters/channel/protocol/ChatSessionMapper.ts` + 各渠道 8 行薄壳，净减约 290 行；类名与 State 类型导出面保持，13 个 `Channel` 零改动。决策见 `docs/notes/implemented/2026-09-11-adapters-skill-split.md`。**（2026-09-17 更新：该处保留的 13 个 8–10 行薄壳已删除，见本节末「2026-09-17 处置追加」；类名导出面经核为零消费者，故随之移除。）**
- **TD-ADAPTERS-N02** · 13 个渠道的单轮处理循环可抽共享 turn-processor（约 −300 行）
  - 类别：A · 严重级：P2 · 工作量：M · 状态：**done（2026-09-14）**——实际覆盖 14 渠道 15 段循环（比登记多 `wecom-callback`，qq 的 c2c 分支亦在同一文件内），净减 309 行；共享模块 `src/adapters/channel/protocol/ImTurnProcessor.ts`（107 行）+ 直测 15 条
  - 位置：13 个渠道的 `processMessage` 循环，差异仅 `mattermost:215`（ctx 重算 chatId）、`qq:240`（`sendC2CReplyChunked`）、`slack:208`（前置 gateway null 守卫）
  - 影响：这 13 个渠道**全部处于无测试集合**；且抽取会把 21 个 `submitTurn` 调用点搬入共享模块，`docs/event-producer-consumer.md` 按 `file:line` 硬编码 → **必须同 PR 跑 `pnpm gen:event-matrix`**。建议先补测试再动。
  - 结果：归一化对比证明 15 段循环本体逐字相同（差异仅签名与投递目标），共享模块取最小结构接口（`ChannelTurnGateway`/`ChannelTurnElicitationSink`/`ChannelTurnPermissionSink`），差异经 `deliver` 闭包 / `interactionKey` / `beforeTurn` / `errorLabel` 四要素吸收；6 处语义不同的循环保留内联（webhook/wecom/weixin/feishu/api-server/tui）。事件矩阵 `submitTurn` 消费点 14 → 1。
- **TD-ADAPTERS-N03** · 3 个渠道的 `readRequestBody` 逐字重复
  - 类别：A · 严重级：P3 · 工作量：S · 状态：**done（2026-09-14）**
  - 位置：`api-server:475` ≡ `sms:300` ≡ `webhook:452`（17 行 ×3）→ 抽入 `channel/protocol/`。
- **TD-ADAPTERS-N04** · 13 处内联等效于既有共享函数
  - 类别：A · 严重级：P3 · 工作量：S · 状态：**done（2026-09-14，8 处转换 / 5 处保留）**
  - 位置：内联体 vs `src/adapters/channel/protocol/ChannelCommandRegistry.ts:363` 的 `resolveIncomingMessage`
  - 注意：**4 个语义例外不得改**——`weixin:568`（队列而非丢弃）、`wecom:761`（按 sessionKey 守卫）、`feishu:505`（chatState.queueTurn）、`api-server:272`（返回 HTTP 响应）。

### 2026-09-14 处置追加（issue #149）

- **N03 done**：新增 `src/adapters/channel/protocol/httpBody.ts`（`readRequestBody` 逐字迁移，保留 `payload too large` 文案与超限 `destroy` 契约），api-server/sms/webhook 三处本地实现删除改 import；补 `tests/adapters/channel-http-body.spec.ts` 4 条直测（**该实现此前零覆盖**）。
- **N04 done（8/13）**：`dingtalk`/`bluebubbles`/`matrix`/`signal`/`whatsapp`/`webhook` 直传 `(id,t)=>this.sendReply(id,t)`；`slack`/`mattermost` 的回复目标是 `{channelId, threadTs|rootId}` 上下文对象，用 `(_id,t)=>this.sendReply(sendCtx,t)` 丢弃 helper 回传的 chatId。
- **保留 5 处内联（原登记 4 例，本轮新增识别 `qq`）**——差异是业务语义而非写法：
  - `api-server`：回执写 HTTP 响应（流式/JSON 二选一），空正文返 400 结构化错误体（非"吞掉"）。
  - `feishu`：`/new` 先 `abortTurn` + 重置交互状态；活跃时 `queueTurn` 排队而非丢弃。
  - `wecom`：回执带 `chatType`/`replyToMessageId` 选项；活跃判据是 `sessionKey`。
  - `weixin`：`/new` 先 `abortTurn` + 重置；空正文分支嵌在 `command === "new"` 内。
  - `qq`：mapper 入参形状为 `{groupId, userId, text}`（非 `{chatId, text}`），且 `command === "new"` 时需回调 `onStateChange` 上报快照——套用 helper 需一层丢弃/转发入参的包装，代码量与可读性均不划算。
- 决策记录：`docs/notes/implemented/2026-09-14-adapters-channel-helper-dedupe.md`（含 `## Alternatives considered`）。
- 门禁：`pnpm check` 全绿；`docs/event-producer-consumer.md` 已同变更重生成（行号位移）。
- **N02 done（2026-09-14）**：新增 `src/adapters/channel/protocol/ImTurnProcessor.ts`——`processChannelTurn(deps, input)` 收拢「`submitTurn` 流 → 交互捕获并即时投递 → 渲染累积 → trim 后整段投递 → 清理挂起」；**实际覆盖 14 渠道 15 段循环**（登记为 13，本轮识别 `wecom-callback` 同形，qq 的 `processC2CMessage` 亦同形），渠道侧 188 插入 / 497 删除（净 −309），共享模块 107 行。差异仅四要素：`deliver` 闭包（吸收 `sendReply(chatId|ctx)` / `sendReplyChunked` / `sendC2CReplyChunked`）、`interactionKey`（与回复目标解耦，mattermost/slack/qq 不同）、`beforeTurn`（discord/telegram 打字指示）、`errorLabel`（qq c2c 的 `(c2c)` 日志后缀）。**测试**：补 `tests/adapters/channel-turn-processor.spec.ts` 15 条直测——被抽取的执行单元此前零覆盖；渠道类本身仍无集成测试（该现状未被本 PR 改变），等价性证据为归一化机械对比。
- **保留 6 处内联循环（语义而非写法差异）**：`webhook`（可见失败去重 + 结构化状态事件）、`wecom`（逐事件 `sendEventMedia` + 交付物抽取）、`weixin`（live reply 控制器 + 超时看门狗 + generation 断点）、`feishu`（live card + 排队）、`api-server`（投递即写 HTTP 响应）、`tui`（本地渲染）。
- 决策记录：`docs/notes/implemented/2026-09-14-channel-turn-processor.md`（含 `## Alternatives considered`：渠道基类 / 一并抽 dispatch / 具体类型入参 / 统一日志文案 / 消除 render 薄包装 / 拆 14 个 PR）。
- 门禁：`pnpm check` 全绿；`docs/event-producer-consumer.md` 已同变更重生成（`submitTurn` 消费点 14 → 1，各事件"submitTurn 流"计数 28 → 14）；`pnpm test` 全绿。
- **N01 前半（dispatch 前置）done（2026-09-14，第二刀）**：新增 `src/adapters/channel/protocol/ImInboundDispatch.ts`——`dispatchChannelMessage(deps, input)` 收拢「elicitation/permission 挂起应答 → `activeChats` 去重 → `resolveIncomingMessage`（`/new` 回执、命令解析、吞空正文）→ `activeChats` 包围的轮次执行」，**13 个渠道**各删 36–37 行共享段改 16 行 deps 字面量（182 插入 / 470 删除，净 −288）＋共享模块 86 行。设计要点：**一个 sink 而非两个**（实证确认回执与 `resolveIncomingMessage` 的 sink 在 13 处同目标，11 处 = 挂起键本身、slack/mattermost = 上下文对象并丢弃 helper 回传的 chatId），`turn` 用回调注入使两模块互不依赖。**一处表面差异经核验为无操作**：dingtalk 调用点 `.trim()` 冗余（helper 内部首行即 `text.trim()`）。**一处措辞归一**：matrix 的 `room … already active` → `chat … already active`（其余 12 处本就是 `chat`；全仓 grep 确认无消费方）。**测试**：`tests/adapters/channel-inbound-dispatch.spec.ts` 14 条直测。**等价性证据**：逐渠道机械比对「被删 span 要素」vs「新调用要素」13/13 一致（`sendCtx` 字面量与 sink 形参 `id` 在核验器中显式解析）。
- 决策记录：`docs/notes/implemented/2026-09-14-channel-inbound-dispatch.md`（含 `## Alternatives considered`）。
- **仍待做**：`TD-ADAPTERS-N01` 剩余面——`deliverCronResult` 投递共享化（挂在各渠道 cron 触发路径，与入站分派不同源）；6 个语义不同渠道（webhook/wecom/weixin/feishu/api-server/tui）的分派与轮次路径不适用既有 helper。
- **N01 done（2026-09-14，收口核对）**：`deliverCronResult` 面经逐渠道核对为**已去重**——13 个实现全部是 3–5 行薄委托（`dingtalk`/`discord`/`email`/`feishu`/`homeassistant`/`matrix`/`signal`/`sms`/`telegram`/`webhook`/`wecom-callback`/`whatsapp` 各 3 行、`weixin` 5 行）到 `protocol/ImCronDelivery.ts#deliverChatCronResult`，无一份自实现；变化的只有各渠道自己的回复函数（`sendReply` / `sendTextMessage` / `deliverReply` / `sendReplyChunked`）与 weixin 的 `userId` 映射，属不可再减的薄包装（同 render 薄包装判例）。另 8 个渠道（api-server/bluebubbles/cli/mattermost/qq/slack/tui/wecom）本就不实现 cron 投递，非债。
- **明确不做（判例）**：6 处跨文件微重复（`extractText` 的 `string("")` vs `string|null`、`formatError`、`normalizeBaseUrl` ×3、`sendJson` ×2、`sleep` ×3、WS 双形态）按「跨文件微重复不合并」判例保留；18 个 `render` 薄包装保留（它们是 options 未被误改的回归钉，且被 `tests/adapters/channel-render.spec.ts` 直接 import）。
- **议题收口（issue #149）**：五条去重轴全部落地——`*SessionMapper.ts` 共享（2026-09-11，−290；其 13 个薄壳**残留**于 2026-09-17 清除，PR #410）、`readRequestBody` 共享（N03）、`resolveIncomingMessage` 采用统一（N04，8 改 5 留）、单轮处理循环共享（−309）、入站分派前置共享（−288）；N01/N02/N03/N04 均 done。渠道模块内**剩下的**是单列登记的小项（N05 日志绕过 ChannelLogger / N07 render 薄包装 / N08 吞错密度 / N09 无界 `as` / N10 渠道注册表未覆盖），它们是各自的债条目而非「公共 helper 重复」，不随本议题关闭而消失。
- **否定结论（省掉一类工作）**：渠道间不存在时间戳/日期格式化重复；`sessionKey` 解析亦无第二份实现。

### 2026-09-17 处置追加（issue #351）

- **done（PR #410）**：13 个渠道的 `*SessionMapper.ts` 薄壳（归一化后同一 shasum，10 行 ×13）删除——渠道改为直接 `new ChatSessionMapper("<渠道键>")`；`src/adapters/index.ts` 摘掉 13 条类导出 + 13 条 State 别名导出（**全仓零消费者**，且 `package.json` 为 `private: true`）。13 个渠道文件各 4 增 4 删、**总行数不变**（事件矩阵 `file:line` 锚点未位移）。
- **推翻 #149 的落选理由**：该 note 把「删文件、各渠道直接 `new ChatSessionMapper("xxx")`」列为落选，理由是「爆炸半径更大 + 丢失每渠道一个可引用的类名」——核码三条均不成立（barrel 死导出 / 那 13 个 Channel 本来就要改构造点 / `XxxSessionMapperState` 只在自身文件内使用）。#149 的**主决策**（实现共享化）继续有效，本项是它的最后一步。
- **新增判据**：`tests/adapters/channel-session-mapper.spec.ts`——13 条接线用例（每个渠道默认 mapper 的会话命名空间 == 该渠道自身 `channelKey`，登记值即落盘会话键前缀）+ 5 条共享实现语义用例（此前零直测）；顺带覆盖「渠道之间不得共享 mapper 状态」（负控制 M5）。决策与 6 条负控制表见 `docs/notes/implemented/2026-09-17-adapters-session-mapper-shells.md`。
- **未做**：不引入工厂/注册表/类型别名兼容层；6 个真实现 mapper（feishu/weixin/qq/wecom/wecom-callback/api-server）不动。

## 10. always-on（B3 ✅）

**模块概况**：38 文件；常驻后台执行（Discovery 计划/报告/工作周期/workspace 隔离 + 4 个 always_on_* 工具）。核心编排 1252 行 `runtime/DiscoveryFire.ts`；职责边界清晰但复制与未接线配置显著。
> 复核更正：本模块无真实 TODO/FIXME 注释（4 处命中均为 prompt/契约里「拒收含 fuzzy 'TODO'」的业务语义，非债）。静默吞错 ~21 处 `.catch(()=>undefined)`，多数为 best-effort cleanup 可接受。

- **TD-ALWAYSON-N01** · `DiscoveryFire` god class，`run`/`rerunPlan` 近乎全量复制
  - 类别：A · 严重级：P1 · 工作量：L · 状态：**done（2026-09-15 · PR #383）**
  - 位置：`src/always-on/runtime/DiscoveryFire.ts:598`（run）与 `:314`（rerunPlan）
  - 影响：两方法从 workspace→execution→report→写 plan/state/history 几乎逐行相同（~250-280 行），修一处须改两处。
  - 处置：抽出 `private runPipeline({runId, startedAt, planRecord, planMarkdown, state})` 承载 Phase 2-4；两个入口各自只保留真正不同的前置（`run` 的 Phase 1 discovery、`rerunPlan` 的计划读回 + 存在性双校验 + 置 ready）。**方法体由原 `run()` 的 Phase 2-4 机械派生**（仅 `planRecord.id`→`planId`、`discoveryCtx.plan.markdown`→入参 `planMarkdown`），脚本对 275 行逐行规范化比对通过且 `biome` 报 `No fixes applied` ⇒ diff 退化为「抽方法 + 纯改名」。`run` 里仅服务「未产出计划即失败」的历史基底改名 `prePlanHistory`。
  - **口径修正 1（`baseHistory`）**：台账与 issue 建议的签名 `runPipeline(plan, baseHistory)` 把「历史基底」当成真实差异，实核它是**偶然差异且不可观察**——`rerunPlan` 的 `baseHistory` 含 `planId`、`run` 的不含，但 `run` 在每处 `appendHistory` 时又显式补上 `planId`，两条入口产出的 history 记录本就完全相同。故未采纳该签名，改为管线内按 `planRecord` 自建。
  - **口径修正 2（静默清理计数）**：「两方法各带 5 个 `.catch(()=>undefined)`」不成立。这段管线内每个入口 2 个（execution/report 的 `closeSession`），`run` 另多 1 个 discovery 会话清理；文件中其余 6 个属 `runApplyPhase`/`runWorkspacePhase`/`emitEvent`/`drainTurn`/`releaseDiscoveryLock`，不属这段重复。
  - **口径修正 3（死接线）**：`deps.logger` 被声明并被 `AlwaysOnRuntime.bindGateway` 注入，却在整个文件里**零引用**。本次把「关闭 always-on 会话」的 5 处清理收敛为 `closeSessionQuietly()` 并接线 logger（失败记 `warn`、仍不上抛）——即 issue 备注建议的「带日志的清理」，未采纳的部分见下。
  - 未采纳：**把本文件全部 11 处 `.catch(()=>undefined)` 一起改为带日志**。其余 4 处属事件落盘（`emitEvent`/`drainTurn`）与锁删除，失败语义不同，且仓库级口径由 **#353** 统一裁定——在一个文件里先落一套会碎片化该决策。
  - 验收：新增 `tests/always-on/runtime/discovery-fire-pipeline.spec.ts`（10 例：七条路径的事件序列与落盘调用 + 跨调用方有序 trace + `run`↔`rerunPlan` 等价性）。**负控制三处**：收尾两笔落盘对调 → trace 用例转红；`rerunPlan` 的 `planMarkdown` 置空制造参数漂移 → 等价性用例转红；`closeSessionQuietly` 改回静默吞 → 留痕用例转红。
  - 证据（指标）：`DiscoveryFire.ts` 1256 → 1078 行（退出「最大文件」榜）；方法 `run`（原 414 行，榜内 `src/` 下最大方法）退出「最大方法」榜；src TS 总行数 185194 → 185017。事件矩阵 `submitTurn` 生产点仅行号位移（`:1138`→`:961`），生产/消费集合未变。
  - 决策记录：`docs/notes/implemented/2026-09-15-discovery-fire-pipeline.md`
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

**模块概况**：约 44 TS + 1500+ wiki md 卡；kg-store/legal-search 已拆纯件、38 测试覆盖深。债务在**检索编排重复**、**法规 LIKE 降级未对齐**、**DB 行强转与全局缓存**。（2026-09-16 附注：A1–A8 诊断一致性问题已全部关闭，见 `knowledge-system-report.md` §2.6/§2.7 与 `docs/notes/implemented/2026-09-16-knowledge-legacy-a3-a6-a7-a8.md`；该轮新增 N09/N10 两条**刻意的延后项**。）`ipc-classifier.ts` 数据内联已由 TD-PATENT-N08 登记，不重复。

- **TD-KNOWLEDGE-N01** · FTS5 探测+降级编排在 3 个检索引擎近乎逐字重复
  - 类别：D · 严重级：P2 · 工作量：S · 状态：done
  - 位置：`legal/legal-search.ts:119-150`、`legal/knowledge-law-search.ts:166-196`、`case-law/case-law-search.ts:351-384`
  - 建议：抽共享 `runFtsThenLikeFallback` 编排原语，把 data-mapper/降级打点作策略参数传入。✅（2026-08-23：`src/knowledge/shared/fts.ts` 新增 `runFtsThenLikeFallback<T>`，三引擎 `search` 主体改调之；降级打点经 `onDegrade`、data-mapper 由调用方闭包注入。新增 `tests/knowledge/shared/fts-then-like.spec.ts`，knowledge 248 测全绿。）
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
- **TD-KNOWLEDGE-N08** · wiki 知识卡「复审无效」主题下整棵嵌套重复目录树（2026-08-27 jscpd 发现）
  - 类别：F · 严重级：P2 · 工作量：S · 状态：**done（2026-08-27：`git rm -r 'src/knowledge/patent/wiki/复审无效/复审无效'`，206 文件 / 2.11MB；card-index.json 零内层引用、`.wiki-meta.json` 由加载器失效机制自愈；守卫已加入 `scripts/measure-techdebt.mjs::knowledgeDupMd` 并写入 metrics.md 异味指标行）** · 意图：[accidental]（疑似导入/同步事故而非有意备份，无任何注释说明）
  - 后续观察（不阻塞）：清树后守卫仍报 wiki 全库存在 **72 组 / 92 个冗余文件 / 546KB** 逐字节重复 md——是否属有意交叉引用待知识库 owner 评审后再处置。
  - Pain×Spread：2×2=4
  - 位置：`src/knowledge/patent/wiki/复审无效/复审无效/**`（内层整树）；外层 `src/knowledge/patent/wiki/复审无效/**`
  - 证据：内层树 206 个 md / 2,112,485 字节；其中 **205 个与外层同相对路径文件逐字节相同**（仅 1 个不同）。占 wiki 全库 1549 卡的 ~13% 为纯重复。复现：`diff -r` 或 `find … -name '*.md' | xargs md5`。
- **TD-KNOWLEDGE-N09** · 一致性自检结果无门控消费者（模型不匹配时语义召回照常返回）
  - 类别：C · 严重级：P3 · 工作量：M · 状态：new · 意图：[intentional]（#376 A3 的决策是「先校正文档、不塞门控」）
  - 位置：`shared/embedding-consistency.ts`（判定）、`assemble.ts:229-243`（挂载点，出口只有 `setEmbeddingConsistency`）、`shared/knowledge-stats.ts`（`embeddingConsistency`）
  - 影响：查询端 embedding 与库向量模型不匹配（平均余弦 < 0.97）时，语义召回**照常返回结果**——只是相关性差。唯一痕迹是启动期一次 `warn` 与 stats 字段，**没有任何入口据此关闭/降权语义路**，故「embedding 模型选错」这类配置错误会在召回质量上长期不可见。设计文档 §4.4 曾声称「语义召回自动降级跳过（复用熔断路径）」，2026-09-16 已按代码实际行为校正（#376 A3）。
  - 建议：门控的前置条件是**先给检索构造器加 quality/阈值参数**（`createKnowledgeEmbeddingSearch`、`VectorDbSearch` 均无该参数），再由 `assemble.ts` 按自检结果决定是否注入。若要做成独立诊断项，需先评估 `KnowledgeCapabilityStatus` 新增取值的影响面（会牵动 UI + i18n）。
- **TD-KNOWLEDGE-N10** · unified 库缺 `kg_nodes_fts` 时 Sati 侧无重建入口
  - 类别：I · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`scripts/trim-knowledge-db.ts:155-159`（`rebuildKgFtsIndex` 首行「表不存在，跳过重建」）；`shared/kg/schema-introspector.ts`（只探测表、不建表）
  - 影响：统一库的 `kg_nodes_fts` 由知识库导入管道生成，Sati 的两个脚本都不建它——`migrate-kg-fts-trigram.mjs` 只服务 `patent_kg.db`，`trim --rebuild-kg-fts` 遇缺表直接跳过。用户用 `trim --no-fts` 裁掉索引（省磁盘）或导入不完整后，KG 检索长期走 LIKE 全表扫描，诊断报 `kg-fts-tokenizer=missing` 且**给出的动作是「由导入管道重建」，无可执行命令**（#376 A8 只修到「归因准确」这一层）。
  - 建议：让 `rebuildKgFtsIndex` 在表缺失时直接建表（`tokenize='trigram', content='', contentless_delete=1`）并按 `kg_nodes` 回填，使 `--rebuild-kg-fts` 成为对称的重建入口；诊断文案随之可收敛为一条命令。
  - 影响：直接放大 `WikiCardLoader` 冷启动全量扫描（TD-KNOWLEDGE-N06 的 1548 张卡计数含此噪声），检索侧 card-index 若按内容入库则同一裁决规则出现双份，浪费向量行并可能双引同源引用。
  - 建议：确认无消费方后删除嵌套树（git 历史可追回），并加一条 CI/脚本守卫防止再次整树复制（如检查同名相对路径 md 内容相同的对数 > 阈值即告警）。

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

**模块概况**：11 TS + 9 测试；YAML（`rules/**`）经 RuleLoader 校验 → RuleEngine 确定性评估 → RuleOutputGate / policy-bridge。已落地分层规则包与输出门禁 HITL 审批闭环；债在**未接线的 policy-bridge**与**YAML↔代码约定耦合**。（2026-09-16 附注：原「缓存失效键」一条已关闭——分层规则包的缓存失效判据改为内容指纹，见 `TD-RULE-N01` 与 `docs/notes/implemented/2026-09-16-rule-pack-cache-fingerprint.md`。2026-09-16 二次附注：`rules/README`「遗留」3 项已清空并落成 `TD-RULE-N07`；同时把「激活评审补丁」从「仅 action」扩为「action 整替换 + check 级增补」，见 `docs/notes/implemented/2026-09-16-rule-asset-semantic-enhancements.md`。）

- **TD-RULE-N01** · `rule_check(pack)` 缓存失效键只覆盖清单 mtime，层规则文件修改不致源
  - 类别：I · 严重级：P2 · 工作量：S · 状态：**done（#389）**
  - 处置：新增 `computeRulePackFingerprint()`（`src/rule/runtime/rule-pack.ts`）——指纹 = 清单**解析结果** + 各已装载层规则文件的 `(文件名, mtimeMs)`；`ruleCheck.ts` 的 pack 缓存键改调它（原实现为 `<清单路径>@mtimeMs`）。
  - 口径更正（核码结论）：issue 建议的「清单 mtime + 各已装载层规则文件 mtime 集合」**照字面实现会留一个同型漏洞**——`sources` 是**上一次加载**的产物，新增的层规则文件不在其中，其 mtime 永远进不了摘要（issue 自己在「额外信息」里点到这个风险）。故改为**每次调用重新枚举各层目录**，同时覆盖「原地修改」（mtime）与「增删文件」（文件名集合）。「按目录 mtime」的折中方案也被否决：目录 mtime 只在增删时变，**不覆盖原地修改**，而后者正是主场景（决策记录备选 3）。
  - 判据同源：层展开抽成 `resolveLayerRefs()`，`loadRulePack` 的加载与指纹采集共用一份（两处各写一份会让指纹指向并未参与加载的目录）。
  - 负控制（5 组，逐条核对转红名单）：① 把 `packCacheKey` 还原为旧的清单 mtime 实现 ⇒ 工具层 3 例转红（`tests/tool/builtin/rule-check.spec.ts` 的长驻进程三条）、其余 25 例绿；② 指纹丢掉各层枚举 ⇒ 单测「各层规则文件」「新增/删除」「同源」3 例 + 工具层 3 例转红，而「未声明目录」「清单内容」保持绿；③ 摘要只记文件名不记 mtime ⇒ mtime 判据的 3 例转红（「增删文件」「同源」复绿，证明两条机制独立）；④ 指纹额外纳入各层目录的**兄弟目录**（「哈希整目录」折中方案的变体）⇒ 仅「不越界到未声明目录」1 例转红；⑤ 清单 part 改用 mtime 而非解析结果 ⇒ 仅「mtime 变而内容不变时保持稳定」1 例转红。
  - 位置：`src/tool/builtin/ruleCheck.ts:52-64`、`src/rule/runtime/rule-pack.ts:136-167`（层展开）、`:269-337`（摘要与指纹）
  - 副作用（行为变化）：改任意层规则文件（原地改/新增/删除）都会在下次 `rule_check(pack)` 重载；内容未变时不重载。`RulePackLoadResult` 结构未动（`manifestMtimeMs` 保留）。
- **TD-RULE-N02** · policy-bridge 工具拦截通道未接入生产路径
  - 类别：F · 严重级：P2 · 工作量：S · 状态：done
  - 位置：`src/rule/runtime/policy-bridge.ts`
  - 处置：已在 `createLocalGateway` 接线——flag `SATI_RULE_POLICY_BRIDGE_ENABLED`（默认关）开启时把 block 规则编译为 policy deny 规则并**前置**合并进 `PermissionContext.rules.deny`（`mergePolicyDenyRules`）；编译带 phase 语义门（默认排除 `post_execution` 输出面规则）；编译结果为空时组合根显式告警。当前资产保留 block 的 2 条均为 `post_execution`，故开启后编译结果为空——通道就绪，真正拦截需新增 `pre_execution` 关键词规则。决策见 `docs/notes/implemented/2026-09-11-policy-bridge-tool-guard-wiring.md`。
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
- **TD-RULE-N07** · `rules/README`「遗留」3 项规则资产语义增强无排期、无跟踪载体
  - 类别：D · 严重级：P2 · 工作量：S · 状态：**done（#394）**
  - 处置：3 项全部落成 `rules/patent/activation-overrides.yaml` 的**评审补丁**（不改转换生成的
    `nuo-*.yaml`）：① X-REF-003 补全/半角+大小写共 9 个漏报变体（`addKeywords` 3 组 OR）；
    ② EX-SEL-004 开 `negationContext` 并追加域放行词 `[防,反,抑制,检测]`；③ IPC-GEN-INV-002
    降 `log`（沿用 IPC-GEN-INV-001↔EX-INV-001 先例）。配套两处能力扩展：`ActivationRulePatch`
    新增 check 级增补键；`KeywordBlocklistCheck` 新增 `additionalNegationWords`（两键正交，
    缺开关告警）。
  - 核码更正：issue 称本批「不改 action 级别」——第 3 项去重**必然**改 action（否则同一文本
    恒有两条用户可见提示）；issue 称两项重复「可合并为一条（跨域共享）」——两条分处两个
    **生成**文件，删除会被下次 `port-nuo-rules.ts` 重新移植还原，故只能走补丁降级。
    另：`keyword_blocklist` 是**子串匹配且大小写敏感**，故小写 `202x` 也是漏报变体（issue 未提）。
  - 判据：`tests/rule/rule-asset-review-samples.spec.ts`（新增 23 例，样本表可执行化）+
    `tests/rule/patent-full-rule-set.spec.ts`（补丁数量 + 四类补丁告警）。负控制 16 组注入，
    15 组精确命中预测名单、1 组判为**无效负控制**（补丁 OR 组自包含 ⇒ "基础条目丢失"无可观测
    差异），矩阵与分类见决策记录。
  - 位置：`rules/patent/activation-overrides.yaml`、`src/rule/runtime/{RuleLoader,RuleEngine,patent-compliance}.ts`、
    `src/rule/protocol/types.ts`、`rules/README.md`
  - 副作用（口径变化）：patent-full 动作分布 `66 warn / 30 log` → `65 warn / 31 log`；补丁条目 29 → 31。

---

## 14. workflow（B3 ✅，2026-09-11 已收敛删除）

**模块已删除**：依 P6a 评估结论（`docs/workflow-convergence-eval.md`）执行 `docs/architecture-fix-plan.md` P6c 选项 (a)——`src/workflow/**`（11 文件，1760 行）与借用者 `src/patent/workflow-dag.ts` 整体删除，`tests/workflow/**` 与 `tests/patent/workflow-dag.spec.ts` 同步移除。

**删除依据**：引擎在 `src` / `ui` / `apps` / `scripts` **零生产调用方**（仅 `tests/` 覆盖）；唯一借用者 `src/patent/workflow-dag.ts` 的三个导出亦无生产消费者（仅 barrel 转出 + 测试），且其 `FlowGraph.validate()` 对 manifest 顺序链恒为空判定。专利域执行路径由 `src/patent/workflow.ts`（`runWorkflow`）与 `src/patent/graph/`（SuperStep，含 `manifestToGraph` 等价性测试）承接，计划层由 `flexible-plan` 承接。

**原子条目终态**：

| 债号 | 终态 |
|---|---|
| TD-WORKFLOW-N01 · 引擎整体未接线 | **done（删除）**——选项 (a) 落地 |
| TD-WORKFLOW-N02 · 失败 wave 不取消兄弟步骤 | **voided**——随模块删除消失 |
| TD-WORKFLOW-N03 · maxParallel worker 池无针对性测试 | **voided**——同上 |
| TD-WORKFLOW-N04 · `workflow_failed.error` 载荷错误 | done（2026-08-23 修复），随模块删除归档 |
| TD-WORKFLOW-N05 · 双份手写点路径解析器重复 | **voided**——同上 |
| TD-WORKFLOW-N06 · 非空断言与双强转 | **voided**——同上 |

`.brooks-lint.yaml` 的 R4 suppress 条目已移除（评估完成、重复模式消失）；`docs/architecture-fix-plan.md` 的 P6a/P6c 勾选，P6b 范围修正见评估报告 §七。

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

### 2026-09-11 处置追加（issue #152）

- **已完成**：`SkillManager.ts` 915 → 623 行——frontmatter 解析族抽为 `src/extension/skills/frontmatter.ts`，bundle 校验族（磁盘 + manifest 双路径）抽为 `src/extension/skills/validation.ts`（`MAX_*`/`RISKY_EXTS` 随之迁出，它们只被校验族使用），并补 6 条直测 `tests/extension/skills/skill-validation.spec.ts`（此前 validate/import 无专门 spec）。销 TD-EXTENSION-N01/N02 的主因。见 `docs/notes/implemented/2026-09-11-adapters-skill-split.md`。
- **保留机会型**：其余 6 个 800–1000 行工具文件（`patentPdfDownload` 953 / `readFile` 891 / `patentWorkflowRunTool` 818 / `kanban` 815 / `executeCode` 774 / `webSearch` 721）的拆分清单与最小步骤已由 issue #152 的调研给出，本 PR 未落地。
  - 优先级（风险低→高）：`webSearch`（721 行里 313 行是三个可独立 provider，且现仅 3 个用例——**先补 provider 解析测试**）→ `executeCode`（已有 `executeCodeRpc.ts` 抽取前例）→ `readFile` → `patentPdfDownload`（⚠️ `loadPdfLinkExtractJs:80-84` 用 `import.meta.url` 上溯定位 assets，跨目录深度抽取会**静默回退内嵌备份**，只能抽到同深度）→ `patentWorkflowRunTool`（先按 TD-PATENT-N07 抽共享 `buildRunContext` 消除双份真相）→ `kanban`（真债是 15 个工厂的脚手架重复，应先抽共享 helper 而非搬文件）。

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
  - 类别：C · 严重级：**P1** · 工作量：M · 状态：**done（已修复 2026-09-15，PR #380）**
  - 修复：在 `loadPilotConfig` 的各段解析外加兜底 `parseConfigSectionsSafely`——把逃逸的异常经 `configFailureDiagnostics` 转写成 fatal 诊断（未携带诊断的 `PilotConfigError` 按 code/message 转写；非 `PilotConfigError` 记 `CONFIG_UNEXPECTED_ERROR` + `logger.warn`）后再由 `throwConfigErrorIfFatal` 抛出，故对外 `code`/`message` 与兜底前逐字一致，只有 `error.diagnostics` 由空变为非空。不变量恢复为「有 fatal 诊断 ⇔ `error.diagnostics` 非空」，`getDiagnostics()` 不再丢失败原因。值校验器保持纯函数（未采纳「全部改 push」的更彻底方向，理由见决策记录）。新增 `tests/pilot/config/config-error-channel.spec.ts`（5 例：5 类裸 throw 的端到端 + reload→`getDiagnostics()` + 三种转写形态的单测），并做负控制（摘掉兜底后两条集成用例转红）。
  - 决策记录：`docs/notes/implemented/2026-09-15-pilot-config-error-channel.md`
  - 位置：`src/pilot/config/loadPilotConfig.ts`；`parseMemoryConfig.ts`
- **TD-PILOT-N01** · `loadPilotConfig.ts` ~784 行单函数编排 monolith
  - 类别：A · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/pilot/config/loadPilotConfig.ts:35-165` + 全文件 784 行
  - 建议：按子系统拆parse+assemble，或拆为 `parse`+`assemble` 两纯函数。
  - 进展（2026-09-15，随 TD-PILOT-N02 修复）：逐段解析已抽成 `parseConfigSections`（入参 `rawConfig`/`model`/`pilotHome`/`diagnostics`，返回 `PilotConfigSections`），`loadPilotConfig` 只保留源读取/校验/快照装配。**未收口**：`parseConfigSections` 仍是约 40 行的顺序编排，`RuntimeDeps` 式依赖注入与 parse/assemble 纯函数化尚未做。
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
  - 类别：A · 严重级：P1 · 工作量：L · 状态：**done（2026-09-18，PR #457）**
  - 位置：`ui/src/components/chat/hooks/useChatComposerState.ts:179`
  - 影响：一个 hook 承担草稿持久化/斜杠命令/文件提及/附件上传/拖拽/忙碌队列/会话生命周期/思维模式编排。建议：拆 `useComposerInput`/`useAttachmentUpload`/`useSlashCommandExecute`/`useSessionSubmit`。证据：`:810-1107`（handleSubmit 单回调 ~300 行）、`:364-549`（handleBuiltInCommand 9+ 分支 switch）。
  - **口径更正**：1430 是 **hook 本体的函数跨度**，文件本身 **1837 行**（11 useState / 14 useRef / 15 effect / 29 useCallback / 0 useMemo）；消费者只有 `ChatInterfaceV2:260` 一处。
  - **2026-09-18 处置（PR #457，六次提交）**：拆成六层——`useSlashCommandExecute`(410) / `useAttachmentUpload`(172) / `useComposerInput`(247) / `useSessionPermissions`(303) / `useSessionSubmit`(705) / `useComposerDraft`(131)，另有共享的 `composerSubmit`(16)。**父 hook 1837 → 558 行（−70%）**，其 god function **1608 → 467（−71%）**。
  - **三条关键判断**：① 有环的缝先绕开（缝 1 用 ref 后绑定解开"附件层要通知忙碌队列快照、而快照又要读附件状态"的环；缝 3/4b 改用"状态在父级、逻辑在 hook"——`input`/refs/排队状态都是更早或更晚层的入参）；② **effect 相对顺序有语义**：缝 3 的 autosize effect 留在父级、缝 4a 的调用点就选在 effect 原处（顺序零变化）、缝 4b 把"回填 ref + flush"整对一起搬（内部顺序不变）、缝 4c 独立成层也是为这一条；③ 代价写清楚（一处后绑定 + 若干"身份稳定、仅为满足 exhaustive-deps"的依赖项；缝 4b 唯一变化的相邻顺序是 ref 回填/flush 排到了 `inputValueRef` 同步之前，而 flush 读的是排队快照）。
  - **验证**：六个证明脚本共 **59 项逐 token 比对**（基线 `f3ab6678`，非 HEAD——分批提交会让基线漂移），三处改写做了精确重建校验；补 **41 条**测试（斜杠 3 / 附件 5+1 / 输入 10 / 权限 14 / 草稿 2，另复跑既有 3 条）；**10 处负控制**，其中"只改文案"与"只改 className"两次是守卫红而用例全绿——守卫与测试覆盖不同失效面。浏览器验证在真实本地栈做（桌面 1440×900 + 移动 390×844 + `main`↔分支 **A/B 行为等价**，见 PR #457 评论）；截图在本环境不可得（CDP captureScreenshot 超时），真实发送消息有意未验证（会在本机真实项目跑 agent）。
  - 决策见 `docs/notes/implemented/2026-09-18-composer-hook-split.md`。
- **TD-UI-CHAT-N02** · `useChatSessionState` God hook + 恒为 false 的死状态 `isLoadingMoreMessages`
  - 类别：A/F · 严重级：P2 · 工作量：L（**死状态半为 S，已完成**）· 状态：**in_progress（死状态半 done，拆分半留待 L 级窗口）**
  - 位置：`useChatSessionState.ts:236`（hook）、`:251`（死状态）
  - 影响：`isLoadingMoreMessages` 从未被 setter 赋值、恒 false，却被透传门控「加载更多」UI。建议：删除该死状态（`isLoadingMoreRef` 已是真实信号），分页/滚动定位抽出独立 hook。
  - **2026-09-18 处置（死状态半 · PR #440）**：✅ 死状态已删，并顺带清掉它造成的两处**不可达**代码——① `MessagesPaneV2.tsx` 的「Loading older messages...」指示器（条件含该状态 ⇒ **从未渲染过**，该文案在 UI 里从未出现）；② `useChatSessionState.ts` 的「Load all」遮罩 effect 里 `if (wasLoading && !isLoadingMoreMessages && hasMoreMessages)` 分支（`wasLoading` 正取自这个恒 false 的值 ⇒ 从未执行；遮罩置位另有 `loadAllMessages()` 与完成态 effect 两条真实路径）。存活条件 `hasMoreMessages && !isLoadingMoreMessages && !allMessagesLoaded` 做等价化简（`X && !false ≡ X`）。改动面 4 文件 +10/−33，**零行为变化**且论证是**静态**的（该状态无 setter ⇒ 恒 false），配两条针对存活条件的回归用例，负控制已验（注入恒假 ⇒ 用例 1 红、用例 2 绿）。**再次核实口径**：该状态的实际触及面比本条原记的更大（4 处守卫 + 2 处 deps + 返回对象 + 1 处 effect 迁移判断）。决策见 `docs/notes/implemented/2026-09-18-ui-god-hook-unblock.md`。
  - **2026-09-20 收官（拆分半 · PR #466）**：分页与滚动定位外置为两个 hook —— `hooks/use-chat-pagination-scroll.ts`（落地当时文件 392 行：分页 state + 12 个滚动 ref + 10 个回调 + E1–E5）与 `hooks/use-chat-scroll-anchor.ts`（87 行：E12–E14，零 state/ref）。**主 hook 914 → 708 行**（文件 1159 → 928）。
    **为何是两个而非一个**：E5（首屏落底）须排在会话加载/搜索定位 effect **之前**（读 `searchScrollActiveRef`），E13（跟随/高度补偿）须排在**之后**（同一提交里那个 effect 先置位）——单 hook 的 effect 整体插入无法表达这种夹逼，故分两段、两个调用点。改前 17 条 effect 与改后展开顺序**索引一一对应**（实测）。
    **单一真源**：消息数组/会话身份/`buildFetchParams`/`sessionStore`/`searchScrollActiveRef` 仍归主 hook，子 hook 不各自 `useState` 一份（那是 `useSessionStore` 那条"多份 store ⇒ 28 方法静默失效"教训的翻版）。
    **对外 API 零变化**：返回对象 **39 键、键序逐项一致**（独立复核）；`MESSAGES_PER_PAGE`/`isScrollNearBottom`/`resolveConversationScrollTop`/`ScrollRestoreState` 迁出后主文件保留同路径 re-export，既有导入不动。
    **验证**：新增 15 条黑盒用例（拆分前写、拆分后零改动仍全绿——含"加载更多后阅读位置不变"与"接近底部自动跟随"）；5 处负控制（高度补偿、阈值翻转、`hasMore` 条件、跟随忽略上滑态、加载锁提前 return）；逐 token 21 段 matched 1907/unmatched 0、原文件补集 21 段按序逐字节 0 missing；依赖数组追加 13 个标识符（10 `useRef` + 4 `useState` setter + 1 `useCallback([])`，逐个复核为恒稳定 ⇒ 重跑时机不变）。
    **剩余（如实登记，不阻塞关闭）**：主 hook 708 行**仍是 god function**（阈值 300）；剩余可拆的是会话加载 / 搜索定位 / token 统计三族，均需双视口浏览器验证（本环境 CDP 截图超时），建议另立条目。另有两处**既有**行为疑点未动（E5 `pendingInitialScrollRef` 的消费时机；已排队的 rAF 跟随帧不因上滑取消），亦建议另开条目。决策见 `docs/notes/implemented/2026-09-20-chat-session-state-pagination-scroll.md`。
  - **2026-09-20 遗留处置（两处时序疑点 · PR #469）**：✅ issue #468 登记的两处**既有**疑点均已修复并各带一条可自动化判据——① 首屏落底的 `pendingInitialScrollRef` 改为「无内容可滚时保留，消息到达再落一次」，不再在消息为空时被静默消费；② 已排队的 rAF 跟随帧在回调内重检上滑态**实时副本**（唯一写入口 `trackUserScrolledUp`，与 state 同源），用户上滑即撤销本次跟随。判据 `useChatSessionState.scroll-follow-timing.spec.ts` 两条用例（jsdom + 只接管 rAF 的 fake timers，不依赖真实浏览器），修复前分别红在「消息到达后视口必须到底」与 `expected 1000 to be 100`；既有 15 条黑盒用例零回归，UI 全量 138 文件/931 用例绿，`pnpm check` 绿（含指标基线刷新）。**仍未还**：主 hook 708 行、拆出的 `useChatPaginationScroll` 自身 326 行（god 阈值 300；函数体口径，文件 410 行，轨迹 #466 392 → #469 403 → #470 410），三族拆分仍待 issue #467。决策见 `docs/notes/implemented/2026-09-20-chat-scroll-follow-timing.md`。
- **TD-UI-CHAT-N03** · `MessagesPaneV2` 巨型组件 + 手写消息虚拟化
  - 类别：A/I · 严重级：P1 · 工作量：L · 状态：**done（2026-09-18，PR #458）**
  - 位置：`ui/src/components/chat-v2/MessagesPaneV2.tsx:314`（文件 1252 行）
  - 影响：同时承担虚拟滚动/进程分组/子代理详情/fork/搜索/可展开行渲染；虚拟化全手写（估算高度 + ResizeObserver + 多条 RAF/前缀和缓存）。建议：窗口计算/高度测量抽独立 hook，拆 LiveProcess/Subagent/Fork 子组件。
  - **口径更正**：「文件 1252 行」与实测不符（立案日已 1375，动手前 1547）；且条目设想的三个子组件**已经是模块级组件**（`ProcessLiveStatus`/`LiveProcessHeader`/`CompletedProcessHeader`/`SubagentDetailModal`），pane 里只剩转发壳。
  - **2026-09-18 处置（PR #458，两次提交）**：① **虚拟化层** → `chat-v2/messageVirtualization.tsx`（378 行：纯函数与类型 + `MeasuredMessageItem` + `useMessageVirtualization`，含测量表/RAF 句柄/高度版本/滚动视口、六个派生值、两个回调、三个 effect）；② **占位视图** → `chat-v2/MessagesPanePlaceholder.tsx`（181 行：五分支 JSX 逐字搬入，分支条件抽成纯函数 `resolveMessagesPanePlaceholder`）。**pane 1547 → 1183 行**，god function **1023 → 824**。
  - **顺序论证**：三个虚拟化 effect 原本就在 pane 内部 595–840 这一段、彼此相邻，而该区间内没有其他 effect ⇒ 搬进 hook 后相互顺序**完全不变**（与 N01 缝 3 相反，那次有别的 effect 夹在中间，故选择留在父级）。
  - **验证**：两个脚本共 **33 项逐 token 比对**（N03a 27 项、N03b 6 项，基线分别为 `c4ae3660` 与 `ac8592d2`——不用 HEAD，分批提交会让基线漂移）；补 **17 条**测试（虚拟化运行时 6、占位优先级 6、占位渲染 5）；**负控制 3 处**，其中一处首次抓到**守卫自身的弱点**（顺序检查只验存在、不验先后），已按"分支标记"补强。取证踩到两个 TS 细节：嵌套三元在 JSX 里是恢复节点（`elseExpression` 缺失）、`IfStatement` 的条件在 `expression` 字段。
  - **未做（记入下一项前置条件）**：`renderMessageItem`（147 行）未抽——它需要约 30 个 pane 值，属"渲染上下文转发"而非职责叠加；要改善得先收敛 `MessageRowV2` 的 props 面。决策见 `docs/notes/implemented/2026-09-18-message-pane-extraction.md`。
- **TD-UI-CHAT-N04** · `MessageComponent` 巨型单消息渲染器（812 行）
  - 类别：A · 严重级：P2 · 工作量：L · 状态：**done（2026-09-18，PR #444 + #445）**
  - 位置：`ui/src/components/chat/view/subcomponents/MessageComponent.tsx:158`
  - 影响：同时渲染 user/assistant/tool/error/thinking/interactive/system 及工具结果/权限/审批/图片/markdown 多形态，props 达 13 个。建议：按消息类型拆 `MessageBubble`/`ToolResultBlock`/`PermissionBlock`。
  - **口径更正**：812 是**组件函数跨度**不是文件大小（立案时文件已 969 行）。真正的"多形态"集中在**工具结果块**（原 `:478-751`，约 270 行，占全文件 28%）：网页搜索未配置 / 通用 `setup_required` / 无权限建议的普通错误 / 权限错误（含"为本会话授予"+ 设置入口 + 待确认态）/ 非错误态交给 `ToolRenderer`。
  - **2026-09-18 处置（工具结果块 · PR #444）**：抽出 `view/subcomponents/ToolResultBlock.tsx`（含它专用的 `permissionGrantState` 状态与复位 effect、三个错误判定 helper），`stringifyMessageContent` 上移到 `chat/utils/messageContent.ts` 供父子共用。文件 **969 → 662 行**（−307），god function 794 → **528**（−266）。
  - **等价性证明**：parser 驱动逐 token 比对 9 项（`/tmp/n04-move-proof.mjs`）——三个 helper（36/86/36 tokens）、`stringifyMessageContent`（67）、权限复位 effect（11）、**工具结果三元两整支 JSX（1203 tokens）**、两条声明；外加"旧位置已消失 + 新位置已出现"的双向反证。JSX 的 `JsxText`（缩进/换行）按 JSX 语义当 trivia，其余 token 逐字符。负控制：① 只改一处 `className` ⇒ 守卫报 `DIFF` 而 6 条既有用例**全绿**（正是守卫存在的理由：视觉级改动测试抓不到）；② 翻转 `if (!permissionSuggestion)` ⇒ 守卫报 `DIFF` 且 6 条用例中 **5 条**变红（另一条属网页搜索分支）。
  - **2026-09-18 收尾（消息类型分支可达性审计 · PR #445）**：先做审计再决策——**只有一支是活的**。三段证据：① `MessageComponent` 全仓唯一挂载点是 `MessageRowV2:265` 的 `if (delegate)` 分支；② `shouldDelegate` 只对 `isToolUse`/`isInteractivePrompt`/`isTaskNotification` 或 `type ∉ {user, assistant, error}` 委托；③ 生产端 `useChatMessages` 的 `case "text"`(user) 与 `case "thinking"` 都不带三标志。故 **user 气泡与 thinking 分支够不着**（运行时探针佐证：user 消息由 v2 原生路径渲染，附件/图片照常；thinking 被折进折叠的进程行）。
    处置：交互提示拆成 `InteractivePromptBlock.tsx`（100 行，412 tokens 逐字搬迁）；user 气泡（~70 行）与 thinking 分支（~26 行）**删除**，连同只喂 user 气泡的 5 个派生值、2 个附件辅助函数与 `attachmentToDocumentReference`；根节点那处 `message.type === "user" ? …` 三元做等价化简。文件 **662 → 409 行**（相对立案的 969 行是 −560），god function **528 → 335**。
    验证：永久用例钉住三类消息的分流（并入 `MessagesPaneV2.render.test.tsx`），**负控制**把 `shouldDelegate` 的门放宽 ⇒ 用例立刻变红（legacy 路径不渲染附件）⇒ 还原全绿。决策见 `docs/notes/implemented/2026-09-18-message-type-branch-audit.md`。
  - **剩余（可选）**：13 个 props 的收窄。**两条本轮明确不做的观察**：① `shouldHideThinkingMessage`（`message.isThinking && !showThinking` 的早退）如今守卫的是"不可能输入"，但删守卫与删渲染分支风险不等价，留待后续；② `taskNotification` 支的正文同样不在可见行里（被 `processGrouping` 折叠）——"折叠"与"不委托"是两种不可达，需各自补证据，故未在本轮断言。
- **TD-UI-CHAT-N15** · `DiffLine` 在聊天栈里有 7 份本地副本，而 `chat/utils/messageTransforms.ts` 已有权威定义
  - 类别：F · 严重级：P3 · 工作量：S · 状态：**done（2026-09-20，PR #463）**
  - 位置（立案时）：`chat/view/subcomponents/MessageComponent.tsx:32`、`chat/tools/ToolRenderer.tsx:21`、`chat/tools/components/ToolDiffViewer.tsx:3`、`chat-v2/MessagesPaneV2.tsx:49`、`chat-v2/MessageRowV2.tsx:33`、`chat-v2/SubagentDetailModal.tsx:9`、`chat-v2/SubagentDetailMessageFlow.tsx:22`
  - 影响：7 份副本的形状都是 `{ type: string; content: string; lineNum: number }`，而权威版（`messageTransforms.ts:1`）把 `type` 收窄为 `"added" | "removed"`。于是"同一份 diff 数据结构"在链路上有两种类型，谁都不敢先收紧——`createDiff` 的契约因此长期停留在 `string`。
  - **处置（2026-09-20）**：**没有**按本条目的建议把权威类型放宽为 `string`——那个建议基于"收紧会外溢"的假设，实测该假设不成立。逐项验证后保留权威窄类型：① `calculateDiff` 的三个 `push` 点产出的 `type` 全是字面量（运行时值域本就等于窄类型）；② 全仓消费 `.type` 的只有 `ToolDiffViewer.tsx`（`added`/`removed` 两分支）；③ 真正的外溢面只有 `ToolResultBlock` 的 `createDiff` 内联匿名结构，随本波一并改为 `DiffCalculator`。
    落地：7 处本地 `type DiffLine` 删除并改为 `import type { DiffLine } from "…/chat/utils/messageTransforms"`，`ToolResultBlock.tsx:60` 的内联 `Array<{ type: string; … }>` 改为 `DiffCalculator`（连同"不复用权威类型"的注释一并改写）。净删 7 份重复声明。
  - **验证**：`ui` typecheck 通过（证明窄类型未破坏任何调用点——若真有 `type: string` 的构造点，这里会编译失败）；`cd ui && pnpm test` 127 文件 / 830 用例全绿（含 4 个传 `createDiff` 的测试文件）。改动仅类型面，无运行时 diff。
  - **口径更正**：副本数是 **7 + 1**（7 处具名 `type DiffLine` + `ToolResultBlock.tsx:60` 的内联匿名结构，后者立案时未记）；刷新后各行号见上一行"位置（立案时）"已作废，实际位置随本波改动已删除。**发现于 #159 N04**（`ToolResultBlock` 当时特意没有复用权威类型，正是因为这次收窄会外溢——该判断在 2026-09-20 被证伪）。
- **TD-UI-CHAT-N05** · chat 与 chat-v2 子代理渲染重复实现
  - 类别：F · 严重级：P2 · 工作量：S · 状态：**done（2026-09-18，PR #442）**
  - 位置：`chat-v2/SubagentCard.tsx:27` vs `chat/tools/components/SubagentContainer.tsx:63`（后者已删）
  - **口径更正**：不再是「两套都在跑的重复实现」，而是**一个活体 + 一个够不着的**。`SubagentContainer` 的唯一入口是 `ToolRenderer` 的 `if (isSubagentContainer && subagentState)` 分支，而容器消息到它之前已被四道机制截住：`MessageRowV2:247` 早退渲染 `SubagentCard`、`MessageRowV2:97`（`shouldDelegate` 里 `isSubagentContainer → false`）、`SubagentDetailMessageFlow:135` 主动清标志、`useSubagentMessages:33` 清无 `subagentId` 的容器。`ToolRenderer` 全仓只有 `MessageComponent` 两个调用点，`MessageComponent` 全仓只有 `MessageRowV2:265` 的 `delegate` 分支一个挂载点 ⇒ 该链第一环即被双重否定。这也解释了它为何零测试覆盖（全仓测试 grep 零命中）。
  - **处置**：删掉不可达实现（219 行组件 + 其导出 + `ToolRenderer` 容器分支 + 两个透传 prop + 随之无用的两份类型导入），存活实现即 `SubagentCard`，「统一为单一实现」以「只剩一个」达成。改动 5 文件 +35/−248。决策与备选见 `docs/notes/implemented/2026-09-18-subagent-renderer-dedup.md`。
  - **验证**：删除前先跑新用例——容器消息确实渲染卡片，`SubagentContainer` 三处独有文案（`View tool history`/`Running subagent`/`Currently:`）在 DOM 里一次不出现；负控制把门 1+门 2 注入成恒假 ⇒ 用例变红，还原后全绿。
- **TD-UI-CHAT-N06** · 工具配置/渲染器大量 `any`，违反 strict/no-any 规范
  - 类别：B · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`chat/tools/configs/toolConfigs.ts:1,19-55,646-783`；`chat/tools/ToolRenderer.tsx:108-109`
  - 影响：工具协议契约以 `any` 表达，改 inputSchema/结果结构无编译期守护。建议：引入结构化联合类型，逐步以 `unknown`+收窄替换 `any`。
- **TD-UI-CHAT-N07** · `PdfDocumentPreview` 巨型组件（1138 行）
  - 类别：A · 严重级：P2 · 工作量：L · 状态：**done（2026-09-20，PR #465）**
  - 位置：`code-editor/view/subcomponents/PdfDocumentPreview.tsx:723`
  - 影响：约 20 个 useState + 12 useRef，承担 PDF 加载/缩放/旋转/导航/搜索/区域选择/大纲/缩略图。建议：抽 `usePdfViewerState`，缩略图/大纲/搜索拆独立组件。
  - **口径更正**：1138 是**主组件的函数跨度**，文件本身 **1885 行**（metrics 记主组件 1130）。模块级已经分过一轮（7 个小组件 ~450 行），真正堆在主函数里的是：加载/视口持久化 ~150、滚动跟踪 ~120、搜索 ~75、选区→引用 ~235、JSX ~380（工具条 230 / 侧栏 87 / 视口 67）。
  - **2026-09-18 处置（逻辑半边 · PR #443）**：① 纯函数 → `utils/pdfViewport.ts`（视口数学 + `PageSize`/`ZoomMode`/`Rotation` 类型）；② 文本选区取文 → `utils/pdfTextSelection.ts`；③ `resolveSearchStatus` 移入既有 `utils/pdfSearch.ts`；④ 搜索状态机 → `hooks/usePdfSearch.ts`（6 state + 请求序号 + 竞态）。两个新模块**此前零测试**，本轮补 22 条直接单测（+ `resolveSearchStatus` 4 条分支）。文件 1886 → 1724（metrics 口径），主组件 1130 → **1064**。
  - **等价性证明**：parser 驱动逐 token 比对 **21 段搬迁**（`/tmp/n07-move-proof.mjs`）——19 段逐字相同；唯一预期改写是 `goToSearchResult` 的两行写操作 → 一次 `forceRenderPage(pageNumber)` 调用，脚本把两条语句摘除并插入调用后要求逐 token 相等，另断言组件里 `forceRenderPage` 的函数体与被摘掉的语句逐字相同；其余任何 token 差异即判失败。负控制两处（`parsePageInput` 夹取上限 `+1`、`runSearch` 的 `!==`→`===`）⇒ 守卫报红，且分别由 `pdfViewport.spec.ts`（2 条）与既有搜索竞态用例报红。
  - **剩余（需 L 级窗口）**：选区→引用块（~235 行，唯一必须浏览器验证的一块）、工具条/侧栏 JSX 拆分（~317 行，需先收窄 props 面）、按粘连度切分的 `usePdfViewerState`（加载/视口持久化、滚动跟踪各成一块）。**注意**：本轮只降了 66 行 god function——被搬走的 110 行纯函数本来就在模块级、不计入函数长度，故剩余三块才是压 1064 的主力。决策见 `docs/notes/implemented/2026-09-18-pdf-viewer-extraction.md`。
  - **2026-09-20 收官（剩余三块 · PR #465）**：拆到 `code-editor/view/pdf/`（14 文件：`hooks/use-pdf-{viewport,scroll-tracking,selection-reference,toolbar-controller}.ts` + `components/{PdfPage,PdfThumbnail,PdfOutlineTree,PdfNavigationSidebar,PdfToolbar,ToolbarPrimitives,pdf-toolbar-icon}.tsx` + `pdf-{constants,types,render-support}.ts`），**主组件 1064 → 260 行**（文件 1723 → 305），未到计划估的 ≈200（差额是 hook 分组选项与侧栏 props 接线；再压会把状态搬进 hook 内部并与 `usePdfSearch` 成环，按纯搬迁优先停在 260）。
    **顺序不变式**（本轮头号风险）：计划判断"jsdom 抓不到"，**实测可抓**——把 5 个同步 effect 与加载 effect 同住 `usePdfViewport` 内按原始顺序声明，另加两路证据：① 运行时顺序断言（effect 打点）；② 把"当前页变化 + 同文件重载"压进同一次 commit 后断言加载 effect 读到的快照值。负控制 NC1（把加载 effect 提到字段同步之前）⇒ 两路各自报红（`expected '1' to be '3'`＝晚一帧恢复出上一个页码）。
    等价性：65 个区间逐 token 相同，源覆盖 9907/9981、未解释丢失 0；**脚本抓到真回归**——首轮漏搬 `pdfjs.GlobalWorkerOptions.workerSrc` 与 `pdf_viewer.css`（worker + textLayer 样式），已补回。新增 23 条测试（2 → 25）；5 处负控制，其中 NC5 诚实记负（侧栏 `navigationMode !== "none"` 守卫在当前实现下不可观测，属既有等价冗余，未假装抓住）。**依赖数组追加 49 处（22 标识符）**是唯一非逐字改动：起因 eslint `exhaustive-deps` 对 props 传入的 ref/setter 判缺失，已独立复核 22 个全部是 `useRef` 结果或 `useState` setter（恒等 ⇒ 重跑条件不变）。未做双视口浏览器验证（CDP 截图超时），无 A/B DOM 指纹。决策见 `docs/notes/implemented/2026-09-20-pdf-preview-remaining-extraction.md`。
- **TD-UI-CHAT-N08** · `CodeEditorBinaryFile` 巨型文件（1510 行）；~~内联 8 hooks 分派器~~
  - 类别：A · 严重级：P3 · 工作量：M · 状态：**done（2026-09-20，PR #464）**
  - 位置（立案时）：`code-editor/view/subcomponents/CodeEditorBinaryFile.tsx:1386`（主组件起点；文件 1510 行）
  - **口径更正（2026-09-20）**：标题里的「内联 8 hooks 分派器」**不成立**——9 个 hook 早已是具名顶层函数，真正的分派器 `OfficeFilePreviewRouter` 只有 89 行，文件里也没有 god function（最长函数 `SpreadsheetPreview` 225 行，god 阈值 300）。成本是纯**文件级**的：改任一预览形态都要读 1510 行。位置应以主组件起点 `:1374` 为准（立案写 `:1386` 指到了 `CodeEditorBinaryFile` 函数体内）。
  - **处置**：按内聚拆到 `code-editor/view/binary-file/`（types / utils / hooks 9 个 / components 13 个），主文件 **1510 → 146 行**，路径与 `export default` 不变。硬约束：`lazy(() => import(...))` 保持动态导入（chunk 切分不变，体积不在门禁内故必须人工守住）。等价性：AST token 比对 35/35 逐 token 相同、0 凭空新增；5 处负控制各自只打红目标用例；新增 5 文件 22 条用例打三类取消语义盲区。决策见 `docs/notes/implemented/2026-09-20-code-editor-binary-file-split.md`。
- **TD-UI-CHAT-N09** · 跨 hook 共享可变 ref（`pendingViewSessionRef`）协调会话时序
  - 类别：D · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`chat-v2/ChatInterfaceV2.tsx:180,258` 透传三个 hook
  - 影响：乐观气泡/会话创建/竞态规避依赖跨 hook 共享可变 ref + 大量时序不变式注释，脆弱难推理。建议：收敛为单一 owner 的会话创建状态机。
- **TD-UI-CHAT-N10** · 巨型组件测试覆盖薄弱，错误可观测依赖裸 console
  - 类别：E/C · 严重级：P3 · 工作量：M · 状态：new
  - 位置：`MessageComponent.tsx`（仅 2 测）、`MessagesPaneV2.tsx`（仅 render.test）、`PdfDocumentPreview.tsx`/`CodeEditorBinaryFile.tsx`（各 1 测）
  - 建议：补虚拟化窗口/审批/工具错误行为测试，引入结构化错误上报。

> **2026-08-27 复扫新增（N11–N14）**：

- **TD-UI-CHAT-N11** · `processGrouping.ts` 成为未登记的 1295 行聊天管线杂物抽屉
  - 类别：A/D · 严重级：P2 · 工作量：M · 状态：new · 意图：[accidental]
  - Pain×Spread：2×2=4
  - 位置：`ui/src/components/chat-v2/processGrouping.ts:690-875`（`buildRenderableMessageItems` ~186 行：嵌套循环+单调游标+三路合并+"fuse"兜底分支）；`:1063-1149`（`formatCompletedProcessTitle`）；`:1009-1046`
  - 影响：单文件混装 turn 分段算法、tool 判定、时长换算、i18n 标题格式化、web-fetch UI 策略、trace 映射共 26 个函数；web-fetch 特例烤进通用分组管线，迫使 MessagesPaneV2/MessageRowV2/SubagentDetailMessageFlow 全量引用。每新增消息形态/运行模式都改这一个文件。
  - 建议：拆 `turnSegmentation.ts` / `toolPredicates.ts` / `processTitles.ts` / `webFetchPolicy.ts`，对外导出面不变。为 TD-UI-CHAT-N03 的姊妹条目。
- **TD-UI-CHAT-N12** · `ComposerV2.tsx` 基线后无登记增长 782→1061 行（+36%）
  - 类别：A · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`ui/src/components/chat-v2/ComposerV2.tsx`
  - 影响：聊天两大热入口之一在基线（807→未入账）后四天吸收新功能，下一次 #159 拆分排期时成本已复利。
  - 建议：按 attachment/draft 镜像 TD-UI-CHAT-N01 的拆分计划提前落钩子；先加行数守卫防止继续膨胀。
- **TD-UI-CHAT-N13** · `useChatRealtimeHandlers.ts` 基线后无登记增长 693→973 行（+40%）
  - 类别：A · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`ui/src/components/chat/hooks/useChatRealtimeHandlers.ts`（内含 598 行匿名回调上帝函数）
  - 影响：同上，实时事件处理热路径持续增重，事件分支数量随 gateway 新帧类型线性生长。
  - 建议：按事件族拆 per-event 模块（stream/subagent/fork/approval），入口只做路由表分发。
- **TD-UI-CHAT-N14** · kanban 年轻模块卫生债三合一（乐观变更协议 ×15 复制 + 直连 i18n 单例 + 网关载荷裸 `as`）
  - 类别：D/F/B · 严重级：P2 · 工作量：S·M · 状态：new · 意图：[accidental]（新功能窗口期便宜修）
  - Pain×Spread：2×1=2（Spread 低但增长快，宜窗口期内收敛）
  - 位置：`ui/src/components/kanban/hooks/useBoardState.ts:155-173,175-197,199-221,223-241,290-308,357-382`（六个 mutation 各自复制「快照→optimistic setBoard→guard→rollback+refresh」）；`:2,12`（hook 内直连 `i18n/config` 单例格式化错误串，绕过 React 语言响应式）；`:39,120,142,251,318`（API 结果裸 `result as BoardState` 强转，网关 schema 变更即渲染层 undefined bug）
  - 建议：(a) 折叠为 `withOptimisticCards(mutate, apiCall)` + `requireProject()` 使回滚结构上必然；(b) mutation 结果返回稳定 i18n key 由视图层翻译；(c) 在唯一 `refresh()` 入口加一个廉价结构校验器（或 zod-lite）。

---

## 25. ui/src · app-shell/面板/stores（B5 ✅）

**模块概况**：UI 壳层与状态层。`app-shell/`（SidebarV2/AppShellV2）、`main-content(-v2)/`、`stores/useSessionStore.ts`（会话消息单例）、`hooks/useProjectsState.ts`、`contexts/`、i18n。集中 UI 最大体积与 i18n 违规痛点。

- **TD-UI-APP-N01** · `SkillsV2.tsx` 全仓最大组件且内嵌 854 行 `ImportFromFolder`
  - 类别：A · 严重级：P1 · 工作量：L · 状态：**done（已修复 2026-09-19，PR #460）**
  - 修复：三次提交分片落地。①`ImportFromFolder` + `ValidationPanel`（853 行）搬出 `SkillsV2.tsx` → `skills/import/ImportFromFolder.tsx`，面板与子组件共用件落 `skills/shared/{types,api,format,Field,ScopeSelector}`（`SkillsV2.tsx` 2525 → 1440 行）；②`parseFrontmatterFields`/`stripRootPrefix` → `skills/import/frontmatter.ts` + 9 条直测；③183 行批量卡片 JSX → `skills/import/BatchImportPanel.tsx`（15 个受控 props，`scope`/`force` 仍归父级，避免两份真源）+ 4 条批量链路测试。`ImportFromFolder.tsx` 1002 → 824 行，god function **852 → 688**。证明：切片 A 19 项 + B-1 4 项（含整文件差集 6202 tokens）+ B-2 6 项（整文件差集 5167 tokens + 15 个 prop 接线断言），基线取**上一个提交**而非 HEAD；负控制 6 处。**顺带修掉覆盖面事实**：整条导入链路此前零测试（切片 A 负控制里把 `/api/skills/validate` 改成错误端点，全量 850 条用例仍全绿），现补 13 条（850 → 863）。双视口浏览器 A/B 指纹逐字节相同（1280×800 与 390×844，真实 95 个技能目录）。决策记录 `docs/notes/implemented/2026-09-19-skills-import-feature-folder.md`。
  - 位置：`main-content-v2/SkillsV2.tsx:120`（主组件）、`skills/import/ImportFromFolder.tsx`（原 `:1414-2268`）
  - 影响（立案时）：单文件 2503 行；`ImportFromFolder` 一个函数 ~40 state/effect + 两套几乎相同的模型/校验 fetch 逻辑。建议：按 `skills/import/` feature-folder 拆出（picked/typed/batch 三模式）。
  - 剩余（新开条目追踪）：`ImportFromFolder.tsx` 仍有 824 行（picked/typed 两模式 + 校验面板 + 提交逻辑），god function 688 行。
- **TD-UI-APP-N02** · `useSessionStore.ts` 主闭包 727 行且**零覆盖**；~~流式/子代理族高度重复~~
  - 类别：A · 严重级：P2 · 工作量：M · 状态：**done（2026-09-20，PR #465）**
  - 位置（立案时）：`stores/useSessionStore.ts:632` —— **指错**：`:632` 落在模块级 `createRafNotifyScheduler` 附近，条目真正要说的是 `:677-1403` 的 `export function useSessionStore()` 主闭包。
  - **口径更正（2026-09-20）**：立案时的两条主张「`updateStreaming` 等 8 个近同函数」与「三处重复拼接 `URLSearchParams`」**已在 2026-09-02（PR #241）修掉**，条目从未回填。本波处理的真问题是**主闭包 727 行 + 零覆盖**（模块级纯函数区当时已有 24 条直测，主闭包一条没有）。
  - **处置**：方案 B —— 33 个 `useCallback` 整体外化到模块级工厂 `createSessionActions(deps)`（634 行、**体内零 hook**），主闭包 **727 → 20 行**（3 × `useRef` + 1 × `useState` + 1 × `useMemo([setTick])`）。**未拆子 hook**：per-session store 是 `useRef(new Map())` 单例，拆子 hook 会各自新建一份 ⇒ 28 个方法静默失效（负控制：改成共享键 ⇒ 18/18 用例全红）。等价性论证见下，逐 token 证明 34/34。
    为何"单次构造"等价：原 33 个 `useCallback` 的依赖数组全是彼此（`[getSlot, notify]` / `[notify]` / `[]`），链收敛到 `[]` ⇒ 原本就是永久稳定引用；`useMemo` 依赖的 `setTick` 是 `useState` setter（恒等）。两边都"永不重建"。
  - **验证**：新增 18 条 `renderHook(useSessionStore)`（主闭包从零覆盖到有网，含 per-session 隔离、水位剪除、流式合并、仅活跃会话重渲染）；4 处负控制（含 `:1176-1179` 的 patch-before-mutate 顺序不变式，翻转后唯一 1 条红）；逐 token 等价性 34/34，hook 创建顺序与 return 键序不变；`as unknown as` 未增加。决策见 `docs/notes/implemented/2026-09-20-session-store-actions-extraction.md`。
- **TD-UI-APP-N03** · `AppShellV2` 删除确认弹窗整段硬编码英文，未走 i18n
  - 类别：H · 严重级：P1 · 工作量：S · 状态：**done（已修复 2026-08-23）**
  - 修复：两个删除弹窗全部文案改为 `useTranslation("common")` 的 `t()`，新增 `deleteDialogs.*`（含复数 `_one/_other` 的 `projectSessionsRemovedCount` 与 `projectFilesOnDisk*` 三段拆分保留内联强调）。父组件错误文案（errorDeleteProject/errorDeleteSession）一并提取，`useCallback` 依赖补 `t`。新增 `app-shell/deleteDialogs.i18n.test.ts` 断言 en/zh-CN 的 key 解析与 `{{count}}`/`{{projectName}}` 插值。en/zh-CN common.json key 对齐（428/428）；ui typecheck/lint/biome/全量测试 578 通过。
  - 位置：`app-shell/AppShellV2.tsx:770-839`（DeleteProjectDialog）、`:848-908`（DeleteSessionDialog）
  - 影响：用户可见文案（"Delete project?"/"Cancel"等）全部硬编码，违反「UI 文案必须提取到 locales」铁律。建议：改用 `useTranslation()` 并补 common/settings key。
  - 2026-08-27 复核补充：i18n 修复后两弹窗的「错误框+底栏+取消/危险确认按钮」JSX 脚手架仍逐字复制（`:808-837` ↔ `:872-900`），建议抽 `ConfirmDialogScaffold(title, body, {isDeleting,error,onCancel,onConfirm,label})`，防第三个确认对话框再次分叉。
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
  - 2026-08-27 复核补充：编排摘要头部 32 行「主代理/子代理」统计卡网格在分组/遗留两分支逐字复制（`:1186-1217` ↔ `:1242-1273`），拆分时一并折叠为 `renderRoleStats(mainRole, subRole)`。

> **2026-08-27 复扫新增（N11–N12）**：

- **TD-UI-APP-N11** · IM 渠道设置区 QR 登录轮询状态机三份手写复制
  - 类别：F/R3 · 严重级：P2 · 工作量：S · 状态：new · 意图：[accidental]
  - Pain×Spread：2×1=2
  - 位置：`ui/src/components/settings/view/integrations/im/components/FeishuChannelSection.tsx:60-108` ↔ `WeComChannelSection.tsx:60-107` ↔ `WeixinChannelSection.tsx:92` 起（三文件共 ~1166 行，轮询体仅 URL 前缀不同，WeCom 多一个 `fallbackUrl`）
  - 影响：同一 qr-begin→`setInterval(3000)` qr-poll→phase 机（idle/scanning/success/error）→cancelQR 生命周期实现了三遍；Weixin 在 `:155` 注释里踩过的过期-vs-待定边界，另两份并未同步该认知——修一处漂两处已可预期。
  - 建议：抽 `useQrLoginPolling(channelPrefix)` 返回 `{qrUrl, phase, error, start, cancel}`。
- **TD-UI-APP-N12** · 中粒度共享组件跨文件逐字复制（SelectControl 与 Markdown 链接渲染器）
  - 类别：F · 严重级：P3 · 工作量：S · 状态：new
  - Pain×Spread：1×1=1
  - 位置：(a) `settings/view/general/CodeEditorSection.tsx:14-42` ↔ `GeneralSettingsSection.tsx:17-45`——28 行样式化 `<select>` 完全相同；(b) `chat/view/subcomponents/Markdown.tsx:22,30-63` ↔ `code-editor/view/subcomponents/markdown/MarkdownPreview.tsx:18,28-57`——同一 `linkClassName` 常量 + 相同锚点组件（内部文件拦截/外链 target:rel 三元）各实现一遍，katex 加载也各自为政
  - 建议：(a) 提升为 `settings/shared/view/SelectControl`；(b) 抽 `createMarkdownLinkComponents({onFileOpen, baseFilePath})` 至共享 utils（两者本就同源引用 `resolveMarkdownFileHref`）。安全策略类改动（如外链 rel 属性）应只改一处。
  - 附注（健康面）：两处 src↔ui 手镜像类型经核对今日仍逐字节一致、kanban/patent/stores 零 lint 逃逸，「不标记 DTO 镜像」规则成立，无需登记。

---

## 26. ui/server（B5 ✅）

**模块概况**：约 99 个手写 JS（routes 33 + services 26 + utils 26 + websocket 3；前两组各含测试文件）。Express 桥连 gateway 属**有意设计**（决策保留）。最大 `sati-bridge.js` 2288 / `routes/git.js` 1490 / `routes/taskmaster.js` 1170。深 `src/` 导入 12 处（对应 TD-BOUND-001）、`memory.js:14` 直连 `lib/index.js` 维持 TD-BOUND-002 wontfix。
> 复核结论：历史「同能力多套实现」中 getProjects/WebSocketServer/repairToolName 三项均已统一收口。
> **2026-09-17 变更**：C34 那批「只登记」条目已收编入本账（见本节末「处置追加」），零消费死表面退役后文件数与最大文件榜随之下降。

- **TD-UISERVER-N01** · `sati-bridge.js` 成为 god-module（2055 行，桥接+统计+缓存混合）
  - 类别：A · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`ui/server/sati-bridge.js`（`runChatViaGateway :671-888`、`getRouterDashboardData :1706-1821`、`getRouterStatsSummary :1918-1956`）
  - 建议：拆 `gateway-client.js`/`event-mapper.js`/`router-stats.js`。
  - 2026-08-27 复核：函数本体自审计以来原封未动（现 `:671-894`，+6 行漂移），文件 +73 行来自 kanban 溯源代码；债停滞未恶化。新增两条无条件日志 `:713,731`（每条用户消息触发，计入 TD-CONSOLE-001 的 ui/server 清单）。
- **TD-UISERVER-N02** · bridge 内 4 个 per-session 内存缓存无 LRU/容量上限
  - 类别：I · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`sati-bridge.js:1237`（`_sessionTitleCache`）、`:1319`（`_userQueriesCache`）、`:1435`（`_toolSequenceCache`）、`:1529`（`_subagentPromptCache`）
  - 建议：为各缓存加 LRU/TTL 上限。
  - 2026-08-27 复核：缓存本体债未变，行号漂移至 `:1221/:1307/:1423/:1518`；同时确认四个缓存的「候选路径枚举」填充前奏（safeId 变体→项目 chats 目录→通用 workspace→全 `projectsDir` 扫描）被逐字复制 4 份（`:1249-1279, :1356-1386, :1443-1470, :1533-1559`），属未登记子债。建议把 remedy 合并为一批：共享 `resolveTranscriptCandidates(sessionId, projectKey)` helper + LRU 包装（工作量维持 S/M）。
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

### 处置追加（2026-09-17 · issue #356 / PR #417）

> **为什么会有这一节**：C34（2026-09-06）在 `docs/code-refinement-plan.md` 里留了 9 条 P0 候选 + 9 条死路由 + 2 项退役建议，此后**没有任何事实源收编它们**——`code-refinement-plan.md` / `code-refinement-report.md` 自 2026-09-11 起退出事实源地位，而本 §26 的 `TD-UISERVER-N01`~`N10` 是**另一批**条目（god-module / 缓存 / 错误码 …），两侧从未对齐。结果：这 20 条 11 天里不上看板、不受 stale 治理、无人认领——治理意义上等于不存在。本节的职责是**先把它们收进活账本，再逐条裁定**。

- **复核结论：登记没有夸大。** 19 条登记项 + 2 项退役建议按**锚点**逐条核码（不按登记行号），**仅 1 条失效**：
  - **已销项 · P0-6 `/load` 路径校验弱于 `/execute`**：#365（2026-09-15）已让两路由共用 `ui/server/utils/commandPaths.js` 并有 14 例直测，C34 所述的「`inHome` 放行 `$HOME` 任意文件」不复存在。本 PR 顺手退役该路由本体（前端零消费）。
  - 其余 8 条 P0 候选 + 全部死路由/退役建议**仍成立**；`ui/server` 对该批 11 天零改动，是「登记准确但无人执行」的典型。
- **口径纠正：9 条 P0 候选不是一类东西。** 其中 6 条是**真实行为缺陷**（广播缺失、PTY 竞态、Map 泄漏、帧解析恒空、R/C 丢失、掩码不识别），只有 3 条与「零消费」相关（`/load`、MCP 死链路、死路由）。所以**不能**按 issue 正文的「确认仍成立的按域拆分为可执行项」把它们和死路由混成一批——死表面可以就地删，缺陷只能另立载体。
- **退役处置（本 PR 落地 · 零消费面）**：

  | 面 | 处置 | 规模 |
  |---|---|---|
  | `routes/taskmaster.js` | 删 4 条 `/prd`（GET/POST/GET-file/DELETE）+ `/detect/:projectName` + `/detect-all` + `/initialize/:projectName` + `/next/:projectName`（**8 条零前端消费路由**）；连带死 helper `detectTaskMasterFolder` / `determineTaskStatus` | 1849 → 1170 行（−679） |
  | `routes/commands.js` | 删 `POST /load`（P0-6 的载体）；`/list` + `/execute` 保留 | 1131 → 1081 行（−50） |
  | `utils/globalChrome.js` | **整删**（413 行，除 server-boot 关机钩子外全零消费，`chromeProcess` 在 ui/server 已无启动路径）；`services/server-boot.js` 关机钩子对应清理块移除并留说明注释 | −413 行 |
  | `services/always-on-paths.js` | **整删**（8 行，仅剩 `getAlwaysOnRoot` 被 parity 测试消费） | −8 行 |
  | `TaskMasterContext.tsx` | 删 `taskmaster-mcp-status-changed` 死监听（P0-5 前端侧；该 frame 全仓零生产者、后端生产者已于 C34 删除） | −7 行 |
  | 连带同步 | `commandPaths.js` 头注/`COMMAND_PATH_DENIED_MESSAGE` 措辞改为「只服务 `/execute`」；`pilotPaths.test.js` 删 `getAlwaysOnRoot` parity 用例；`WebSocketContext.noise.test.tsx` 死帧样例改用存活的 `taskmaster-project-updated`；`commands.test.js` 删 8 条 `/load` 路由级用例（策略覆盖由 `commandPaths.test.js` 14 例保留） | −159 行 |

- **仍成立 → 6 条新载体**（每条独立成 issue，**未并成一条**，因为触发条件与爆炸半径各不相同）：

  | 原登记 | 载体 | 一句话债务 |
  |---|---|---|
  | C34 P0-1 | **#411** | `chat.js` 的 `edit-last-turn` / `regenerate-last-turn` 用 `writer` 而非 `streamWriter`，兄弟标签页停在 `Processing`；**已交付（PR #429）** |
  | C34 P0-2 + P0-3 | **#412** | `shell.js` PTY 重连竞态（旧 `close` 清新连接引用 + 挂 30 分钟 kill 定时器）与 `onExit` 误删同 key 新会话（含跨会话串流）；**已交付（PR #425）** |
  | C34 P0-4 | **#413** | `sati-bridge.js` 三张 per-session Map 慢泄漏（清退全挂在对端终态事件上）；**已交付（PR #425）** |
  | C34 P0-8 | **#414** | `POST /api/agent` 四项：`getAssistantMessages` 恒空 / 双层 `catch {}` 吞错 / checkout 错变量 / `setSessionId` 全链零调用；**已交付（PR #426）**——清理目标另发现是 pre-rebrand 改名遗留（`~/.sati/sessions/<id>` 无生产者），改指真实转录位置 |
  | C34 P0-7 | **#415** | `git.js` `/status` 丢 R/C（同文件 `parseStatusFilePaths` 已有正确实现 ⇒ 两处口径分叉，非「不会写」）；**已交付（PR #428）**——分桶收敛为唯一入口 `parseStatusBuckets()` + 「条目总数守恒」不变式 |
  | C34 P0-9 | **#416** | `config.js` `/test-connection` 不识别掩码键（`/models` 与 `/test-web-search` 都有回落，当前前端传明文故未触发）；**已交付（PR #427）**——两条 provider 探针共用 `resolveProviderProbeApiKey()`，掩码永不发往上游 |

- **判据**：新增 `ui/server/routes/retired-routes.test.js`（2 例）钉**存活清单**——taskmaster 仅剩 8 条、commands 仅剩 `POST /list` + `POST /execute`。**刻意不写「退役项不在表里」**：该写法在路由表解析为空时恒真（与 #341「空集放行」同源的失败模式）。3 条负控制（复活死路由 / 改名存活路由 / 删除存活路由）逐条转红且相邻用例保持绿。
- **维持原判不修**：C34 的 P2「记录不处理 ×10」与 P3 各项不变；`TD-BOUND-002`（`memory.js` 直连编译产物）维持 wontfix。
- 决策记录与 6 条 `Alternatives considered`：`docs/notes/implemented/2026-09-17-ui-server-dead-surface-retirement.md`。

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
  - **2026-08-27 复核扩充范围**（复核确认 board/task/methodology/adapters 已有对应直测，不属缺口；新增缺口如下）：`src/shared/paths/` 全目录（findGitRoot/resolveCanonicalRoot/findCanonicalProjectRoot/LRUMap，含两条防目录穿越安全校验却零回归）、`src/shared/sqlite.ts`、`src/shared/ttl-cache.ts`、`src/shared/debug.ts`、`src/telemetry/sender.ts`、`src/telemetry/context.ts` 均无直接 spec。注意与 TD-SHARED-N01 部分重叠（paths 安全逻辑），补测时合并处理。
- **TD-TESTNSCRIPT-N08** · 附图 PDF 提取「单一事实源」一致性用例靠正则扫源码，跨构建跳过
  - 类别：E · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`tests/patent/tool/patentPdfDownload-extractjs.spec.ts:67-90`
  - 建议：改为运行时读取内嵌常量导出并对比，或明确 skip。

---

## 28. apps/desktop（B5 ✅）

**模块概况**：Electron 壳（macOS DMG arm64 + Windows NSIS x64/arm64，Linux 不维护）：12 TS（main/preload/server-manager/runtime-layout/onboarding/splash）+ 26 发布脚本。安全基线良好（三窗口 `contextIsolation+sandbox+nodeIntegration:false`、导航白名单）。债务集中在**跨平台构建产物一致性、进程管理误杀邻近进程、文档漂移**。

- **TD-DESKTOP-N01** · 运行时包布局的符号链接接线在多处重复实现
  - 类别：D · 严重级：P1 · 工作量：M · 状态：**done（2026-09-15，PR #385）**
  - 位置：`apps/desktop/src/server-manager.ts:716-766`（原登记缺 `apps/desktop/` 前缀）；`apps/desktop/scripts/lib/packaged-runtime.sh:62-81`；`apps/desktop/scripts/verify-dmg.sh:243-278`
  - **2026-09-15 处置（PR #385，`refactor(desktop)`）**：核实后本条登记的「三处」实为**两组共 5 处**——
    ① **铺陈**（`dist`/`src`/`node_modules`/`memory-core` 五条链接）：`server-manager.ts:729-766`、`packaged-runtime.sh:64-83`、`verify-dmg.sh:246-275`；
    ② **`.pnpm` vstore 重链**（原文措辞未提、且漏了一处）：`server-manager.ts:795-924` + 原文**完全未提及**的 `relink-pnpm-win.mjs`。
    处置：TS 侧两组抽进 `apps/desktop/src/runtime-layout.ts`（无 electron 依赖 ⇒ **首次可直测**；`server-manager.ts` 1401 → 1205 行，机械派生 + 三段函数体逐行相同核对）；shell 侧两处收敛为 `lib/packaged-runtime.sh` 的 `pd_runtime_stage_links()`（两处真实差异显式参数化：根级 `edgeclaw-memory-core`、logger）；`relink-pnpm-win.mjs` 改为可导入并**补齐「自身无 `.pnpm` 时借用兄弟树 vstore」**——此前它整体跳过 `satiui`，导致该树在验证中**从未被重链**（验证比运行时弱）。
    证据：`docs/notes/implemented/2026-09-15-desktop-runtime-layout-single-source.md`；19 条新用例 + TS↔shell / TS↔mjs 一致性判据 + 11 类负控制（全部转红后复绿）。
  - **未验证**：Windows 安装器验证与 DMG 验证未真机实跑（本地无法产出 DMG/NSIS）；残留见下条。
- **TD-DESKTOP-N07** · 布局接线仍是「每种语言一份」，未收敛为单一实现
  - 类别：D · 严重级：P3 · 工作量：M · 状态：new
  - 位置：`apps/desktop/src/runtime-layout.ts`（运行时）↔ `apps/desktop/scripts/lib/packaged-runtime.sh`（L1/L2/L3 验证）↔ `apps/desktop/scripts/relink-pnpm-win.mjs`（Windows 验证）
  - 现状：跨语言无法共用一个文件，故为「两份实现 + 判据」而非「一份实现」；单侧漂移已由 `tests/desktop/runtime-layout-shell-parity.spec.ts` 与 `tests/desktop/pnpm-vstore-relink-parity.spec.ts` 钉住。
  - 触发条件：**下次在 Windows / DMG 环境实跑发版流程时**，若确认解包树能稳定拿到编译后的 `runtime-layout.js`，则把 shell 与 mjs 改为调用它（即 #348 建议的方向 1）。届时一并实跑确认：`relinkTrees` 的借用语义、`pd_runtime_stage_links` 第 4 参为 0（verify-dmg.sh 路径）时不建根级 `edgeclaw-memory-core` 是否安全。
- **TD-DESKTOP-N02** · release.sh 与 build-win.bat 的 bundle 配方已分叉（排除清单 + 产物内容不一致）
  - 类别：F · 严重级：P1 · 工作量：M · 状态：**done（2026-09-15，PR #377）**
  - 位置：`scripts/release.sh:450-524,551-559`；`scripts/build-win.bat:318-399`
  - 影响：mac 的 sati-main bundle 带 `dist/assets/`（`render_patent_document` 运行时需它）`skills/` 等，而 win 的 `build-win.bat:397` 仅打 `src dist\src scripts node_modules vendor package.json tsconfig.json`——Windows 打包缺运行资产，专利文书渲染可能失效。建议：收敛为单一共享 bundle 清单。
  - **2026-09-15 处置（PR #377，`fix(desktop)`）**：核对后发现比本条描述更靠下——macOS 走根 `pnpm run build`，其脚本体含 **11 处 `cpSync`**（专利模板 / skills / 知识 wiki / 方法论 data 等非 TS 资产），而 Windows 的 Step 7 只跑裸 `npx tsc` + 一处 `xcopy`，故 `dist/assets` 与 `dist/src/**/data` 在 Windows **从未被生产**（只补 tar 清单三项会得到空目录）。处置：把那 11 处 cpSync 抽成 `scripts/copy-build-assets.mjs` 作单一事实源，根 `build` 与 `build-win.bat` 共用；tar 清单补 `dist\assets skills rules`。**仍未验证**：需在下次 Windows 发版流程实跑 `build-win.bat` 核对 tar 内资产。
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

> 后续批次专项排期（阶段化顺序 / 爆炸半径 / 浏览器验证 / 硬截止）见 `docs/technical-debt/next-batches-schedule.md`。

**立即（P0–P1，短平快，优先做）** — ✅ 1–3 已全部落地（2026-08-23）
1. 安全：`mcp` 路径穿越读盘（MCP-N02）→ resolvePath 加 `cwd` 包含校验；`permission` 损坏→权限绕过（PERMISSION-N02）→ 损坏时 fail-safe 到 `skipPermissions:false`；`desktop` 端口误杀（DESKTOP-N03）→ 先 `isSatiRuntimeProcess` 校验。✅
2. 数据一致性：`workflow_failed.error` 用错步骤 id（WORKFLOW-N04）；`ui/server` PRD 模板双份漂移（UISERVER-N05）；`cron` 损坏 tasks.json 被清空（CRON-N02）。✅
3. 测试可靠性：删除/改写 weixin 伪测试（TESTNSCRIPT-N01）、llm-replay-drafting 空洞测试（TESTNSCRIPT-N03）。✅

**短期（P2，1-2 天/项）**
4. 前端巨无霸：拆分 `useChatComposerState`(UI-CHAT-N01)、`MessagesPaneV2`(N03)、`SkillsV2/ImportFromFolder`(UI-APP-N01)、`PdfDocumentPreview`(N07)；删除 `useChatSessionState` 死状态 `isLoadingMoreMessages`(N02)。UI 改动须浏览器验证。
   - **2026-09-18 分档复核**：N02 的**死状态半**已完成（PR #440，S 级、零行为变化）；N05 已完成（PR #442：删掉不可达的 legacy 子代理渲染器，条目"两套重复实现"的事实前提更正为"一个活体 + 一个够不着的"）；N07 的**逻辑半边**已完成（PR #443：纯函数 + 搜索状态机外置，补 26 条单测，21 段搬迁逐 token 可证）；N04 **已完成**（PR #444：工具结果块 ~270 行拆出 `ToolResultBlock`；PR #445：可达性审计后——交互提示拆出 `InteractivePromptBlock`，user 气泡与 thinking 两支**不可达故删除**，文件 969 → 409、god function 794 → 335）。**中件三项至此全部落地**：N04 done、N05 done、N07 逻辑半边（剩余部分与 L 级窗口共享"浏览器验证"成本）。**L 级窗口第一项 N01 已完成**（PR #457：拆成六层 hook，父 hook 1837 → 558 行、god function 1608 → 467，59 项逐 token 证明 + 41 条测试 + 10 处负控制 + 双视口浏览器验证）；**第二项 N03 已完成**（PR #458：虚拟化层 + 占位视图外置，pane 1547 → 1183 行、god function 1023 → 824，33 项逐 token 证明 + 17 条测试 + 3 处负控制）；**只剩 UI-APP-N01（SkillsV2 的 ImportFromFolder 拆 feature-folder）**——**2026-09-19 收官：UI-APP-N01 已完成**（PR #460：853 行 `ImportFromFolder` 搬出 `SkillsV2` → `skills/import/`，共用件落 `skills/shared/`；两个纯函数 → `frontmatter.ts` + 9 条直测；183 行批量卡片 → `BatchImportPanel` + 4 条批量链路测试。`SkillsV2` 2525 → 1440 行、`ImportFromFolder` god function 852 → 688；19 + 4 + 6 项逐 token 证明（基线取上一个提交）、6 处负控制、双视口浏览器 A/B 指纹逐字节相同；顺带补上零覆盖的导入链路测试，850 → 863 条）。**L 级专项窗口三项（N01 / N03 / UI-APP-N01）至此全部落地。** 当初「短期（P2，1-2 天/项）」低估了三个 L 级项——它们共享同一成本项（双视口浏览器验证）且都在聊天主链路（提交/虚拟化/滚动定位），改为分三档：小件（N02 死状态，已完）→ 中件（N04/N07/N05，有同址测试兜底）→ L 级专项窗口（N01/N03/UI-APP-N01）。**另注**：N07 剩余部分（选区→引用 ~235 行、工具条/侧栏 JSX ~317 行）同样落在"需浏览器验证"这一成本项上，压 1064 行 god function 的主力在那里——本轮只降了 66 行（被搬走的 110 行纯函数本来在模块级、不计入函数长度）。同批复核发现台账另有两条同族载体未列入 #159：`TD-UI-CHAT-N08`（`CodeEditorBinaryFile` 1523 行）、`TD-UI-APP-N02`（`useSessionStore` ~1440 行），已在 #159 评论中补登。另更正口径：该批 issue/台账引用的行数多为**函数/组件跨度**而非文件大小（`Pdf 1138≈函数 1130`、`ImportFromFolder 854≈852`、`MessageComponent 812≈798`），唯独 `MessagesPaneV2`「文件 1252 行」与实测不符（立案日已 1375，现 1556）。
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

---

## 30. debt-batch2 落地（分支 `refactor/debt-batch2` · 2026-08-27）

> 本节登记第二批修复的完成态；各条目的原始登记与复核见上文对应模块节，合并后以本节状态为准。

- **TD-AGENT-101（扩围收敛 ✅ / 本体拆分 pending）**
  - 新增共享生成器策略方法 `recoverFromMaxOutputBump(state,input,decision,routed,{stripTrailingErrorPairMessages})`
    与 `recoverFromEmptyResponse(...)`（`src/agent/loop/AgentLoop.ts`）：max-output 双胞胎
    （assembleAndRecover ↔ handleModelError）与连空双胞胎（assembleAndRecover ↔ handleNoToolCalls）收口；
    第三级兜底因调用方语义不同保留在各方法内；terminal 场景透传 `terminateTurn` 的 TurnStepReturn。
  - 行为等价验证：tests/agent 275 用例全绿。`handleModelError` 本体拆分的前置条件（先抽策略防孪生体）已满足，仍待排期。
- **TD-GATEWAY-002 待做半（守卫表 ✅ / 深度逐字段开放）**
  - 新增 `src/gateway/server/methodGuards.ts`：handleRequest 分发前收窄 params，全 66 方法穷尽表；
    必填标量族（submit_turn/abort_turn/resume_session/new_session/close_session、kanban 全 18、
    panel_heartbeat/team_*）精确校验，其余命名类型为 OBJECT_PARAMS 基线按域逐步收紧。
    畸形入参回结构化 **invalid_params**（新错误码），不再深入实现层炸 TypeError。
  - 新增回归：dispatch.spec「kanban_get 缺 projectKey」「submit_turn.sessionKey 类型错误且未触达 submitTurn」。
- **TD-GATEWAY-006（守卫侧穷尽 ✅ / switch 本体开放）**
  - `satisfies Record<WsGatewayMethod, ParamSpec>` 使新增 union 成员漏登守卫即 typecheck 失败；
    但 dispatchRequest 的 switch 仍未 satisfies 化，彻底解法留给后续（守卫表反推分发或穷尽 switch）。
- **TD-UI-CHAT-N14（✅ done）**
  - `ui/src/components/kanban/hooks/useBoardState.ts`：统一 `mutate({slice?,optimistic?},run)` 执行体折叠
    15 处变更脚手架（项目守卫/异常清错/成功清错/乐观切片失败整片回滚+refresh 结构性保证）；
    移除 i18n/config 单例直连改 `useTranslation("kanban")`；新增 `parseBoardState` 在唯一 refresh()
    入口校验 columns/cards 骨架。外部签名不变。
- 同批附带：presence-wiring.spec 空 submit_turn 探活帧补齐合法最小载荷（守卫生效后的必要跟进）。

**门禁证据**：root typecheck/lint/format ✅；agent 275、gateway 132（含 2 新增）、UI vitest 101 文件 617 用例 ✅。

---

## 31. 2026-09-14 补审（B7：2026-08-23 审计基线之后新增/大改的模块）

> **背景**：§1–§30 的审计基线为 2026-08-23。此后仓库新增了团队编排 M1–M4、J-Space 工作区账本、专利 clarity/evaluate/claim-chart 子系统、元认知控制、方法论 bridge-reencode/triz、协议 1.8 与跨进程续算等模块，原台账对其**零覆盖或仅零散提及**（`workspace-ledger`/`clarity`/`broadcast-hub`/`metacognitive`/`bridge-reencode` 在库中命中数为 0）。
>
> **本次补审**：按 `README.md` §审计方法论 的 A–I 九类专项扫描上述模块，条目编号续接（`TD-PATENT-*` 从 N16 起、`TD-WORKSPACE-*` 从 N01 起、`TD-TEAM-*` 从 N01 起）。
>
> **方法**：静态扫描 + 逐条代码核实；凡「疑似债务」读注释/决策记录后被证伪者，移入各节末尾「设计使然」清单，不计为债务。

### 31.1 团队编排（`src/agent/team/` + `src/tool/builtin/team/`，M1–M4）

**模块概况**：`src/agent/team/` 23 文件 + `src/tool/builtin/team/` 8 文件 = **31 文件 / 3425 行**；另 `ui/src/components/team-panel/` 17 文件 / 2140 行、`ui/server/routes/teams.js` 88 行、`src/gateway/teamPanel.ts` 48 行、`src/cli/teamSubsystem.ts` 259 行（装配根）。测试：`tests/agent/team/` **19 spec**、`tests/tool/builtin/team/` **7 spec**、team-panel 5 test。**总评**：静态口径几乎全线干净（`src/` 侧零 `any`/零类型逃逸、零裸 `console.*`、零无注释 catch、零 TODO），债务集中在**文档漂移**与**未缓存重复查询**，无 P0。

- **TD-TEAM-N01** · `CLAUDE.md` 声称「冷恢复 turn 的 approval_pending 不冒泡」，代码已全程接线
  - 类别：H · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`CLAUDE.md:164`（对照 `src/agent/team/member/member-scanner.ts:38-40,95-97`、`src/cli/teamSubsystem.ts:94-97`）
  - 影响：CLAUDE.md 是 agent/维护者的第一事实源。该句会让人误判 HITL 审批在崩溃恢复后失联，从而绕过或重复实现冒泡逻辑（实际已闭环）。
  - 建议：改写为「M1 已知限制已闭环：`scanTeamMembers` 增 `onEvent?` 透传、`runMemberScan` 接 `TeamApprovalForwarder.handleMemberEvent`」。
  - 证据：`member-scanner.ts:38-40` 定义 `onEvent?: (member, event) => void`；`:95-97` 直调 `wakeMember(..., { onEvent: event => options.onEvent?.(member, event) })`；`teamSubsystem.ts:97` 接 `teamForwarder.handleMemberEvent(member, event)`，注释明写「M1 已知限制在此闭环，计划 1349 行承诺兑现」。**核实结论：已接线，文档陈述为假。**
- **TD-TEAM-N02** · `docs/patent-team-usage.md` 八.2 保留同款过时限制
  - 类别：H · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`docs/patent-team-usage.md:105`
  - 影响：面向用户的团队使用说明，「已知限制 2」会让使用者以为重启后成员审批卡片不会出现（实际会，见 N01 证据链）。
  - 建议：删除该条或改为「已闭环（M2）」。同文件 `:95` 的 `isCaptainOnline` 描述是**正确**的，可作改写参照。
- **TD-TEAM-N03** · `defaultModelRoute` JSDoc 称「wakeMember 未消费」，实际已消费
  - 类别：H · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/tool/builtin/team/teamUtils.ts:157-159`（对照 `src/agent/team/member/member-waker.ts:51-57`）
  - 影响：注释断言会让维护者以为改 `modelRoute` 快照无效而改错地方；实际 `wakeMember` 已把 `modelRoute` 注入 `submitTurn`。
  - 证据：`teamUtils.ts:159`「当前仅快照存储——wakeMember 未消费」；`member-waker.ts:53-57` `parseModelRouteJson(member.modelRouteJson)` → `...(modelRoute !== undefined ? { modelRoute } : {})`；git `cb0f5418b`。
- **TD-TEAM-N04** · `buildTeamSubsystem` 205 行单函数（装配根膨胀）
  - 类别：A · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/cli/teamSubsystem.ts:55-259`
  - 影响：一个函数内混 6 件事（emit 闭包、forwarder 装配、`runMemberScan`、workerRegistry 注册、`TeamScheduler` 构造含 4 个内联闭包、`runStrandedScan`、`startStartupScan`）。`:74-82` 与 `:174-179` 是刻意对称的两份「completed 收集 + reclaimCompleted」实现，改一处极易漏另一处。
  - 建议：按 `emitTeamEvent`/`runMemberScan`/`runStrandedScan`/`createSchedulerWake(deps)` 拆子函数；两份 completed 收集抽共享 `createTurnCompletionCollector(...)`。
- **TD-TEAM-N05** · `TeamScheduler.kickMember` 157 行、四段式（邮箱/任务/回滚/终态防护）
  - 类别：A · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/agent/team/scheduler/scheduler.ts:146-302`
  - 影响：单函数内嵌 4 个 `withTeamLock` 临界区、`KickPlan` 计划类型、锁内重读防 TOCTOU、邮箱 ack、唤醒失败回滚 + 终态防护。核心调度路径，M3 集成测试已暴露过一次持锁死锁。
  - 建议：抽 `claimPlanInLock()` / `deliverMailbox()` / `rollbackDispatch()` 三个私有方法，`kickMember` 只留编排。
- **TD-TEAM-N06** · 通用编排层 `agent/team` 直依赖专利领域 `src/patent`
  - 类别：D · 严重级：P2 · 工作量：S · 状态：**done（#392）**
  - 位置：`src/agent/team/scheduler/scheduler.ts:20`（`import { workerAllowedForRole, type WorkerRegistry } from "../../../patent/worker-contract.js"`）
  - 影响：`agent/team/` 其余 22 文件只依赖 `node:*`、`gateway/protocol/types`、`telemetry` 与自身（分层自洽）。唯独 scheduler 反向拉入专利域：`WorkerTier`/`WorkerContract` 是专利专业子任务语义，通用任务池无权知晓。非专利团队被强制走 tier 校验路径；`WorkerRegistry` 演进会牵动通用调度器。
  - 建议：抽 `interface WorkerGate { allows(roleSlug, workerName): boolean }` 放 `agent/team` 侧，专利侧提供 adapter。
  - 证据：`grep -rn "patent" src/agent/team/` 仅命中 `scheduler.ts:20`（实际 import）与 `task-status.ts:2`（注释）。
  - **核账更正（作用域偏窄）**：issue 的 grep 只在 `src/agent/team/` 内，漏掉**同型的第二处**——`src/tool/builtin/team/{teamUtils,teamTasks}.ts`（通用团队工具）同样把专利域拉进类型面（`TeamToolsOptions.workerRegistry?: WorkerRegistry` 类型 import 自 patent **barrel** + `teamTasks.ts:171-173` 的存在性校验）。真实形态是 **2 个通用目录 / 3 个消费点**。
  - **核账补充（该路径此前零判据）**：`scheduler.spec.ts` 的 18 例从未注入过 `workerRegistry`，「无权成员被跳过 / 有权成员照常认领」此前只有 22s 的 gateway 集成用例间接经过，且那两条断的是**工具侧存在性校验**、不是调度侧判定。
  - 处置（#392）：`src/agent/team/worker-gate.ts` 定义领域无关 `WorkerGate { has(workerName) / allows(roleSlug, workerName) }`（`has` 不可省——省掉则工具侧存在性校验只能继续持 `WorkerRegistry`，接口只覆盖一半消费方）；`src/patent/team-worker-gate.ts` 提供适配器并**刻意不 import `agent/team` 类型**（patent 是业务域，反向 import 通用层在四层六域下仍是方向颠倒），结构一致性由装配点 `src/cli/teamSubsystem.ts` 的 `const workerGate: WorkerGate = createPatentWorkerGate(workerRegistry)` 在编译期把关。`workerRegistry` → `workerGate` 在 `TeamSchedulerOptions` / `TeamToolsOptions` / `TeamSubsystemRuntime` 三处一并更名（option 名是公开契约）。`allows` 的三条 fail-open 分支（未注册 worker / 未登记角色 / 按 tier 白名单）与 `ownedOpenTask` 走**未过滤快照**（已认领不夺回）逐条保持原语义并各自写成判据。
  - 判据：新增 13 例——调度侧 5（未注入 fail-open / 无权被跳过而有权限照派 / 实参逐条为 `[["researcher",…],["drafter",…]]` / 无 `workerName` 不查门禁 / 已认领不夺回）、适配器 5、分层守卫 2（`tests/agent/team/layering-boundary.spec.ts` 扫**真实源码树**，扫不到文件即失败）、lint 配置断言 1。**负控制 6 组**逐条核对转红名单；其中「`has` 恒真」除预期 4 例外额外打红适配器「读实时状态」用例（该例同时断言 `has(...) === false`），属同一注入多判据承重、非误红。
  - 防回退门禁：eslint `no-restricted-imports.patterns` 对 `src/agent/team/**` 与 `src/tool/builtin/team/**` 禁止 `**/patent(/**)` 说明符；因 ESLint 规则配置**按块整体覆盖**，同块必须复用抽出的 `DANGEROUS_IMPORT_PATHS` 常量，否则这两个目录会静默失去 `child_process.exec/execSync` 禁令（已在常量注释与 `lint-contract.spec.ts` 断言里写明）。
  - 未做：同节 `TD-TEAM-N07`（成员会话前缀正则三处独立定义）issue 提过「可一并处理」，本次未动（触及会话身份 fail-closed 判定，值得独立一轮）；worker tier 判定规则本身未改，只搬了判定位置。
  - 决策记录：`docs/notes/implemented/2026-09-16-team-worker-gate-decoupling.md`。
- **TD-TEAM-N07** · 成员会话前缀正则 `/^team[:-]/` 三处独立定义，同步说明只提一处
  - 类别：F/D · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/session/storage/SessionList.ts:16`、`src/tool/builtin/team/teamUtils.ts:36`、`src/agent/team/protocol/member-key.ts:11`
  - 影响：`member-key.ts:8-9` 注释只写「必须同步 SessionList.ts」，漏了 `teamUtils.ts:36` 的同款正则（**同名字面量两份**）。改前缀时漏改任一处 → 成员会话泄漏进 `listProjectSessions`/`TaskResumeScanner` 冷恢复双跑，或 `team_*` 工具身份判定 fail-open 成 captain（越权方向）。
  - 建议：`teamUtils.ts` 从 `agent/team` barrel 导入 `MEMBER_SESSION_PREFIX` 派生正则；另两处注释补齐同步点清单。
- **TD-TEAM-N08** · `recomputeBlockedByCount` 在团队锁内做 O(n²) 重算
  - 类别：I · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/tool/builtin/team/teamTasks.ts:47-55`（调用点 `:355`）
  - 影响：每个任务终态都要对每个任务调 `unsatisfiedDependencies(tasks, t.dependencies)`，而该函数每次 `new Map(tasks.map(...))` → n 任务即 n 次建 n 元素 Map。全程在 `withTeamLock` 临界区内（`:311-393`），阻塞同队全部并发认领/派发。
  - 建议：一次建 `Map<id,status>` 复用，或仅重算下游子集（增量）。
- **TD-TEAM-N09** · `TeamShare` 无实例缓存：每次工具调用/每次派发全量重读重解析 JSONL
  - 类别：I/G · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/agent/team/storage/team-share.ts:50-53,138-159`；消费点 `src/tool/builtin/team/teamShare.ts:112,189`、`src/cli/teamSubsystem.ts:154-164`
  - 影响：构造即 `load()` → `existsSync` + `readFileSync` 全文 + 逐行 `JSON.parse`。**调度器每次派发任务都 `readSharedBoardSummary` → `new TeamShare(...).summary()`**，即每任务派发 = 一次全量同步读；黑板随轮次单调增长，成本线性恶化，且 `readFileSync` 在调度路径上是同步阻塞。
  - 建议：进程内按 teamId 缓存实例（dispose 清理）；写路径内存 append 后落盘。
- **TD-TEAM-N10** · 面板快照每轮 O(teams×members) 过滤 + 每成员一次同步 SQL，且不按 sessionKey 过滤
  - 类别：I/G · 严重级：P2 · 工作量：M · 状态：new
  - 位置：`src/gateway/teamPanel.ts:32-46`（`toMemberView` 见 `src/agent/team/views.ts:32-40`）；路由 `ui/server/routes/teams.js:19-31`
  - 影响：(a) 性能：先 `listTeams()`+`listMembers()`，再对**每个团队**在两份全量数组上 `filter`；`toMemberView` 内 `db.isRetired(sessionKey)` 是每成员一次同步 SQL 往返。UI 每 10s 轮询，多客户端线性叠加。(b) 暴露面：`sessionKey` 入参被 `_input` 丢弃，任何持 token 的浏览器可见全部团队——已在 `gatewayRuntimeOptions.ts:150-155` 登记为信任边界，随多会话使用应复核。
  - 建议：快照按 `teamId` 预分组一次；批量取 retired 集合替代每成员 SQL；`sessionKey` 传入时按归属过滤。
- **TD-TEAM-N11** · `runMemberScan` 外层 `.catch` 静默吞掉整次启动扫描失败
  - 类别：C · 严重级：P2 · 工作量：S · 状态：done（2026-09-18，PR #434）
  - 位置：`src/cli/teamSubsystem.ts:121-124`（原登记写 `:118-121`）
  - 影响：本模块**唯一一处无注释、无日志的吞错点**。`scanTeamMembers` 契约「单成员失败不抛错」只覆盖成员级；若因 db 关闭/枚举异常**整体**抛出，此处静默返回 `{scanned:0, resumed:0}`——冷恢复静默失效，队长侧毫无信号。同文件 `:255` 的 `startStartupScan` catch **有** logger，同一失败域两种待遇。
  - 建议：补 `logger.error` 后返回。
  - **2026-09-18 处置**：✅ **done（PR #434）**——按建议补 `logger.error("Team member scan failed:", error)` 后返回零值（只附加日志，不改控制流）。测试 `tests/cli/team-subsystem-scan-failure.spec.ts` 用**一对判据**钉住不变量：① db 关闭使 `listMembers()` 抛错 ⇒ 返回零值**且**恰好一条 error 日志；② 无成员的正常空扫描 ⇒ 同样返回零值但**不**记 error。只测 ① 无法排除「每次都打」，只测 ② 无法证明失败被观测。负控制已验：撤掉该行后 ① 变红（`整体失败必须记恰好一条 error`）、② 仍绿。
  - **口径注记（为何没混进 #353 的注释 PR）**：该处是 **promise 链上的 `.catch()`**，不是 `catch {}` 子句，因此既不被 `measure-techdebt.mjs` 的「无注释的无参 catch」统计（#353 的 114 处里**不含**它），也不是补一行注释能治的——危害是「失败与『确实没有可恢复成员』的返回值同为 `{scanned:0, resumed:0}`」，只能靠日志区分。故 #353 的注释治理（PR #432/#433）与它分开交付，避免「零行为变化」的编译级证明被这一行日志稀释。
- **TD-TEAM-N12** · 派发类 fire-and-forget `.catch(() => undefined)` 静默吞错 ×4
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/tool/builtin/team/teamMailbox.ts:114`；`src/tool/builtin/team/teamTasks.ts:228,396,498`
  - 影响：设计意图（防重入死锁）成立，但异常被完全吞掉且无日志——若 `kickMember` 因 db 竞态抛出，表现为任务永久滞留 claimed/pending 而无人知晓。
  - 建议：换 `.catch(error => logger.warn("team dispatch kick failed", { teamId, error }))`（保留 fire-and-forget 语义，仅补可观测）。
- **TD-TEAM-N13** · `member_status` 事件变体已声明但零发射点（死事件类型）
  - 类别：F · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/agent/team/protocol/events.ts:14`
  - 影响：`TeamEvent` 联合类型含 `{ type: "member_status" }`，全仓发射点 **0**（成员状态实际由 `member_idle` + 轮询快照体现）；它同时进了 `docs/event-producer-consumer.md:38`（生产/消费双 `-`）。消费方要为不存在的帧维护分支，类型穷尽性被稀释。
  - 建议：删除该变体或补发射点。⚠️ 改 `TeamEvent` 属协议载荷，须跑 `pnpm gen:event-matrix`。
- **TD-TEAM-N14** · `TEAM_MEMBER_RESUME_MARKER` 死导出
  - 类别：F · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/agent/team/member/member-scanner.ts:24`（经 `src/agent/team/index.ts:24` 再导出）
  - 影响：`[team-resume]` 标记被导出两次，但全仓无任何 import（只被同文件 `:26` 模板串内联使用）；barrel 导出制造「这是对外契约」的假象。
  - 建议：去掉 `export` 或从 barrel 移除。
- **TD-TEAM-N15** · `EVENT_STYLE` 仅覆盖 5/16 事件类型，其余静默降级中性灰
  - 类别：F · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`ui/src/components/team-panel/constants.ts:19-27`
  - 影响：`TeamEvent` 16 个变体，`EVENT_STYLE` 只定义 5 个，其余 11 个（含 `member_stalled_approval`、`team_share_updated`、`task_reassigned`）落到 `FALLBACK_EVENT_STYLE`——「14 种 TeamEvent 彩色徽章」（`docs/patent-team-usage.md` 界面表）名不副实。
  - 建议：补齐为 `Record<TeamEvent["type"], string>` 让 TS 强制穷尽。
- **TD-TEAM-N16** · 面板轮询间隔文档/注释三处不一致（实际 10s）
  - 类别：H · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`ui/src/components/team-panel/constants.ts:3`（10s）对照 `hooks/useTeamPanel.ts:16,60`（5s）与 `docs/patent-team-usage.md`
  - 影响：容量估算会按 2 倍偏差计算后端 QPS。
- **TD-TEAM-N17** · 面板收起为浮标后仍每 10s 拉全量快照
  - 类别：I · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`ui/src/components/team-panel/floating-team-panel.tsx:145`（`useTeamPanel` 在 `:242` 收起早退之前调用）
  - 影响：收起态只需 `activeTeams.length` 与事件脉冲，但 `setInterval` 不感知 view，持续 POST + `setSnapshot`（触发整面板 re-render）。多标签页常驻时是无谓负载。
  - 建议：`useTeamPanel(sessionId, { enabled: view === "expanded" })`。
- **TD-TEAM-N18** · `member-tree` 每行 O(tasks) 查找、每次 render 无 memo
  - 类别：I · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`ui/src/components/team-panel/member-tree.tsx:47-54`
  - 影响：`currentTaskOf`/`statsOf` 对每个成员各 `team.tasks.find/filter` 两遍 → O(members×tasks)，未 `useMemo`，快照每 10s 刷新即全量重算。
  - 建议：`useMemo` 建 `Map<assigneeId, {current, done, total}>` 一次（对照 `task-dag.tsx:35,38,44` 已用 `useMemo`）。
- **TD-TEAM-N19** · 锁内全表 `listMembers()` 统计 working 数
  - 类别：I · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/agent/team/scheduler/scheduler.ts:211`
  - 影响：并发闸判定在团队锁内做 `db.listMembers().filter(...)`——`listMembers()` 是**全库**成员全量读（`team-db.ts:400-407` 无 WHERE），只为数本队几个。每次认领一次，锁内。
  - 建议：增 `countWorkingMembers(teamId)` 走 `SELECT COUNT(*)`。
- **TD-TEAM-N20** · `approval-forwarder` 每次 decide 全表 `listMembers().find`
  - 类别：I · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/agent/team/member/approval-forwarder.ts:78-80`
  - 影响：每次审批决定拉全库成员再线性查 sessionKey；`TeamDb` 已有按 sessionKey 索引的查询可复用。审批是低频人操作，影响有限，属同类「以全表换单点」。
  - 建议：增 `getMemberBySessionKey(sessionKey)`（`members.session_key` 无索引，可加）。
- **TD-TEAM-N21** · 工具层测试约 90 处 `as never` 绕过 `SatiToolRuntimeContext` 类型
  - 类别：B · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`tests/tool/builtin/team/teamTasks.spec.ts`（~50）、`teamMailboxStatus.spec.ts`（~25）、`teamArchive.spec.ts`、`teamShare.spec.ts`、`tests/agent/team/taskpool/task-status.spec.ts:33`
  - 影响：`src/` 侧**零**类型逃逸（本模块强项），但测试把上下文断言成 `never`，意味着 `SatiToolRuntimeContext` 增改字段时这些测试**不会编译报错**——恰是工具层最需回归保护的契约（9 个 `team_*` 全走 `context.sessionId/cwd/currentToolCallId`，任一变化是越权方向风险）。`as never` 比 `as any` 更隐蔽（无告警）。
  - 建议：抽 `tests/tool/builtin/team/helpers.ts` 的 `makeCtx(partial)` 返回真实类型最小上下文。
- **TD-TEAM-N22** · `views.ts` / `broadcast.ts` 无直接单测（仅间接覆盖）
  - 类别：E · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/agent/team/views.ts`（55 行）、`src/agent/team/protocol/broadcast.ts`（12 行）
  - 影响：两文件是 `team_status` 工具与面板快照**共用**的视图映射单点；`views.ts:48-53` 的「可选字段才输出」语义是 UI 侧 `undefined` 判定的依赖前提，仅靠集成测试间接覆盖。
  - 建议：补 `views.spec.ts`（含残缺 modelRoute 降级、可选字段省略）与 `broadcast.spec.ts`。
- **TD-TEAM-N23** · `TeamDb` 613 行单类 ~30 方法（模块最大文件）
  - 类别：A · 严重级：P3 · 工作量：M · 状态：new
  - 位置：`src/agent/team/storage/team-db.ts:289-613`
  - 影响：单类承载 6 类实体读写与迁移；`:540-612` 是 P0-3 追加的审批子域，内聚已跨「团队状态库」与「审批挂起表」两个关注点。
  - 建议：`pending_approvals` 组抽 `TeamApprovalStore`（同 db 实例）。
- **TD-TEAM-N24** · 已登记的「静默吞错」`lock.ts:19` 实为带 3 行论证的防御式——**登记失准**
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`docs/technical-debt/backlog.md:129`（TD-AGENT-104）对照 `src/agent/team/scheduler/lock.ts:16-19`
  - 影响：核实结论——`await previous.catch(() => undefined)` **不是**无注释静默吞错：`:16-18` 三行注释完整论证了「tail 链归纳证明永不 reject，`.catch` 仅作未来 reject 源的锁自愈兜底」。把它与 `TurnRunner.ts` 真静默点并列，会让修复者误改或误判该项无进展。**属已注释的刻意设计。**
  - 建议：从 TD-AGENT-104 位置清单移除 `lock.ts:19`；本模块真正的无注释吞错点是 N11。
- **TD-TEAM-N25** · M2 计划文档「`isCaptainOnline` 未接线」与代码相反（历史快照残留）
  - 类别：H · 严重级：P3 · 工作量：S · 状态：done（2026-09-18，PR #439）
  - 位置：`docs/superpowers/plans/2026-08-20-agent-teams-m2-taskpool-scheduler.md:1343,1354,1535`（对照 `src/cli/teamSubsystem.ts:158`）
  - 影响：核实结论——**已接线**（`isCaptainOnline: captainSessionKey => deps.sessionPresence.isActive(captainSessionKey)`）。计划文档三处称「默认常在线/未接线/留 M3」，与代码状态错位。
  - 建议：计划文档属历史快照不必改内容，但**台账/入口文档不应继续把它当未决项**；在该行标注接线位置。
  - **2026-09-18 处置**：✅ **done（#359 批量回收）**——该文档新增「验收状态」段，正文**不改**（历史快照），在段内单列更正：`isCaptainOnline` 已由提交 `d87bac0e` 接线（`src/cli/teamSubsystem.ts:158`），该提交同时删掉了旧注释「I3 标注：isCaptainOnline 未接线（默认常在线）」；同批「留待 M3」的另两项也已落地（`message_delivered` 批次 → `senders[]`，`events.ts:37-38`；`blockedByCount` 维护，`src/tool/builtin/team/teamTasks.ts:46-52`）。该文档未勾选 57 项经逐条核对：**51 项已交付**（已回填勾选 + 逐项证据），6 项「无法核实」（均为 TDD 红灯/跑测试类瞬时步骤，无持久产物）。
- **TD-TEAM-N26** · `team_event` 下游计数文档 ×14 与实际 16 变体不符
  - 类别：H · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`docs/event-producer-consumer.md:75`（对照 `src/agent/team/protocol/events.ts:10-59`）
  - 影响：三处口径互不一致（矩阵 ×14、`events.ts` 16、m3 plan「13 种」）；事件矩阵门禁仅校验外层 `team_event`，变体数漂移不会被拦住。
  - 建议：以 `events.ts` 为准更新为 16，并在 `events.ts` 头注释注明「变体数漂移需手工同步矩阵」。
- **TD-TEAM-N27** · 工具 `description` 超长（562/465/431 字符）注入每次模型请求
  - 类别：A · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/tool/builtin/team/teamTasks.ts:278`（562）、`teamShare.ts:75`（465）、`teamMailbox.ts:48`（431）
  - 影响：`team_update_task` 的 description 单条 562 字符，把豁免/状态落参全塞进一句。这些 schema 每次会话都进模型请求（成员回合带作业面工具），属常驻 prompt 成本。
  - 建议：细节移到返回错误消息或系统提示段，`description` 只留主语义。
  - ⚠️ **红线**：改工具 `description` 会使 llm-replay fixture 失配（`README.md:90`），须走显式重录流程。

**设计使然（已写入决策/注释，登记为意图而非缺陷）**：单进程边界（`team-db.ts:6-9` 无 WAL/跨进程锁，不在支持范围）；`SessionPresence` Map 不做 TTL（为保 known-offline 语义稳定，`sessionPresence.ts:14-17` 有完整论证）；面板快照信任边界（`gatewayRuntimeOptions.ts:150-155` 登记「单用户桌面场景可接受」）；`invalidateTaskAttempt` 与 `retryFailedTask` 双实现（`taskpool/retry.ts:6-9` 记录「故独立实现，不复用」）；`detectDependencyCycle` 运行期不可达（`taskpool/cycle.ts:4-8` 声明为防御性纯函数）；`lock.ts:19`（见 N24）。

**审计结论**：债务集中在两处——(1) **文档/注释漂移**（H 类 6 条，含 3 条 P2，方向一致：代码早已接线、文字停在旧里程碑；四份独立事实源互不同步且无一处可机检锚点）；(2) **通用层被领域耦合 + 未缓存重复查询**（D/I 混合 3 条 P2）。健康面突出：分层约束被显式书写并遵守（`views.ts:5`、`modelRouteJson.ts:7` 陈述「tool 依赖 agent/team，反向会循环」且真的无反向 import）、注释密度与推理质量显著高于仓库均值（多数「疑似债务」读注释即被证伪，N24 即典型）、测试覆盖完整（scheduler 622 行 spec 覆盖 stale-attempt/TOCTOU/终态防护/归档只读/fail-closed 身份等边界）。

### 31.2 J-Space 工作区账本（`src/session/workspace/` + `src/tool/builtin/workspace/` + `registerLeak`）

**模块概况**：7 文件 / ~792 行（`src/session/workspace/` 4 文件 447 行 · `src/tool/builtin/workspace/` 2 文件 151 行 · `src/context/workspace/registerLeak.ts` 194 行）；测试 3 spec。纯状态机 + 派生读取，零 `any` 零 `@ts-expect-error`，惯用法干净；债务集中在**读取路径冗余重算**与**降级静默**。

- **TD-WORKSPACE-N01** · `readLatestWorkspaceState` 对**每一个** `workspace_state` 条目都 clone 一次，只留最后一个
  - 类别：I · 严重级：P2 · 工作量：S · 状态：**done（2026-09-15，PR #378）**
  - 位置：`src/session/workspace/WorkspaceLedgerReader.ts`；调用方 `WorkspaceLedgerStore.ts`、`src/agent/loop/modelRequest.ts`
  - 影响：已登记的 TD-SESSION-N01 描述「O(entries) 重扫 + clone」，但真实代价比它描述的重一档：循环体内 `latest = cloneWorkspaceLedgerState(entry.state)` 对每个匹配条目都深拷贝，**前面的拷贝全被丢弃**。叠加 TD-SESSION-N02 已确认的「每笔写入追加一份全量快照」，快照数 S 单调增长 → **每次模型调用**实际开销 ≈ O(N) 浅拷贝 + O(N) 扫描 + **O(S×L) 次深拷贝**（L=账本规模）。修法只有一行。
  - 建议：循环内只记引用，循环后 clone 一次；如仍要缓存，按 TD-SESSION-N01 的尾部衔接键做 O(1) 命中。
  - **2026-09-15 处置（PR #378）**：与 TD-SESSION-N01 同批落地——`scanLatestWorkspaceState` 循环内只记 `entry.state` 引用（`cursor.state`），一次 clone 由 `WorkspaceLedgerStore.read()` 在返回时按需做；缓存则按尾部衔接键做 O(1) 命中（即 N01 的游标）。
- **TD-WORKSPACE-N02** · 账本读取丢弃 `diagnostics`：transcript 超 50MB 时账本**静默消失**
  - 类别：C · 严重级：P2 · 工作量：S · 状态：**done（2026-09-15，PR #378）**
  - 位置：`WorkspaceLedgerStore.read()`（原只解构 `{ entries }`）；`src/session/transcript/TranscriptReader.ts:176-188`；`src/agent/loop/modelRequest.ts`
  - 影响：`readTranscript` 在 `size > DEFAULT_MAX_TRANSCRIPT_READ_BYTES`（50MB）时**不抛错**，返回 `entries: []` + 一条 `severity:"error"` 的 `transcript_too_large` 诊断。`read()` 忽略 `diagnostics` → `readLatestWorkspaceState` 返回 undefined → 靠 `?? this.latest` 内存兜底掩盖。后果：(1) 进程内不丢，但**新进程/新会话重开时账本凭空消失**，模型侧只是「没有 `<workspace-state>` 块」，零告警；(2) 长会话越 50MB 后注入的是陈旧内存态而非 transcript 真值，与「transcript 是唯一事实源」的模块契约背离。
  - 建议：`read()` 把 `severity !== "info"` 的诊断经会话诊断通道上报（去重）；`entries` 为空且诊断非空时返回带标记的空态而非静默回退。
  - **2026-09-15 处置（PR #378）**：`SatiWorkspaceLedgerProvider.read()` 返回改为判别式结果 `{status:"ok",state} | {status:"unavailable",code,message}`；error 级诊断 → `unavailable` 且**不再回退 `this.latest`**；诊断按 `code + line` 去重后经 `createLogger("session")` 上报一次（`transcript_missing` 走 warn）。内存态兜底只保留给「无 transcript 路径」与「路径已声明但 transcript 里确无账本条目」两种情形。三处调用点适配：`modelRequest` / `toolContext` 在 `unavailable` 时跳过注入（前者裸 catch 补 debug 日志）；**`workspace_note` 在 `unavailable` 时拒绝写入**（防「以空态为基座写回、丢掉既有账本」这条数据丢失路径）。决策见 `docs/notes/implemented/2026-09-15-workspace-ledger-read-path.md`。
- **TD-WORKSPACE-N03** · `registerLeak` 的 ASCII 标点成员在散文里做**子串**匹配，普通标点即误报
  - 类别：F · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/context/workspace/registerLeak.ts:16`（`INNER_ONLY` 含 `"??"`、`"?!"`）、`:50`、`:19` + `:55`
  - 影响：非 ASCII 的 `⇒/⟸/💀` 语义明确，但 `??` 与 `?!` 是普通标点。因 `workspace_ship` 是**报告型不阻断**，代价为假阳性报告消耗模型注意力、训练用户忽略该工具输出——真正的 register 泄漏被噪音稀释。
  - 建议：`"??"`/`"?!"` 移入独立「弱信号」清单（或要求连续两个以上）；`STATE_MARKERS` 改词边界匹配。
  - 证据（实跑 `dist/` 编译产物）：`"Really?!"` → 命中 `?!`；`"为什么??"` → 命中 `??`；`"The plan is ready. phew"` → 命中 `PHEW`。
- **TD-WORKSPACE-N04** · openspec 归档任务清单未勾选，但对应产物均已存在
  - 类别：H · 严重级：P3 · 工作量：S · 状态：done（2026-09-18，PR #439）
  - 位置：`openspec/changes/archive/2026-08-21-broadcast-hub/tasks.md:12`（3.1）、`:10`（2.2）、`:16`（4.1）
  - 影响：归档 change 的 tasks.md 停在 `[ ]`，持续误导后续审计者把「已交付」读成「未交付」。核实结论：`tests/agent/sub/workspace-core-inheritance.spec.ts` **确实存在**（3 个 test，覆盖 protocol note / 无 core 时 no-op），`renderWorkspaceCoreDirective` 亦已落地。**属归档文档漂移，非功能缺口。**
  - 建议：勾选 2.2/3.1/4.1 并注明归档核对日期；在 `README.md` §如何保持新鲜 加入「归档 change 的 tasks.md 随交付回填」。
  - **2026-09-18 处置**：✅ **done（#359 批量回收 · PR #439）**——三份归档 `tasks.md`（broadcast-hub / bridge-reencode / metacognitive-control）共 16 处未勾选：**12 项已交付**（逐条给出产物出处，如 3.1 的测试文件实为 5 用例、2.1 的实现名是 `buildWorkspaceCoreDirective`/`renderWorkspaceCoreDirective`）、1 项仍未交付（metacognitive 1.1 的 `shouldRetryDiagnosis` 未同名落地，职责由 `buildMetacognitiveRetryPrompt` + `AgentLoop.ts:707` 承担）、3 项无法核实（三处 §4「Full verification」都是一次性运行，仓库不存结果）。同时新增两份防复发约定：`docs/issue-management.md` §6.1 与 `docs/technical-debt/README.md` §如何保持新鲜 第 5 条。

> **存量条目状态（2026-09-15 更新）**：TD-SESSION-N01 与 TD-SESSION-N04 **已 done**（PR #378，账本读取路径专项）——`read()` 改为增量游标扫描，并补齐 Store/Reader 直测；N01 原文记的 `34-40` 行号随施工位移，勿按行号复排查。
>
> **健康面**：`applyWorkspaceNote` 五个不变式（开账双字段、Next 非空、Verified 覆盖、Open settle-by、close 须同次 checkpoint）与 core slot swap/parked 降级（`WorkspaceLedger.ts:243-284`）都有直测（spec:26-204，含 swap 后 live 恰为 2、parked 恰为 1 的断言）；A 类无超标函数（最大 `applyWorkspaceNote` ~103 行）。

### 31.3 专利新子系统（`clarity/` · `evaluate/` · `claim-chart/` · `problem/` · `retry-hints`）

**模块概况**：23 文件 / ~2589 行（`clarity/` 3 文件 283 行 · `evaluate/` 11 文件 1564 行 · `claim-chart/` 7 文件 406 行 · `problem/atomicChecker.ts` 168 行 · `retry-hints.ts` 68 行）；测试 16 spec。全模块 **0 个 `: any` / `as any` / `@ts-expect-error` / `as never`**，`catch {}` 均有意图注释，分层纪律与纯函数化程度高；债务集中在**未接线的预留导出**、**协议字段冗余**与**同构复制**。

- **TD-PATENT-N16** · `deriveNoveltyCoverage` / `deriveDistinguishingFeatures` 经 barrel 导出但**运行时无人消费**
  - 类别：F · 严重级：P3 · 工作量：M · 状态：new
  - 位置：`src/patent/claim-chart/runtime/mapping-machine.ts:25-35`、`:38-47`；导出 `src/patent/claim-chart/index.ts:9-10`
  - 影响：CLAUDE.md 称 claim-chart「映射状态机（场景合法性 + 新颖性/区别特征推导）」已实现全链路，但全仓引用只有 barrel 再导出与 spec——新颖性单篇全覆盖与三步法区别特征提取的**下游消费（novelty/inventiveness 图节点）没有接线**，即「算得出、没人用」。同批的 `verifyVerdictEnvelope` 与 `src/patent/reasoning/` 按 2026-08-30 note 做了「孤儿/预留 API 显式注释定位」，本条漏在该纪律之外，易被误读为「已生效」。
  - 建议：同款处理——JSDoc 显式写明「预留：接线目标为 novelty/inventiveness 图节点，当前仅测试消费」，或列入接线待办。
- **TD-PATENT-N17** · `ChartRow.state` 是 `mapping` 的冗余同义字段（`RowState = Mapping`），只写不读且随产物落盘
  - 类别：F · 严重级：P3 · 工作量：S · 状态：new
  - 位置：类型 `src/patent/claim-chart/protocol/types.ts:46`、`:55-56`；唯一写点 `src/patent/atoms/handlers/builtin/chart.ts:321`
  - 影响：两字段承载同一语义，必然漂移；`state` 被写进 `claim-chart-<id>.json` 而渲染读的是 `mapping`，`state` 是纯死重。测试里被迫手工同步两处（`gap-detector.spec.ts:8`、`store.spec.ts`），说明该字段已在污染测试夹具。
  - 建议：删除 `RowState`/`state` 与 `chart.ts:321`；若确有「行状态可独立于 mapping」的规划，则补读写两侧并在 protocol 注释说明语义。
- **TD-PATENT-N18** · `loadClaimChart` 只守 `rows`/`elements` 后 `as ClaimChart`；且在 async 路径用 `readFileSync`
  - 类别：B · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/patent/claim-chart/runtime/store.ts:30-42`（守卫 36、cast 37、`readFileSync` 34）；消费者 `src/patent/atoms/handlers/builtin/chart.ts:312-319`
  - 影响：守卫仅查两个数组，随后 `return parsed as ClaimChart`——人工编辑或旧版本文件缺 `gaps`/`claimNos`/`targets` 时仍是「合法 ClaimChart」。当前安全**纯属巧合**（唯一消费者只用 `existing?.rows`）；任何未来读 `loaded.gaps.length`（如规划中的离线审计 API）都会裸 `TypeError`。
  - 建议：守卫扩到 `gaps/claimNos/targets`（缺失即 `return null` + warning），或收窄返回契约为 `Pick<ClaimChart,"rows">`；`readFileSync` 换 `await readFile`。
- **TD-PATENT-N19** · clarity-gate 降级信号依赖「`outputSchema[0]` 字符串前缀」的隐式契约（**降级本身是设计使然**）
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/patent/atoms/handlers/builtin/clarity.ts:112-119`、`:136-139`、`:158-161`、`:170-173`；声明依据 `clarity.ts:13-15`、`CLAUDE.md:151`
  - 影响（**核实结论：三条降级路径都 `return failOpenReport(...)`，从不 throw；`failOpenReport` 在报告前置 `[WORKFLOW_DEGRADED]`，被 `workflow.ts:221` 与 `workflow/executor.ts:112` 识别并归入 `degradedSteps`；有直测**——属写入决策记录的「诚实降级」信条，**不作为缺陷**）。仅两点残留：(1) 降级信号完全依赖「主输出键 = `atom.outputSchema[0]` 的字符串前缀」这一隐式契约——若有人把 `clarity_score` 提到 `outputSchema[0]` 之前（`clarity.ts:46`），degraded 归类会静默失效，而 `clarity.spec.ts:204` 自身并未断言该前缀；(2) 无结构化日志，唯一线索是报告正文里的人读文案。
  - 建议：在 `clarity.spec.ts:204` 补 `assert.ok(out.clarity_report.startsWith("[WORKFLOW_DEGRADED]"))` 把契约钉在该原子自己的 spec 上。
- **TD-PATENT-N20** · P2-4 反馈回流写侧文档漂移：代码已接线，plan 文档仍写「生产接线待宿主侧落地」
  - 类别：H · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`docs/patent-inventiveness-optimization-plan.md:6`、`:270`（陈旧）↔ `src/cli/patentOutputGateFactory.ts:199-206`（生产接线点）、`src/patent/feedback/inventiveness-feedback.ts:76,86,98-102`、`src/patent/graph/README.md:103`
  - 影响（**核实结论：note 写的「已落地」属实，plan 文档未同步**）：`patentOutputGateFactory.ts:199` 已注册 `onDecisionFeedback`，`:206` 调 `findCaseIdBySession(casesRoot, sessionId)` 反查后追加 `inventiveness-feedback.jsonl`。plan 文档两处未回填，形成三份文档两种说法，后续读者会以 plan 为准重开已完成的接线工作。
  - 建议：更新该 plan 第 6/270 行为「已接线（2026-08-31 起）」，并链到 note 与 `graph/README.md:103`。
  - **2026-09-18 处置**：✅ **done（#359 批量回收 · PR #439）**——该 plan 新增「验收状态」段（正文不改，历史快照），段内给出生产接线的**独立复核**证据链：宿主侧接线由提交 `e8ca780b`（2026-08-31，message 原文含 "complete the P2-4 inventiveness feedback loop"）补齐——`src/cli/patentOutputGateFactory.ts:199` 注册 `onDecisionFeedback`、`:206` 调 `findCaseIdBySession(casesRoot, sessionId)` 反查、`:208` 追加写 `caseInventivenessFeedbackPath`，用例见 `tests/patent/feedback/inventiveness-feedback.spec.ts:88,104,130`。该文档唯一未勾选项已回填；同批「不做」清单 5 条可检约束逐条核对未越界。
- **TD-PATENT-N21** · 评测 runner 通过 `registerBuiltinAtoms()` 改写**进程级全局** handler 注册表
  - 类别：D · 严重级：P3 · 工作量：M · 状态：new
  - 位置：`src/patent/evaluate/runner.ts:29-32`、`:65`
  - 影响：`createGraphRunner` 默认 handler 集来自 `registerBuiltinAtoms()` + 全局单例，评测对全局状态产生**副作用**——评测跑过后同进程其它消费者看到的注册表已被填充（且 `includeApproval:false` 只作用于本图构建，全局仍含审批门）。会让测试顺序敏感、并行 spec 互相污染。
  - 建议：提供 `createBuiltinHandlerRegistry()` 返回新实例（或 `registerBuiltinAtoms(target)` 支持注入），评测用隔离注册表。
- **TD-PATENT-N22** · 原子写 tmp+rename 在 patent 域被复制第 4 份；`evaluate/scoreboard.ts` 未复用既有 `persist-utils`
  - 类别：F · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`src/patent/evaluate/scoreboard.ts:148-153`；同域孪生 `src/patent/persist-utils.ts:25-28`、`document/renderPatentDocument.ts:59-62`、`document/stylePreset.ts:33-35`、`src/tool/builtin/patentWorkflowTool.ts:95`
  - 影响：同一「mkdir + tmp(.pid+random) + writeFile + rename」模式在 `src/patent` 下有 **4 处**独立实现（外加 `src/tool` 1 处），差异仅 JSON vs 文本、同步 vs 异步。任何一次修复（`crypto.randomUUID`、tmp 泄漏清理、Windows rename 语义、fsync）都必须记得改 4 处；本处还额外丢了 `persist-utils` 已有的加固。
  - 建议：把 `persist-utils.atomicWriteJson` 泛化为 `atomicWriteText(file, content)` + JSON 包装，四处齐改。
- **TD-PATENT-N23** · `chemistry/index-store.ts` 与 `figure/index-store.ts` 同构复制（**实测 85/179 行逐字节相同**）
  - 类别：F · 严重级：P2 · 工作量：M · 状态：**done（#391）**
  - 位置：`src/patent/chemistry/index-store.ts`（133 行）↔ `src/patent/figure/index-store.ts`（131 行）
  - 影响：两个索引存储除实体名外逻辑完全一致（读容错、版本守卫、逐条 shape 守卫、队列串行化 upsert、损坏备份）。任一侧的 bug 修复必须手工同步，且**事实上已经不同步**：`upsertFigureIndex` 的排序键多了一个附图编号维度（`figure:110`），`isFigureIndexEntry` 多校验两个标量字段——说明「同构」靠人工维护。
  - 建议：抽 `src/patent/shared/index-store.ts`（泛型 + 注入 `keyOf/compare/isValidEntry/notice`），两模块退化为 ~30 行参数化调用；同时消化 N24。
  - 证据：`difflib.SequenceMatcher` 匹配块合计 **85** 行（并集 = 133+131-85 = 179）；`git diff --no-index --numstat` → `46 48`（即 87 行相同），两法一致落在 85–87。逐字节相同块含 `69-76 == 67-74`（`load*Index` 的 ENOENT 与 `readFile` 容错整段）、`114-133 == 112-131`（upsert 尾部 + `backupCorruptIndex` 整段 + 队列声明）。
  - **勘误**：前序快查给的「union 145 行中 65 行相同」与实测有出入，以本行为准。
  - 处置（#391）：新增 `src/patent/shared/index-store.ts`（151 行）导出 `createIndexStore(spec)`，注入 `label / version / keyOf / compare / isValidEntry` 五项**真实域差异**；两侧退化为「域声明 + 薄包装」（chem 83 / fig 81 行），全部导出名、类型名与三处 barrel（`chemistry/index.ts`、`figure/index.ts`、`src/patent/index.ts`）逐字不变。`is*IndexEntry` 留在各自域内。**每个实例自带一份队列**，与收敛前「每模块一份 `upsertQueues`」等价。
  - 等价性证据：两侧既有 15 例（chem 5 + fig 10）在收敛后全部保持绿——它们锁的读容错、版本守卫、逐条过滤、覆盖与排序、并发串行化、备份命名都没变。
  - 判据：`tests/patent/shared/index-store.spec.ts` 11 例（注入点承重 4 / 队列清退与备份核证 4 / 结构判据 3）。**负控制 7 组**逐条核对转红名单，其中 `compare` 不注入 → 仅新 spec 排序 1 例转红，而 fig 既有排序用例保持绿（其数据下「按路径」与「按编号」同序，无法区分）——证明该新用例不是冗余。
  - 决策记录：`docs/notes/implemented/2026-09-16-patent-index-store-convergence.md`。
- **TD-PATENT-N24** · `upsertQueues` 进程级 Map 无淘汰、无删除；`.corrupt-<ts>` 备份无保留策略
  - 类别：G · 严重级：P2 · 工作量：S · 状态：**done（#391，队列侧；备份侧核账后不成立）**
  - 位置：`src/patent/chemistry/index-store.ts:104,116-119,133` 与 `src/patent/figure/index-store.ts:102,114-117,131`（两份同构）；备份 `chemistry:124-130` / `figure:122-128`
  - 影响：`upsertQueues` 以**文件路径**为键长期驻留，`run` 完成后**从不 `delete`**。专利 case 是「每案一目录」，长驻进程（desktop/server 形态）跨大量 case 后 Map 无界增长，每个 value 是一条已 resolve 的 promise 链（含闭包捕获的 entries）无法回收。`backupCorruptIndex` 每次命中损坏索引都 `copyFile` 出 `.corrupt-<Date.now()>`，无清理/上限——反复 upsert 一个坏索引会持续堆积备份文件。
  - 建议：`run.finally(() => { if (upsertQueues.get(filePath) === settling) upsertQueues.delete(filePath); })` 或改 LRU（对照 `TranscriptReader` 的 `TAIL_STATE_MAX`）；备份改为「仅当不存在同名 `.corrupt` 时创建」或限保留 N 份。
  - 处置（#391，队列侧）：改为 `settle` 后**仅在自己仍是队尾**（`upsertQueues.get(filePath) === settled`）时清退该键。无条件 `delete` 会删掉后继的链——后继的 `previous` 指向的 promise 已不在表里，它会与本次**并发**执行，读-改-写竞态回归（负控制实测：该注入精确红在「仅在自己仍是队尾时清退」1 例）。未采纳 LRU：队列的键是「**正在**写」的路径，写完即应消失，且 LRU 会淘汰仍在排队的路径、破坏串行化。
  - 观测手段：实例暴露 `pendingWrites()`（仍有排队写入的文件路径数）。不暴露则该实现选择没有任何外部可观测差异（条目数、产物字节都相同）。语义是「文件数」而非「请求数」——同一文件的 N 次并发 upsert 共享一条队尾链。
  - **核账更正（备份侧不成立）**：「反复 upsert 一个坏索引会持续堆积备份」**不可达**——`upsert` 命中 `warning` 时会 `save` 一份过滤掉无效条目、版本已归一的合法文件，因此第二次 `upsert` 的 `load` 不再产生 `warning`，备份只发生一次；可达的堆积路径需要「两次 upsert 之间由外部把索引重新改坏」。新增判据钉住该性质（连读三次 upsert 一个已损坏索引，目录里恰好 1 个 `.corrupt-*`；负控制：把备份移出 `warning` 门控 → 该例精确转红）。
  - 未做（另行观察，不立项）：仓内三处 `.corrupt-<ts>` 实现语义不同——`CronTaskStore` / `BoardStore` 用 `rename` 把损坏文件**移出原位**后 fail-closed，专利侧用 `copyFile` **保留原位**并继续写入，故不适合抽成同一工具。
- **TD-PATENT-N25** · 测试目录布局与实现目录不一一对应（`clarity`/`problem` 无同名目录，散落为扁平 spec）
  - 类别：E · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`tests/patent/clarity.spec.ts`（235 行）；`tests/patent/{atomic-checker,retry-hints}.spec.ts`
  - 影响：`tests/patent/clarity/` 与 `tests/patent/problem/` **不存在**，而 `evaluate/`、`claim-chart/` 是目录形态。对新加入者「按模块找测试」的心智模型失效。仅布局一致性问题，不影响覆盖。
  - 建议：迁移为同名目录（注意 import 相对深度由 `../../src/` 变 `../../../src/`），或在 `tests/patent/README` 登记扁平 spec 清单。

> **已核实为设计使然而非缺陷（不登记）**：`verifyVerdictEnvelope` 仅测试消费——`evaluate/consensus.ts:156-158` 显式注释「预留离线审计 API…宿主接线前不参与运行时判定」，且 2026-08-30 note 已将「孤儿/预留 API 显式注释定位」记为决策；同理 `src/patent/reasoning/`、`compare` 原子。
>
> **健康面**：`clarity/signals.ts`（机械层）与 `clarity/score.ts`（融合纯函数）职责切得干净——signals 只回答「有没有」、score 只做加权与门判定，`semanticOnly` 是显式字段而非隐式分支；`claim-chart` 的 protocol（纯类型）/runtime（纯函数）/store（唯一 IO）三层堪称模板；`atomicChecker` 与 `retry-hints` **均已真实接线**（`technicalProblemCheck` 被 3 条 `INVENTIVENESS-PROBLEM-*` 规则消费、`buildSlopRevisionHint` 被 `slop-gate` 消费）；A 类无超标函数（最大 `evolve.ts` 293 行/文件，单函数均 <150 行）。测试 19 spec / 117 test 覆盖主链路、边界与降级路径，**零伪测试**。

### 31.4 Agent 循环新增件（`src/agent/loop/` 2026-09 拆解产物 + 元认知/对拍/软提醒）

**模块概况**：9 个新模块 / 2102 行（`turnExit` 185 / `recoveryStrategies` 225 / `modelErrorRecovery` 592 / `responseAssembly` 394 / `modelRequest` 287 / `compactionExecutor` 143 / `metacognitiveControl` 66 / `requestInvariant` 130 / `repeatToolReminder` 80）；配套 9 个直连 spec / 2444 行（**覆盖率 1.16，逐模块均有直连单测**）；零循环依赖、零 `any`、零裸 `console`、零 `TODO`。**拆解运动验收：通过**（见本节末）。（2026-09-16 附注：`requestInvariant` 因 #360 的派发点判据增至 **238 行**；其余模块行数未变。）

- **TD-AGENT-N01** · request_header 的生产对拍器用同一对入参自比，**恒真、检测不到请求漂移**
  - 类别：C · 严重级：**P2** · 工作量：S · 状态：done（#386）
  - 位置：原 `src/agent/loop/AgentLoop.ts:481-485`、`src/agent/loop/requestInvariant.ts:55-104`
  - 影响：该对拍器是「模型可见 = 已记录」在请求侧的**唯一**验证手段（`CLAUDE.md:153`）。原实现给出**虚假保证**——比对恒等，无法发现「落盘快照 ≠ 实际发送请求」这类真实漂移（如 router 内部 materialize 改写、tool schema 在 `prepareForModel` 后被过滤），审计者会误以为请求侧已受保护。
  - 处置：**点位与判据分开重做**（台账建议的两个方向经核码后均需修正，见下「口径更正」）。
    - 点位：新增 `RouterExecuteContext.onDispatchRequest`，router 在两条派发路径（`enabled` attempt 循环、`enabled:false` 直通）**送出首字节前**报出实际请求 + 该 attempt 有效决策 + 实际施行的改写标签（`RouterTransformTag`，7 个）。
    - 判据：`requestInvariant.verifyDispatchedRequest` 要求「落盘快照与派发请求的字段差异 ⊆ 标签声明字段集」，未声明的改写 fail-loud。标签→字段映射由 `Record<RouterTransformTag, …>` 强制穷尽（漏登记字段 = 编译失败）。
    - `AgentLoop` 不再自比；仅在 `SATI_VERIFY_REQUEST_RECONSTRUCTION=1` 时经 ctx 提供回调（未开启零开销）。**快照的落盘时机与内容未变**（pre-send 落盘是 `TaskResumeScanner` (a) 形态判定的 durable 基础）。
  - 证据：负控制（判据在承重）——往 `applyDecisionToRequest` 注入一处未声明的静默系统提示改写 → `tests/agent/loop/request-dispatch-verification.spec.ts` 走**真实路由链路**的用例转红（回合以 `stop_failure` 收尾，消息点名 `systemPromptDigest`），还原后复绿；接线层常驻负控制：同一处未声明漂移，开关关时回合正常完成、开关开时失败。新增 3 个 spec（判据 12 例 / 派发报告 6 例 / 生产接线 4 例），相关目录 417 例全绿。决策记录 `docs/notes/implemented/2026-09-16-request-dispatch-verification.md`。
  - **口径更正（核码后，与原文两处不同）**：(1) 台账与 issue 推荐的方向 A「生产改用 `verifyRequestReconstruction`」**修不了这个洞**——该函数内部仍是 `verifyRequestHeaderSnapshot(entry.header, request, decision)`，期望值仍由同一对入参派生，落盘条目也是同一对入参算出的；换过去只多一项「落盘—读回」序列化保真。原文称它「真正有牙齿」是核码前的判断。(2) 顺带发现 `RouterDecision.requestPatch` **全仓零写入点**（`RouterRequestPatch` 的 `tools`/`systemPrompt` 分支从未生效）、`RouterMutationsLog` 的 `systemPromptSlim`/`toolsStripped` 也只在类型里存在——本 PR 未清理，映射表已预留 `requestPatch:*` 标签，一旦真有生产者对拍会立即要求同步声明。
- **TD-AGENT-N02** · `CLAUDE.md:165` 的 AgentLoop 拆解声明与代码实际不符（**三处**）
  - 类别：H · 严重级：**P2** · 工作量：S · 状态：new
  - 位置：`CLAUDE.md:165`
  - 影响：该条是拆解运动的验收声明，也是新人与审计的入口。声明不实会让第二次拆解（6 模块 / 1828 行）在文档层「隐身」，后续维护者不知道新边界存在，回归到直接在 `AgentLoop.ts` 里加逻辑的老路。
  - 建议：补记 2026-09-14 的 6 个模块（`turnExit`/`recoveryStrategies`/`modelErrorRecovery`/`responseAssembly`/`modelRequest`/`compactionExecutor`）与 4 个 commit；把「4685 行巨型循环」改为当前值；对 `modelErrors.ts` 补专属 spec 或把「各模块配套独立单测」改为「关键模块配套独立单测」。
  - 证据：三处不符——(1) 上述 6 个模块名在 `CLAUDE.md` 中逐个 `grep -c` = **0**，`:165` 只列 8 月的 8 件 + 阶段四两件，与 `git log`（`9bf02fa54`/`56b349f81`/`b9d8662a9`/`ddcee1a9d`，均 2026-09-14）不符；(2) 「各模块配套独立单测」对 `modelErrors.ts`（591 行，`:165` 明列为 8 模块之一）不成立——`tests/agent/loop/` 下**无** `modelErrors` 专属 spec；(3) `AgentLoop.ts` 现为 **1133 行**（`wc -l`），非 4685 行。
- **TD-AGENT-N03** · 6 个新模块的类型导出无任何外部消费者（过度导出）
  - 类别：F · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`modelRequest.ts:55`、`compactionExecutor.ts:26,37`、`responseAssembly.ts:69,97`、`modelErrorRecovery.ts:64`
  - 影响：无外部消费者的 `export` 让模块接口面虚胖，误导「这是对外契约」的判断，削弱后续改动自由度。
  - 建议：降为非导出（同 commit `8b80b37d5`「narrow triz module-internal exports」的既有做法）。
  - 证据：逐符号全仓 grep（`src`+`tests`+`ui`，排除定义文件本身）**零命中**——`ModelRequestOptions`、`AutoCompactOptions`、`AutoCompactOutcome`、`SyntheticPromptContinuer`、`ResponseAssemblyOutcome`、`RecoveryHandled`。
- **TD-AGENT-N04** · 请求对拍开关裸读 `process.env`，未进 `ENV_KEY` 集中注册表；开关约定不统一
  - 类别：C/H · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`AgentLoop.ts:483`、`src/env.ts:55-70`
  - 影响：绕过集中注册表意味着该开关不出现在任何 env 清单/文档生成物里；且其真实作用范围与其余开关相悖（见 N01）。开关语义亦不一致：此处 `=== "1"`（显式开）、`ProjectRuntimeRegistry` 的 `TASK_RESUME_ENABLED !== "0"`（默认开）。
  - 建议：登记进 `ENV_KEY` 统一走 `brandEnv`；`src/env.ts:65` 注释补全为 `SATI_METACOGNITIVE_CONTROL_ENABLED`（现写作 `SATI_METACOGNITIVE_CONTROL`，键名缺 `_ENABLED`）。
- **TD-AGENT-N05** · `modelRequest.ts` 引入模块级可变全局 `promptCacheGeneration`（跨会话共享）
  - 类别：D/I · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/agent/loop/modelRequest.ts:38`、`:222`
  - 影响：自称「装配」的模块内出现进程级可变状态，并发多会话时计数交错，单测无法隔离；该值是后续任何「缓存布局变更」判断的潜在依据，一旦有人据它做决策即成隐蔽 bug。当前仅诊断用途，故 P3。
  - 建议：改为 `TurnRuntimeState` 上的 per-turn 计数器，或挪进 `deps`（与 `TokenCapManager` 同构）。
  - 证据：模块顶层 `let promptCacheGeneration = 0`（`:38`）；`:222` `options.previewOnly ? promptCacheGeneration : ++promptCacheGeneration`；模块 JSDoc（`:1-9`）通篇未提该全局。

> **拆解运动验收核查（本次重点）**——结论：**验收通过，但有文档账缺口**。
> - **测试覆盖：通过**。9 个新模块逐个拥有直连 spec，2444 行测试对 2102 行实现；`turnExit.spec.ts`（9.9 KB）、`responseAssembly.spec.ts`（21 KB）、`modelErrorRecovery.spec.ts`（20 KB）体量饱满，非凑数。全组无「`readFileSync` + 正则扫源码」式伪测试。
> - **循环依赖：无**。`src/agent/loop/` 全 28 文件 intra-module DFS 零环；`turnExit ← recoveryStrategies ← modelErrorRecovery/responseAssembly` 为清晰单向分层。
> - **消债实效：真实**，不是搬代码——`turnExit.ts` 的 `terminateTurn` 消灭 ~25 处复制粘贴的终止仪式；`recoveryStrategies.ts` 把双份 max-output/空响应恢复收敛为共享函数（TD-AGENT-101 扩围）；`modelErrorRecovery.ts` 用 `StageOutcome`/`unhandled` 统一了恢复链与装配链的词汇。
> - **唯一未消的债是文档账**：`CLAUDE.md:165` 未登记这 6 个模块（N02），导致第二次拆解在文档层隐身。

### 31.5 方法论组件（`triz` / `bridge-reencode` / `keywordMatch`）

**模块概况**：新组件 2 个 + 共享助手 1 个 / 239 行 TS（`triz.ts` 182、`bridge-reencode.ts` 37、`keywordMatch.ts` 20），外置数据 `data/` 2 个 JSON / 1651 行；测试 3 spec / 226 行。**总评**：新组件严格遵循既有模式（`bridge-reencode` 与 `five-whys` 逐行同构），触发词机制**无重复**（`keywordMatch.ts` 是既有 `hasAnyKeyword` 死代码收敛后的唯一共享实现，9 件组件全部复用同一 `keywordScore`）。**内联大表问题不存在**：TRIZ 数据已外置 JSON（非 `ipc-classifier.ts` 式 779 行内联），`build` 含 `cpSync(data → dist)`，且惰性加载 + 缓存。

- **TD-METHODOLOGY-N05** · `triz` 的数据文件读取无 fail-safe，异常会穿透到请求装配、**打断该轮对话**
  - 类别：C · 严重级：**P2** · 工作量：S · 状态：**done（2026-09-15，PR #377）**
  - 位置：`src/methodology/runtime/components/triz.ts:38-39`、`:56-57`；调用链 `methodologyInjection.ts:40-48` → `modelRequest.ts:156` → `agentSessionConfig.ts:155-159`
  - 影响：`data/*.json` 缺失或损坏（打包裁剪、磁盘/权限异常、JSON 被误改）时，`execute()` 抛出的异常沿注入链一路**无捕获**，**整个模型请求失败**——一个纯辅助的方法论提示变成主链路单点。这与仓内其他「辅助读」的既有约定相矛盾（workspace 账本读、toolContext 账本读均 wrap 为 best-effort）。
  - 建议：`loadMatrix`/`loadPrinciples` 内 catch 后返回空数据并降级到 `triz.ts:9-10` 已声明的「未识别到参数对时回退为 prompt 引导 LLM 自行查表」路径；或把 `inject` 钩子包一层 try/catch。
  - 证据：`triz.ts:38-39` `JSON.parse(readFileSync(path,"utf8"))` 与 `:56-57` 同型，**均无 try/catch**；对照 `modelRequest.ts:71-79` 与 `toolContext.ts:123-126` 的账本读均为 try/catch + 注释「must never block the request」。
  - **2026-09-15 处置（PR #377，`fix(methodology)`）**：两层落地——根因层新增导出 `readTrizData<T>(file)`（失败返 `undefined` → 退化为空矩阵/空原理 → 落到 prompt 引导路径；**失败不写缓存**以便重试，告警**按文件去重**因 `buildLookupLines` 两两查表是 O(n²)）；收口层在 `computeMethodologyAddendum` 内包住 `inject`——该处是全部 8 个 `MethodologyComponent` 的唯一必经点，一处守卫同时覆盖 `modelRequest` 与 `cli` 两条构造链（优于本条建议的 `agentSessionConfig`，那里只是其中一条链上的实现点）。测试：`tests/methodology/triz.spec.ts` 2 条 + `tests/agent/loop/methodologyInjection.spec.ts` 3 条。决策见 `docs/notes/implemented/2026-09-15-low-cost-blockers-batch.md`。
- **TD-METHODOLOGY-N06** · `triz.execute` 偏离既有组件「纯模板」契约，引入 IO 与非确定性
  - 类别：D · 严重级：P3 · 工作量：M · 状态：new
  - 位置：`triz.ts:150-181`（`execute` 内 `detectParamNumbers` → `buildLookupLines` → 条件注入）
  - 影响：既有 7 件组件的 `execute` 全是纯字符串模板（无 IO、无分支、无抛错），注册表与 injector 按纯函数契约调用。`MethodologyComponent` 契约未声明「可读外部数据/可抛错」，未来任何把 `execute` 当纯函数优化或并发批量调用的改动都会踩坑。**属刻意设计且已记录**（`triz.ts:8-10` 注释 + `CLAUDE.md:170`），本项只登记契约口径问题，非缺陷。
  - 建议：查表下沉为 `execute` 之前的纯函数（数据经依赖注入），或在 `MethodologyComponent` 契约显式标注 `execute` 可读打包数据/可抛错。
  - 证据：`five-whys.ts:21-43` / `mece.ts` / `swot.ts` / `pdca.ts` / `fishbone.ts` / `first-principles.ts` / `six-hats.ts` 的 `execute` 均为单条 `return { prompt: ... }` 字面量。
- **TD-METHODOLOGY-N07** · `triz` 每次调用重建原理 Map，且与实际 `paramLabel` 线性查找叠加在 O(k²) 双循环内
  - 类别：I · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`triz.ts:123`、`:117-119`、`:131-141`
  - 影响：绝对开销小（40 条原理、39 个参数），不构成真实性能问题；但违反「每轮重复计算、未缓存检索」的 I 类口径，且与已缓存的 `loadPrinciples` 数组形成「缓存了一半」的不一致写法。
  - 建议：把 `Map<no, TrizPrinciple>` 与 `Map<no, label>` 一并提到模块级缓存（与 `principlesCache` 同处）。
  - 证据：`:123` `new Map(loadPrinciples().map(...))` 每次 `principleNames` 调用都重建，而 `principleNames` 处在 `:131-141` 的 `for improving × for worsening` 双循环内（最坏 k² 次）；`paramLabel`（`:117-119`）每次线性扫 39 项。对比 `loadPrinciples()`（`:53-59`）自身已用 `principlesCache`。

### 31.6 协议 1.8 与跨进程续算（`gateway/protocol` · `session/resume` · `session/transcript`）

**模块概况**：`version.ts` 315 行（2026-09-16 台账化：原 67 行的散文变更表 → `PROTOCOL_RELEASES` + `PROTOCOL_METHOD_VERSION` 数据 + `protocolLedgerIssues()`）、`src/session/resume/` 2 文件 242 行、`src/session/transcript/` 11 文件（`JsonlTranscriptWriter.ts` 546 行）、`src/agent/loop/modelErrors.ts` 591 行；测试 `tests/session/resume/` 1 spec、`tests/session/transcript/` 5 spec、`tests/gateway/` 29 spec。**总评**：协议 1.8 接线完整且门禁正确（`close_project_sessions` 三处守卫/透传/`method_unavailable` 均有专测；协议**方法侧**的门禁原缺失，已由 `pnpm check:protocol-version` 补齐，见 TD-GATEWAY-N01），续算链路只读 transcript、零内存态、单会话失败不阻塞，健壮性设计到位。债务集中在「文档滞后一代」（H 类 4 条）与两处重复/裸 catch。

> **三条线索经核实为清白，予以销项**：
> - **`SATI_CHECKPOINT_EVERY_N_STEPS` 无悬空引用**。全仓唯一命中是 plan 文档的一行删改记录，`src/` 零引用。
> - **metacognitive 的 reconcile/escalate 无半成品残留**。`metacognitiveControl.ts` 全文 66 行 / 3 个纯函数，无相关符号或分支；`design.md:37` 明确「deferred」并入档——**设计使然**。
> - **triz 内联大表问题不存在**（数据已外置 JSON 且 build 拷贝，详见 §31.5）。

- **TD-GATEWAY-N01** · 协议版本表**无门禁**，唯一「覆盖」是弱断言（三个来源靠人工同步）— **done（#388）**
  - 类别：E/H · 严重级：**P2** · 工作量：M · 状态：**done（#388，2026-09-16）**
  - **口径更正（核码结论）**：三份副本的门禁强度并不一致——`methodGuards.ts` 的参数守卫表早已由 `satisfies Record<WsGatewayMethod, ParamSpec>` **编译期**把关，真正完全无门禁的只有 `version.ts` 顶部的散文变更表。**而且它已经漂移两次**：`knowledge_capabilities`（2026-08-06 进入 union，当时常量 1.1）与 `kanban_reorder_columns`（2026-08-26 随 Phase 5.1「列拖拽排序」进入，当时常量 1.5）从未登记——issue 预言的后果**已经发生过**，只是没人发现。
  - 处置：散文变更表升级为机器可读台账（`PROTOCOL_RELEASES` 记变更理由 + `PROTOCOL_METHOD_VERSION` 记「方法 → 引入版本」，`satisfies Record<WsGatewayMethod, GatewayProtocolVersion>` 双向把关，版本常量改为**由台账末条派生**）；新增 `pnpm check:protocol-version`（`scripts/check-protocol-version.ts`，挂 `pnpm lint` 链尾）——AST 重提 union 成员做两向集合相等 + 守卫表覆盖 + `protocolLedgerIssues()` 版本连续性；两处历史漂移按**引入时点**回溯登记（1.1 / 1.5，故本次**无需 bump**）；`discovery-protocol.spec.ts:91` 的白名单 `includes` 换成字面量强断言，`steer-protocol.spec.ts:52-53` 的 `startsWith("1.")`+自比换成「常量 === 台账末条」与跨版本兼容语义。
  - 证据：负控制把两处登记从台账摘掉 ⇒ 编译期 `TS1360` 与运行期门禁**各自**逐条点名这两条；再把台账的 `satisfies` 改写成 `as` 绕过编译期 ⇒ typecheck 转绿而运行期门禁仍红（证明后者非冗余）。决策记录 `docs/notes/implemented/2026-09-16-protocol-version-gate.md`。
- **TD-GATEWAY-N02** · 「新方法登记在**当前**版本而不 bump」无法判定（协议版本门禁的残余缺口）
  - 类别：E · 严重级：**P3** · 工作量：S · 状态：new
  - 位置：`src/gateway/protocol/version.ts`（`protocolLedgerIssues`）、`scripts/check-protocol-version.ts`
  - 影响：`PROTOCOL_METHOD_VERSION` 已堵住「漏登记」，但若把新方法登记在**已发布**的当前版本上（如 1.8）而不 bump，台账自洽性仍然成立 ⇒ 旧客户端会被告知 1.8 就有该方法。判定「当前版本已发布」需要第二事实源（git tag / 上一个 `package.json` 版本 / 已提交的冻结基线）。
  - 建议：与发布流程合并考虑——`scripts/bump-version.mjs` 只管 `package.json`，可在发布/tag 时把当时的台账快照冻结成 `docs/` 产物，再由门禁比对快照的**已发布部分**。**不得**用「生成器产基线」糊弄：生成物由台账算出即恒真（#360 的教训）。

- **TD-SESSION-N08** · 「写入即落盘 / `flushCheckpoint` 为契约性 no-op」在 **4 处文档**已过时一代
  - 类别：H · 严重级：P3 · 工作量：S · 状态：new
  - 位置：待更新 4 处 —— `CLAUDE.md:154`、`docs/cross-process-retry-resume-plan.md:27`、`:128`、`docs/deepseek-harness-phase4-plan.md:413`
  - 影响：该表述直接影响「崩溃会丢多少数据」的判断——按旧文档理解失败窗口是 0；按新实现，**无显式 checkpoint 时最多丢 64 KB 或 50 ms 内的 pending 条目**。审计/值班人员据此评估 durable 语义会得出错误结论。
  - 建议：4 处统一改为「批写（阈值 64 KB / 兜底 50 ms，`SATI_TRANSCRIPT_FLUSH_THRESHOLD_BYTES` 可调）+ 显式 `flushCheckpoint` durable 边界（工具副作用前 await，fail-closed）」。
  - 证据：`JsonlTranscriptWriter.ts:44-51` 新增 `flushThresholdBytes`（默认 64 KB）/`flushIntervalMs`（默认 50 ms）；`:133-149` `flushCheckpoint` 已是真 flush（JSDoc `:127-132` 自述「M3 后为真 flush」）；`:287-296` `recordEntry` 明确「M3 写缓冲：条目序列化后入队（**不立即落盘**）」，落盘时机 4 条。
- **TD-SESSION-N09** · `CLAUDE.md:154` 声称的「resume-journal 防重」机制**不存在**，且已被计划文档明确否决
  - 类别：H/F · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`CLAUDE.md:154`；决策依据 `docs/cross-process-retry-resume-plan.md:214`
  - 影响：文档描述了一个不存在的持久化幂等机制，会让后续维护者以为「跨启动防重有持久化保证」而省掉必要检查——实际只有进程内 `Set` + transcript 状态自推进（崩溃在两次扫描之间则依赖 transcript，语义不同）。
  - 建议：删除 `CLAUDE.md:154` 括注中的「+ resume-journal 防重」。
  - 证据：全仓 `grep -ri journal src/` 无该机制（仅无关的 sqlite `journal_mode`）；plan 决策表原文「resume-journal 幂等（`.sati/resume-journal.jsonl`）→ **不需要** → 防重靠 transcript 状态 + 内存 `submittedKeys`」，代码即 `TaskResumeScanner.ts:96` + `:77-79` + `:83-90`。
- **TD-SESSION-N10** · 启动续算扫描对项目全部会话做**无上限全量转录读**
  - 类别：I · 严重级：P3 · 工作量：M · 状态：new
  - 位置：`src/session/resume/TaskResumeScanner.ts:63-67`、`:75-97`
  - 影响：gateway 启动后 3 s 对所有会话**串行**逐个 `readTranscript` 全量读盘+解析。会话数/转录体量大时形成启动期 IO 与内存峰值；M5 注释已识别该风险但只做延时错峰，未做限流或分页。
  - 建议：`listProjectSessions` 传 `limit`（分页/按 mtime 取近期 N），或给扫描加并发上限与总量预算。
  - 证据：`TaskResumeScanner.ts:63-67` 调用 `listProjectSessions({ projectRoot, pilotHome, includeInternal: false })`，**未传 `limit`**；对照 `SessionList.ts:68`（`limit?: number`）与 `:131-134`（`paginateSessions` 支持 `limit/offset`）——**能力已有，调用方未用**。
- **TD-SESSION-N11** · `findOpenTurn` 与 `findOpenRequest` 是同一括号平衡逻辑的**两份实现**
  - 类别：F · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/session/transcript/interruptedTurn.ts:34-55` 与 `:156-186`
  - 影响：同一文件内两份「按 turnId 跟随、遇 `turn_result` 清空候选」的游标逻辑，差异只在活动条目集合与返回粒度。`retry_schedule` 新增条目类型时这类「活动集合」语义一旦需要调整，必须同步改两处，漏改即出现 turn 级与 request 级判定不一致。
  - 建议：抽 `scanOpenTurn(entries, isActivityEntry)` 共享遍历，两级各自做投影。
- **TD-SESSION-N12** · 2 处无注释裸 `catch`（`session/transcript` 内唯一未收束项）
  - 类别：C · 严重级：P3 · 工作量：S · 状态：done（2026-09-18，PR #434）
  - 位置：`src/session/transcript/TranscriptReader.ts:343`、`:425`
  - 影响：按 `README.md:57` 判定口径，这 2 处属「无注释隐患类」。危害有限（两函数 JSDoc 已述回退语义，且回退方向保守），但与本组其余代码的纪律形成可见落差。对照 `src/agent/loop/` 的 7 处裸 catch **全部**带意图注释。
  - 建议：补「失败模式 → 回退语义」单行注释。
  - **2026-09-18 处置**：✅ 由 #353 第二段（PR #434）补注释还清——`:344`（`readFirstBytes` 的 open/read 失败 → 返回 undefined，本轮不判定替换、续用缓存条目）与 `:427`（末段 JSON 解析失败 → 判为非完整行，`extractTrailingTail` 保留原始字节待下轮拼接）。附带发现：`:332` 的函数 doc 写「失败返回 undefined → 调用方保守全量」，而唯一调用方（`:166-172`）实际只刷新 `lastVerifyAt` 并续用缓存条目、**不**触发全量重读——陈旧 doc 或调用方既存缺陷，属另一件事，本轮未改代码，登记待查。
- **TD-SESSION-N13** · `synthesizeInterruptedTurn` 返回的内存条目与落盘条目 `entryId` 不同（注释宣称「一致」只对 sequence 成立）
  - 类别：C · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/session/transcript/interruptedTurn.ts:124-133`（`:130` 自生成 `entryId`）对照 `JsonlTranscriptWriter.ts:535`（`baseEntry()` 再生成一个）
  - 影响：当前无消费者按 `entryId` 关联两份条目，故无实际故障；但幂等键若将来改用 `entryId`，或做「内存投影 vs 落盘」对账时会失配。注释 `:100-103` 的「一致」承诺不完整（只覆盖 sequence）。
  - 建议：让 `synthesizeInterruptedTurn` 接受/回传 writer 生成的 `entryId`；否则把注释限定为「sequence 与 parentEntryId 一致」。
- **TD-SESSION-N14** · `RetryStateTracker` 仍是 test-only 死代码；计划文档「保留」决策的理由**循环论证**、且行号引用已漂移
  - 类别：F · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`src/model/streaming/retryState.ts:124-158`（全文件 158 行）
  - 影响：类占据末尾 35 行，其唯一「消费者」是自己的测试。这构成一个**循环论证的保留决策**：plan 文档 `:212` 以「有测试覆盖…非死代码」为由推翻 `:75` 的删除建议，而测试恰恰是死代码自身带来的。台账口径若接受这种论证，任何死代码只要配一个自测即可免于清理。另 plan `:40` 与 `:75` 对同一事实给出互斥结论。
  - 建议：二选一——按原议删除（`retry_schedule` 条目 + 事件钩子已承载重试轨迹）；或真正接入为 `RetryJournal`（消费方存在后再保留）。同步修正文档行号（`:40`/`:75` 引用 `retryState.ts:66` 与实际 `:124` 不符）并统一三处口径。
  - 证据：全仓 `grep -rn RetryStateTracker src tests docs` 仅 2 处命中——定义处与 `tests/model/streaming/retry-state.spec.ts:30-31`，**`src/` 内无任何生产调用点**。同文件其余导出**均有**生产消费者（`createRetryId`、`RetrySchedule`、`createPolicyKey`/`normalizeRetryReason`），故仅该类是死代码。

> **健康面（值得留存的做法）**：① 类型与日志纪律极佳——`src/agent/loop/` 28 文件零 `any`、零裸 `console`、零 `TODO`；`src/methodology/`、`src/session/transcript/`、`src/session/resume/` 同为 0。② 裸 `catch` 几乎全部带「失败模式 → 回退语义」意图注释，`methodology/` 与 `gateway/protocol/` 为 0 裸 catch。③ 续算链路设计克制——只读 transcript 零内存态、`(b)` 形态与挂起审批显式跳过、单会话失败不阻塞且注释说明。④ TRIZ 数据外置 + build 拷贝 + 惰性缓存，主动避开了仓内已知的 `ipc-classifier.ts` 内联大表反模式。⑤ 协议 1.8 的「未实现显式报错、不降级 `not_configured`」例外有专测锁定（`dispatch.spec.ts:198,217,241`）。

---

## 32. 2026-09-14 全仓复扫（度量口径与治理基建）

> **背景**：§31 为盲区补审。本节登记**全仓横切复扫**发现的一类不同性质的债务——不是某个模块的实现问题，而是**债务治理体系自身**的缺陷：度量口径漏项、基线失真、门禁空转。这类债的共同特征是「让前 31 节的优先级排序建立在不可信的数据上」。

- **TD-METRIC-001** · `measure-techdebt.mjs` 漏统计 `as unknown as`（**329 处**最强类型逃逸隐形）
  - 类别：B/H · 严重级：**P1** · 工作量：S · 状态：new
  - 位置：`scripts/measure-techdebt.mjs:~208`（`scanTypeEscapes`）
  - 影响：`scanTypeEscapes` 只统计 TS AST 的 `AnyKeyword` 节点与 `@ts-*` 指令，完全漏掉 `as unknown as X` 双重断言——而它比 `any` **更强**（绕开全部类型检查，`any` 至少会传染且能被 lint 捕获）。后果是「类型纪律很好」的印象（`any` 仅 3 处）与「329 处绕开类型检查」的实际并存，**仪表盘在误导排期决策**。这也解释了为何 §1–§30 的类型债清单长期只有 TD-TYPE-002 一条。
  - 建议：在 `scanTypeEscapes` 增加 `AsExpression` → `TypeReference` 名为 `unknown` 的检测分支，计入**独立指标** `asUnknownAs`（不要与 `any` 合并——治理成本与语境不同）；同步更新 `README.md` §指标口径说明 与 `metrics.md` 表头。
  - 证据：实扫 `grep -rEn 'as unknown as' src/ ui/src/ --include='*.ts' --include='*.tsx' | wc -l` → **329**；分布 `tests/tool` 49、`tests/gateway` 46、`tests/agent` 38、`tests/knowledge` 24、`tests/patent` 21、`tests/context` 21、**`ui/src` 19（生产码）**、`tests/session` 16；生产码中值得警惕的是跨层类型未对齐（如 `ui/src/components/chat/hooks/useChatRealtimeHandlers.ts:74` 的 `msg as unknown as NormalizedMessage`，会掩盖协议变更的编译期错误）。
- **TD-METRIC-002** · 债务指标基线无新鲜度校验，`metrics.md` 可长期静默失真
  - 类别：H · 严重级：**P1** · 工作量：M · 状态：new
  - 位置：`scripts/measure-techdebt.mjs`（`--update` 手工触发）；`README.md` §如何保持新鲜
  - 影响：基线由手工命令刷新，无机制保证与工作树同步。**2026-09-14 实证**：基线停在 09-11，而 09 月拆解运动已让报表严重失真——`createLocalGateway.ts` 记 **2696 行**（实测 **448**）、`AgentLoop.ts` 记 **2430 行**（实测 **1134**）、god-function 表中 `createLocalGateway`(607)/`prepareSessionRuntime`(517)/`createReadFileTool`(509)/`handleModelError`(364) **四条已全部不存在**。本次复扫已重跑基线修正（见 `metrics.md`），但不建机制下次仍会重演。
  - 建议：二选一——(a) `measure-techdebt.mjs --check` 模式，重算关键指标与快照比对，不一致非 0 退出，挂 `pnpm lint` 链尾（与 `check:event-matrix`、`check:issue-labels` 同构，仓库已有两个同形态门禁可复制）；(b) 在 `metrics.md` 顶部记录快照 commit SHA，比对「HEAD 之后是否改过 `src/`」并提示。**倾向 (a)**，(b) 的「提醒」在 CI 中容易被忽略。
- **TD-METRIC-003** · 指标口径缺口：空 catch 漏 `ui/server`；vendored 子包污染文件级排名
  - 类别：H/D · 严重级：P2 · 工作量：S · 状态：**done（#390）**
  - 位置：`scripts/measure-techdebt.mjs`（`productCatchFiles` / `SCOPE_DOC.catch` / 新增 `VENDORED_SUBTREES`·`isVendored`）；`src/context/memory/edgeclaw-memory-core/`
  - 处置：① `productCatchFiles` 纳入 `uiServerScan`，`SCOPE_DOC.catch` 同步改写（`catchEmpty` 与 `catchNoParam` 共用该集合 ⇒ 两者一起含 `ui/server`，正是要消除的自相矛盾）；② 新增导出 `VENDORED_SUBTREES = ["src/context/memory/edgeclaw-memory-core"]` 与 `isVendored()`，`src/` 先取全量再分流，vendored 组进入新的 `vendored` 分组并在 `metrics.md` 单列一节（规模 + 自身 Top 5 + ≥300 行函数数）；③ 顺带把 `godFunctions` 从 `main()` 移入 `measure()`，三条 CLI 路径（`--json`/`--check`/`--update`）拿到同一份结果，函数级与文件级指标不再各持一份文件集。
  - 口径更正（第一处）：issue 引用的「catch = `src + ui/src` 产品代码」是**如实声明**（`docs/code-refinement-plan.md` §六 基线表口径），故这不是「实现与文档不一致」，而是**口径本身选错了**——它声称描述「本项目维护的代码」，却把 105 文件 / 31K 行的本仓后端整体排除。处置方向因此是改口径，而不是改文档迁就。
  - 口径更正（第二处）：issue 把 `lib/`（编译产物）与 `ui-source/app.js`（2324 行）也列为污染源，实测**两者自脚本首版 `4d83bda7f` 起就由 `EXCLUDE_DIRS` 的目录名豁免覆盖**（`app.js` 从未进过 Top-30）；真正在污染的只有 `src/` + `tests/` 下的 **49 个 `.ts` / 16,682 行**（占 `src` 行数 9.0%）。issue 另记「Top-30 表有 4 项来自该子树」，实测为 **3 项**（`dream-review.ts` 1046 行已跌出 Top-30）。
  - 一次性跳变（跨此日期同比须按同口径重算）：空 catch `0 → 1`；无参 catch `517 → 684`（+175 `ui/server` − 8 vendored）；其中无注释隐患类 `40 → 124`（+84 `ui/server`，vendored 那 8 处均已带注释）；`as unknown as` `27 → 26`；src TS `1078 / 186146 → 1029 / 169464`；两张排期表各减 3 席。
  - 连锁影响：**#353 的治理目标按新口径为 124**（`ui/server` 持 84），其「回升超过 45 即立项专项」的触发条件随之满足——已在该 issue 留结论评论。是**口径变更而非新增债务**。
  - 负控制（4 组注入，逐条核对转红名单，相邻用例保持绿）：① 清空 `VENDORED_SUBTREES` ⇒ 清单守卫 / `isVendored` 命中 / Top 大文件 / God function / 单列 / 规模 6 例转红，而「路径段匹配不误伤」与「catch 含 ui/server」保持绿；② `isVendored` 退回**字符串前缀**匹配 ⇒ 仅「不误伤 `edgeclaw-memory-core-extra`」1 例转红；③ catch 口径回退成 `src + ui/src` ⇒ 仅 catch 用例转红；④ 单列侧 `godFunctionCount` 写死 0 ⇒ 仅「单列而非消失」1 例转红。
  - 判据同源修正（**负控制实测抓到**）：首版「Top 大文件不含 vendored」用被测实现导出的 `isVendored()` 来筛，与实现同源 ⇒ 注入「清空清单」时 `filter(...) === []` 恒真、判据根本不红。改为判据侧自带独立前缀字面量（`VENDORED_PREFIX`），并补一条绑定用例拦两侧漂移。
  - 决策记录：`docs/notes/implemented/2026-09-16-metric-scope-fix.md`（含 8 条备选）。
- **TD-METRIC-004** · 两张排期表含测试文件（排期对象混入）
  - 类别：H/D · 严重级：P3 · 工作量：S · 状态：new
  - 位置：`scripts/measure-techdebt.mjs` 的 `godFunctions` 与 `topFiles` 文件集（`src + ui/src` 全量 `.ts/.tsx`，未区分产品代码与测试）
  - 影响：两张排期表都把测试文件当作本仓产品代码参与排名——God function 表 3 项匿名箭头函数（`MessagesPaneV2.render.test.tsx` 842 / `processGrouping.test.ts` 409 / `CronV2.test.tsx` 384），Top 30 大文件表 1 项（`MessagesPaneV2.render.test.tsx` 1013 行，本次 `TD-METRIC-003` 把 vendored 移出后才补位进榜、此前被挤出可见）。它们不是「待拆函数 / 待拆文件」，却与真实条目并列，读表者无从分辨。与 `TD-METRIC-003` 同型（口径未区分产品代码与测试代码），但**不是同一件事**：测试文件属于本仓、只是不在排期范围内，故未并入 #341 的 PR。
  - 建议：两处文件集改用与 catch 相同的「产品代码」口径（排除 `*.spec.*` / `*.test.*`）；若认为测试内的超长回调本身也值得治理，应**另立指标**而非混入这两张表。
  - 触发条件：下次改动 `measure-techdebt.mjs` 的扫描范围时顺带处理（boy-scout）。
- **TD-PROCGATE-001** · PR 追溯门禁被 PR 模板自带 HTML 注释**恒真通过**（门禁空转）
  - 类别：C/E · 严重级：**P1** · 工作量：S · 状态：**done（2026-09-15 复核：已由 `cfffe6ae3` 修复，issue #332）**
  - 位置：`.github/scripts/check-pr-issue.mjs` × `.github/PULL_REQUEST_TEMPLATE.md`
  - **2026-09-15 复核**：`check-pr-issue.mjs:54-55` 已加 `HTML_COMMENT = /<!--[\s\S]*?-->|<!--[\s\S]*$/g` 并在判定前剥离（按 CommonMark 把未闭合注释一并剥离到文末，堵住「复制模板后误删 `-->`」的残余路径）；`check-pr-issue.test.mjs` 用例数 10 → **19**。本条目原登记已不成立，仅留存历史。
  - 影响：门禁是纯正则匹配、**不剥离 HTML 注释**，而 PR 模板的注释里字面写着 `` `Closes #123` `` / `` `Fixes #123` `` 作为填写提示——于是**任何用仓库 PR 模板创建的 PR 都无条件通过**，包括完全没有关联 issue 的 PR。同源问题：`BARE_NUMBER = /#\s*[0-9]+\b/` 使裸 `#1` 即通过；`EXEMPT` 中裸 `n/a` 会命中模板「测试计划」表格里的 `N/A`，豁免口子过宽；`check-pr-issue.test.mjs` 的 10 个用例**没有一条使用真实模板文本**，缺「模板原样 body 必须失败」的负控制——所以这个 bug 能长期存活。
  - 建议：匹配前先剥离 HTML 注释（`body.replace(/<!--[\s\S]*?-->/g, "")`）再走四路判定；补一条以真实模板为输入的负控制用例。
  - 证据（实跑复现）：`PR_BODY="$(cat .github/PULL_REQUEST_TEMPLATE.md)" PR_TITLE="chore: 随手改点东西" node .github/scripts/check-pr-issue.mjs` → `✓ PR 已通过可追溯门禁（检测到 issue 引用）`，`exit=0`。
- **TD-PROCGATE-002** · `test:pr-tooling` 无任何挂载点，三个门禁负控制测试在 CI 中**从不执行**
  - 类别：E · 严重级：P2 · 工作量：S · 状态：**done（2026-09-15，PR #377）**
  - 位置：`package.json:39`；`.github/workflows/ci.yml:57`
  - 影响：`test:pr-tooling` 定义后无任何调用方（CI 不跑、`pnpm lint` 不跑、hooks 不跑），而 CI 的 `quality` job 只单独跑 4 个测试文件中的 1 个。**门禁本体在 CI 里（`check:issue-labels` 挂 `pnpm lint`），但门禁的测试不在**——`sync-labels.test.mjs`（标签门禁的**全部**负控制）、`classify-issue.test.mjs`（含「不得越界读契约影响节」负控制、CLI 行协议回归）、`open-pr.test.mjs` 永不运行。负控制失效意味着门禁哪天被改坏也无人拦。
  - 建议：在 `ci.yml` 的 `quality` job 增加 `pnpm test:pr-tooling` 步骤（替换或并列于现有只跑单文件的 `Self-test PR traceability gate`）。
  - **2026-09-15 处置（PR #377，`ci`）**：采用「替换为整体挂载 `pnpm test:pr-tooling`」方案，并把该步骤从 install **之前**移到**之后**（`measure-techdebt.test.mjs` 依赖 `typescript`，install 前跑不起来）。整体挂载使今后新增的脚本测试自动进 CI。CI 日志已确认该步骤在 `quality` job 中执行（83 用例）。
- **TD-PROCGATE-003** · `tech_debt.md` 模板缺「影响 scope」节 → 债务议题**拿不到 `scope:*`**
  - 类别：F/H · 严重级：P2 · 工作量：S · 状态：**done（2026-09-17，PR #408）**
  - 位置：`.github/ISSUE_TEMPLATE/tech_debt.md`
  - 影响：三个模板中它是唯一没有「影响 scope」节的，而 scope 自动打标**完全依赖解析该节**。后果：**所有技术债议题零 scope**（实况证据：`#164 #163 #162 #161 #160 #153 #206` 七个 tech-debt 来源议题**全部只有 `tech-debt` 一个标签**），无法按模块筛选、无法统计「债务按模块分布」——而技术债恰恰最需要按模块归类。`docs/issue-management.md` §1 却称作用域是「自动」的。且 `sync-labels.mjs --check` 的「模板 scope 勾选 ↔ 标签双向一致」校验**天然覆盖不到**该模板，缺口不会被门禁发现。
  - 建议：补上与 bug/feature 逐字一致的「## 影响 scope」节；**附带**补「## 契约影响」节（债务修复若触及 `inputSchema`/事件面/协议同样需前置声明）。
  - 判据：`tech_debt.md` 补「## 影响 scope」节（17 项勾选，与 `bug_report.md` / `feature_request.md` 逐字一致）与「## 契约影响（重要）」节
    （6 项，取 `feature_request.md` 口径——债务修复同样可能触及 i18n 文案与 UI 渲染，`bug_report.md` 的 4 项版不含这两条）。
    **门禁覆盖实证**：补节后三条模板全部进入模板间比对；临时从 `tech_debt.md` 删去 `patent` / `desktop` 两行 →
    `--check` 退出码 1 并逐条点名「缺勾选项「patent」（与 bug_report.md 不一致）」，还原后恢复绿（证明该模板不再游离于校验之外）。
    **分类器 dry-run**：对模板体勾 `patent`+`desktop` → 产出 `scope:patent` `scope:desktop` `status: triage`；勾满「契约影响」节 → 零标签（不越界读取）。
    ⚠️ 本项还清后暴露一处**新盲区**（记入 `docs/issue-management.md` §2 诚实边界）：**「模板缺整节」不被任何校验发现**——缺的那节连比对对象都不存在，
    故本项在补节前不会被任何门禁报警。附带建议的「契约影响」节则**至今无模板间校验**（它不产生标签、无下游消费者），
    三条模板的该节选项已漂移（4 项 vs 6 项）且不会红——是否给 `bug_report.md` 补齐两项未决。
- **TD-PROCGATE-004** · stale 豁免清单与分诊目标**互相抵销**（`priority: p0/p1` 与 `triage` 议题 120 天后静默关闭）
  - 类别：D · 严重级：P2 · 工作量：S · 状态：new
  - 位置：`.github/workflows/stale.yml:35` × `docs/issue-management.md` §3/§5/§6
  - 影响：豁免清单 `status: in-progress,status: blocked,good first issue,help wanted,pinned` **不含 `status: triage`、不含 `priority: p0/p1`**。后果：一个从未被分诊的议题 90 天后标 `stale`、再 30 天**自动关闭**（无人看管的议题不是被提醒而是被归档）；更严重的是 `priority: p0`/`p1` 按定义是「堵塞/主链路明显受损」，**若未推进到 `in-progress` 也未挂 milestone，同样 120 天后被关**。这与规范 §3「不让任何议题停在 `triage` 无人看管」在机制上互相拆台。
  - 缓解关系：`exempt-all-milestones: true` 意味着**挂 milestone 的议题天然豁免**——所以本批债务 issue 挂 `v0.2.0` 即受保护，但未挂 milestone 的独立高优缺陷仍暴露。
  - 建议：优先考虑把 `priority: p0,priority: p1` 加入豁免（高级别议题不该因无人推进而消失）；或在规范 §6 明确写「`triage` 超 120 天会被归档，这是设计而非疏漏」，并让 §5/§6 不再逐字重复同一份豁免清单（重复导致一致性检查发现不了语义冲突）。
- **TD-PROCGATE-005** · `scope` 分类器与规范三处不符（摘掉会打回 / 与提交 scope 不同名 / 词表第三份）
  - 类别：D/H · 严重级：P2 · 工作量：M · 状态：**done（2026-09-16，PR #395）**
  - 位置：`scripts/classify-issue.mjs:22-24`；`scripts/open-pr.mjs` `KNOWN_SCOPES`；`.github/labels.yml`；`docs/issue-management.md` §5
  - 影响：(1) 「自动打错的标签人工摘掉即可、脚本不会再打回」对 `scope:*` **不成立**——`classifyIssue()` 每次从 body 重推，人去摘掉后下一次 `edited` 事件会加回来；(2) 「`scope:*` 与提交 scope 同名」**不成立**——实测提交 scope 中 `adapters`/`desktop`/`context`/`ui-server`/`board`/`techdebt`/`session`/`task`/`extension`/`telemetry`/`pr`/`pilot`/`code-refinement`/`deps` 共 14 个**无对应标签**，一个 `refactor(adapters)` PR 无法被任何 `scope:` 筛选；(3) scope 词表已有**三份**（`labels.yml` 16 个 / `open-pr.mjs` `KNOWN_SCOPES` / 模板勾选项）。
  - 建议：修正规范表述或让分类器记录「已人工摘除」状态；确定 `labels.yml` 为唯一事实源并补齐提交侧高频 scope；`open-pr.mjs` 的 `KNOWN_SCOPES` 改为从 `labels.yml` 派生。
  - **2026-09-16 处置（PR #395，`scope:other`）**：三条建议里采纳第 3 条（`KNOWN_SCOPES` 改为从 `labels.yml` **派生**，
    规模仍为 21 项、行为零变化；`COMMIT_ONLY_SCOPES` 显式声明并被 `duplicateScopeDeclarations()` 约束不得与标签重叠），
    第 2 条只走「确定唯一事实源」这一半（词表契约定为**单向包含**：`scope:*` ⊆ 提交词表、反向不成立），
    第 1 条走「修正规范表述」（**否决** issue 建议的"记录已摘除状态"与"对称化自动摘除"两条实现路径，理由见决策记录）。
    同时把「模板之间勾选项必须一致」**新增进** `pnpm check:issue-labels`——GitHub 无法共享模板片段，
    同一份清单在两条模板里各存一份，而既有校验只比对模板**并集**，此前「只改一条模板」无任何门禁。
  - **核码更正**（正文为当日快照，已漂移）：① 提交 scope 频次实为 `main` 全历史 2628 提交的
    `ui 233 / patent 133 / agent 91 / desktop 61 / …`，去重约 **180 个取值**（正文记的 14 个是子集，且量级与截断快照不符）；
    ② **PR 从不打 `scope:*` 标签**（无任何生产者），受影响的只有 issue 侧筛选，原文「一个 `refactor(adapters)` PR 无法被筛选」措辞失真；
    ③ 正文候选清单（`adapters`/`desktop`/`context`）与 §35 的候选清单（`ci`/`scripts`/`desktop`/`ui-server`/`adapters`）**互不一致**
    ⇒ 分类学本身未定，本轮不照任一清单补齐。
  - 判据：`scripts/open-pr.test.mjs` 新增「提交 scope 词表由清单派生」9 例（含判据侧**独立**读清单的真值 + 绑定用例 +
    "other 不进词表" + 提交独有表不得与标签重叠）；`scripts/sync-labels.test.mjs` 新增模板间比对 5 例；
    `scripts/classify-issue.test.mjs` 新增投影语义 3 例。负控制 7 组注入（派生漏项 / 提升为标签后忘删旧声明 / `other` 混入 /
    停用模板间比对 / 比对改单向 / 分类器"有标签即短路" / 越界产出 `priority:`）红名单与预测**逐条相等**，相邻用例保持绿。
  - 副作用：`scope:desktop` 按成文判据补为标签（`apps/desktop` 是独立 workspace 包 + 独立 CI job + 独立发布文档），
    须**人工**跑一次 `node scripts/sync-labels.mjs` 同步实体；`feature_request.md` 的「影响 scope」节此前未记入
    规范 §2 表格，一并补上。决策记录：`docs/notes/implemented/2026-09-16-scope-vocabulary-contract.md`（含 10 条备选）。
- **TD-PROCGATE-006** · `status: done` 禁令与 `priority` 取值**无枚举门禁**兜底
  - 类别：E · 严重级：P3 · 工作量：S · 状态：**done（2026-09-16，PR #405）**
  - 位置：`scripts/sync-labels.mjs:153-156`
  - 影响：`labels.yml` 与规范宣布「不设 `status: done`」，但 `validateLabels()` 对前缀标签**只校验「前缀后非空」**，不校验取值集合——往 `labels.yml` 加一条 `status: done` 或 `priority: p9`，`pnpm check:issue-labels` **放行**。`scope:` 有双向校验保护，**只有 `status:` 与 `priority:` 裸露**。同时 `priority:*` 全链路无自动化（模板无字段、workflow 不写、门禁不校验），「定级」可被整体跳过且无人发现。
  - 建议：`validateLabels()` 增加取值枚举断言（`status:` 仅 `triage`/`in-progress`/`blocked`；`priority:` 仅 `p0..p3`），取值集合注释出处避免第四份词表；补 `sync-labels.test.mjs` 负控制。
  - 判据：`validateLabels()` 新增 `PREFIX_VALUES` 词表断言（`scope:` 刻意不入表——由模板双向校验兜底，再抄一份即第四份词表）；
    `sync-labels.test.mjs` 新增 4 例（`status: done` / `priority: p9` / `priority: urgent` 三条负控制 + 7 条合法取值放行对照 +
    `scope:` 不受词表约束的边界）；**真清单实弹注入**一条 `status: done` → `--check` 退出码 1 并点名越界取值，还原后恢复绿
    （合成输入的负控制不足以证明门禁在真实清单上生效）。两处规范同 PR 登记（`docs/issue-management.md` §1 规则表、
    `docs/development-standards.md` 门禁职责表）。**未做**：`priority:*` 的全链路半自动化（模板「严重级」勾选 + 分类器解析），
    属增量项，已另开 #406 跟踪（不在本项范围内）。
  - **2026-09-18 续（#406 · PR #436）**：✅ 上述增量项**已交付**——`tech_debt.md` 新增「严重级」勾选节（选项文本与 `README.md` §严重级定义同源）、`classify-issue.mjs` 解析该节产出 `priority: pN`（多选取最严重、已有 `priority:*` 不加第二个、认不出的级别原样保留以便门禁拦下）、`sync-labels.mjs` 把两节抽象为 `ENUM_SECTIONS` 表驱动校验（模板↔标签双向 + 模板间一致）。真模板实弹注入两组负控制均报红并点名（`P4 未知档` / 删掉 `P0` 行）。决策见 `docs/notes/implemented/2026-09-18-priority-severity-section.md`；`priority:*` 的可逆性随之变为「部分由正文推导」，规范 §5 已同步。
- **TD-PROCGATE-007** · 议题治理规范自身文档漂移（§8 checkbox 未回填 / 提交页缺规范链接 / `documentation` 无模板）
  - 类别：H · 严重级：P3 · 工作量：S · 状态：done（2026-09-18，PR #435）
  - 位置：`docs/issue-management.md:174-176`、`docs/development-standards.md:247`、`.github/ISSUE_TEMPLATE/config.yml`、`.github/labels.yml`
  - 影响：三处——(1) §8 把「同步标签实体」列为未完成 `[ ]`，但 `gh label list` 显示标签与 `labels.yml` **逐条一致**（名称/color/description 全对齐），该步骤**早已执行**，规范在描述自身状态时是错的；(2) `config.yml` 的 `contact_links` **未包含 `docs/issue-management.md`**，新议题提交页看不到治理规范；(3) `documentation` 标签无模板引用，文档类议题只能用 bug/feature 模板开、自动落 `bug`/`enhancement`，语义错位需人工改标。
  - 建议：回填两处 checkbox；`config.yml` 增规范链接；`documentation` 二选一（新增 `documentation.md` 模板，或在规范 §2 明确「文档类用 feature 模板开、手工改标」）。
  - **2026-09-18 处置**：✅ **done（PR #435）**——取 issue 建议的 (a)。① 两处 checkbox 回填并**附核验证据**（2026-09-18：`gh label list --limit 100` 得 **39** 条与 `.github/labels.yml` 逐条一致；issue 原文的 38 是当时读数），「（按需）创建版本里程碑」如实留白并注明"尚无需求，故未建"；② `config.yml` 增加指向 `docs/issue-management.md` 的 `contact_link`；③ 新增 `.github/ISSUE_TEMPLATE/documentation.md`（`docs: ` 前缀 + `labels: ["documentation"]` + 「影响 scope」节，**刻意不含「契约影响」节**并在模板内写明边界）。门禁由「39 标签 / 3 模板」变为「39 标签 / **4** 模板」；两组负控制实测：删一行勾选项被模板间比对拦下、加一行未声明选项被模板↔标签拦下。分类器联动实测：喂入新模板正文（勾选 `ui` + 「其他」）输出 `scope:ui` / `scope:other` / `status: triage`。规范 §2 计数（三个→四个）与「诚实边界」同步更新（新增第三条：类型标签"声明了却无模板引用"无门禁可守）。决策见 `docs/notes/implemented/2026-09-18-documentation-template.md`（内含对 `2026-09-16-scope-vocabulary-contract.md` 两句过期陈述的更正说明——按 note 纪律不改旧 note）。

---

## 33. §31–§32 的设计使然清单（明确**不**作为债务处理）

> 依 `README.md` §边界与约束 与 §31 各节的「设计使然」段汇总。这些是**有意取舍且有决策记录**的项，登记以防后续审计者重复翻案。

| 事项 | 出处 | 理由 |
|---|---|---|
| team 单进程边界（无 WAL / 无跨进程锁） | `team-db.ts:6-9` | 多 gateway 共享 `teams.db` 不在支持范围 |
| `SessionPresence` Map 不做 TTL 清理 | `sessionPresence.ts:14-17` | 清理会让 key 翻回 unknown→在线，导致离线/在线振荡 |
| 面板快照信任边界（持 token 即可枚举全部团队） | `gatewayRuntimeOptions.ts:150-155` | 单用户桌面场景可接受；随多会话使用应复核（见 TD-TEAM-N10） |
| `invalidateTaskAttempt` 与 `retryFailedTask` 双实现 | `taskpool/retry.ts:6-9` | 自动转派必须 `reassigning=false` 且不生成 `handoffId`，故不复用 |
| `detectDependencyCycle` 运行期不可达 | `taskpool/cycle.ts:4-8` | 防御性纯函数，依赖未来可变时成唯一防线 |
| `lock.ts:19` 的 `.catch(() => undefined)` | `lock.ts:16-18` | tail 链归纳证明永不 reject；**已推翻 TD-AGENT-104 对它的登记**（见 TD-TEAM-N24） |
| J-Space / metacognitive / bridge-reencode 开关默认关 | `CLAUDE.md:166,168,169` | 拥有者明确、默认关是设计 |
| metacognitive 的 reconcile / escalate deferred | `openspec/.../metacognitive-control/design.md:37` | 明确分期裁剪，无半成品残留（已核实） |
| clarity-gate 的 fail-open 降级 | `clarity.ts:13-15`、`CLAUDE.md:151` | 「诚实降级」信条；三条路径都不中断、有 `[WORKFLOW_DEGRADED]` 标记、有直测 |
| `verifyVerdictEnvelope` / `reasoning/` 仅测试消费 | `evaluate/consensus.ts:156-158` | 显式注释「预留离线审计 API，宿主接线前不参与运行时判定」 |
| triz 在 `execute` 内读打包数据 | `triz.ts:8-10`、`CLAUDE.md:170` | 刻意设计并已记录；仅契约口径待标注（见 TD-METHODOLOGY-N06） |
| 专利链路各路 fail-open（反馈反查落空、`derivedFrom` 声明缺失、judge 失败票） | `2026-08-30-patent-audit-fixes.md:32,40` | 「诚实降级」是显式设计信条 |
| 26 条 structural block 全降级 warn/log | `rules/README.md:232` | 误报率论证充分 |
| `tech-investigator` 缺 `"legal"` 域 | `docs/team-role-mapping.md:48` | M3 spec 逐字批准 |
| 续算「首期不续算」三类形态 | `docs/cross-process-retry-resume-plan.md:128,133` | 明确的分期裁剪 |
| `close_project_sessions` 未实现即显式报错 | `CLAUDE.md:173` | 显式失败优于静默降级 |
| WS 无 Origin 校验 / token 非常量时间 | `performance-review.md:163` | 本地 loopback 场景明确接受的风险 |
| team 集成 spec 靠 `--test-force-exit` 收尾 | `code-refinement-plan.md:609` | 官方脚本已知形态 |
| Linux 桌面不维护 | `CLAUDE.md:21` | 明确范围裁剪 |
| `ui/server` 双后端保留、不收敛 | `technical-debt-report.md:335` | 2026-08-14 明决策 |

---

## 34. §31–§32 的修复排期建议

**立即可做（S 级、低爆炸半径、消除「错误决策」风险面）**
1. **TD-PROCGATE-001**（PR 门禁恒真）—— 一行剥离注释 + 一条负控制，**当前所有 PR 的追溯保证都是假的**。
2. **TD-AGENT-N01**（请求对拍器恒真）—— 观测性缺陷属「可致错误决策」，与上条同类。
3. **TD-METHODOLOGY-N05**（triz 数据 IO 无 fail-safe）—— **唯一会打断主链路**的项（一个辅助提示能让整轮请求失败）。
4. **TD-TEAM-N01/N02/N03 + TD-AGENT-N02 + TD-SESSION-N08/N09**（同源文档漂移，可合成一个 docs commit）—— 五条都指向同一根源：**2026-09 的 M3 写缓冲与第二次 AgentLoop 拆解落地后，`CLAUDE.md` 与 plan 文档未同步迭代**。`CLAUDE.md` 现有 **5 处**与实际不符，作为第一事实源这是系统性风险。

**短期（M 级，需排期）**
5. **TD-METRIC-001/002/003**（度量口径与基线）—— 仪表盘不可信会让**后续所有**排期决策失真，杠杆高于任何单个实现债务。与 `check:event-matrix` 同批做生成式门禁。
6. **TD-GATEWAY-N01**（协议版本无门禁）—— 与上条同属「门禁缺失」，可合并为一个生成式门禁专项。
7. **TD-TEAM-N06**（通用层耦合专利域）—— 抽一个接口即可，但越晚改成本越高（§31.1 结论）。
8. **TD-PROCGATE-004**（stale 与分诊抵销）—— 直接影响本批债务 issue 自身的可管理性（同批的 003「债务模板缺 scope 节」已于 2026-09-17 还清）。

**中期（P2 专项）**
9. **TD-TEAM-N09/N10**（黑板与面板快照的缓存/批量查询）、**TD-PATENT-N22/N23/N24**（原子写与索引存储的复制）、**TD-SESSION-N10**（启动扫描全量读）—— 同属「新增期扩张留下的一致性税」，收敛点清晰、爆炸半径小。
10. **TD-PROCGATE-005/006/007**（scope 词表统一、枚举门禁、规范自查）。

**持续**
11. 本批 §31 共 **45 条**新条目，其中 P2 以上须在下个季度复扫时逐条核对进展；`README.md` §如何保持新鲜 建议补一条「归档 change 的 tasks.md 随交付回填」（TD-WORKSPACE-N04 的直接教训）。

### 35. 本批复扫对应的 issue（2026-09-14 创建）

> 全部挂在里程碑 **v0.2.0** 下（仓库首个里程碑，此前零 milestone）。类型/优先级标签为创建时携带，`scope:*` 与 `status: triage` 由 `issue-triage.yml` 从正文「## 影响 scope」节**自动打上**。
>
> ⚠️ **其中 12 条落在 `scope:other`**（#332–#341、#348、#351、#353、#354、#359、#365）——因为 `ci`/`scripts`/`desktop`/`ui-server`/`adapters` 等**没有对应的 `scope:` 标签**，即 §32 `TD-PROCGATE-005` 待解决的问题。
>
> **2026-09-16 更新（PR #395）**：`scope:desktop` 已按成文判据补上（`docs/issue-management.md` §1 的「用户可感知的模块 + 独立交付边界」两道判据；`apps/desktop` 是独立 workspace 包 + 独立命名 CI job + 独立发布文档）。其余候选（`ci`/`scripts`/`ui-server`/`adapters`）按同一判据**不收**——issue 面要的是用户可感知的模块，而非源码目录的一一映射，细粒度归 `scope:other`，这是取舍不是缺口。已创建的这 12 条**不会追溯改标**（分类器只在 `opened`/`edited` 事件运行），需要时按新词表手工调整。是否进一步扩充仍是开放决定，判据已写进 §1，扩充成本已降到「一行 `labels.yml` + 两条模板」。

| 台账条目 | issue | 摘要 |
|---|---|---|
| TD-PROCGATE-001 | **#332** | PR 追溯门禁被模板注释恒真通过 |
| TD-PROCGATE-002 | **#333** | `test:pr-tooling` 无挂载点，负控制测试从不执行 |
| TD-PROCGATE-005 | **#334** | scope 分类器与规范三处不符 |
| TD-PROCGATE-003 | **#335** | tech_debt 模板补「影响 scope」节 |
| TD-PROCGATE-004 | **#336** | stale 豁免与分诊目标抵销 |
| TD-PROCGATE-006 | **#337** | priority/status 取值枚举门禁。**已交付（PR #405）**；同源的增量项 `priority:` 半自动化见 **#406（PR #436）** |
| TD-PROCGATE-007 | **#338** | 议题治理规范自身文档漂移。**已交付（PR #435）**——§8/开发标准两处 checkbox 回填并附核验证据（39 标签逐条一致）、`config.yml` 增治理规范入口、新增 `documentation.md` 模板（门禁 3 → 4 模板，两组负控制 + 分类器联动实测） |
| TD-METRIC-001 | **#339** | measure-techdebt 漏统计 `as unknown as`（329 处） |
| TD-METRIC-002 | **#340** | 债务指标基线加新鲜度校验 |
| TD-METRIC-003 | **#341** | 指标口径缺口（ui/server、vendored 子包） |
| TD-AGENT-102 | **#342** | TurnRunner.run() 三条失败路径重复样板 |
| TD-ROUTER-001 + 002（+003） | **#343** | RouterRuntime 巨型闭包（同文件同根因，已合并） |
| TD-SESSION-N01 | **#344** | WorkspaceLedgerStore.read() 每轮全量重扫 |
| TD-PATENT-N01 | **#345** | graph/ 与 workflow/ 双轨重复且已漂移 |
| TD-ALWAYSON-N01 | **#346** | DiscoveryFire god class |
| TD-PILOT-N02（+N01） | **#347** | Pilot 校验错误走两套通道 |
| TD-DESKTOP-N01 | **#348** | 运行时布局符号链接接线三处重复 |
| TD-DESKTOP-N02 | **#349** | Windows 打包缺 `dist/assets`、`skills`、`rules` |
| TD-TEAM-N01/N02/N03 + TD-AGENT-N02 + TD-SESSION-N08/N09 | **#350** | **`CLAUDE.md` 五处陈述与代码实际不符**（一条汇总） |
| 13 个 SessionMapper 空壳 | **#351** | 逐字相同的 10 行薄壳收敛为工厂；**已交付（PR #410）**——薄壳删除、渠道直接构造共享实现（未走工厂，理由见 note） |
| TD-PATENT-N23 + N24 | **#352** | index-store 同构复制（85/179 行）+ 队列无淘汰 |
| TD-CATCH-001 残留 + TD-TEAM-N11 + TD-SESSION-N12 | **#353** | 无注释无参 catch（创建时旧口径 37；#390 口径变更后为 124 → 114）。**已交付（PR #432 段一 + PR #434 段二）**——`ui/server` 72 → 0、`src` 36 + `ui/src` 6 → 0，全仓无注释 **114 → 0**；同 issue 的 `TD-TEAM-N11`（`.catch()` 链、不在本判据内）按「场景 B」补 `logger.error`（PR #434） |
| 端口/超时散落 | **#354** | 5 个渠道端口 + 内联 setTimeout。**已交付（PR #437 端口半 + PR #438 超时半）**——4 个渠道端口集中到 `channel-defaults.ts`（5433 是 Postgres 端口，不入表、仅更名 `DEFAULT_PG_PORT`）；内联毫秒字面量**实测 76 处**（非登记的 43 处：原口径漏了"数字写在下一行"的多行调用，且其点名的热点 `ui/server/utils/globalChrome.js` 已随 PR #417 整文件删除）集中为三张注册表（`src/shared/timeouts.ts` 17 键 / `ui/src/constants/timeouts.ts` 35 键 / `ui/server/utils/timeouts.js` 9 键），取值守恒经多重集比对逐文件证明 |
| TD-RULE-N01 | **#355** | rule_check(pack) 缓存失效键覆盖不全 |
| `ui/server` P0 级候选（文档登记未跟踪） | **#356** | **已交付（PR #417）**——20 条登记逐条复核（19 条仍成立）+ 零消费死表面退役；仍成立的 6 条拆成 #411–#416，裁定表见 §26「处置追加」。**6 条载体已全部还清**：#412 / #413（PR #425）、#411 / #414 / #415 / #416（PR #426–#429） |
| TD-RULE-N07 | **#357** | 规则资产语义增强 3 项（全角漏报 / 安防误伤 / 重复去重；已交付） |
| TD-PATENT-N01（验证面） | **#358** | 双链路缺跨链路一致性 fixture |
| TD-WORKSPACE-N04 + TD-TEAM-N25 + TD-PATENT-N20 | **#359** | 计划文档悬空勾选批量回收。**已交付（PR #439）**——21 份计划文档 / **559** 处悬空勾选逐条核对：**377 项已交付**（回填勾选 + 逐项证据）、**37 项仍未交付**（含 #359 之外新发现的 4 项：`patent-optimization-plan-v2` 的基线保存/SSL 字面 DoD/日志可追溯/兼容性报告，及 html 交付物的 A4 分页与纯白违规等）、**145 项无法核实**（一次性运行类步骤无持久产物，如实留白）；三份载体 `TD-WORKSPACE-N04`/`TD-TEAM-N25`/`TD-PATENT-N20` 全部置 done；并建立两份防复发约定（`docs/issue-management.md` §6.1、`docs/technical-debt/README.md` §如何保持新鲜 第 5 条） |
| TD-AGENT-N01 | **#360** | request_header 对拍器恒真 |
| TD-METHODOLOGY-N05 | **#361** | triz 数据 IO 无 fail-safe（会打断主轮） |
| TD-GATEWAY-N01 | **#362** | 协议版本无门禁 |
| TD-TEAM-N06 | **#363** | 通用编排层反向耦合专利域 |
| TD-WORKSPACE-N02 | **#364** | 账本在 transcript 超 50MB 时静默消失 |
| （`docs/code-refinement-plan.md:573`） | **#365** | `/api/commands/load` 路径校验放行 `$HOME` 任意文件 |
| 知识系统 A1–A8（`knowledge-system-report.md`） | **#366** | 诊断恒报 ready 但实际未装配 |

### 36. #356 复核后新立的载体（2026-09-17 创建）

> 全部挂里程碑 **v0.2.0**，标签 `tech-debt` / `priority: p2` / `scope:ui` / `status: triage`。来源是 §26「处置追加」的复核裁定表：这 6 条**不是**新发现，而是 C34 登记项中**复核后仍成立的真实缺陷**——它们此前只存在于已退役的文档里，本次借 #356 取得事实源地位。⚠️ 它们**各自独立**，不要并成一条批处理（触发条件、爆炸半径、判据方向均不同）。

| 台账来源 | issue | 摘要 |
|---|---|---|
| C34 P0-1 | **#411** | `chat.js` edit/regen 流用 `writer` 而非 `streamWriter`，兄弟标签页停在 `Processing`；**已交付（PR #429）** |
| C34 P0-2 + P0-3 | **#412** | `shell.js` PTY 重连竞态 + `onExit` 误删同 key 新会话（合并：同一闭包变量共享根因）；**已交付（PR #425）** |
| C34 P0-4 | **#413** | `sati-bridge.js` 三张 per-session Map 慢泄漏；**已交付（PR #425）** |
| C34 P0-8 | **#414** | `POST /api/agent` 四项缺陷（帧解析恒空 / 吞错 / 错变量 / 零调用）；**已交付（PR #426）** |
| C34 P0-7 | **#415** | `git.js` `/status` 丢 R/C 变更；**已交付（PR #428）** |
| C34 P0-9 | **#416** | `config.js` `/test-connection` 不识别掩码 API key；**已交付（PR #427）** |
