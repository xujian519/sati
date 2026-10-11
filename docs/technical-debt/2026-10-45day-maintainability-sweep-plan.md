# Sati 全库可维护性优化中期计划（45 工作日 · 2026-10-12 → 2026-12-11）

> 类型：中期专项计划（技术债总清算 · 可维护性为主）
> 基线：`docs/technical-debt/metrics.md` 快照 **2026-10-10** · git HEAD `7a414709e` · 活账本 `docs/technical-debt/backlog.md`
> 提出：2026-10-11 · owner：xujian519
> 状态约定：执行中按 §8 回填本条目的勾选与实施备注；完成后整篇标注 done 或被新方案取代时在文件头写明被谁取代（`docs/issue-management.md` §6 / 铁律 7）。

---

## 1. 目标与边界

### 1.1 目标

45 个工作日内对全部产品代码（`src/` 1,081 文件 / 187,550 行 · `ui/src` 638 文件 / 102,247 行 · `ui/server` 129 文件 / 35,394 行）完成**一遍系统性优化**：

1. **拆分**：63 个 ≥300 行 God function 清零主力（≥400 行归零、300–400 行收敛到设计使然的少数编排函数并留 note）；
2. **瘦身**：30 个 ≥800 行文件压到 ≤10 个；`architecture-baseline.json` 的 42 条 file-size 存量豁免注销过半；
3. **收敛**：类型逃逸（`as unknown as` 产品代码 22 处）、无注释无参 catch 17 处、cli 裸 console 137 处、figuregen 88 个零消费导出、ui/server→src 15 处直连、知识卡 70 组重复，六类横切债清零或大幅下降；
4. **补强**：测试洼地补齐（adapters 0.12 → ≥0.30；git-panel 0 → 有）。

### 1.2 非目标（明确不做）

- **性能专项**：不主动做性能优化专项。记忆检索 30s 阻塞（#536）、文件树（#533）、账本写放大（#537）、团队读放大（#531）等走既有 issue 队列；本计划仅在拆到同文件时顺带处理并登记。
- **4 个开放 bug**（#625 / #626 鉴权、#643 符号链接逃逸、#624 标注门控）：走正常 issue 流程，不占本计划工期；拆到同文件时可顺手修并在回填中注明。
- **工具 `inputSchema` 的任何改动（含描述文本）**：触碰即触发 llm-replay fixture 重录（铁律 6）。本计划全部条目均为内部结构拆分，不触及；PR 时自查。
- **行为变更型重构**：删功能、改 UX 结构、改协议一律不做。所有拆分为行为保持，按 §4.3 逐 token 证明 + 双视口浏览器 A/B。
- **vendored 子包** `src/context/memory/edgeclaw-memory-core`：外部搬入、不随本仓演进，metrics 已单列，不在扫除面。

### 1.3 产能假设

- 40–50 天按**工作日**口径（若按自然日则为 40-50 个日历天，范围收缩到 P1/P2/P3 主干，见 §7 降级顺序）。
- 每日 8 小时有效深度工作（本人 + AI 并行：explorer 定位、general 副线执行同构件、oracle 周审）。
- 串行工作量合计 **56 人日**（P0 2 · P1 5 · P2 11.5 · P3 28.5 · P4 5 · P5 4）。
- 墙钟 **45 工作日** = 各阶段跨度（P0 2 · P1 5 · P2 10 · P3 20 · P4 4 · P5 4）；**跨度小于串行人日的压缩全部来自 §4.2 并行编排**（P2 11.5→10 靠与 P3 的 B 线窗口并行；P3 28.5→20 靠同构件副线 + 浏览器验证窗口利用，压缩系数 1.43×）。周审校准压缩是否成立，失效即按 §7 降级，不硬超。
- 日历落点：D1 = 2026-10-12（周一），D45 = 2026-12-11；50 工作日上限 = 2026-12-18。

---

## 2. 基线（2026-10-10 实测，HEAD `7a414709e`，两路独立侦察交叉验证一致）

| 维度 | 值 |
|---|---|
| 规模 | src 1,081/187,550 · ui/src 638/102,247 · ui/server 129/35,394 · tests 629 |
| God function ≥300 行 | **63**（ui/src 46 · src 17；其中测试文件条目 6） |
| ≥800 行文件 | **30**（Top1 `ui/server/sati-bridge.js` 2,348） |
| file-size 存量豁免 | **42 条**（`architecture-baseline.json`，行数棘轮） |
| 裸 `console.*` | **160**（cli 137 · telemetry 8 · ui/server 6，其余 ~9 散落 src/adapters·shared·mcp·context） |
| 无参 catch | 692（无注释 **17** · 已有 thresholds.json 棘轮上限 17） |
| `as unknown as` | 38（**产品代码 20**：ui/src 11 + src 9；其余 18 在测试文件，口径外） |
| 知识卡逐字节重复 | **70 组 / 90 文件 / 527,689 B**（67 组 `专利侵权/` 同名嵌套目录 + 3 组 `专利实务/` 多副本） |
| figuregen 零消费导出 | **88**（barrel 235 个导出名；4 个 tool 文件深引 barrel 内单模块） |
| ui/server→src 直连 | 15（全部在白名单内合法，属已登记耦合面） |
| UI 无 colocated 测试的 God 组件 | **16/40 产品条目**；git-panel 全域 0 测试 |
| 测试洼地（文件比） | adapters 0.12 · shared 0.15 · browser 0.17 · lifecycle 0.17 · methodology 0.21 · board 0.25 · extension 0.25 · always-on 0.37 |
| i18n 缺口 | teamPanel zh 缺 `pill.teamCount_one`；FilesV2 `fileTree.*` 14 处靠 defaultValue 兜底 |

---

## 3. 验收指标（可测、有门禁或脚本背书）

| # | 指标 | 基线 | 目标 | 背书 |
|---|---|---|---|---|
| M1 | God function ≥400 行 | 32 | **0** | `measure-techdebt.mjs` godFunctions 表 |
| M2 | God function 300–400 行 | 31 | **≤8**（每个留 note 说明设计使然） | 同上 |
| M3 | ≥800 行文件 | 30 | **≤10** | `check-architecture-boundaries.mjs` |
| M4 | file-size 存量豁免 | 42 | **≤20**（每消除一条 `--update-baseline` 注销留痕） | 同上 |
| M5 | 无注释无参 catch | 17 | **0** | `thresholds.json` 棘轮（catchNoParam.undocumented） |
| M6 | cli 裸 console | 137 | **0**（收束后按 C39 先例申报豁免入口；散落 src 其他 ~9 处同批收拢） | `measure-techdebt.mjs` |
| M7 | `as unknown as` 产品代码 | 20 | **≤8** | metrics asUnknownAs 口径（src+ui/src） |
| M8 | 知识卡重复 | 70 组 / 527,689 B | **0**（或每组有 owner 确认的有意保留 note） | metrics knowledgeDup |
| M9 | figuregen 零消费导出 | 88 | **0**（删除或降测试专用并说明） | #541 收口 + decision note |
| M10 | ui/server→src 直连 | 15 | **≤5**（其余收进白名单 barrel 收口） | `check-ui-server-boundary.mjs` |
| M11 | adapters 测试文件比 | 0.12 | **≥0.30** | 手测（tests/adapters vs src/adapters） |
| M12 | git-panel 测试 | 0 文件 | **≥3 文件** | 手测 |
| M13 | 全门禁 | — | **每 PR green**：`pnpm typecheck && pnpm --filter sati-ui typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm --filter sati-ui test` | CI 4 job |

> M6/M10 的「豁免/白名单」动作必须打印 Δ 并在 PR 说明理由（棘轮纪律）；M8 若保留副本必须留 decision note（2026-08-27 先例口径）。

---

## 4. 编排原则

### 4.1 顺序：严格 bottom-up

数据底座 → 叶子组件 → 编排枢纽。`useSessionStore`（被 chat 与 app-shell 两条链路共同消费）与 `useChatRealtimeHandlers`（chat 事件面）先行；`ChatInterfaceV2` / `AppShellV2` 两个枢纽排最后。反序拆 = 上游接口重拆 = 连锁返工。

### 4.2 并行纪律

- **A 线（主线）**：UI 拆分（P3），按 B1→B5 推进。
- **B 线（辅线）**：后端拆分 + 机械收敛（P1/P2/P4），不依赖 A 线产物。
- 两线同周并行；**浏览器验证的等待窗口**（A 线组件拆完跑双视口 A/B）用于推 B 线后端项——后端不需要浏览器。
- 并行写入仅限：文件集完全不相交 + 无共享状态。同构件批量（settings 三个 IM section、main-content 兄弟搬移、三个 patentFigure 工具）先由主 Agent 做第一件确立模式，其余派 `general` 副线执行，主 Agent 逐件验 diff + 跑门禁。**Worker 报告成功 ≠ 完成**。
- 每 PR 一个 Concern；不把两个域的拆分混在一个 PR。

### 4.3 验证协议（每 PR 必过）

**后端 / 主链路项**（agent/router/tool/session/gateway 铁律 8）：
1. `pnpm typecheck && pnpm test`（node --test dist 全量）；
2. 触碰 LLM 回路的走重放 seam（`pnpm test` 内含重放）；**不碰 inputSchema**，自查 diff 无 schema/描述文本变更；
3. 新增/搬迁的纯函数补直测（迁徙段逐 token 可证的，录 A/B 输出）。

**UI 项**（复用 #159 已验证的成本模型）：
1. `pnpm --filter sati-ui test`（colocated + 同目录测试全绿；拆 MessagesPaneV2 必须保 943 行 render describe 整块 green）；
2. 无 colocated 测试的 16 个产品条目：**先补测试再拆**（或至少拆前先钉 golden 行为）；
3. **双视口浏览器 A/B 指纹逐字节相同**（桌面 + 移动）+ N 项负控制（#159 PR 先例：PR #457/#458/#460）；
4. 新增用户可见文案一律提取 `ui/src/i18n/locales/{en,zh-CN}/`（铁律 4）；
5. 拆分跨度证明：函数行数 before/after + 搬迁段逐 token 对照记录在 PR 正文。

**每 PR 同批落四件**（缺一即债）：
- `pnpm measure:update`（影响指标的改动）；
- 消除 file-size 豁免的 `node scripts/check-architecture-boundaries.mjs --update-baseline`（打印 Δ）；
- `backlog.md` 对应条目标 done + commit/PR + 最后复核日期；
- 非平凡拆分一条 `docs/notes/implemented/` decision note（含 `## Alternatives considered`，铁律 7；一个工作流里程碑一篇，不搞每文件一篇）。

### 4.4 棘轮守夜

- `thresholds.json`：catchEmpty=0 / catchNoParam.undocumented=17 → 下降后 `--update-thresholds` 锁定收益；
- `architecture-baseline.json` file-size 行数上限：存量文件不得再长；拆分后立即注销；
- 每次刷新强制打印 Δ，让「承认动作」在 diff 里留痕。

### 4.5 周度 Oracle 门禁

每周五派 `oracle` 做独立 Review（graded 门禁结论）：本周 diff 抽审 + 下周批次预排。FAIL 项按 3 轮中断规则上报（累计 3 轮不通过即停，出 2-3 个方案让用户决策），不自动重试。

---

## 5. 阶段计划

### P0 · 基线与编排（D1–D2，2 天）

| # | 事项 | 产出 | 通过判据 |
|---|---|---|---|
| P0.1 | 冻结清单：以 metrics.md 2026-10-10 快照 + 两路侦察为 sweep 清单基线，登记到 backlog 新节 | 63 God fn / 30 大文件 as checkable 清单 | backlog §38 收录 |
| P0.2 | 把 #159 的逐 token 证明 + 双视口 A/B 指纹流程写成可复用 checklist（进 `docs/technical-debt/`） | 拆分 PR 模板 | P1 起每个 UI PR 引用 |
| P0.3 | 建 milestone + 分支策略（每项 `refactor/sweep-<batch>-<item>`）+ 每日 rhythm（§6） | 跟踪载体 | milestone 挂上 |

### P1 · 机械收敛（D3–D7，5 天，B 线先行）

| # | 事项 | 量 | 兜底 | 通过判据 |
|---|---|---|---|---|
| P1.1 | 无注释无参 catch 补「失败模式→回退语义」注释（17 处全表见 backlog §37.8 / 侦察清单）；`proxyFallback.ts:54`/`config.js:669`/`api.js:142` 三处意图需业务确认 | 17 | 有 | M5=0，棘轮下调 |
| P1.2 | i18n：teamPanel zh 补 `pill.teamCount_one`；FilesV2 `fileTree.*` 14 处 defaultValue → 正式 en/zh keys | 15 key | `check:i18n-namespaces` | 两语言全绿、defaultValue 清零 |
| P1.3 | `as unknown as` 产品代码 20 处 → 守卫/窄类型（ui/src 11 + src 9；测试文件不动） | 20 | typecheck 自验证 | M7 ≤8 |
| P1.4 | cli 裸 console 137 + src 散落 ~9 → `src/telemetry/logger.ts`（cli：gatewaySetup 80 · sati.ts 38 · configSet 8 · 其余 11 · 其他模块 9）；注意 stdout/stderr 映射与 SATI_DEBUG 门控语义差异，逐处确认降噪预期 | ~146 | cli 15 测试 + typecheck | M6=0 后按 C39 先例申报豁免入口 |
| P1.5 | figuregen barrel 收敛：88 零消费导出分类（删除/降测试专用/保留说明）+ 4 个 tool 文件深引归一 barrel + decision note | 88 | patent 141 测试 | M9=0，#541 收口 |

### P2 · 后端拆分（D8–D17，10 天，A/B 两线）

| # | 位置（file:function） | 现状 | 兜底 | 量 | 通过判据 |
|---|---|---|---|---|---|
| P2.1 | `gateway/client/InProcessGateway.ts:submitTurn`（301 fn / 1,518 file） | 主链路 | gateway 34 测试 + 重放 | 1.5d | submitTurn ≤150 行，契约不变 |
| P2.2 | `gateway/client/eventMapping.ts:mapAgentEventForTurn`（417） | 事件面 | gateway 测试 + check:event-matrix | 1d | 映射表化，矩阵不变 |
| P2.3 | `gateway/client/telemetry.ts:emitSessionTelemetry`（333） | — | telemetry 3 测试 | 0.5d | ≤150 行 |
| P2.4 | `gateway/server/GatewayWsConnection.ts:dispatchRequest`（353） | 已有守卫表 | dispatch.spec | 0.5d | 守卫表反推分发 |
| P2.5 | patentFigure 三工具（`patentFigureProject` 554+411 · `patentFigureGenerate` 422+322 · `patentFigureCheck` 384） | #539 同题：21 规则挤一个 503 行函数 + 产物清单拼三遍 | patent 141 测试 | 2.5d | 规则注册表 + 共享产物装配模块；三工具 execute ≤200 行 |
| P2.6 | `router/execution/executeRouterDecision.ts:executeRouterDecision`（449） | 主链路 | router 19 测试 | 1d | 决策树外置，行为逐 token |
| P2.7 | `cli/sati.ts:main`（642 fn / 1,035 file） + `cli/projectRuntimeFactory.ts`（424+316） | CLI 入口 | cli 15 测试 | 2d | 命令分发表化；两 file ≤600 |
| P2.8 | `adapters/channel/tui/app/TuiApp.tsx:TuiApp`（643） | TUI | adapters 11 测试 + ink-testing | 1d | 拆 render/input/state 三层 |
| P2.9 | `web/client/webMessage.ts:applyWebGatewayEvent`（383）+ `tool/execution/ToolRuntime.ts:execute`（388） | — | web 9 / tool 68 测试 | 1d | 各 ≤200 行 |
| P2.10 | `patent/graph/domains/inventiveness.ts:buildInventivenessGraph`（342） | — | patent 测试 | 0.5d | 图构建声明化 |

### P3 · UI 拆分（D18–D37，20 天，A 线；按批 bottom-up）

#### B1 · 底座与实时链（D18–D22，5 天）

| # | 位置 | 现状 | 兜底 | 量 | 通过判据 |
|---|---|---|---|---|---|
| B1.1 | `ui/src/stores/useSessionStore.ts:createSessionActions`（631 fn / 1,352 file） | **数据底座**，双链路共用 | 2 个 store 测试（actions 354 行 describe + streaming 575 行） | 2.5d | server fetch / subagent detail / streaming / activity 四组 → actions factories；文件 ≤800，注销豁免 |
| B1.2 | `ui/src/components/chat/hooks/useChatRealtimeHandlers.ts`（721 fn + 624 fn = handleMessage） | chat 事件面 | colocated 210 行测试 | 2d | 624 行 handleMessage → 按 kind 分发的 handler 注册表；timers → `useSessionStatusRetryTimers`；helper → utils |
| B1.3 | `ui/src/hooks/useProjectsState.ts:useProjectsState`（647） | app-shell 数据 | colocated 115 行 | 1d | openSettings / optimistic / selection 三簇外置 |

#### B2 · chat 主链路（D23–D28，6 天；浏览器验证成本一次摊）

| # | 位置 | 现状 | 兜底 | 量 | 通过判据 |
|---|---|---|---|---|---|
| B2.1 | `chat-v2/MessagesPaneV2.tsx:MessagesPaneV2`（824） | #159 已拆一轮仍 824 | **943 行 render describe** | 2d | ~15 个 useMemo → `useRenderableMessageItems`；subagent 投影 → hook；行渲染 → per-kind dispatcher；测试整块 green |
| B2.2 | `chat-v2/ComposerV2.tsx:ComposerV2`（741） | **零测试** | 先补 | 1.5d | token budget 展示块 → `ContextWindowIndicator`；派生状态 → `useComposerDerivedState` |
| B2.3 | `chat-v2/ChatInterfaceV2.tsx:ChatInterfaceV2`（668） | **编排枢纽**，排本批最后 | reconnect.spec | 1.5d | 流缓冲 / fork-regenerate / reconnect / composerSlot 四簇外置，props 契约不动 |
| B2.4 | `chat/hooks/` 剩余三件：`useSessionSubmit`(528) `useSlashCommands`(395) `useSlashCommandExecute`(331) | useSubmit **无测试** | 先补 | 1.5d | 三 hook ≤300 |
| B2.5 | `chat-v2/MessageRowV2`(429) + `SubagentDetailMessageFlow`(309) + `chat/view/subcomponents/MessageComponent`(335) | MessageComponent memo 已部分拆 | MessageComponent 2 测试 | 0.5d | 各自 ≤300 |
| B2.6 | `chat/hooks/useChatComposerState`(467) + `useFileMentions`(366) + `AskUserQuestionPanel`(378) | #159 残余 + 有测试 | colocated | 0.5d | ≤300 |

#### B3 · app-shell（D29–D31，3 天）

| # | 位置 | 现状 | 兜底 | 量 | 通过判据 |
|---|---|---|---|---|---|
| B3.1 | `app-shell/SidebarV2.tsx:SidebarV2`（1,014 fn / 1,323 file） | **props-only 零 store import，低连锁** | 172 行行为测试 | 2d | renderSessionRows / renderProjectGroup / 右键菜单 / resize / rename 五簇外置 |
| B3.2 | `app-shell/MainAreaV2.tsx`（381） | — | colocated 235 行 | 0.5d | ≤300 |
| B3.3 | `app-shell/AppShellV2.tsx:AppShellV2`（631） | **外壳枢纽**，排最后 | 邻接 2 测试 | 1d | switchProject / 删除对话框 / 选择处理 / misrouted URL 外置（后两簇已有模块地基） |

#### B4 · main-content-v2（D32–D35，4 天）

| # | 位置 | 现状 | 兜底 | 量 | 通过判据 |
|---|---|---|---|---|---|
| B4.1 | `main-content-v2/DashboardV2.tsx`（332 fn / **1,345 file**，~15 个兄弟组件） | 多组件文件，抽兄弟非拆函数 | 无 | 1.5d | 兄弟组件 → `dashboard/` 子目录；主文件 ≤500 |
| B4.2 | `main-content-v2/SkillsV2.tsx`（1,441 file，无 ≥300 fn） | #159 已拆 ImportFromFolder 仍 1,440 | 863 条导入链路测试 | 1.5d | 按功能分子文件（同 #460 模式） |
| B4.3 | `main-content-v2/FilesV2.tsx:FilesV2`（849） | **零测试** | 先补 | 1.5d | inline edit / 右键菜单 / 文件操作 / 上传下载四簇 → hooks + 组件；i18n fileTree key 已在 P1.2 落地 |
| B4.4 | `main-content-v2/CronV2.tsx`（476 fn / 1,129 file）+ `PlansAndCronJobs`(334) + `ImportFromFolder`(688) | Cron 有 463 行测试 | 有 | 1d | CronV2 拆 CronFormView/CronListView 两文件；另两项 ≤400 |

#### B5 · settings + 尾部（D36–D37，2 天起，滑期最先砍）

| # | 位置 | 现状 | 兜底 | 量 | 通过判据 |
|---|---|---|---|---|---|
| B5.1 | settings IM 三 section：WeCom(398) / Feishu(381) / Weixin(303) | 同构，Weixin 有测试 | Weixin 206 行 | 1d | 共享 IM section 框架（主 Agent 做第一件，其余副线） |
| B5.2 | settings `ProviderCard`(447) + `RouterSection`(357) + `ToolsSection`(399) | ToolsSection 有测试 | ToolsSection 有 | 1d | 各 ≤300 |
| B5.3 | `git-panel/hooks/useGitPanelController.ts`（704） | **全域 0 测试**，最大零覆盖债 | 先补 | 1.5d | 先补 ≥3 个测试文件，再拆 branch/remote/commit/working-tree 四子 hook |
| B5.4 | 尾部：`onboarding/LlmConfigurationStep`(633) · `kanban/useBoardState`(368) · `code-editor` 三件(422/407/326) · `MainContent`(573+346) · `annotation/Annotator`(322) | LlmConfigurationStep 4 测试 · 其余混合 | 混合 | 2.5d | 各自 ≤300-400；LlmConfigurationStep 按 loadModels/save 两 hook 拆 |
| B5.5 | 测试文件型 God fn 8 个（MessagesPaneV2.render 943 · CronV2.test 384 · processGrouping.test 409 · contentReference.spec 408 · annotationReference.spec 381 · useSessionStore.actions.test 354 等） | 测试文件拆分不影响产品 | — | 0.5d | 按 describe 块拆文件 |

### P4 · 数据与测试专项（D38–D41，4 天，B 线）

| # | 事项 | 量 | 通过判据 |
|---|---|---|---|
| P4.1 | 知识卡去重 70 组 / 527,689 B：先写 card-index + 全仓引用比对脚本（现无），按 2026-08-27 先例「留外层」逐组确认后删内层；owner 不确定的组留 note | 70 组 | M8；`.gitignore` 干扰用 git 感知口径（防 72↔70 漂移） |
| P4.2 | adapters 测试补强 0.12 → ≥0.30（95 文件洼地；ImTurnProcessor/ImInboundDispatch 已有直测先例可扩） | ~20 文件 | M11 |
| P4.3 | ui/server→src 15 处直连收口：sati-bridge 5 处优先，其余并 barrel 白名单收敛（新增合法入口 = 白名单 + eslint except 两处同步） | 15 → ≤5 | M10 且门禁 green |
| P4.4 | 同批补：shared/browser/lifecycle/methodology/board 测试洼地按触达顺带补（不单列专项） | 机会型 | 比值有提升即可 |

### P5 · 收口（D42–D45，4 天）

| # | 事项 | 通过判据 |
|---|---|---|
| P5.1 | oracle 全量终审（graded）：45 天 diff 抽审 + M1–M13 全指标复核 | graded 结论，FAIL 走 §7 |
| P5.2 | 全门禁三连跑 + `pnpm test` + `pnpm --filter sati-ui test` 全绿 | CI 4 job green |
| P5.3 | metrics 终值快照（`measure:update`）+ thresholds/baseline 收益锁定 + backlog 全量回填（done + commit + 最后复核） | 账本与代码一致 |
| P5.4 | 结项 note：`docs/notes/` 一篇 sweep 总结（ Alternatives: 为何拆这些/为何不拆哪些/降级记录） | note 入库 |

---

## 6. 每日 / 每周节奏

**每日**（一个闭环）：
1. 早：从当前批次队首取 1 项（并行日取第 2 项给副线）；拆前跑一遍 `pnpm measure:update` 确认基线无漂移；
2. 中：实现（先补测试的项先补）；colocated/同域测试 → 全门禁 → UI 项加双视口 A/B；
3. 晚：PR（Conventional Commits，`refactor(sweep): <域>-<item>`）→ 四件套（metrics / baseline / backlog / note）→ 勾掉本文对应条目。

**每周五**：oracle graded review（抽审本周 diff + 预排下周批）；周一复盘降级信号（§7）。

**每双周**：`measure:update` 趋势留档一次（非门禁需要，为记录趋势）。

---

## 7. 滑期降级顺序（不静默——砍什么、为什么砍，记入 PR/note）

滑期判定：周五 oracle review 或周一复盘发现批次进度落后 ≥1.5 天。按以下顺序**从尾部砍**，每砍一项在 §8 记录理由：

1. B5.5 测试文件型 God fn（0.5d，最低价值）；
2. B5.4 尾部五项中 code-editor / annotation / MainContent（1d）；
3. P4.4 机会型补测（不占专项）；
4. P4.1 知识卡去重（数据专项，不动代码健康门禁；留 note 说明保留原因——70 组重复已登记在 metrics 保持可见）；
5. P4.2 adapters 补测降为目标 0.20；
6. B5.1/B5.2 settings 降为「只拆最痛的 ProviderCard 447」；
7. **红线不砍**：B1.1/B1.2（底座与事件面，砍了等于 A 线主线断裂）、P2.5 主链路、P1.1/P1.4（棘轮目标项）、P0/P5。

若红线也守不住（>3 天系统性滑期）：停下，按 3 轮中断规则上报，出「延到 50 工作日 / 砍 B 线只保 A 线 / 缩小每项验收（保 compile+test 不做 A/B 指纹）」三方案让用户决策。

---

## 8. 状态回填

- 本文件每条目留 `<task>` 空勾；交付时同 PR 勾选 + 一行实施备注（commit 短 hash + 实际行数 before/after）。不回填的代价见 `docs/issue-management.md` §6（21 份文档 559 处悬空勾选的前车之鉴）。
- 与 `docs/technical-debt/backlog.md` 双向：本计划条目 = backlog 对应条目的排期载体；backlog 是债务事实源，本文件是进度载体。
- 节点：P0 完成 / P1 完成 / P2 完成 / P3 完成 / P4 完成 / P5 完成——每节点在 note 里留一天小结。

---

## 9. 风险登记

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| UI 拆分连锁返工（chat 链路 / app-shell 链路共用一个 store 底座） | 中 | 高 | 严格 bottom-up；B1.1/B1.2 未绿不动 B2/B3；每批 oracle 抽审 |
| 双视口 A/B 指纹偶发失配（字体/时序噪声） | 中 | 中 | 复跑一次仍失配才计入失败；失配即停拆，查根因 |
| cli console 迁移改变输出语义（stderr/stdout、SATI_DEBUG 门控） | 中 | 中 | P1.4 逐处确认；先迁移非交互路径，交互 CLI 最后 |
| 知识卡「留外层」判据在个别组不成立（card-index 指向内层） | 中 | 低 | 逐组按脚本证据；不确定的组保留 + note，不硬删 |
| figuregen barrel 收敛留下「一半收敛一半深引」中间态 | 中 | 中 | 与 4 个 tool 文件深引归一同 PR |
| 并行副线产出与主线约定漂移 | 中 | 中 | 副线只做同构件第 2..n 件；主 Agent 逐件验 diff + 跑全门禁 |
| 45 天总产能估算偏差（1.5× 并行系数不成立） | 中 | 高 | §7 降级顺序 + 3 轮中断规则；每周五校准 |
| llm-replay fixture 失配（误触 inputSchema） | 低 | 高 | 每 PR 自查 diff；触及即重录（铁律 6） |
| 新 bug 修复插入挤占工期 | 高 | 中 | bug 走独立 issue 流（§1.2）；仅同文件顺手修 |

---

## 10. 附：本计划的侦察证据来源

- `docs/technical-debt/metrics.md`（2026-10-10 快照，`pnpm check:techdebt-metrics` 保真）
- 两路只读侦察（2026-10-11，HEAD `7a414709e` 实测）：UI 46 个 God function 逐条 AST 复算 + 测试分布 + Top12 拆分接缝；8 类收敛债 file:line 清单（15/70/88/38/17/137/8）
- `docs/technical-debt/backlog.md` §37（2026-09-23 全仓复扫）、`audit-report-2026-09-23.md`
- `docs/technical-debt/next-batches-schedule.md`（#159 历史排期，其完成态为 B 批提供成本模型）
