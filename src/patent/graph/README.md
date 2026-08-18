# src/patent/graph — 图引擎（可自动执行 / 可降级 / 可评估）

移植自 Mady `graph/pregel.go` 的 SuperStep（BSP）图执行引擎，把专利规则与工作流升级为
**可自动执行、可降级、可评估**的图。

## 核心概念

- **节点（GraphNode）**：`(ctx) => Promise<StateDelta>`。接收共享 state 的**深拷贝快照**，
  返回**增量片段**（只含自己产生的 key），引擎按 Reducer 确定性合并 —— 同超步并行无数据竞争。
- **边**：静态边（`addEdge`）+ 条件边（`setConditionalEdge`，router 返回目标节点列表，
  支持扇出与受控循环）。`GRAPH_END`（`"__end__"`）哨兵终止。
- **超步（SuperStep）**：并行执行当前超步所有 active 节点 → 确定性合并 → 计算下一超步。
  无拓扑排序/无环检测，靠 `maxSteps`（默认 100）防死循环。
- **节点策略（NodePolicy）**：重试（指数退避）/ 超时（总时长含重试）/ 副作用（delta 不合并）。
- **降级（DegradationMark）**：LLM/检索器缺失或失败时写 fallback + `<key>__degradation` 标记，
  下游可见"该数据来自降级"，绝不让全图崩溃。
- **检查点（Checkpoint）**：每超步前持久化 `{ state, activeNodes, stepIndex }`，
  中断后 `resume` 从该超步继续（断点续跑）。

## 快速开始

```ts
import { GraphBuilder, runGraphWithCheckpoints, InMemoryCheckpointStore } from "../../patent/index.js";

const builder = new GraphBuilder();
builder
  .addNode("a", async () => ({ x: 1 }))
  .addNode("b", async () => ({ y: 2 }))
  .addEdge("a", "b")
  .addEdge("b", "__end__");
const graph = builder.compile("a"); // entry 节点 + maxSteps

const { result, checkpointId } = await runGraphWithCheckpoints(graph, { input: "..." }, {
  store: new InMemoryCheckpointStore(),
  graphId: "my_graph",
});
```

## 与现有 Workflow 的关系（兼容层）

- `runWorkflow`（`src/patent/workflow.ts`）保留为兼容入口，行为不变。
- `manifestToGraph`（`adapter.ts`）：现有 `WorkflowManifest`（线性阶段 + retry 信号回退）
  自动转图执行，输出与 `runWorkflow` **尽力等价**（等价性测试兜底 happy path/中断/回退）。
  已知差异：
  - 错误重试：runWorkflow 对 handler 错误重试 maxRetries 次（默认 2）并写
    `[WORKFLOW_DEGRADED]` 文本；图路径只执行一次，错误转节点级降级标记；
  - 放行 approval：runWorkflow 把空输出阶段标 degraded（completed=false），
    图路径无此概念（completed=true）；
  - executor 分支：图路径额外写 `state[stage.id]`（runWorkflow 不写）。
- `runStageHandler`：现有 `StageHandler` 直接作为图节点执行（统一中断转换），
  保留降级（普通错误）与中断（`InterruptStageError` → `GraphInterruptError`）语义。

## 三性领域子图（domains/）

| 子图 | 构建函数 | entry | 覆盖法条 | 规则门域 |
|---|---|---|---|---|
| 新颖性 | `buildNoveltyGraph` | `extract` | A22.2 单独对比 + 数值范围 | `patent_novelty` |
| 创造性 | `buildInventivenessGraph` | `parse` | A22.3 三步法 + 辅助因素 | `patent_inventiveness` |
| 充分公开 | `buildEnablementGraph` | `load` | A26.3 三步审查 + 领域规则 | `patent_disclosure` |

子图复用现有原子（extract/keywords/search/novelty/approval-gate）+ 新增确定性节点
（`numeric_range` 数值范围专项判定 / `domain_rules` 化学·计算机·机械领域特殊要求），
末端接 checker 规则门收口（`rule_gate` 节点写 `rule_gate_verdict` / `rule_gate_failures`）。

### 充分公开子图（enablement）专项增强（2026-08）

`buildEnablementGraph` 除三步审查 LLM 节点（completeness/clarity/enablement/conclude）外：

| 节点/输入 | 类型 | 职责 |
|---|---|---|
| `load` 章节切片 | 确定性 | `splitSpecSections` 按行首标题切分五部分+摘要 → `spec_section_texts`；LLM 节点经 `buildSpecContext` 按"具体实施方式优先"的章节序拼接（长说明书不再头部 8K 截断漏判实施例） |
| `spec_prechecks` | 确定性 | 数值范围端点/中间值实施例（`checkNumericRangeCoverage`）、实施例计数、效果数据定量性（`checkEffectQuantification`）——纯函数共享自 `src/patent/spec/checks.ts`（validate_specification 同源） |
| `domain_rules` | 确定性 | 技术领域检测扩展为 6 域：化学/医药、生物（保藏两条件）、电学（连接关系/信号流）、计算机、机械、通用 |
| `claimText` 输入 | 工具参数 | `patent_workflow_run({graph:"enablement", claimText})` 独立传入权利要求——enablement/conclude 节点按"权利要求保护的技术方案"判断（缺省回退 input） |
| enablement 提示 | LLM prompt | 显式列出审查指南 §2.1.3 五种无法实现情形（(1)-(5)）+ 平衡条件（本领域技术人员视角/常识可省略/至少一个技术问题成立/效果可预期无需实验数据/夸大效果通常不构成） |

### 创造性子图（inventiveness）专项节点（2026-08 优化）

`buildInventivenessGraph` 除三步法 LLM 节点（parse/build_query/closest/diff/hint/
secondary/conclude）外，新增：

| 节点 | 类型 | 职责 |
|---|---|---|
| `recall_check` | LLM | 检索覆盖度反思（`{adequate, covered_features, missing_features}`）；降级/解析失败直接放行，不进入重检回路 |
| `refine_query` | 确定性 | 覆盖不足时拼补检索式（`旧查询 OR 缺特征1 OR 缺特征2`），轮次 +1 |
| `converge_prior_art` | 确定性 | 多轮 union 结果收敛为最近轮优先的前 8 篇（防 closest 候选膨胀） |
| `domain_inject` | 确定性 | IPC 领域知识注入（P2-2）：parse 特征文本经 `classifyIpc` 分类，命中部的 `inventivenessFocus`（如化学"预料不到的技术效果"）注入 closest/diff/hint 提示 |
| `combination` | LLM | D2 组合动机/技术障碍/反向教导显式建模（`{candidate_documents, combinable, motivation, obstacles, teaching_away}`），输出拼接 hint/conclude |
| `citation_gate` | 确定性 | 引用真实性校验：结论引用的 D1/D2 必须真实出现在 prior_art（专利号/文档标识提取比对），未接地引用经 `precomputedFailures` 并入规则门（pass → needs_revision；blocked/needs_revision 保持） |

行为开关：
- `retrieval.maxRounds`（缺省 2，0 = 关闭检索反思回路保持旧行为）；工具层对应
  `patent_workflow_run({ graph: "inventiveness", retrievalRounds: 0 })`；
- `combination: false` / `citationGate: false` 关闭对应节点退回旧行为；
- **模型分层（P2-1）**：9 个 LLM 节点携带 `modelHint` 标识（parse/build_query/recall_check/
  combination = "cheap"，closest/diff/hint/secondary/conclude = "strong"），
  `patent_workflow_run` 的 deps 配置 `modelHints` 映射后按节点分层调用模型，未配置时
  全部用默认模型（行为不变）；
- **LLM Judge 双轨（P2-3）**：`patent_workflow_run({ judgeSamples: N })` 对结论报告打
  0-1 分附在结果尾部，仅参考不改变规则门判级；
- **HITL 反馈回流（P2-4）**：读侧已接线——`patent_workflow_run`（graph=inventiveness + caseId）读取
  `data/cases/<caseId>/inventiveness-feedback.jsonl` 历史反馈注入 conclude 提示（仅提示，不强制）；
  写侧为宿主接线点——`PatentOutputGate.onDecisionFeedback` 回调在审批 modified/rejected 时暴露
  `ApprovalRecord`（含原文摘录与人工反馈），宿主可调用 `appendInventivenessFeedback` 落盘
  （gateway 审批上下文暂无 caseId，生产接线待宿主侧落地，`feedback/inventiveness-feedback.ts` 已就绪）；
- `build_query` 检索式带申请日/优先权日时间基准（`after:YYYYMMDD` 日期限定）；
- 检索命中 `publication_date` 透传（`StageProvider.search` 返回字段），closest 提示逐篇标注公开日。

审批门（HITL）：构建选项 `includeApproval`（缺省 true）注入 approval-gate 节点，
图停在审批门暂停等待人工介入（工具路径默认）；自动执行/评测场景传
`includeApproval: false` 直达规则门收口（如 `createGraphRunner`）。

审批通过（2026-08 补齐闭环）：`grantApproval(store, checkpointId)` 把放行标记
（`APPROVAL_GRANTED_KEY`）写入检查点 state 并持久化；`patent_workflow_run` 的
`approveCheckpointId` 参数 = 批准 + 续跑一步到位——resume 时审批门节点重放，
`ApprovalGateHandler` 检测到标记即放行，后续节点继续执行（不再无限暂停）。
manifest 路径（`runWorkflow`）对应 `approvalGrants: string[]`（已批准的审批门
阶段 id），重跑时跳过这些门直接放行。

消费方式（推荐）：
```ts
import { DOMAIN_GRAPHS, runGraphWithCheckpoints, JsonFileCheckpointStore } from "../../patent/index.js";

const def = DOMAIN_GRAPHS.inventiveness;
const graph = def.build({ handlers }).compile(def.entry);
const { result } = await runGraphWithCheckpoints(graph, { text: "权利要求…" }, {
  store: new JsonFileCheckpointStore("checkpoints/"),
  graphId: "patent_inventiveness",
  provider, // StageProvider：callLLM + search
});
```

或直接调用工具 `patent_workflow_run`：
```
patent_workflow_run({ graph: "inventiveness", input: "权利要求…" })   // 自动跑三步法全图
patent_workflow_run({ graph: "inventiveness", resumeCheckpointId: "patent_inventiveness-9" })  // 断点续跑
```

## 评估（evaluate/）

`src/patent/evaluate/` 提供统一评估框架：
- `Evaluator`：CaseRunner + 指标汇总（keyword_recall / citation_completeness / rule_gate_pass / jaccard / conclusion_direction）；
- `createGraphRunner`：把领域子图自动执行包装为 CaseRunner（未映射法条降级单文本规则门）；
- `conclusionDirection`：结论方向指标（a22.3 专属基准用，只认 `结论：具备创造性` / `结论：不具备创造性`
  单行标记；expected 无标记的旧 suite 恒为 1，不改变旧分数）；
- `llmJudge`：LLM Rubric Judge（N 采样取中位数）；
- `scripts/patent-eval.mjs --mode graph`：对 fixtures 跑图 + expected 打分（`pnpm test:patent-eval`）；
  a22.3 基准：`--suite tests/patent/benchmark/fixtures/patent-exam-real-a22.3.json --mode graph`。

## 设计约定

- 节点**只返回增量 key**（不得返回整个 state），保证并行合并确定性。
- 中断（审批门）用 `GraphInterruptError`，引擎捕获后暂停（completed=false + interrupted），
  不执行后续超步；同超步内其它节点的 delta **一并丢弃**（不提交部分结果，resume 重放该超步）。
- 条件边 router 可读写 state（回退时删除被回退阶段键），但应保持纯函数语义优先。
- 超步粒度检查点会重放该超步内已完成的外部副作用调用 —— 假定节点幂等。
