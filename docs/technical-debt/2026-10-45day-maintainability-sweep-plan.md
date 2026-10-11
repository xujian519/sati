# Sati 全库可维护性优化中期计划（45 红线工作日 + 5 余额档 · 2026-10-12 → 2026-12-18）

> 类型：中期专项计划（技术债总清算 · 可维护性为主）
> 基线：`docs/technical-debt/metrics.md` 快照 **2026-10-10** · git HEAD `7a414709e` · 活账本 `docs/technical-debt/backlog.md`
> 提出：2026-10-11 · v2 修订：2026-10-12（oracle 开工前评审 FAIL → 最小修订集落地，见 §11）
> 状态约定：勾选载体为 `backlog.md` §38（P0.1 建）；交付时按 §8 回填条目状态与实施备注；完成后整篇标注 done 或被新方案取代时在文件头写明被谁取代（`docs/issue-management.md` §6 / 铁律 7）。

---

## 1. 目标与边界

### 1.1 目标

45 个**红线工作日**（D45 = 2026-12-11）+ 5 个**余额档**（D46–D50 = 12-14 → 12-18，在用户给的 40–50 天窗口内，是正规排期档不是失败补救）完成一遍全代码可维护性优化：

1. **拆分**：63 个 ≥300 行 God function 清零主力（≥400 行 32 个归零；300–400 行收敛到设计使然的 ≤8 个编排函数并留 note）；
2. **瘦身**：≥800 行文件 **42 个**（metrics「Top 30 大文件」是 `TOP_FILES_LIMIT=30` 截断表，同口径全量 42）→ **非豁免清零**（每个继续超 800 的文件必须留在 `architecture-baseline.json` 豁免中且带 note，不得静默）；file-size 存量豁免 **42 → ≤20**；
3. **收敛**：类型逃逸（产品代码 `as unknown as` 20 处）、无注释无参 catch 17 处、cli 裸 console 137 + 散落 ~9、figuregen 88 个零消费导出、ui/server→src 15 处直连、知识卡 70 组重复，六类横切债清零或大幅下降；
4. **补强**：测试洼地补齐（adapters 0.12 → ≥0.25；git-panel 0 → 有）。

**未纳入承诺面的部分（不静默）**：42 个 ≥800 行文件中约 25 个（`sati-bridge.js` 2,347 · `WeComChannel.ts` 1,763 · `render-check.ts` 1,633 · `providers.ts` 1,592 · `InProcessGateway.ts` 1,518 · `git.js` 1,506 · `WeixinChannel/FeishuChannel` · `agent.js/taskmaster.js/commands.js/config.js` · `AgentLoop.ts` 1,149 · `streamModel.ts` · `types.ts` 994 · `DefaultContextRuntime.ts` 953 · `loadPilotConfig.ts` · `inkscape-renderer.ts` · `toolConfigs.ts` · `satiConfig.js` · `evidence/engine.ts` · `kanban.ts` 815 等）**无本计划条目承接**——P0.1 将其登记为 sweep 后 backlog 条目，不在 45/50 天承诺面。本计划条目覆盖的是「God function 密集 + 测试有据 + 链路清晰」的 ~17 个文件。

### 1.2 非目标（明确不做）

- **性能专项**：不主动做。记忆检索 30s 阻塞（#536）、文件树（#533）、账本写放大（#537）、团队读放大（#531）等走既有 issue 队列；仅在拆到同文件时顺带处理并登记。
- **4 个开放 bug**（#625 / #626 鉴权、#643 符号链接逃逸、#624 标注门控）：走正常 issue 流程，不占本计划工期；拆到同文件时可顺手修并在回填中注明。
- **工具 `inputSchema` 的任何改动（含描述文本）**：触碰即触发 llm-replay fixture 重录（铁律 6）。本计划全部条目均为内部结构拆分，不触及；PR 时自查 diff。
- **行为变更型重构**：删功能、改 UX 结构、改协议一律不做。所有拆分为行为保持，按 §4.3 逐 token 证明 + 双视口浏览器 A/B。
- **vendored 子包** `src/context/memory/edgeclaw-memory-core`：外部搬入、不随本仓演进，metrics 已单列，不在扫除面。
- **补测暴露的既有缺陷**（ComposerV2/useSessionSubmit/useGitPanelController「先补测再拆」时可能出现）：属行为变更 → 按铁律 11 登记降级项、转正常 issue 流，**不占 sweep 工期**（见 §9 风险 R8）。

### 1.3 产能与日历假设

- 40–50 天按**工作日**口径（若按自然日，则收缩为 P1/P2/P3 红线主干，余额档整体后移，见 §7）。
- 每日 8 小时有效深度工作（本人 + AI 并行：explorer 定位、general 副线执行同构件、oracle 周审）。
- 串行工作量 **≈53 人日**（P0 2.5 · P1 5 · P2 10.5 · P3 红线 25.5 · P4 5.5 · P5 4）；红线跨度 45 = 3+5+10+19+4+4，余额档 5 天装 B5 尾部（B5.4/B5.5）与各批溢出。
- **压缩归因（诚实版）**：P3 红线 25.5d → 19d span（1.34×）主要靠**单件执行速度**（AI 起草下一件 + 人工验证当前件的流水线；先例：2026-09-19 一日合入 #457/#458/#460 三个深度 UI 拆分，各带逐 token 证明 + 双视口 A/B），少量靠同构件副线（B5.1/B5.2/B2.3/B2.5/B4.4 ~4d）与 B 线窗口利用。周审观测量 = **单件实际耗时 / 估时比**（连续两周 >1.2 即判定压缩失效，走 §7）。
- 日历：D1 = 2026-10-12（周一），D45 = 2026-12-11（周五），D50 = 2026-12-18（周五），窗口内无法定假日。

---

## 2. 基线（2026-10-10 实测，HEAD `7a414709e`，两路独立侦察交叉验证一致）

| 维度 | 值 |
|---|---|
| 规模 | src 1,081/187,550 · ui/src 638/102,247 · ui/server 129/35,394 · tests 629 |
| God function ≥300 行 | **63**（≥400 行 32 · 300–399 行 31；ui/src 46 + src 17；其中测试文件条目 6） |
| ≥800 行文件 | **42**（metrics Top30 为截断表；全量口径见 §1.1） |
| file-size 存量豁免 | **42 条**（`architecture-baseline.json`，行数棘轮） |
| 裸 `console.*` | **160**（cli 137 · telemetry 8 · ui/server 6，其余 ~9 散落 src/adapters·shared·mcp·context） |
| 无参 catch | 692（无注释 **17** · thresholds.json 棘轮上限 17） |
| `as unknown as` | 38（**产品代码 20**：ui/src 11 + src 9；其余 18 在测试文件，口径外） |
| 知识卡逐字节重复 | **70 组 / 90 文件 / 527,689 B**（67 组 `专利侵权/` 同名嵌套目录 + 3 组 `专利实务/` 多副本） |
| figuregen 零消费导出 | **88**（barrel 235 个导出名；4 个 tool 文件深引 barrel 内单模块） |
| ui/server→src 直连 | 15（全部在 `check-ui-server-boundary.mjs` 白名单内合法，属已登记耦合面） |
| UI 无 colocated 测试的 God 组件 | **16/40 产品条目**；git-panel 全域 0 测试 |
| 测试洼地（文件比） | adapters 0.12 · shared 0.15 · browser 0.17 · lifecycle 0.17 · methodology 0.21 · board 0.25 · extension 0.25 · always-on 0.37 |
| i18n 缺口 | teamPanel zh 缺 `pill.teamCount_one`；FilesV2 `fileTree.*` 14 处靠 defaultValue 兜底 |

---

## 3. 验收指标（可测、有门禁或脚本背书）

| # | 指标 | 基线 | 目标 | 背书 |
|---|---|---|---|---|
| M1 | God function ≥400 行 | 32 | **0** | `measure-techdebt.mjs` godFunctions 表 |
| M2 | God function 300–400 行 | 31 | **≤8**，每个留 note | 同上；预留额度候选：`sati.ts main`（CLI 参数编排）· `TuiApp`（ink 根组件）· `useGitPanelController` compose 壳 · `patentFigureProject execute` · `executeRouterDecision` · `dispatchRequest` · `mapAgentEventForTurn` · `projectRuntimeFactory resolve` |
| M3 | 非豁免 ≥800 行文件 | gate 自证（现全在豁免中） | **0**（`check-architecture-boundaries.mjs` R3 自证；新增长文件即 gate 红） | 门禁 |
| M4 | file-size 存量豁免 | 42 | **≤20**（每消除一条 `--update-baseline` 注销留痕；保留的每条带 note） | 门禁 + Δ 打印 |
| M5 | 无注释无参 catch | 17 | **0** | `thresholds.json` 棘轮 |
| M6 | cli 裸 console | 137 | **0**（收束后按 C39 先例申报豁免入口；散落 src ~9 处同批收拢） | `measure-techdebt.mjs` |
| M7 | `as unknown as` 产品代码 | 20 | **≤8** | metrics asUnknownAs 口径（src+ui/src） |
| M8 | 知识卡重复 | 70 组 / 527,689 B | **0 或每组有 owner 确认的有意保留 note**；默认达成态 = 脚本化批量判定 + 不确定组留 note 不删（重复数在 metrics 保持可见） | metrics knowledgeDup |
| M9 | figuregen 零消费导出 | 88 | **0**（删除或降测试专用并说明）；88 vs backlog `TD-EXTENSION-N08` 的 84 口径差执行期首日厘清 | **判据脚本 P0.2 入库**（现无，先补再验收） |
| M10 | ui/server→src 直连 | 15 | **≤5**（其余收进白名单 barrel 收口） | 手测（gate 只查白名单成员，对本目标零约束） |
| M11 | adapters 测试文件比 | 0.12 | **≥0.25** | 手测（tests/adapters vs src/adapters） |
| M12 | git-panel 测试 | 0 文件 | **≥3 文件** | 手测 |
| M13 | 全门禁 | — | **每 PR green**：`pnpm check && pnpm test && pnpm test:pr-tooling && pnpm --filter sati-ui test`（`pnpm check` = typecheck×2 + lint 全套 13 域门禁 + format:check，铁律 9） | CI 4 job |

---

## 4. 编排原则

### 4.1 顺序：严格 bottom-up

数据底座 → 叶子组件 → 编排枢纽。`useSessionStore`（被 chat 与 app-shell 两条链路共同消费）与 `useChatRealtimeHandlers`（chat 事件面）先行；`ChatInterfaceV2` / `AppShellV2` 两个枢纽最后。反序拆 = 上游接口重拆 = 连锁返工。同文件两轮改的（P1.4 console → P2.7 sati.ts 拆分）机械项先于结构项。

### 4.2 并行纪律

- **A 线（主线）**：UI 拆分（P3），按 B1→B5 推进。
- **B 线（辅线）**：机械收敛（P1）+ 后端拆分（P2）+ 数据专项（P4），不依赖 A 线产物。
- 两线同周并行；**浏览器验证的等待窗口**用于推 B 线后端项——后端不需要浏览器。
- 并行写入仅限：文件集完全不相交 + 无共享状态 + 无契约耦合（契约级并行见 §9 R7）。同构件批量（settings 三个 IM section、code-editor 预览件、三个 patentFigure 工具）先由主 Agent 做第一件确立模式，其余派 `general` 副线执行，主 Agent 逐件验 diff + 跑门禁。**Worker 报告成功 ≠ 完成**。
- 每 PR 一个 Concern；不把两个域的拆分混在一个 PR。

### 4.3 验证协议（每 PR 必过）

**后端 / 主链路项**（铁律 8）：
1. `pnpm typecheck && pnpm test`（node --test dist 全量）；
2. 触碰 LLM 回路的走重放 seam；**不碰 inputSchema**，自查 diff 无 schema/描述文本变更；
3. 新增/搬迁的纯函数补直测（迁徙段逐 token 可证的，录 A/B 输出）。

**UI 项**（复用 #159 已验证的成本模型）：
1. `pnpm --filter sati-ui test`（colocated + 同目录测试全绿；拆 MessagesPaneV2 必须保 943 行 render describe 整块 green）；
2. 无 colocated 测试的 16 个产品条目：**先补测试再拆**（补测暴露缺陷按 §9 R8 处理）；
3. **双视口浏览器 A/B 指纹逐字节相同**（桌面 + 移动）+ N 项负控制（PR #457/#458/#460 先例）；
4. 新增用户可见文案一律提取 `ui/src/i18n/locales/{en,zh-CN}/`（铁律 4）；
5. 拆分跨度证明：函数行数 before/after + 搬迁段逐 token 对照记录在 PR 正文。

**每 PR 同批落五件**（缺一即债）：
1. `pnpm measure:update`（影响指标的改动）；
2. 消除 file-size 豁免的 `node scripts/check-architecture-boundaries.mjs --update-baseline`（打印 Δ）；
3. `backlog.md` 对应条目标 done + commit/PR + 最后复核日期；
4. 非平凡拆分一条 `docs/notes/implemented/` decision note（含 `## Alternatives considered`，铁律 7；一个工作流里程碑一篇）；
5. **新增 `*.test.ts` 必须 `git add -f` 且同 PR `measure:update`**——`.gitignore` 忽略 `*.test.ts`，不 force-add 则测试不入库、CI 不跑（#449 前车之鉴），且 force-add 改变 tests 基线（629）。**不在 CI 跑的测试 = 没测**。

### 4.4 棘轮守夜

- `thresholds.json`：catchEmpty=0 / catchNoParam.undocumented=17 → 下降后 `--update-thresholds` 锁定收益；
- `architecture-baseline.json` file-size 行数上限：存量文件不得再长；拆分后立即注销；
- 每次刷新强制打印 Δ，让「承认动作」在 diff 里留痕。

### 4.5 周度 Oracle 门禁与中断规则（唯一定义处）

每周五派 `oracle` 做独立 Review（graded 门禁结论）：本周 diff 抽审 + 下周批次预排 + 单件耗时/估时比趋势。
**中断触发（唯一定义，§7 只引用）**：连续 2 周 oracle FAIL，**或**任一批次滑期 >3 天 → 停止自动推进，按中断规则上报用户（当前状态 / 原因 / 2-3 个方案 / 推荐项），不无限重试。

---

## 5. 阶段计划

### P0 · 基线与编排（D1–D3，3 天）

| # | 事项 | 量 | 通过判据 |
|---|---|---|---|
| P0.1 | 冻结清单：63 God fn + 42 个 ≥800 行文件进 `backlog.md` §38（勾选载体）；~25 个无承接文件登记为 sweep 后条目；修正「Top30 截断表」认知 | 0.5d | §38 收录、42 文件全量可查 |
| P0.2 | #159 逐 token 证明 + 双视口 A/B 指纹流程写成 checklist；**A/B 指纹自动化程度实测**（人工 or 脚本，计入成本模型）；**M9 判据脚本化入库**（零消费导出扫描进 `scripts/`） | 1.5d | P1 起每个 UI PR 引用；M9 可机械复算 |
| P0.3 | milestone + 分支策略（每项 `refactor/sweep-<batch>-<item>`）+ 每日 rhythm（§6）+ 跟踪 issue 挂 milestone | 0.5d | 跟踪载体就绪 |

### P1 · 机械收敛（D4–D8，5 天，B 线先行）

| # | 事项 | 量 | 兜底 | 通过判据 |
|---|---|---|---|---|
| P1.1 | 无注释无参 catch 17 处补「失败模式→回退语义」注释（清单在 `backlog.md` `TD-CATCH-001` 残留条目与 §37.3；侦察明细：`HookTrustStore.ts:50/72` · `proxyFallback.ts:54` · `figure.ts:242` · `probe.ts:70` · `window/store.ts:61/129` · `patentSignals.ts:90/97/104` · `ui/src` 4 处 · `config.js:669` 等）；`proxyFallback.ts:54`/`config.js:669`/`api.js:142` 意图需业务确认 | 17 | 有 | M5=0，棘轮下调 |
| P1.2 | i18n：teamPanel zh 补 `pill.teamCount_one`；FilesV2 `fileTree.*` 14 处 defaultValue → 正式 en/zh keys | 15 key | `check:i18n-namespaces` | 两语言全绿、defaultValue 清零 |
| P1.3 | `as unknown as` 产品代码 20 处 → 守卫/窄类型（ui/src 11 + src 9；测试文件不动） | 20 | typecheck 自验证 | M7 ≤8 |
| P1.4 | cli 裸 console 137 + src 散落 ~9 → `src/telemetry/logger.ts`（cli：gatewaySetup 80 · sati.ts 38 · configSet 8 · chatSearch 4 · satiServer 3 · patentSearch 3 · createLocalGateway 1）；注意 stdout/stderr 映射与 SATI_DEBUG 门控语义差异，逐处确认降噪预期 | ~146 | cli 15 测试 + typecheck | M6=0 后按 C39 先例申报豁免入口 |
| P1.5 | figuregen barrel 收敛：88 零消费导出分类（删除 / 降测试专用 / 保留说明）+ 4 个 tool 文件深引归一 barrel + decision note（`TD-EXTENSION-N08` 口径差 84↔88 首日厘清） | 88 | patent 141 测试 | M9=0，#541 收口 |

### P2 · 后端拆分（D9–D18，10 天）

| # | 位置（file:function） | 现状 | 兜底 | 量 | 通过判据 |
|---|---|---|---|---|---|
| P2.1 | `gateway/client/InProcessGateway.ts:submitTurn`（301 fn / 1,518 file） | 主链路 | gateway 34 测试 + 重放 | 1.5d | submitTurn ≤150 行，契约不变 |
| P2.2 | `gateway/client/eventMapping.ts:mapAgentEventForTurn`（417） | 事件面 | gateway 测试 + `check:event-matrix` | 1d | 映射表化，事件矩阵不变 |
| P2.3 | `gateway/client/telemetry.ts:emitSessionTelemetry`（333） | — | telemetry 3 测试 | 0.5d | ≤150 行 |
| P2.4 | `gateway/server/GatewayWsConnection.ts:dispatchRequest`（353） | 已有守卫表 | dispatch.spec | 0.5d | 守卫表反推分发 |
| P2.5 | patentFigure 三工具：`patentFigureProject`（554+411）· `patentFigureGenerate`（422+322）· `patentFigureCheck`（384） | **规则层已就绪**：#539（PR #555，2026-09-24）已交付规则注册表 `check-rules.ts` 与共享产物装配 `deliverables.ts`（三个工具已 import，`patentFigureProject.ts:34-35`）；剩余 = 三个 execute 收敛到既有共享装配 | patent 141 测试 | 1.5d | 三个 execute 各 ≤200 行，无第二份产物清单 |
| P2.6 | `router/execution/executeRouterDecision.ts:executeRouterDecision`（449） | 主链路 | router 19 测试 | 1d | 决策树外置，行为逐 token |
| P2.7 | `cli/sati.ts:main`（642 fn / 1,035 file）+ `cli/projectRuntimeFactory.ts`（424+316） | CLI 入口；在 P1.4 迁完 console 后动 | cli 15 测试 | 2d | 命令分发表化；两 file ≤600 |
| P2.8 | `adapters/channel/tui/app/TuiApp.tsx:TuiApp`（643） | TUI | adapters 11 测试 + ink-testing | 1d | 拆 render/input/state 三层 |
| P2.9 | `web/client/webMessage.ts:applyWebGatewayEvent`（383）+ `tool/execution/ToolRuntime.ts:execute`（388） | — | web 9 / tool 68 测试 | 1d | 各 ≤200 行 |
| P2.10 | `patent/graph/domains/inventiveness.ts:buildInventivenessGraph`（342） | — | patent 测试 | 0.5d | 图构建声明化 |

### P3 · UI 拆分（D19–D37，19 天红线 span；A 线；按批 bottom-up）

#### B1 · 底座与实时链（D19–D23，5 天）

| # | 位置 | 现状 | 兜底 | 量 | 通过判据 |
|---|---|---|---|---|---|
| B1.1 | `ui/src/stores/useSessionStore.ts:createSessionActions`（631 fn / 1,352 file） | **数据底座**，双链路共用 | 2 个 store 测试（actions 354 行 describe + streaming 575 行） | 2.5d | server fetch / subagent detail / streaming / activity 四组 → actions factories；`createSessionActions` ≤350 行；文件 ≤800，注销豁免 |
| B1.2 | `ui/src/components/chat/hooks/useChatRealtimeHandlers.ts`（721 fn + 624 fn = handleMessage） | chat 事件面；**与 P2.2 互为契约接缝**（§9 R7） | colocated 210 行测试 | 2d | 624 行 handleMessage → 按 kind 分发的 handler 注册表；timers → `useSessionStatusRetryTimers`；helper → utils；两函数各 ≤350 |
| B1.3 | `ui/src/hooks/useProjectsState.ts:useProjectsState`（647） | app-shell 数据 | colocated 115 行 | 1d | openSettings / optimistic / selection 三簇外置，≤400 |

#### B2 · chat 主链路（D24–D29，6 天；执行序 = 子件先、枢纽后）

| # | 位置 | 现状 | 兜底 | 量 | 通过判据 |
|---|---|---|---|---|---|
| B2.1 | `chat-v2/MessagesPaneV2.tsx:MessagesPaneV2`（824） | #159 已拆一轮仍 824 | **943 行 render describe** | 2d | ~15 个 useMemo → `useRenderableMessageItems`；subagent 投影 → hook；行渲染 → per-kind dispatcher；≤350 行且测试整块 green |
| B2.2 | `chat-v2/ComposerV2.tsx:ComposerV2`（741） | **零测试** | 先补 | 1.5d | token budget 展示块 → `ContextWindowIndicator`；派生状态 → `useComposerDerivedState`；≤400 |
| B2.3 | `chat-v2/MessageRowV2`(429) + `SubagentDetailMessageFlow`(309) + `chat/view/subcomponents/MessageComponent`(335) | MessageComponent memo 已部分拆；三者有测试 | MessageComponent 2 测试 | 0.5d | 各自 ≤300 |
| B2.4 | `chat/hooks/` 三件：`useSessionSubmit`(528) `useSlashCommands`(395) `useSlashCommandExecute`(331) | useSubmit **无测试** | 先补 | 1.5d | 三 hook ≤300（补测暴露缺陷按 §9 R8） |
| B2.5 | `chat/hooks/useChatComposerState`(467) + `useFileMentions`(366) + `AskUserQuestionPanel`(378) | #159 残余 + 有测试 | colocated | 0.5d | ≤300 |
| B2.6 | `chat-v2/ChatInterfaceV2.tsx:ChatInterfaceV2`（668） | **编排枢纽，本批最后执行**（B2.1–B2.5 是它的子件） | reconnect.spec | 1.5d | 流缓冲 / fork-regenerate / reconnect / composerSlot 四簇外置，props 契约不动；≤350 |

#### B3 · app-shell（D30–D32，3 天）

| # | 位置 | 现状 | 兜底 | 量 | 通过判据 |
|---|---|---|---|---|---|
| B3.1 | `app-shell/SidebarV2.tsx:SidebarV2`（1,014 fn / 1,323 file） | **props-only 零 store import，低连锁** | 172 行行为测试 | 2d | renderSessionRows / renderProjectGroup / 右键菜单 / resize / rename 五簇外置；≤400 |
| B3.2 | `app-shell/MainAreaV2.tsx`（381） | — | colocated 235 行 | 0.5d | ≤300 |
| B3.3 | `app-shell/AppShellV2.tsx:AppShellV2`（631） | **外壳枢纽，全计划最后** | 邻接 2 测试 | 1d | switchProject / 删除对话框 / 选择处理 / misrouted URL 外置；≤350 |

#### B4 · main-content-v2（D33–D36，4 天）

| # | 位置 | 现状 | 兜底 | 量 | 通过判据 |
|---|---|---|---|---|---|
| B4.1 | `main-content-v2/DashboardV2.tsx`（332 fn / **1,345 file**，~15 个兄弟组件） | 多组件文件，抽兄弟非拆函数 | 无 | 1.5d | 兄弟组件 → `dashboard/` 子目录；主文件 ≤500 |
| B4.2 | `main-content-v2/SkillsV2.tsx`（1,441 file，无 ≥300 fn） | #159 已拆 ImportFromFolder 仍 1,440 | 863 条导入链路测试 | 1.5d | 按功能分子文件（同 #460 模式） |
| B4.3 | `main-content-v2/FilesV2.tsx:FilesV2`（849） | **零测试** | 先补 | 1.5d | inline edit / 右键菜单 / 文件操作 / 上传下载四簇 → hooks + 组件；i18n key 已在 P1.2 落地 |
| B4.4 | `main-content-v2/CronV2.tsx`（476 fn / 1,129 file）+ `PlansAndCronJobs`(334) + `ImportFromFolder`(688) | Cron 有 463 行测试 | 有 | 1d | CronV2 拆 CronFormView/CronListView 两文件；另两项 ≤400 |

#### B5 · settings + 尾部（D37–D39 红线 span；B5.4/B5.5 滑入余额档 D46–D50）

| # | 位置 | 现状 | 兜底 | 量 | 通过判据 |
|---|---|---|---|---|---|
| B5.1 | settings IM 三 section：WeCom(398) / Feishu(381) / Weixin(303) | 同构，Weixin 有测试 | Weixin 206 行 | 1d | 共享 IM section 框架（主 Agent 第一件，其余副线） |
| B5.2 | settings `ProviderCard`(447) + `RouterSection`(357) + `ToolsSection`(399) | ToolsSection 有测试 | ToolsSection 有 | 1d | 各 ≤300 |
| B5.3 | `git-panel/hooks/useGitPanelController.ts`（704） | **全域 0 测试**，最大零覆盖债 | 先补 | 1.5d | 先补 ≥3 个测试文件，再拆 branch/remote/commit/working-tree 四子 hook |
| B5.4 | 尾部：`onboarding/LlmConfigurationStep`(633) · `kanban/useBoardState`(368) · `code-editor` 三件(422/407/326) · `MainContent`(573+346) · `annotation/Annotator`(322) | LlmConfigurationStep 4 测试 · 其余混合 | 混合 | 2.5d | 各自 ≤300-400；**默认进余额档** |
| B5.5 | 测试文件型 God fn **6 个**（MessagesPaneV2.render 943 · processGrouping.test 409 · contentReference.spec 408 · CronV2.test 384 · annotationReference.spec 381 · useSessionStore.actions.test 354） | 测试文件拆分不影响产品 | — | 0.5d | 按 describe 块拆文件；**默认进余额档** |

> B5 红线 span 只装 B5.1–B5.3（3.5d，压 3 天）；B5.4/B5.5（3d）在余额档 D46–D50 交付——**这是排期决定不是滑期降级**，D45 交付口径见 §7。

### P4 · 数据与测试专项（D38–D41，4 天，B 线；溢出进余额档）

| # | 事项 | 量 | 通过判据 |
|---|---|---|---|
| P4.1 | 知识卡去重 70 组 / 527,689 B：用 P0.2 已入库的判据 + card-index 引用比对（2026-08-27 先例「留外层」），逐组确认后删内层；owner 不确定组留 note 不删 | 2d | M8 达成态（默认态见 §3） |
| P4.2 | adapters 测试补强 0.12 → 0.25（95 文件洼地；ImTurnProcessor/ImInboundDispatch 直测先例可扩；新增 `*.test.ts` 走 §4.3 第五件） | 2d | M11 |
| P4.3 | ui/server→src 15 处直连收口：sati-bridge 5 处优先，其余并 barrel 白名单收敛（新增合法入口 = 白名单 + eslint except 两处同步） | 1d | M10 且门禁 green |
| P4.4 | 同批补：shared/browser/lifecycle/methodology/board 洼地按触达顺带补 | 0.5d | 机会型，比值有提升即可 |

### P5 · 收口（D42–D45，4 天）

| # | 事项 | 通过判据 |
|---|---|---|
| P5.1 | oracle 全量终审（graded）：红线期 diff 抽审 + M1–M13 复核（M9 用 P0.2 入库脚本复算） | graded 结论 |
| P5.2 | 全门禁三连跑：`pnpm check && pnpm test && pnpm test:pr-tooling && pnpm --filter sati-ui test` | CI 4 job green |
| P5.3 | metrics 终值快照（`measure:update`）+ thresholds/baseline 收益锁定 + backlog 全量回填（done + commit + 最后复核） | 账本与代码一致 |
| P5.4 | 结项 note：sweep 总结（含 Alternatives：为何拆这些 / 为何不拆哪些 / 未承接 25 文件的处置 / 降级记录） | note 入库 |

---

## 6. 每日 / 每周节奏

**每日**（一个闭环）：
1. 早：从当前批次队首取 1 项（并行日取第 2 项给副线）；跑 `measure:update` 确认基线无漂移；
2. 中：实现（先补测试的项先补）；colocated/同域测试 → 全门禁 → UI 项加双视口 A/B；
3. 晚：PR（`refactor(sweep): <域>-<item>`）→ 五件套（§4.3）→ backlog §38 勾选。

**每周五**：oracle graded review（抽审本周 diff + 预排下周批 + 单件耗时/估时比）；周一复盘降级信号（§7）。

**每双周**：`measure:update` 趋势留档（非门禁需要，为记录趋势）。

---

## 7. 滑期降级与余额档（不静默——砍什么、为什么砍，记入 PR/note）

**D45 = 红线口径交付，D46–D50 = 余额档**（用户给的 40–50 天窗口内的正规档，不是失败补救）：
- 红线口径（D45 必须达到的）：B1.1/B1.2（底座与事件面）· B2.1–B2.6 · B3.1–B3.3 · B4.1–B4.4 · B5.1–B5.3 · P1 全部 · P2.1/P2.2/P2.6 · P0/P5；
- 余额口径（D46–D50 交付）：B5.4/B5.5 · P4 溢出 · 各批溢出件。

**滑期判定**：周五 oracle review 或周一复盘发现批次进度落后 ≥1.5 天。**砍单即回填**：砍下的 span 按 B5→P4→B1–B4 溢出顺序回填，不得蒸发。按以下顺序从尾部砍，每砍一项在 PR/note 记录理由：

1. B5.5（0.5d）→ 2. B5.4 中 code-editor/annotation/MainContent（1d）→ 3. P4.4（机会型）→ 4. P4.1 降为「脚本 + 批量判定，不确定组全留 note」（-1d）→ 5. P4.2 目标降 0.20 → 6. B5.1/B5.2 降为只拆 ProviderCard；
7. **余额档若再滑期**（D50 仍差 >1.5 天）：触发 §4.5 中断规则上报，出「申请延期 / 再砍（M8 放弃全删、B5.4 剩 kanban 一件）/ 缩小验收（保 compile+test 不做 A/B 指纹）」三方案让用户决策。

**红线条目不砍**：B1.1/B1.2（砍了 A 线主线断裂）· P2.1/P2.2/P2.6（gateway/router 主链路）· P1.1/P1.4（棘轮目标项）· P0/P5。

---

## 8. 状态回填

- **勾选载体 = `backlog.md` §38**（P0.1 建，约定见 `docs/issue-management.md` §6.1 的 `- [ ]` 格式）；本文表格是排期载体，不重复维护第二套勾选。
- 每条交付：§38 勾选 + 一行实施备注（commit 短 hash + 实际行数 before/after）；不回填的代价见 §6.1（21 份文档 559 处悬空勾选的前车之鉴）。
- 与 `backlog.md` 双向：backlog 是债务事实源，本文件是进度载体。
- 节点：P0 / P1 / P2 / P3 / P4 / P5 完成 + D45 红线交付 + D50 余额档关闭——每节点在 note 留一天小结。

---

## 9. 风险登记

| # | 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|---|
| R1 | UI 拆分连锁返工（chat 链路 / app-shell 链路共用 store 底座） | 中 | 高 | 严格 bottom-up；B1.1/B1.2 未绿不动 B2/B3；每批 oracle 抽审 |
| R2 | 双视口 A/B 指纹偶发失配（字体/时序噪声）或自动化程度低致人力超支 | 中 | 中 | 复跑一次仍失配才计失败；P0.2 先实测自动化程度计入成本模型 |
| R3 | cli console 迁移改变输出语义（stderr/stdout、SATI_DEBUG 门控） | 中 | 中 | 逐处确认；先非交互路径，交互 CLI 最后 |
| R4 | 知识卡「留外层」判据个别组不成立（card-index 指向内层） | 中 | 低 | 逐组脚本证据；不确定组保留 + note，不硬删 |
| R5 | figuregen barrel 收敛留「一半收敛一半深引」中间态 | 中 | 中 | 与 4 个 tool 文件深引归一同 PR |
| R6 | 并行副线产出与主线约定漂移 | 中 | 中 | 副线只做同构件第 2..n 件；主 Agent 逐件验 diff + 跑全门禁 |
| R7 | **P2/P3 主链路接缝并行**：P2.1/P2.2（submitTurn / mapAgentEventForTurn）与 B1.1/B1.2（useSessionStore / useChatRealtimeHandlers）互为契约接缝，回归可能落在接缝、被两侧各自验证互相掩盖 | 中 | 高 | B1.2 拆分以 `check:event-matrix` + 重放 fixture 对拍 P2.2 映射表化；**任一侧未绿另一侧不动**；oracle 周审重点抽接缝 |
| R8 | **零测试项「先补测」暴露既有缺陷**（ComposerV2 / useSessionSubmit / useGitPanelController）：属行为变更（§1.2 非目标） | 中 | 中 | 按铁律 11 登记降级项、转正常 issue 流，不占 sweep 工期；不为了「让补测绿」而改行为 |
| R9 | 45 天产能估算偏差（P3 压缩 1.34× 失效：A/B 人工比对 / AI 起草一次通过率低） | 中 | 高 | 周审「单件耗时/估时比」观测量；连续两周 >1.2 即判定失效走 §7 |
| R10 | tests 基线 +~25 文件（补测潮 + force-add）拉长 CI、增加 metrics 回填频次 | 高 | 低 | P3 中期评估一次 CI 时长；回填并入五件套不单独排期 |
| R11 | 新 bug 修复插入挤占工期 | 高 | 中 | bug 走独立 issue 流（§1.2）；仅同文件顺手修 |

---

## 10. 附：证据来源与 v2 修订记录

- 基线：`docs/technical-debt/metrics.md`（2026-10-10 快照，`pnpm check:techdebt-metrics` 保真；Top30 为截断表，全量 42）。
- 两路只读侦察（2026-10-11，HEAD `7a414709e`）：UI 46 个 God function 逐条 AST 复算 + 测试分布 + Top12 拆分接缝；8 类收敛债 file:line 清单（15/70/88/38/17/137/8）。
- `docs/technical-debt/backlog.md` §29/§37、`audit-report-2026-09-23.md`、`next-batches-schedule.md`（#159 历史成本模型）。
- **v2 修订（2026-10-12，oracle 开工前评审 FAIL → 小修后执行）**：M3/M4 基线 30→42 且改「非豁免清零 + 豁免 with-note」口径；§1.1 补「25 个未承接文件」清单；B5 算术闭环（B5.4/B5.5 入余额档 + 砍单即回填规则）；P4 补单条日估；P2.5 按 #539 已交付改写（预算 2.5→1.5d）；B1.1/B2.1/B2.6/B3.3 补 ≤350 行目标 + M2 预留 note 候选；压缩归因改诚实版 + 周审耗时比；§4.3 加 `*.test.ts` force-add 第五件；§8 勾选载体改 backlog §38；M13 改聚合命令；M10 背书改手测；M9 判据脚本化进 P0.2；B5.5 8→6；P1.1 指针修正；§9 加 R7/R8 两行；§4.5 中断规则单点定义；§1.1 22→20。
