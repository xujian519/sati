# 决策溯源 + 实施例覆盖 —— 实施任务清单

> 对应方案：`docs/patent-provenance-claim-coverage-plan.md`（v2.1）
> 顺序依据：方案 §五 落地顺序（评审 F1 调整）
> 编制日期：2026-08-20
> 状态：**未开始**（T0 可立即开工）
> 提交规范：每任务完成后单独提交，Conventional Commits（`feat(patent): ...`），git hook 强制

---

## 任务总览与依赖

```
线 B（设计 2，独立）:  T0 纯函数 ──→ T6 mapper 原子 ──→ T7 manifest 接入+联动
                         0.5–1d        1–1.5d            1d

线 A（设计 1，关键路径）: T1 存储底座 ──┬→ T2 全局审批库 ──┐
                         1d            ├→ T3 审批门旁路 ──┼→ T5 导出+开关 ──→ T8 图决策链
                                        └→ T4 Worker落盘 ──┘   1d            3–4d
                                        1d                    (依赖 T1–T4)

T9 RDF 导出：条件触发（出现真实消费方），不排期
```

| ID | 任务 | 依赖 | 预估 | 状态 |
|---|---|---|---|---|
| T0 | 设计 2 纯函数（校验 + 骨架解析） | 无 | 0.5–1 天 | ✅ 已落地（17/17 测试绿，typecheck/eslint/biome 绿） |
| T1 | 设计 1 存储底座（schema + store + paths） | 无 | 1 天 | ✅ 已落地（9/9 测试绿，typecheck/eslint/biome 绿） |
| T2 | 全局审批审计库（output_gate 落盘） | T1 | 1–1.5 天 | ✅ 已落地（6/6 测试绿，typecheck/eslint/biome 绿） |
| T3 | 审批门旁路 + runId 生成 | T1 | 1 天 | ☐ |
| T4 | Worker 执行落盘 | T1 | 0.5–1 天 | ☐ |
| T5 | 审计导出 + enableProvenance 开关 | T1–T4 | 1 天 | ☐ |
| T6 | claim-embodiment-mapper 原子 | T0 | 1–1.5 天 | ☐ |
| T7 | manifest 接入 + draft-spec 联动 + 门禁收尾 | T6 | 1 天 | ☐ |
| T8 | 图节点决策链（wrapGraphBuilder + 结论树） | T1（存储接口冻结） | 3–4 天 | ☐ |
| T9 | RDF 导出（条件触发） | T5 | 不排期 | ☐ |

---

## T0：设计 2 纯函数（校验 + 骨架解析）— 0.5–1 天 ✅ 已落地（2026-08-20）

**目标**：先把零依赖的确定性部分落地，固化验收基线。

**改动文件**：
- 新增 `src/patent/claim-coverage/types.ts`——`ClaimEmbodimentCoverage` / `CoverageCheckResult`（方案 §4.2）
- 新增 `src/patent/claim-coverage/coverage-check.ts`——`checkClaimEmbodimentCoverage(matrix)` 纯函数：每特征至少一个 `embodimentRefs`（→ missingEmbodiment）、claimId 编号连续性（→ badClaimIds）、跨权项重复特征（→ duplicateFeatures）
- 新增 `src/patent/claim-coverage/skeleton.ts`——交底书实施例骨架正则（「实施例 N」「实施方式 N」；**不含** 具体实施方式章节/[00xx]，方案 P5）
- 新增 `src/patent/claim-coverage/index.ts` barrel + `src/patent/index.ts` 导出
- 新增 `tests/patent/claim-coverage-check.spec.ts`

**关键实现点**：
- 校验纯函数零依赖、确定性（对齐 `spec/checks.ts` 风格）；claimId 命名规则与 claim-chart 的 `1a/1b` 不兼容，**按新写计**（评审 P5-设计2#10）
- skeleton 正则返回 `{实施例编号集合}` 供后续交叉校验

**验收（DoD）**：
- [ ] `pnpm typecheck && pnpm test` 全绿，新增 spec 覆盖三字段全表（full/partial/none、编号断裂、重复特征、空输入）
- [ ] 无任何既有文件改动（纯新增）
- [ ] commit: `feat(patent): claim-coverage 纯函数校验与实施例骨架解析`

---

## T1：设计 1 存储底座 — 1 天 ✅ 已落地（2026-08-20）

**目标**：provenance 双库 schema 与存储实现，冻结存储接口（Phase 2 依赖）。

**改动文件**：
- `src/knowledge/shared/schema-versions.ts`——新增 `PROVENANCE_DB` spec（**`kind: "source"`**，方案 P3）
- `src/patent/paths.ts`——新增 `caseProvenanceDir(caseId, cwd)`（三态解析：绝对/含分隔符/cwd 相对，对齐 `patentWorkflowTool.ts:69-77`）与全局库路径（`~/.sati/provenance/approval-audit.db`，`SATI_PROVENANCE_DIR` 可覆盖）
- 新增 `src/patent/provenance/types.ts`——`ProvenanceSource` / `ProvenanceActivity` / `ProvenanceEntity` / `ProvenanceAgent`（case_id NULLABLE；**无 edge 表**，关系走 JSON 数组列，评审 A1）
- 新增 `src/patent/provenance/provenance-store.ts`——`DatabaseSync` 建表；`upsertActivity/upsertEntity`（幂等键 `activity.id`）；`close()`（Windows EBUSY，方案 B4）；打开前 `mkdirSync`
- 新增 `tests/patent/provenance-store.spec.ts`

**关键实现点**：
- 幂等键格式 `${runId}:${source}:${step}:${nodeName}`（方案 P2，无 seq）
- `openKnowledgeDb` 复用（魔数 + kind:source fail-loud）；`derived_from`/`input_ids` 存 JSON 文本数组（对齐 `kg_nodes.law_refs`）
- 全局库与 per-case 库同 schema、不同路径

**验收（DoD）**：
- [ ] `provenance-store.spec.ts` 全绿：建库/魔数校验/幂等 upsert（同 id 二次写不重复）/kind:source 版本不符抛 `KnowledgeDbVersionError`/close() 后可删库
- [ ] `pnpm typecheck` 通过；无任何接线改动（纯底座）
- [ ] commit: `feat(patent): provenance 存储底座（PROVENANCE_DB kind:source）`

---

## T2：全局审批审计库（output_gate 落盘）— 1–1.5 天 ✅ 已落地（2026-08-20）

**目标**：审批留痕落盘（G2 缺口，最高价值项）——重启不丢、可导出。

**改动文件**：
- `src/patent/approval.ts`——`ApprovalRecord` 增**可选** `caseId?/runId?/ruleViolations?`（契约扩展，向后兼容）
- 新增 `src/patent/provenance/approval-store.ts`——`SqliteApprovalStore implements ApprovalStore`（**全接口**：`saveRecord` + `listRecords`）；写全局库；`saveRecord` 内部 try/catch **绝不向外抛**（`swallowRejection` 只吞 thenable，评审 P8）；caseId 缺失时 `case_id` 置 NULL 不伪造归属（方案 P1）
- `src/cli/createLocalGateway.ts:1909`——构造 `PatentOutputGate` 时注入 `approvalStore`（当前未传，需加一行）
- `enableProvenance` 双通道接线：`deps.enableProvenance ?? process.env.SATI_PROVENANCE === "1"`（方案 P6），prepared 构造处
- 新增 `tests/patent/provenance-approval-store.spec.ts`

**关键实现点**：
- 注意 `output_gate` 审批在 AgentLoop 消息层（不在工具内），caseId 恒未知属预期——本任务只保证**记录不丢**，per-case 归档留待 session→case 映射出现
- 与 `inventiveness-feedback.jsonl` 的关系：宿主接线时同一 `ApprovalRecord` 派生两条，避免时点不一致（方案 B6）

**验收（DoD）**：
- [ ] 场景 C 验收：一次 agent 输出审批（approve/reject）后，全局库含 `output_gate` 记录（verdict/feedback/triggerKeyword）；**重启进程后记录仍在**
- [ ] `saveRecord` 同步抛错（模拟磁盘满）不外泄至 approve/reject（审批流程不中断）
- [ ] `enableProvenance` 默认关时零写入、零构造开销
- [ ] commit: `feat(patent): 审批审计全局库落盘（output_gate）`

---

## T3：审批门旁路 + runId 生成 — 1 天

**目标**：manifest/图两条审批门路径的放行与挂起可溯源（per-case 库）。

**改动文件**：
- `src/tool/builtin/patentWorkflowRunTool.ts`：
  - **runId 生成**：`${graphId|manifestId}-${Date.now()}-${自增}`；同一运行实例（含 resume 续跑）复用，新运行新 runId（方案 P2）
  - **manifest pending**：`runWorkflow` 返回后读 `result.interrupted`（runWorkflow 无决策回调，评审 P7）→ 记 pending activity
  - **manifest decision**：放行集合对比（显式 `approveStageIds` + resume 合并路径 `workflow.ts:161-167` 的 approvalGrants）→ 记 decision activity（含 resume 自动放行）
  - **图审批门**：`:463` `grantApproval` 调用点旁路记 `approval_gate` activity（grantApproval 唯一调用点）
- `src/patent/workflow/executor.ts:65`——放行注入处确认旁路点（如走工具层对比则此处不改）
- 新增 tool 层接线测试 `tests/patent/provenance-tool-hooks.spec.ts`（mock provider 模式）

**关键实现点**：
- resume 重放审批节点会再产 graph_node 记录——按幂等键去重（方案 §3.3③）
- runId 一致性是幂等前提：resume 用同一实例 id，重跑用新 id（不覆盖审计历史）

**验收（DoD）**：
- [ ] 场景 A（manifest）：一次 `patent_workflow_run`（patent_drafting_v1，含审批门）后 per-case 库含 `approval_gate` + `worker` 两类 activity；**resume 续跑不产生重复 id；重跑（新 runId）不覆盖前次记录**
- [ ] 场景 B（图路径）：一次 `patent_workflow_run`（graph=inventiveness，含 HITL 审批）后 per-case 库含 `approval_gate` activity
- [ ] commit: `feat(patent): 审批门放行与挂起溯源旁路（runId 实例化）`

---

## T4：Worker 执行落盘 — 0.5–1 天

**目标**：worker 契约执行留痕（当前生产路径是死点，方案 P4）。

**改动文件**：
- `src/tool/builtin/patentWorkflowRunTool.ts`——runWorkflow 调用（`:293-308`）**装配 WorkerMonitor** 传入 `monitor`（当前未传）
- `src/patent/worker-contract.ts`——`WorkerMonitor` 增可选 `onRecord` 回调（缺省 no-op，零开销），或由 collector 旁路
- outputPath 解析：从 worker 契约 `outputs[0].path`（`worker-contract.ts:270-277`，含 `{caseId}` 占位）替换生成
- 记录形态：activity(source:"worker") + entity(kind:"output_file", value=outputPath)

**关键实现点**：
- `WorkerExecutionRecord`（`worker-contract.ts:72-79`）无 outputPath——用契约推导，不改记录结构
- 降级/验证失败的 worker 也要记录（degraded 字段入 entity）

**验收（DoD）**：
- [ ] 场景 A 中 worker activity 的 `output_file` entity 指向真实存在的输出文件（如 `outputs/technical-analysis.md`）
- [ ] 未配置 collector 时 WorkerMonitor 行为与现状完全一致（回归）
- [ ] commit: `feat(patent): worker 执行溯源落盘`

---

## T5：审计导出 + enableProvenance 开关 — 1 天

**目标**：CSV/JSON 导出（G3 缺口）+ 开关传播闭环。

**改动文件**：
- 新增 `src/patent/provenance/export.ts`——`exportProvenance(caseId: string | null, "json" | "csv")`：
  - csv：时间线视图 `时间, 来源, 活动, 执行者, 输入(used), 产出, 审批结论`（**注意值转义**：结论文本含逗号/换行）
  - json：完整图导出（机器消费/回归快照）
- `enableProvenance` 开关贯通：T2 接线点 + collector 构造处共用同一来源
- 新增 `tests/patent/provenance-export.spec.ts`（双库 CSV/JSON）与 `tests/patent/provenance-disable.spec.ts`

**关键实现点**：
- CSV 导出基于 activity/entity/agent 三表 JOIN 时间线，per-case 与全局库同一实现（参数化 caseId）
- disable 回归：`enableProvenance=false` → 断言 `data/cases/<caseId>/provenance.db` 与全局库文件均不存在

**验收（DoD）**：
- [ ] `exportProvenance(caseId, "csv")` 断言列头与行内容（含中文结论文本转义正确）；`exportProvenance(null, "csv")` 导出全局库
- [ ] `provenance-disable.spec.ts`：开关关 → 双库文件不存在、零写入
- [ ] commit: `feat(patent): provenance 审计导出（csv/json）与开关`

---

## T6：claim-embodiment-mapper 原子 — 1–1.5 天

**目标**：设计 2 的核心原子（依赖 T0 纯函数）。

**改动文件**：
- 新增 `src/patent/atoms/handlers/builtin/mapper.ts`：
  - **输入**：`source_text`（交底书）+ **`claims_draft`**（draft-claims 产出，`draft.ts:79`，特征锚点）+ 可选 `pfe_triples`（方案 P5-设计2#2）
  - LLM 结构化输出（`jsonSchema` 强制 `required: [claims]`），复用 `callLlm`/`parseLlmJson`/`degraded`（`builtin/llm.ts`）
  - **parse 失败分支**：非 JSON/缺字段 → 保留原文不降级（extract 骨架行为）；LLM 调用异常 → 降级（方案 §4.3①）
  - 骨架交叉校验：LLM 输出的 `embodimentRefs` 与 T0 skeleton 集合校验（引用不存在 → gap）
  - **落盘**：`outputs/claim-embodiment-coverage.json`（`JsonFileStore(dir=caseOutputsDir(caseId), id="claim-embodiment-coverage")`）；**无 caseId 跳过**（`provider.caseId` 守卫，claim-chart 先例 `chart.ts:343-346`）
- `src/patent/atoms/handlers/builtin/index.ts` barrel + `src/patent/atoms/index.ts` `registerBuiltinAtoms` 注册（**不注册则 runWorkflow fail-fast**，`workflow.ts:150-155`）
- 新增 `tests/patent/claim-coverage-mapper.spec.ts`

**关键实现点**：
- 降级语义：`{_error}` 后 executor 重试（`executor.ts:58-100`），manifest `maxRetries:2` → 最多 3 次调用后才降级；降级后 `requireAll=true` 使 `completed=false`（方案 §4.3①）
- 输入契约与 `draftClaimsAtom`（`draft.ts:24-26`）同风格

**验收（DoD）**：
- [ ] `claim-coverage-mapper.spec.ts` 全绿：正常抽取/骨架交叉校验/parse 失败保留原文/LLM 异常降级/无 caseId 跳过落盘
- [ ] `registerBuiltinAtoms` 后 `drafting-sop.spec.ts` 的注册断言不红（如有）
- [ ] commit: `feat(patent): claim-embodiment-mapper 原子`

---

## T7：manifest 接入 + draft-spec 联动 + 门禁收尾 — 1 天

**目标**：设计 2 全链路生效，既有门禁与测试不破。

**改动文件**：
- `src/patent/workflow/manifests.ts`——`patentDraftingManifest` 在 `draft_claims`（`:420`）与 `draft_spec`（`:426`）之间插 `claim_coverage` 阶段（`atom: "claim-embodiment-mapper"`）；`stage.params` 合并进 execState（`executor.ts:66-68`），不需要改 executor
- `src/patent/atoms/handlers/builtin/draft.ts`——`DraftSpecHandler.execute`：读 `state.claim_coverage_result`（**判空守卫**，缺失/降级时跳过），`uncoveredFeatures` 追加进 `spec_validation.violations`（warning 级，不翻转 passed；`validateDraftSpec` 纯函数不动，评审 P5-设计2#7）
- **既有测试更新**：
  - `tests/patent/drafting-sop-fullrun.spec.ts`——mock provider 增 mapper 分支（否则 fallback `"推理结论"` 使新阶段降级 → `degradedSteps` 断言必红）
  - `tests/patent/drafting-sop.spec.ts`——若断言 22 阶段数需同步
- **收尾门禁**：`pnpm gen:patent-workflow-docs` 重新生成 `assets/workflows/patent/generated/patent_drafting_v1.yaml`（`check:patent-workflow-docs` 挂 lint，评审 D4）
- **llm-replay**：`tests/test-support/llm-replay-drafting.spec.ts` 的 fixture 录制须在**新阶段就位、draft-spec prompt 定稿后**执行（请求键含内容哈希，改动即失配）

**关键实现点**：
- 预检语义（方案 P5）：本阶段校验交底书实施例，不是最终说明书；draft_spec 后复核是 §4.6 可选扩展，不做
- `inputSchema` 无执行语义（`atom.ts:23-27` 纯声明）——真实改动只在 handler，勿在 inputSchema 上期待行为

**验收（DoD）**：
- [ ] 场景 设计 2 全链路：`patent_drafting_v1` 跑通含 `claim_coverage` 阶段，`outputs/claim-embodiment-coverage.json` 落盘（有 caseId 时）
- [ ] 缺实施例特征出现在 draft-spec 校验提示（warning）
- [ ] `pnpm lint`（含 `check:patent-workflow-docs`）与 `pnpm test` 全绿（含更新后的既有测试）
- [ ] commit: `feat(patent): drafting 链路实施例覆盖校验接入`

---

## T8：图节点决策链（wrapGraphBuilder + 结论树）— 3–4 天

**目标**：G1 缺口——图路径结论的可回溯决策链（依赖 T1 存储接口冻结）。

**改动文件**：
- 新增 `src/patent/provenance/collector.ts`：
  - `wrapGraphBuilder(builder, collector)`——在 **addNode 统一入口**包装全部节点（含约 10 个裸节点：inventiveness.ts:270/298/335/336、novelty.ts:154、enablement.ts:303/313/397 等，评审 P9），不经工厂逐个包
  - 产出自动记录（delta keys → state_snapshot entity）；`derivedFrom` 来自输入声明表，缺失只记产出不伪造因果
  - **输入声明表**：三子图按节点名声明输入 state key；`rule_gate`/`approval` 节点不记 inputIds（`collectStateText` 读全量，评审 P13）；声明表给 key→entityId 模板（含 step/版本，处理 LWW 重写键如 inventiveness_query）
  - **降级记录**：在 `runGraphWithCheckpoints` **结果侧**扫描 `__degradation` 后缀键（`degradationSummary` 现成，`degradation.ts:51-66`）——覆盖引擎级直接写 state 的路径（`engine.ts:214-217`）
- 接线：`patentWorkflowRunTool.ts` graph 分支（`:477-483`）用 `wrapGraphBuilder` 包装 + 结果侧降级扫描
- 测试：`tests/patent/provenance-graph-collector.spec.ts`（mock provider 模式，参照 `tests/patent/graph/` 既有 9 个测试）

**关键实现点**：
- 当前超步号：collector 用 `onSuperStepStart` 维护 currentStep 供记录（`GraphNodeContext` 无 stepIndex，评审 P9）
- 结论树验收：`inventiveness_conclusion` → derivedFrom [closest, diff, hint] 三节点产出

**验收（DoD）**：
- [ ] Phase 2 验收：inventiveness 图运行后，`inventiveness_conclusion` entity 沿 `derivedFrom` 回溯到 closest/diff/hint（D1 + 区别特征 + 技术启示）
- [ ] resume 重放最后超步不产生重复 activity（幂等）；引擎级降级节点被记录（source:"degradation"）
- [ ] `enableProvenance=false` 时图路径零写入（回归）
- [ ] commit: `feat(patent): 图节点决策链溯源（wrapGraphBuilder）`

---

## T9：RDF 导出 — 不排期（条件触发）

**触发条件**：出现真实消费方（客户合规工具对接需求）。
**验收基线**（保留一行，防重复立项）：合法 PROV-O Turtle，可被 W3C 校验器接受。

---

## 总体验收（全部任务完成后）

- [ ] 方案 §七 全部验收项通过（场景 A/B/C + 设计 2 全链路 + 幂等 + disable 回归 + 既有记录零改动）
- [ ] `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` 全绿
- [ ] `docs/patent-provenance-claim-coverage-plan.md` 实施状态更新为已落地（对照 problem-atomization-minimal-plan.md 先例）

## 踩坑提醒

| 任务 | 高频坑 | 预防 |
|---|---|---|
| T2 | `ApprovalStore` 接口还要求 `listRecords()`；同步抛错穿透 approve/reject | 全接口实现 + saveRecord 内部 try/catch |
| T3 | runId 生成位置与 resume 复用逻辑分离 → 幂等失效 | runId 在工具层单点生成，resume 参数透传 |
| T5 | CSV 值含逗号/换行（中文结论文本） | 引号包裹 + 转义测试 |
| T7 | 快照门禁 diff、mock provider fallback 命中新阶段 | 先更新测试再跑 `pnpm gen:patent-workflow-docs` |
| T8 | 裸 addNode 漏包、LWW 重写键无版本 | wrapGraphBuilder 在统一入口、声明表模板化 |
