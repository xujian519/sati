# Sati 知识库增强设计（修订版 v2.1）：决策溯源层 + 权利要求-实施例覆盖校验

> 方案版本：v2.1（v2.0 经 2026-08-20 三轮对抗性评审后修订）
> 编制日期：2026-08-20
> 实施状态：**未开始**（评审已完成，阻断项已消解，可进入实施排期）
> 适用范围：Sati 专利域（`src/patent/`）——三性分析结论的可审计性 + 申请撰写链路的实施例覆盖校验
> 决策依据：
> - v1.0 草案（桌面《Sati知识库增强设计-决策溯源与动态建图.md》）经真实代码核验，产出 v2.0（9 项修订 R1-R9）；
> - v2.0 经三个独立评审代理对抗性评审（设计 1 可行性 / 设计 2 可行性 / 整体范围约束），评审意见已逐条复核真实代码后裁定（见 §0.2 评审记录），产出 v2.1。

---

## 0. 修订摘要

### 0.1 v1.0 → v2.0 变更（保留）

| # | v1.0 原案 | 修订 | 依据（真实代码） |
|---|---|---|---|
| R1 | 设计 1 接入点 "hook `approval.ts` 的 `grantApproval` 单点" | **审批有三套独立机制，全部接入**：① 图路径 approval 节点（`grantApproval` 实际在 `graph/checkpoint.ts`，写 `APPROVAL_GRANTED_KEY` 放行标记）；② 输出门禁 `PatentOutputGate`（`output-gate.ts` approve/reject）；③ manifest 路径 `approval-gate` 原子（`atoms/handlers/builtin/gate.ts` InterruptStageError） | `graph/checkpoint.ts:104-112`；`output-gate.ts:196-241`；`gate.ts:37-60` |
| R2 | 设计 1 隐含"Checkpoint/Worker/审批即全部决策点" | **补两个被遗漏的留痕机制**：`FactBlackboard` 与 `EvidenceExtension`——v2.1 不整合它们，复用其记录作 entity 来源，显式声明职责边界 | `reasoning/fact-blackboard.ts:80-91`；`evidence/index.ts:64-78` |
| R3 | 设计 1 验收含 "RDF 可被 W3C 校验器接受" | **RDF 降级为三期条件触发**；验收保留一行触发基线（合法 PROV-O Turtle）防未来重提立项 | 无 RDF 消费方；CSV 满足审计需求 |
| R4 | 设计 1 未提 `derivedFrom` 从哪来 | **"人工声明表 + 产出自动记录"两段式**；声明缺失只记产出不伪造因果；不引入 Proxy | `domains/shared.ts` `llmNode` 仅声明 `outputKey`；`engine.ts` 快照语义 |
| R5 | 设计 1 隐含"provenance 可从 workflow-runs 重灌" | graph 路径运行结果不落盘，**必须运行期收集**；manifest 路径 worker 记录可事后重灌，**审批记录仅运行期收集**（approveStageIds 是下次工具输入，不在 run JSON） | `patentWorkflowRunTool.ts:477-483`；`workflow.ts:161-167` |
| R6 | 设计 2 "复用 KgStore 建表/SQL/FTS 代码省一套存储层" | **不成立**（KgStore 只读，无 upsert），砍掉 case-graph.db 建库，改为矩阵 JSON 落盘 | `kg-store.ts:54`（readOnly） |
| R7 | 设计 2 "实体层+概念层双层图 + 多跳检索 + RRF 融合" | **降级为"权利要求-实施例覆盖矩阵"**（单文档小语料，一次 LLM 结构化输出即可），成本约 1/3 | `spec/checks.ts` 无特征↔实施例校验 |
| R8 | 设计 2 接入 `analyze_patent_figure` 附图对齐 | **撤销**：附图标记索引已存在 | `src/patent/figure/` |
| R9 | 设计 2 与 claim-chart 关系未明 | **明确边界**：claim-chart 管外部证据映射，覆盖矩阵管文档内部映射；模式借鉴、数据不共用（实现按重写计） | `claim-chart/runtime/mapping-machine.ts` |

### 0.2 v2.0 → v2.1 变更（评审裁定）

| # | 评审意见（阻断级） | 裁定 | v2.1 修订 |
|---|---|---|---|
| P1 | **output_gate 审批无 caseId 归属**：`ApprovalRecord` 只有 sessionId/turnId（`approval.ts:16-31`）；`PatentOutputGate` 在 `createLocalGateway.ts:1909-1960` per-session 构造且未传 approvalStore；审批发生在 AgentLoop 消息层（`output-gate.ts:20-21`），不在 patent_workflow_run 工具内；全仓无 session→caseId 映射 | **接受**（已核验 createLocalGateway 无 approvalStore 注入） | 拆为**双库**：全局审批审计库（output_gate/flexible_plan 决策，caseId 可为空）+ per-case provenance.db（graph_node/worker/approval_gate/degradation）。Phase 1 只做后者 + 全局库落盘；验收拆场景 |
| P2 | **幂等键 `${runId}:${source}:${step}:${seq}` 三处失稳**：graph 路径无 runId（`runGraphWithCheckpoints` 只传 store/graphId/provider/resumeFrom，checkpoint id 为 `${graphId}-${step}`）；并行超步（engine.ts Promise.all）下 seq 完成序不确定 → resume 重放产生不同 id；确定性 runId 跨合法重跑冲突 | **接受**（已核验 graph 分支无 runId） | id 改 **`${runId}:${source}:${step}:${nodeName}`**（去掉 seq）；runId 由工具层生成（`${graphId}-${Date.now()}-${自增}`），resume 复用同一实例 runId，新运行用新 runId（审计历史不覆盖） |
| P3 | **provenance.db 标 `kind:"derived"` 语义错误**：`evaluateVersion` 对 derived 库版本过旧返回 `needsRebuild`（`db-version.ts:151-153`），审计是运行期采集的唯一副本、不可重灌，版本升级会静默销毁 | **接受**（已核验 evaluateVersion） | **标 `kind:"source"`**（版本不符 fail-loud 拒开，绝不 needsRebuild），application_id 魔数保留 |
| P4 | **Worker 落盘是生产死点**：`WorkerMonitor.record` 仅在 `options.monitor` 注入时被调（`workflow.ts:229-243`），而 `patent_workflow_run` 的 runWorkflow 调用未传 monitor（`patentWorkflowRunTool.ts:293-308`）；`WorkerExecutionRecord` 无 outputPath 字段 | **接受**（已核验两处） | Phase 1 补两处改动：`patent_workflow_run` 装配 WorkerMonitor 传入 runWorkflow；outputPath 从 worker 契约 `outputs[0].path`（含 {caseId} 占位，`worker-contract.ts:270-277`）解析 |
| P5 | **实施例骨架时序矛盾（设计 2）**：claim_coverage 插在 draft_spec 前，此时"具体实施方式"章节/[00xx] 段号不存在（那是 draft-spec 产出与 CNIPA 公开格式）；`source_text` 恒为交底书 | **接受**（逻辑自洽） | **明确预检语义**：骨架解析对象改为交底书段落（删除「具体实施方式」/「[00xx]」表述）；在 §4.6 补充"draft_spec 后复核"可选扩展 |
| P6 | **enableProvenance 开关传播路径未定义**，存储/风险/验收三处依赖它 | **接受** | 定为 `deps.enableProvenance ?? process.env.SATI_PROVENANCE === "1"` 双通道；接线点在 createLocalGateway prepared 构造处 |

评审同时确认的**主要级**意见（v2.1 已吸收，见对应章节）：wrapNode 需覆盖约 10 个裸 addNode 节点（inventiveness.ts:270/298/335/336 等，§3.3⑤）；引擎级降级不经 markDegraded（engine.ts 直接写 `__degradation`，§3.3⑦）；mapper 输入遗漏 `claims_draft`（§4.3①）；atom 未注册 fail-fast + `check:patent-workflow-docs` 快照门禁 + drafting-sop-fullrun 测试必红（§附）；edge 表与 JSON 数组列双写冗余（删 edge 表，§3.2）；审批 derivedFrom 不天然已知（ApprovalRecord 扩展可选字段，§3.3①）；flexible_plan 为第四套人工决策（§3.3⑧）；case 路径三态解析与 Windows EBUSY（§3.2）。

---

## 一、目标与范围

### 1.1 目标

1. **决策溯源（设计 1）**：为专利分析结论提供可查询、可导出、可回溯的决策记录——先把**审批留痕落盘**（最高价值真实缺口）与**图节点决策链**做出来，再按需导出。
2. **实施例覆盖校验（设计 2）**：让撰写链路**预检**"权利要求特征是否有实施例支撑"，缺口反馈给撰写阶段——不建图、不做多跳检索。

### 1.2 做什么 / 不做什么

**设计 1（决策溯源）**

| 做 | 不做 |
|---|---|
| Phase 1：全局审批审计库（output_gate + flexible_plan）+ per-case 审批门/Worker 落盘 + CSV/JSON 导出 | RDF Turtle 导出（Phase 3 条件触发） |
| Phase 2：图节点收集（`wrapGraphBuilder` 全覆盖）+ 降级记录 + 结论树 derivedFrom | Proxy 包装 GraphState（不侵入 `engine.ts` 快照语义） |
| per-case `provenance.db`（SQLite，`kind:"source"` + 魔数） | 整合 `FactBlackboard` / `EvidenceExtension` 内部结构 |
| `enableProvenance` 开关（默认关，env/配置双通道） | 改动 `workflow-runs` / `outputs` 既有 JSON 记录 |

**设计 2（实施例覆盖）**

| 做 | 不做 |
|---|---|
| 新原子 `claim-embodiment-mapper`（输入含 `claims_draft`，LLM 一次结构化输出矩阵） | case-graph.db 建库（不新建写路径 SQLite） |
| 确定性纯函数 `checkClaimEmbodimentCoverage`（特征→实施例 + 编号连续性 + 跨权项重复提示） | 实体/概念双层抽取、多跳检索、RRF 融合新增路 |
| 交底书实施例骨架正则解析（「实施例 N」等，不靠 LLM；**不含** 具体实施方式/[00xx]） | 增量重抽（textHash）——一次性行为 |
| patent_drafting_v1 manifest 插入 `claim_coverage` 阶段（draft_spec 前，预检语义），缺口注入 draft-spec | 附图标记对齐（已有 `figure/index-store.ts`） |
| 矩阵 JSON 落盘（复用 `JsonFileStore`，无 caseId 时跳过） | 与 claim-chart 合并 |

---

## 二、现状盘点（代码核验后）

### 2.1 既有资产（v2.1 复用的底座）

| 资产 | 位置 | 复用方式 |
|---|---|---|
| `db-version` 魔数 + source/derived | `src/knowledge/shared/db-version.ts` | `PROVENANCE_DB` spec（**kind: "source"**，P3） |
| `JsonFileStore` 原子写 | `src/patent/persist-utils.ts` | 覆盖矩阵 JSON 落盘；provenance 导出文件 |
| 节点工厂 | `src/patent/graph/domains/shared.ts` | 包装点（Phase 2，经 `wrapGraphBuilder` 全覆盖，含裸节点） |
| `DEGRADATION_SUFFIX` | `src/patent/graph/degradation.ts:12` | 降级识别（Phase 2 改结果侧扫描） |
| `WorkerMonitor.record` | `src/patent/worker-contract.ts:201` | Phase 1 需先装配 monitor（P4） |
| `ApprovalStore` 注入点 | `output-gate.ts:64` | 全局库落盘走现成注入点 |
| 要素校验/gap 检测模式 | `src/patent/claim-chart/runtime/` | 覆盖矩阵的校验/缺口按此模式**新写**（编号规则不兼容，按重写计） |
| `claims_draft` 产出 | `atoms/handlers/builtin/draft.ts:79` | 矩阵特征抽取锚点（P5 配套） |

### 2.2 真实缺口（v2.1 要补的）

| 缺口 | 证据 | 归属 |
|---|---|---|
| G1：图路径结论无结构化决策链 | 超步 checkpoint 只存 `{state, activeNodes, stepIndex}`（`graph/checkpoint.ts:3-5`） | 设计 1 Phase 2 |
| G2：审批留痕不落盘 | `InMemoryApprovalStore` 仅内存（`approval.ts:42-59`）；挂起队列重启重建为空（`output-gate.ts:22-25`） | 设计 1 **Phase 1** |
| G3：无审计导出 | 产出为 `outputs/*.md` + HTML/PDF；graph 运行结果仅工具返回文本（`patentWorkflowRunTool.ts:477-483`） | 设计 1 Phase 1/2 |
| G4：draft-spec 无"特征↔实施例"校验 | `spec/checks.ts` 仅章节/定量/数值范围三类 | 设计 2 |

### 2.3 已撤销的"缺口"（v1.0 误判）

- 附图组件对齐：已有 `figure/index-store.ts`（R8）。
- 跨文档多跳检索：无此业务需求（R7）。
- 与静态 KG 命名冲突：case-graph 撤销后消失（R6）。

---

## 三、设计 1（修订）：决策溯源层

### 3.1 数据模型

```ts
// src/patent/provenance/types.ts
export type ProvenanceSource =
  | "graph_node"        // 图节点执行（Phase 2）
  | "worker"            // worker 契约执行（Phase 1）
  | "output_gate"       // PatentOutputGate 审批（Phase 1，全局库）
  | "approval_gate"     // manifest/graph 审批门放行（Phase 1）
  | "flexible_plan"     // flexible-plan 阶段确认/回退（Phase 1，全局库）
  | "degradation";      // 降级标记（Phase 2）

export type ProvenanceActivity = {
  id: string;            // 幂等键：`${runId}:${source}:${step}:${nodeName}`（P2，无 seq）
  source: ProvenanceSource;
  name: string;          // 节点名 / worker 名 / 审批动作
  caseId: string | null; // output_gate/flexible_plan 可为空（无 session→case 映射）
  runId: string;
  stepIndex?: number;
  startedAt: number;
  durationMs?: number;
  agentId: string;
  inputIds: string[];    // used 边（Phase 2 来自声明表；审批/worker 天然已知）
};

export type ProvenanceEntity = {
  id: string;
  kind: "conclusion" | "evidence" | "state_snapshot" | "output_file" | "approval";
  value: string;
  caseId: string | null;
  generatedByActivityId?: string;
  derivedFromIds: string[];   // wasDerivedFrom（决策链骨架）
  degraded?: boolean;
};

export type ProvenanceAgent = {
  id: string;
  kind: "llm" | "human" | "rule_gate" | "retrieval" | "system";
  name: string;
  model?: string;
};
```

**要点**：
- 去 `wasInformedBy` 边；`used` + `wasDerivedFrom` + `wasGeneratedBy` 足够还原决策链。
- **runId 来源（P2）**：工具层生成，`${graphId|manifestId}-${Date.now()}-${自增}`；同一运行实例（含 resume 续跑）复用同一 runId，新运行新 runId——保证"resume 不重复、重跑不覆盖审计历史"。
- `derivedFromIds` 两段式：产出自动记录（delta keys → state_snapshot entity）+ 输入人工声明表；声明缺失只记产出不伪造因果（fail-open 诚实降级）。
- 审批 entity 的 derivedFrom 需要 `ApprovalRecord` 扩展（见 §3.3①），不天然已知（评审 P8）。

### 3.2 存储：双库

```
# 库 A（全局，Phase 1）：审批审计库 —— ~/.sati/provenance/approval-audit.db
  activity (id, source, name, case_id NULLABLE, run_id, step_index, started_at, duration_ms, agent_id, input_ids)
  entity   (id, kind, value, case_id NULLABLE, generated_by, derived_from, degraded)
  agent    (id, kind, name, model)
  # 不建 edge 表：关系以 activity.input_ids / entity.derived_from 的 JSON 数组表达（评审 A1）

# 库 B（per-case，Phase 1+2）：data/cases/<caseId>/provenance.db —— 同 schema
```

- `node:sqlite` `DatabaseSync`，与 `kg-store.ts` 一致。
- `PROVENANCE_DB` spec：**`kind: "source"`**（P3：版本不符 fail-loud 拒开，绝不 needsRebuild），application_id 魔数防误开；`schema-versions.ts` 集中声明。
- **case 路径解析（P11/E2）**：新增 `paths.ts` 的 `caseProvenanceDir(caseId, cwd)`，复用工具层三态解析（绝对 caseId / 含分隔符 / cwd 相对，`patentWorkflowTool.ts:69-77` 同款）；collector 构造时传入 cwd；打开前 `mkdirSync`（`openKnowledgeDb` 不建父目录）。
- **句柄生命周期（B4）**：`ProvenanceStore.close()`，运行结束/导出后关闭（Windows EBUSY 教训，`kg-store.ts:74-78`）。
- graph 路径运行结果不落盘（R5）→ provenance 必须**运行期接线收集**；manifest 路径 worker 可事后从 `JsonFileWorkflowRunStore` 重灌，审批记录仅运行期收集。

### 3.3 接入点

#### Phase 1：审批留痕落盘 + Worker 落盘

**① output_gate 审批（全局库）** —— `SqliteApprovalStore implements ApprovalStore` 走 `output-gate.ts:64` 注入点，写入库 A：
- 接线：`createLocalGateway.ts:1909` 构造 `PatentOutputGate` 时传 `approvalStore`（当前未传，需加一行）。
- **caseId 未知（P1）**：`ApprovalRecord` 扩展可选字段 `caseId?/runId?/ruleViolations?`（改 `approval.ts:16-31` 契约）；caseId 缺失时 `case_id` 置 NULL，不伪造归属。
- **fail-open 强化（P8）**：`SqliteApprovalStore.saveRecord` 内部 try/catch，同步抛错不得穿透 approve/reject（`swallowRejection` 只吞 thenable，`output-gate.ts:333-336`）；实现 `listRecords()`。
- 验收单列（§七），与 per-case 库分开。

**② manifest 审批门（per-case 库）** —— 两条记录点：
- **pending**：工具层 `patentWorkflowRunTool.ts:310` 后 `result.interrupted` 可用（`runWorkflow` 无决策回调，评审 P7）——中断时记 pending activity。
- **decision**：放行注入在 `workflow/executor.ts:65`（approvalGrants → `APPROVAL_GRANTED_KEY`）；`patentWorkflowRunTool.ts:305` 显式 approveStageIds 与 **resume 合并路径**（`workflow.ts:161-167` restoreFromCheckpoint 的 approvalGrants）都要覆盖——建议在 `runWorkflow` 返回后由工具层统一对比"本次放行集合"记 decision（含 resume 自动放行）。

**③ 图审批门放行（per-case 库）** —— `patentWorkflowRunTool.ts:463` 的 `grantApproval(store, checkpointId)` 调用点旁路记一条 `approval_gate` activity（grantApproval 全仓库唯一调用点）；批准后 resume 重放审批节点会再产 graph_node 记录，按幂等键去重。

**④ Worker 执行记录（per-case 库，P4）** —— 两处接线：
- `patent_workflow_run` 的 runWorkflow 调用（`patentWorkflowRunTool.ts:293-308`）**装配 WorkerMonitor** 传入 `monitor`；
- outputPath 从 worker 契约 `outputs[0].path`（`worker-contract.ts:270-277`，含 {caseId} 占位）解析；记录形态：activity(source:"worker") + entity(kind:"output_file")。

**⑧ flexible_plan 阶段确认（全局库）** —— `patentFlexiblePlanTool.ts:363-370` 的 autoConfirm/confirm 路径旁路记 `flexible_plan` decision（第四套人工决策点，评审 P10）。

#### Phase 2：图节点决策链

**⑤ `wrapNode` / `wrapGraphBuilder`（全覆盖）** —— 三子图约 10 个节点**不经 shared.ts 工厂**直接 `addNode(name, 裸函数)`（inventiveness.ts:270/298/335/336、novelty.ts:154、enablement.ts:303/313/397 等，评审 P9）。改为提供 `wrapGraphBuilder(builder, collector)` 在 **addNode 统一入口**包装所有节点（含裸节点），不在工厂调用处逐个包。

**⑥ 输入声明表**：按节点名声明输入 state key；`rule_gate`/`approval` 节点约定**不记 inputIds**（`collectStateText` 读全量 state，声明无意义，评审 P13）；声明表给"key→entityId 模板"（含 step/版本，处理 LWW 重写键，评审 P9）。

**⑦ 降级记录** —— 两条降级写入路径（评审 P9）：markDegraded 进 delta（`degradation.ts:18-28`）与引擎级直接写 state（`engine.ts:214-217` `state[`${name}__degradation`]`）。统一在 **`runGraphWithCheckpoints` 结果侧**扫描 state 的 `__degradation` 后缀键（`degradationSummary` 现成，`degradation.ts:51-66`）记录，不依赖 wrapNode 内检测。

### 3.4 审计导出

```ts
// src/patent/provenance/export.ts
export async function exportProvenance(
  caseId: string | null,        // null = 全局库
  format: "json" | "csv",
): Promise<Buffer>;
```

- **csv（Phase 1）**：时间线——`时间, 来源, 活动, 执行者, 输入(used), 产出, 审批结论`。
- **json（Phase 1）**：完整图，机器消费 / 回归快照。
- **rdf（Phase 3，条件触发）**：PROV-O Turtle；启动条件=出现真实消费方；验收基线=合法 Turtle 可被 W3C 校验器接受（一行保留，R3）。

### 3.5 三阶段落地（工作量已重估，评审 D1）

| 阶段 | 内容 | 依赖 | 预估 |
|---|---|---|---|
| Phase 1 | 双库建库 + output_gate 全局落盘（含 createLocalGateway 接线）+ manifest/图审批门旁路 + Worker 落盘（含 monitor 装配）+ CSV/JSON 导出 + `enableProvenance` 双通道 | 无 | **4–6 天** |
| Phase 2 | `wrapGraphBuilder` + 输入声明表（三子图）+ 结果侧降级记录 + 结论树 derivedFrom | Phase 1（存储接口冻结） | 3–4 天 |
| Phase 3 | RDF 导出（条件触发） | Phase 1/2 | 1–2 天 |

---

## 四、设计 2（修订）：权利要求-实施例覆盖矩阵

### 4.1 目标与边界

- **预检语义**（P5）：校验对象是**交底书中的实施例**（撰写前预检），不是最终说明书——"每个拟入权特征都有实施例支撑"在撰写前发现缺口，反馈给撰写阶段。若后续要"校验最终说明书覆盖"，见 §4.6 可选扩展。
- 不建图、不做检索（R7）；与 claim-chart 分工明确（R9）：外部证据映射 vs 文档内部映射。

### 4.2 数据模型

```ts
// src/patent/claim-coverage/types.ts
export type ClaimEmbodimentCoverage = {
  caseId: string;
  claims: Array<{
    claimId: string;              // claim_1 ...（与 claims_draft 对齐）
    features: string[];           // 从 claims_draft 抽取的技术特征（P5）
    embodimentRefs: string[];     // 实施例编号 embodiment_1 ...（骨架集合交叉校验）
    coverage: "full" | "partial" | "none";
    uncoveredFeatures: string[];  // 无实施例支撑的特征
  }>;
  degraded: boolean;              // 重试耗尽后降级（P5-设计2#5）
};

export type CoverageCheckResult = {
  missingEmbodiment: Array<{ claimId: string; feature: string }>;
  badClaimIds: string[];          // 编号断裂
  duplicateFeatures: string[];    // 跨权项重复（提示性）
};
```

### 4.3 实现

**① 新原子 `claim-embodiment-mapper`**（落位 `src/patent/atoms/handlers/builtin/mapper.ts`，评审 P5-设计2#3）：
- **输入**：`source_text`（交底书）+ **`claims_draft`**（draft-claims 产出，`draft.ts:79`，特征锚点）+ 可选 `pfe_triples`。只喂 source_text/pfe_triples 会让 LLM 自造权利要求（评审 P5-设计2#2）。
- LLM 结构化输出（`jsonSchema` 强制 `required: [claims]`），复用 `callLlm`/`parseLlmJson`/`degraded`（`builtin/llm.ts`）；**parse 失败分支语义明确**：非 JSON/缺字段 → 保留原文不降级（extract 骨架行为），与"LLM 调用异常 → 降级"分开描述（评审 P5-设计2#9）。
- **降级语义修正（P5-设计2#5）**：`{_error}` 降级后 executor 进入重试（`executor.ts:58-100`），manifest `maxRetries:2` → 最多 3 次 LLM 调用后才降级；降级后 `requireAll=true` 使 `completed=false`，工具输出标"⚠️ 降级"——文档按此描述，不写"失败即降级"。
- **实施例骨架正则**（P5）：从**交底书段落**提取「实施例 N」「实施方式 N」等，建立实施例编号集合；LLM 输出的 `embodimentRefs` 与该集合交叉校验（引用不存在 → gap）。**不含**「具体实施方式」章节/[00xx]（该时序下不存在）。

**② 确定性校验纯函数**（`src/patent/claim-coverage/coverage-check.ts`，新写不"复用"）：
- 每个 feature 至少一个 `embodimentRefs`；claimId 编号连续性（claim_1 命名与 claim-chart 的 `1a/1b` 规则不兼容，按新写计，评审 P5-设计2#10）；跨权项重复特征提示。

**③ 矩阵落盘**：`data/cases/<caseId>/outputs/claim-embodiment-coverage.json`——`JsonFileStore(dir=caseOutputsDir(caseId), id="claim-embodiment-coverage")`；**无 caseId 时跳过落盘**（`provider.caseId` 守卫，claim-chart 先例 `chart.ts:343-346`，评审 P5-设计2#8）。

### 4.4 接入

| 接入点 | 方式 |
|---|---|
| `patent_drafting_v1` manifest | `draft_claims` 与 `draft_spec` 之间插入 `claim_coverage` 阶段（`atom: "claim-embodiment-mapper"`）；`stage.params` 合并进 execState（`executor.ts:66-68`），**不需要改 executor** |
| **注册（硬依赖）** | ① `atoms/handlers/builtin/index.ts` barrel 导出 mapper；② `registerBuiltinAtoms`（`atoms/index.ts:88-116`）注册 Atom 契约 + StageHandler——**不注册则 runWorkflow fail-fast**（`workflow.ts:150-155`） |
| draft-spec 原子 | **真实改动在 `DraftSpecHandler.execute`**（inputSchema 无执行语义，`atom.ts:23-27` 纯声明，评审 P5-设计2#6）：读取 `state.claim_coverage_result`（缺失/降级时跳过，判空守卫），把 `uncoveredFeatures` 追加进 `spec_validation.violations`（warning 级，`draft.ts:169` 只判 error 不翻转 passed；`validateDraftSpec` 纯函数不动，在 execute 闭包后处理） |
| 降级 | 重试耗尽 → `degraded: true`，draft-spec 照常执行（manifest 既有降级语义，非 DegradationMark——两套机制不同源，评审 P5-设计2#11） |
| 独立调用 | 复用 `patent_workflow_run` 跑 manifest 阶段，不新增工具 |

### 4.5 验收（修订）

- [ ] 输入含 3 个实施例的交底书 + `claims_draft` → 矩阵与权利要求逐条对齐，每特征有 `embodimentRefs`，`coverage: "full"`。
- [ ] 某特征无实施例 → `uncoveredFeatures` 列出，gap 出现在 draft-spec 校验提示（warning）。
- [ ] LLM 重试耗尽 → `degraded: true`，管线不中断（`completed=false` 仅影响完成状态字样）。
- [ ] `badClaimIds` / `duplicateFeatures` 纯函数单测覆盖（评审 C4）。
- [ ] 静态专利 KG、claim-chart、`figure/index-store.ts` 零改动。

### 4.6 可选扩展（不在本期）

- **draft_spec 后覆盖复核**：基于 `spec_draft`（说明书草稿）再做一次矩阵校验，此时才有"具体实施方式"章节——本期不做，仅记录语义区分（预检 vs 复核）。

---

## 五、落地顺序与依赖（评审 F1 调整）

```
① 设计 2 纯函数 + 单测（checkClaimEmbodimentCoverage + skeleton 正则，0.5–1 天，零依赖独立交付）
② 设计 1 Phase 1（双库 + 审批/Worker 落盘 + 导出；先冻结存储接口）
③ 设计 2 mapper 原子 + manifest 接入（依赖 ① 的纯函数）
④ 设计 1 Phase 2（wrapGraphBuilder + 声明表 + 结论树，依赖 ② 的存储接口）
⑤ Phase 3 RDF（等真实需求，不排期）
```

- 设计 1 Phase 1 是关键路径（P1/P2/P3/P4 已消解，但接线面最大）；设计 2 纯函数部分零依赖可先行。
- Phase 2 的声明表工作不依赖建库，可与 ② 并行，但需先冻结存储接口。

---

## 六、风险与对策（修订表）

| 风险 | 影响 | 对策 |
|---|---|---|
| **输入声明表漂移**（节点增删漏更） | 审计链不完整 | 声明表与子图同文件；缺失只记产出不伪造因果（诚实优先） |
| **三套审批语义分叉**（+flexible_plan 第四套） | 审计口径混乱 | `ProvenanceSource` 枚举统一；每 source 一个适配器；entity.value 统一 ApprovalRecord 摘要格式 |
| **审计碎片化**（与 Ledger/ClaimBinding/feedback.jsonl 并存） | 以哪份为准模糊 | provenance 双库为审计导出单一事实源；Ledger/ClaimBinding 为运行态账本；feedback.jsonl 为回流通道（宿主接线时同一 ApprovalRecord 派生两条，保一致，评审 B6） |
| **resume 重复记录 / 重跑覆盖审计** | 链重复或历史丢失 | 幂等键 `${runId}:${source}:${step}:${nodeName}`；runId 实例化（P2） |
| **output_gate 无 caseId** | per-case 收不到 | 全局库 + case_id NULLABLE（P1） |
| **provenance.db 误标 derived 被重建** | 审计销毁 | `kind:"source"` fail-loud（P3） |
| **Windows EBUSY** | 删库/替换失败 | `ProvenanceStore.close()`，运行结束/导出后关闭（B4） |
| 溯源存储膨胀 | 查询变慢 | `enableProvenance` 双通道开关（默认关）；按 runId 归档 |
| **LLM 矩阵抽取质量**（设计 2） | 误报/漏报 | schema 强制 + 骨架集合交叉校验；重试耗尽降级不阻断 |
| **既有测试/门禁变红**（设计 2） | 合并阻塞 | gen:patent-workflow-docs 重生成快照 + drafting-sop-fullrun mock 分支 + llm-replay 重录（见附录） |
| 跨语言运行时 | 运维复杂 | 不引入 Python 依赖；已移除建图 |

---

## 七、验收标准（总，评审 C1 拆场景）

### 设计 1

- [ ] **场景 A（manifest 路径）**：一次 `patent_workflow_run`（manifestId=patent_drafting_v1，含审批门）后，`data/cases/<caseId>/provenance.db` 含 approval_gate + worker 两类 activity；重跑（新 runId）不覆盖前一次记录；resume 续跑不产生重复 id。
- [ ] **场景 B（图路径）**：一次 `patent_workflow_run`（graph=inventiveness，含 HITL 审批）后，per-case 库含 approval_gate activity；`enableProvenance=false` 时库文件不存在（零写入，`provenance-disable.spec.ts`）。
- [ ] **场景 C（输出门禁）**：一次 agent 输出审批（approve/reject）后，全局库 `approval-audit.db` 含 output_gate 记录（含 verdict/feedback/triggerKeyword）；重启后记录仍在。
- [ ] `exportProvenance(caseId, "csv")` 时间线含：时间、来源、活动、执行者、输入、产出、审批结论（场景 A/B）；`exportProvenance(null, "csv")` 导出全局库（场景 C）。
- [ ] Phase 2：inventiveness 图 `inventiveness_conclusion` entity 沿 `derivedFrom` 回溯到 closest/diff/hint 三节点产出（D1 + 区别特征 + 技术启示）。
- [ ] ClawXMemory / KgStore / claim-chart / workflow-runs 既有记录零改动（回归）。

### 设计 2

- [ ] `patent_drafting_v1` 跑通含 `claim_coverage` 阶段全链路，`outputs/claim-embodiment-coverage.json` 落盘（有 caseId 时）。
- [ ] 缺实施例支撑特征出现在 draft-spec 校验提示（warning）。
- [ ] LLM 重试耗尽降级不中断；静态专利 KG / claim-chart / figure 索引零改动。
- [ ] `check:patent-workflow-docs` / `pnpm lint` / `pnpm test` 全绿（含既有测试更新）。

---

## 附：文件清单（拟新增/修改，评审 D 系列补全）

```
src/patent/provenance/
  ├─ types.ts                 # PROV 简化类型（ProvenanceSource 枚举，case_id NULLABLE）
  ├─ provenance-store.ts      # SQLite 存储（PROVENANCE_DB spec kind:"source" + 幂等 upsert + close()）
  ├─ approval-store.ts        # SqliteApprovalStore（全局库，实现 ApprovalStore 全接口）
  ├─ collector.ts             # ProvenanceCollector（wrapGraphBuilder + Worker/审批/降级旁路）
  └─ export.ts                # JSON/CSV 导出（RDF 三期）

src/patent/claim-coverage/
  ├─ types.ts                 # ClaimEmbodimentCoverage / CoverageCheckResult
  ├─ coverage-check.ts        # 确定性校验纯函数（新写）
  ├─ skeleton.ts              # 交底书实施例骨架正则解析（不含 [00xx]）
  └─ mapper.ts                # claim-embodiment-mapper 原子（放 atoms/handlers/builtin/）

修改（不动既有核心逻辑）：
  ├─ src/patent/approval.ts                     # ApprovalRecord 增可选 caseId/runId/ruleViolations
  ├─ src/cli/createLocalGateway.ts              # PatentOutputGate 注入 approvalStore（:1909）
  ├─ src/knowledge/shared/schema-versions.ts    # PROVENANCE_DB spec（kind:"source"）
  ├─ src/patent/paths.ts                        # caseProvenanceDir(caseId, cwd) 三态解析
  ├─ src/tool/builtin/patentWorkflowRunTool.ts  # monitor 装配 + 审批门旁路（:305/:463）+ runId 生成
  ├─ src/patent/workflow/executor.ts            # 审批放行旁路（approvalGrants 注入处，:65）
  ├─ src/patent/worker-contract.ts              # WorkerMonitor 输出 path 解析（或旁路回调）
  ├─ src/patent/graph/domains/*.ts              # 输入声明表 + wrapGraphBuilder 包装（Phase 2）
  ├─ src/patent/atoms/handlers/builtin/index.ts # barrel 导出 mapper
  ├─ src/patent/atoms/index.ts                  # registerBuiltinAtoms 注册 mapper
  ├─ src/patent/workflow/manifests.ts           # patentDraftingManifest 插 claim_coverage 阶段
  ├─ src/patent/atoms/handlers/builtin/draft.ts # DraftSpecHandler 读 claim_coverage_result 追加 warning
  ├─ src/patent/index.ts                        # barrel 导出（provenance/claim-coverage）
  └─ assets/workflows/patent/generated/*.yaml   # pnpm gen:patent-workflow-docs 重生成（lint 门禁）

测试（新增）：
  ├─ tests/patent/provenance-store.spec.ts       # 建库/幂等/魔数/kind:source fail-loud
  ├─ tests/patent/provenance-export.spec.ts      # CSV 时间线 / JSON 导出（双库）
  ├─ tests/patent/provenance-disable.spec.ts     # 开关关 → 库文件不存在（零写入回归）
  ├─ tests/patent/claim-coverage-check.spec.ts   # 纯函数（三字段全表）
  └─ tests/patent/claim-coverage-mapper.spec.ts  # 原子降级/骨架交叉校验/parse 失败分支

测试（既有更新）：
  ├─ tests/patent/drafting-sop-fullrun.spec.ts   # mock provider 增 mapper 分支（否则必红）
  └─ tests/patent/drafting-sop.spec.ts           # 若断言 22 阶段数需同步
  └─ llm-replay fixture                          # 录制须在新阶段就位、draft-spec prompt 定稿后
```

**收尾门禁**：`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`；`check:patent-workflow-docs` 自动挂 lint。
**无 UI 变更**：新增内容均为 manifest 描述/模型 prompt/工具 description，不触发 i18n；不新增工具（outputSchema 门无关）；不新增事件（event-matrix 门无关）。
