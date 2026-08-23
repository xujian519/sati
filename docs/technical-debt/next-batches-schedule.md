# Sati 后续批次专项排期建议

> 日期：2026-08-23（当前主流程批次「技术债修复」进行中）
> 依据：`docs/technical-debt/backlog.md` §29.C 修复排期（B1–B6 全量审计后），与已建 issue 一一映射。
> 定位：**专项 Sprint 排程**。区分「可顺手」的机会型条目与「必须专项」的 L 工作量条目；标注工作量大、爆炸半径、是否需要浏览器验证、是否存在硬截止。

## 0. 结论速览

当前批次共 6 条 issue，其中 2 条已闭环（#160、#164），剩 **4 条专项**待做；另有 1 条**带硬截止**的收口项（#150）与一批**机会型**（路过就修）条目。

| 项 | 类别/级别 | 工作量 | 爆炸半径 | 浏览器验证 | 建议阶段 |
|---|---|---|---|---|---|
| #163 类型强转收敛（TD-TYPE-002） | B / P1 | L | 低 | 不需要 | 一 |
| #162 收束裸 console + 静默 catch（TD-CONSOLE-001 · TD-CATCH-001） | C / P2 | L | 低 | 不需要 | 一（穿插） |
| #159 前端 God Hook/组件拆分（UI-CHAT-N01/02/03/04/07 · UI-APP-N01） | A / P1 | L | **高（UI 主链路）** | **必须**（桌面+移动） | 二 |
| #161 policy-bridge 拦截接线（RULE-N02） | F / P2 | S(代码) | **极高（全局权限）** | 不需要 | 三（灰度） |
| #150 多套并行引擎统一（WORKFLOW-N01 · PATENT-N01） | D / P1 | L | 高 | 不需要 | 三/四（硬截止） |

> 注：以上 4 条专项均**不触碰工具 `inputSchema`**，因此不会使 llm-replay fixture 失配，无需重录（AGENTS 铁律 6 / 重放契约）。

## 1. 现况盘点

### 已闭环（本批次）
- **#165**（TD-UI-APP-N04）：LlmConfigurationStep 收尾。
- **#167**（TD-KNOWLEDGE-N01）：knowledge 三引擎 FTS→LIKE 编排去重。
- 另：`#166` 纯文档同步（TD-DOC-001 / TD-GATEWAY-008 / TD-CONTEXT-N04）。

### 待做专项
- **#163 类型强转收敛**（TD-TYPE-002，P1/L）：全源码 >90 处 `as`。`gateway/GatewayWsConnection.ts` `as never` 43 · `gateway/client/RemoteGateway.ts` `as XResult` ~30 · `knowledge/**` DB 行 `as X` 29 · `model/streaming`/`providers/google`/`patent/provenance`/`evidence/receipt` `as unknown as X`。
- **#162 可观测性收束**（TD-CONSOLE-001 + TD-CATCH-001，P2/L）：裸 `console.*` 267 处（`cli` 191 最热）；静默吞错 catch 151 处（`adapters` 40 · `always-on` 15 · `tool` 14）。
- **#159 前端 God Hook/组件拆分**（P1/L）：见 §2 阶段二子项。
- **#161 policy-bridge 接线**（RULE-N02，P2/S-code）：`rulesToPolicyDenyRules` 从不注入 `PermissionContext`，`action:"block"` 未真正拦截工具调用。
- **#150 多引擎统一**（WORKFLOW-N01 / PATENT-N01，P1/L）：`.brooks-lint.yaml` 对该债 suppress 至 **2026-11-18**。

## 2. 建议顺序（阶段化）

### 阶段一 · 低风险机械收口（优先做）
**#163 类型强转收敛（P1）**：本质机械、`typecheck` 即自验证、无 UI、爆炸半径小，ROI 最高。按模块切片，每片独立 PR：

1. `gateway/GatewayWsConnection.ts` `as never`(43) → 用 `unknown` + 收窄守卫；
2. `gateway/client/RemoteGateway.ts` `as XResult`(~30) → 引入 `isXResult` 类守卫或精确结果类型；
3. `knowledge/**` DB 行 `as X`(29) → 行类型（替代裸 `as X`）；
4. `model/streaming` · `providers/google` · `patent/provenance` · `evidence/receipt` `as unknown as X` → 类型守卫。

可穿插 **#162 的 `cli` 部分**：`sati.ts` / `createLocalGateway.ts` 191 处 `console.*` 收束到 `src/telemetry/` wrapper，作为低风险填充项。

### 阶段二 · 前端专项拆分（Sprint 级，需浏览器验证）
**#159 前端巨无霸（P1）**：风险高，必须逐组件 PR + 浏览器验证（桌面 + 移动双视口），并按铁律 4 将新增用户可见文案提取到 locales。拆子项推进，先摘低垂果实：

1. **UI-CHAT-N02**：删 `useChatSessionState` 恒 false 死状态 `isLoadingMoreMessages`（S，先做）；
2. `SkillsV2` / `ImportFromFolder`（UI-APP-N01，2503 行）；
3. `useChatComposerState`（UI-CHAT-N01，~1430 行）；
4. `MessagesPaneV2`（UI-CHAT-N03，1252 行）；
5. `PdfDocumentPreview`（UI-CHAT-N07，1138 行）。

每个组件一个 PR；拆分后**必须**浏览器验证 + 补组件测试（这些巨型组件测试薄弱，见 UI-CHAT-N10）。涉 UI 改动须按 AGENTS/用户规则验证，不能只凭截图。

### 阶段三 · 高改动面 + 硬截止（单独排期）
- **#161 policy-bridge 接线（P2）**：影响 `PermissionRuntime` 全局工具拦截。建议**最后做**：`flag-gated` 灰度 + 一次只开一个规则域 + `docs/notes/` decision note（含 `## Alternatives considered`）。勿当作快项直接全量接入。
- **#150 多引擎统一（P1）**：suppress 至 **2026-11-18** 到期，需在截止前完成「graph↔workflow↔flexible-plan」能力对比 + 消费者需求评估，产出「删除 / 合并 / 降级」结论。

## 3. 机会型（不占专项排期，命中才修）

| Issue | 内容 | 触发条件 |
|---|---|---|
| #147 | AgentLoop / createLocalGateway 巨型文件 | 下次动 AgentLoop 主循环或 gateway 装配 |
| #148 | edgeclaw-memory-core 大文件 | 随 memory 里程碑（M1/M2 记忆增强） |
| #149 | 渠道公共 helper 去重（ADAPTERS-N01） | 新增下一 IM 渠道前 / 渠道里程碑 |
| #151 | patent 域耦合度确认 | 下次大改 patent 任一核心子模块前 |
| #152 | 800–1000 行工具文件 | 下次改这些文件时顺带拆分 |
| #153 | patent 数据映射层领域逻辑位置 | 下次动 patent 数据映射时确认 |

## 4. 持续项

- 每季度 `node scripts/measure-techdebt.mjs --update docs/technical-debt/metrics.md` 刷新指标趋势；
- 每个非平凡修复按 AGENTS 铁律 7 在 `docs/notes/` 记一条 note（含 `## Alternatives considered`）；
- 新功能引入新债时顺手在 `backlog.md` 新增条目。

## 5. 依赖与约束（执行时注意）

- **重放契约**：本排期各项均不改工具 `inputSchema`，无需重录 llm-replay fixture；若后续改动 `inputSchema`（含描述文本），须重录。
- **浏览器验证**：#159 必须浏览器验证；其余纯后端无需。
- **i18n 铁律**：#159 若新增用户可见文案，须提取到 `ui/src/i18n/locales/{en,zh-CN}/`。
- **门禁**：每项走 `pnpm typecheck && pnpm lint && pnpm format:check`；改核心模块（`router/` `tool/` `session/` 等）须附测试。涉及事件面改版须过 `pnpm check:event-matrix`（#163/#161 均不改事件面）。

## 6. 状态跟踪

| Item | 状态 |
|---|---|
| #160 / #164 | ✅ done（PR #165 / #167） |
| #163 / #162 / #159 / #161 | ⏳ 待做（按 §2 阶段推进） |
| #150 | ⏳ 待做（硬截止 2026-11-18） |

---

## 7. 复评结论（Brooks-Lint 技术债评估，2026-08-23）

> 依据：对全项目（`src/` 33 模块 + `ui/` + `apps/desktop/` + `scripts/`）的独立扫描 + `backlog.md` 台账交叉核对。本节做**优先级复排与「值与不值为」判断**，不重复 `backlog.md` 逐条条目（那仍是唯一事实源，且已新鲜）。

### 复评观察（增量扫描，台账未系统量化）

- **R5 依赖混乱 · 模块级为正向**：模块级依赖环 **0**、import 扇出均 ≤5、`src→ui` 导入 **0**。R5 的实质债是**类型断言/契约侵蚀**（>90 处 `as`），而非模块环。
- **8 月新增模块（team M1 / patent graph / clarity / session workspace / patent evaluate）卫生面干净**：无空 `catch {}`、无 `TODO/FIXME`、无 `console.*`、无 `@ts-ignore`；唯一 God function 是 `buildInventivenessGraph`（~356 行）。
- `patent/graph` 与 `patent/workflow` 的双轨重复（呼应 PATENT-N01）经代码核实：`src/workflow/runtime/` 的 DagEngine/WorkflowEngine/SafeEvaluator 等在全 `src/` 无生产消费方，仅 `patent/workflow-dag.ts` 与 `patent/graph/adapter.ts` 借用 `FlowGraph`/`FlowNodeType`。

### 复排后的优先级（Recommended focus）

| 序 | 项 | 类别/级别 | 判定 | 理由 |
|---|---|---|---|---|
| ① | **#163 类型断言收敛**（TD-TYPE-002） | R5 / P1 | **值得清，最先做** | 纯机械、`typecheck` 自验证、无 UI、爆炸半径小、不触发重放契约，ROI 最高 |
| ② | **#159 前端 God Hook/组件拆分** | R1 / P1 | **值得清，唯一须浏览器验证** | 高价值但高风险；唯一需浏览器（桌面+移动）实测的专项 |
| ③ | **#162 可观测性收束**（裸 console + 静默 catch） | R2 / P2 | **值得清，可与①穿插滚焊** | 普通工具；改日志方案是 Shotgun Surgery，统一 churn 前先定期 |
| ④ | **#150 多引擎统一** | R4 / P1 | **值得清，但**须**排期评估** | 已 suppress 至 2026-11-18；勿作快项全量删，先出「删除/合并/降级」结论 |
| ⑤ | **#161 policy-bridge 接线** | R4 / P2 | **值得清，但最后做** | 全局权限高爆炸半径，须 flag-gated 灰度 + decision note |

### 值得优先动（真正值得清）

- **#163 类型断言**：机械、零新增行为、不触碰 `inputSchema`（不使 llm-replay fixture 失配）。分步切片见 `docs/type-assertion-cleanup-plan.md`；排序决策见 `docs/notes/implemented/2026-08-23-type-assertion-cleanup-priority.md`。
- **#159 前端 God 组件**：全项目最大可维护性病灶；拆分后必须浏览器验证 + 补组件测试（UI-CHAT-N10）。
- **#162 可观测性**：267 处裸 `console.*` 与 151 处静默吞错，是唯一横跨所有模块的收敛性债。

### 不建议优先动（判别）

- **#150 双轨引擎**：`src/workflow` 引擎无生产消费者，属死重量而非活跃 bug；带硬截止（2026-11-18），排期评估前置，勿在无结论前删。
- **#161 policy-bridge**：影响全局工具拦截，勿当快项直接全量接入。
- **8 月新增核心模块自带的「已知限制」**（如 team 冷恢复 turn 的 approval_pending 不冒泡，M2 接线点）属**有意设计 + 有 owner**，按台账记为 intentional，不进此排期。

### 复评对既有排期的对齐与修正

- **无冲突**：§2 阶段一「#163 先做」、阶段二「#159 需浏览器验证」、阶段三「#161 灰度 / #150 硬截止」均与本复评一致。
- **修正一处强调**：本复评把 **#163 与 #162 的 `cli` 部分**并列为「低风险机械收口」，并明确 #163 是**全项目 ROI 最高的单项**（机械、自验证、无 UI），建议作为独立切片先行落地。
- **新增一条散落但根因同源**：`planModeConstraints`/`askModeConstraints` 工具白名单、`AgentSessionState`/`loop/misc` usage 合并、literature 4 连接器 limit/authors/toHit 属于**小决策重复（R3）**，既有台账未并列为独立条目，建议下次改对应文件时顺带收敛。

### 复评边界

- 本复评基于静态扫描 + 台账交叉，未在浏览器实测 #159；#159 落地后须按用户规则浏览器验证（桌面 + 移动）。
- 每一步若改工具 `inputSchema`（含描述文本）须重录 llm-replay fixture（铁律 6）；本排期各项均不触达。
