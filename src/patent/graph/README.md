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

审批门（HITL）：构建选项 `includeApproval`（缺省 true）注入 approval-gate 节点，
图停在审批门暂停等待人工介入（工具路径默认）；自动执行/评测场景传
`includeApproval: false` 直达规则门收口（如 `createGraphRunner`）。

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
- `Evaluator`：CaseRunner + 指标汇总（keyword_recall / citation_completeness / rule_gate_pass / jaccard）；
- `createGraphRunner`：把领域子图自动执行包装为 CaseRunner（未映射法条降级单文本规则门）；
- `llmJudge`：LLM Rubric Judge（N 采样取中位数）；
- `scripts/patent-eval.mjs --mode graph`：对 fixtures 跑图 + expected 打分（`pnpm test:patent-eval`）。

## 设计约定

- 节点**只返回增量 key**（不得返回整个 state），保证并行合并确定性。
- 中断（审批门）用 `GraphInterruptError`，引擎捕获后暂停（completed=false + interrupted），
  不执行后续超步；同超步内其它节点的 delta **一并丢弃**（不提交部分结果，resume 重放该超步）。
- 条件边 router 可读写 state（回退时删除被回退阶段键），但应保持纯函数语义优先。
- 超步粒度检查点会重放该超步内已完成的外部副作用调用 —— 假定节点幂等。
