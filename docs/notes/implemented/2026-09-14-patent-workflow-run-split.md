# Agent Note: patent_workflow_run 按模式拆分（graph / manifest / judge / 溯源）

Status: implemented

## Problem

`src/tool/builtin/patentWorkflowRunTool.ts` 818 行里有四条彼此独立的执行面：工具契约（含 100 行 `description`/`inputSchema`）、manifest 模式编排（续跑检查点、溯源旁路、worker 监控、持久化、规则门、结果渲染）、图模式编排（领域子图 + 检查点 + 审批放行 + 图结果渲染）、judge 装配与判分段落（多模型共识 / 单模型采样）。加上溯源收集器工厂与 `PatentWorkflowRunInput`/`Deps` 两个大类型块。

后果：改图模式的检查点/审批语义要跨过 manifest 模式的 180 行；改 judge 段落要跨过两条编排；类型块把"契约"推到文件 130 行之后。台账 `docs/technical-debt/backlog.md` 的 issue #152 列该文件待拆，并给出了 graph / judge / 渲染三块的初步切分建议。

## Decision

`src/tool/builtin/patentWorkflowRunTool.ts` 只保留**工具契约与分派**（module 说明、`description`/`inputSchema`、`isReadOnly`/`isConcurrencySafe`、按 `input.graph` 分流到图模式或 manifest 模式、导出面），818 → 149 行。其余移入 `src/tool/builtin/patent-workflow-run/`：

| 文件 | 职责 |
|---|---|
| `types.ts` | `PatentWorkflowRunInput` / `PatentWorkflowRunDeps`（原文件内类型块逐字迁移） |
| `provenance.ts` | `openProvenanceCollector`（`SATI_PROVENANCE` 开关 + caseId 才构造，否则 null） |
| `manifestRun.ts` | `runManifestWorkflow`：续跑检查点 → 溯源旁路 → worker 监控 → `runWorkflow` → 规则门 → 持久化与渲染 |
| `graphRun.ts` | `executeGraphRun`：子图装配 → 检查点运行（可续跑/放行）→ 图结果文本渲染 |
| `judges.ts` | `assembleGraphJudges`（judgeModels → modelHints）与 `buildJudgeSection`（多模型共识 / 单模型采样） |

入口保留既有导出面：`createPatentWorkflowRunTool` 原地不变，`openProvenanceCollector` 与 `buildJudgeSection` 由入口转出（`tests/patent/provenance-*.spec.ts` 与 `tests/tool/builtin/patentWorkflowRun.spec.ts` 从入口导入这两个符号，无需改测试），两个类型同样转出。工厂在构造时建立 manifest 表并注入 `runManifestWorkflow({ deps, manifests }, …)`，避免每次调用重建。

**行为不变用差分对拍确认**（以改动前实现为对照，验证后删除）：**22 条场景完全一致**——

- manifest 模式：disclosure 全流程、未知 manifest fail-closed、无 caseId 时续跑报错、caseId 持久化产物（`workflow-runs/` 落盘清单）、放行审批门后的完成路径；
- 图模式：`inventiveness` 中断 + 检查点、`novelty`、`enablement`、`judgeSamples`、无效 `resumeCheckpointId`、缺模型客户端、`judgeModels` 双模型共识；
- `buildJudgeSection`：单模型采样、中断跳过、空报告、无 LLM 通道、空 judges、多模型 hints 六种配置；
- `openProvenanceCollector`：开关关 / 开但无 caseId / 开且有 caseId / 开 + resume 四种组合（含返回 null 与构造 collector 的差异、以及落盘文件清单）。

对拍同时比对文本结果、结构化产物与落盘文件清单；仅掩蔽随调度抖动的量（`durationMs`、时间戳、检查点序号、节点耗时段的毫秒数与并列项顺序）。

工具契约段（工厂函数到 `execute` 之前，含 `description` 与 `inputSchema`）与类型块均**逐字未变**（已逐行比对），因此 llm-replay 请求键与既有 fixture 不受影响。

## Alternatives considered

- **只把图模式抽出去、manifest 分支留在入口** — 落选：manifest 分支 180 行仍是入口的主体，`execute` 依旧承担"分流 + 两条编排"三段职责，认知负载没有实质下降。
- **把 `runManifestWorkflow` 保持为入口内的闭包、只抽出纯函数（渲染/规则门）** — 落选：闭包捕获 `deps`/`manifests` 使其无法单测，且入口仍握着 200 行编排；改为显式 runtime 参数后，依赖面一眼可见。
- **把 `types.ts` 拆成 input / deps 两个文件** — 落选：两个类型同属"本工具的调用契约"，拆开只会让导入方多写一行，收益为零。
- **让 `judges.ts` 与 `graphRun.ts` 合并**（judge 段落只服务图模式）— 落选：`buildJudgeSection` 是纯逻辑且已被单测直接消费（多模型共识/单模型兼容），与图运行时的检查点/审批/降级渲染不是一类；合并会让"纯函数"重新埋回编排文件里。
- **同 PR 一起处理 `kanban.ts`（815）/`executeCode.ts`（774）** — 落选：两者尚未达 800 行阈值且拆分方案未成形（台账已记"暂不登记"），硬塞进同一 PR 只会放大 diff。

## Consequences

- 入口 818 → 149 行；manifest 编排 214 行、图编排 272 行、judge 137 行、溯源 30 行、类型 69 行，各面独立可读可测。
- 既有测试无需改动即通过（`patentWorkflowRun.spec.ts` 847 行 + 两个溯源 spec 覆盖两条模式的主路径），仅新增决策记录与台账更新。
- issue #152 的剩余文件为 `patentWorkflowRunTool.ts` 之外的两项（`kanban.ts`、`executeCode.ts`，均未达阈值），已按"机会型"留在台账。
- 差分对拍脚本是一次性验证手段（依赖改动前的实现副本），已随验证结束删除，不入库。
