import { builtinPatentManifests } from "../../patent/index.js";
import type { SatiToolDefinition } from "../protocol/types.js";
import { executeGraphRun } from "./patent-workflow-run/graphRun.js";
import { runManifestWorkflow } from "./patent-workflow-run/manifestRun.js";
import type { PatentWorkflowRunDeps, PatentWorkflowRunInput } from "./patent-workflow-run/types.js";

export { openProvenanceCollector } from "./patent-workflow-run/provenance.js";
export { buildJudgeSection } from "./patent-workflow-run/judges.js";
export type {
  PatentWorkflowRunDeps,
  PatentWorkflowRunInput,
} from "./patent-workflow-run/types.js";

/**
 * `patent_workflow_run` — 原子自动执行工作流工具。
 *
 * 与 `patent_workflow`（收口语义：主代理产出文本 → 工具收口校验）互补：
 * 本工具**注入 provider 自动执行声明了 atom 的阶段**——LLM（`context.model`
 * 或 deps.model）驱动 extract/merge/groundedness/reasoning/keywords/novelty/
 * draft-claims，nuo-patent 检索驱动 search；无 atom 阶段（preprocess/report）
 * 透传输入文本（consistency 已声明 reasoning 原子，不再透传原文）。
 *
 * 审批门语义：disclosure manifest 的 review_gate 阶段（approval-gate 原子）执行时
 * 抛 InterruptStageError → 工作流**暂停**（返回 interrupted，后续阶段不执行）。
 * 断点续跑（manifest 模式）：提供 resumeCheckpointId + caseId 时从上次检查点继续
 * （跳过已完成阶段），approveStageIds 放行已批准审批门；无 caseId 时不可续跑。
 * 图模式（graph=…）另支持 resumeCheckpointId / approveCheckpointId（见 execute）。
 * 人工确认后的 draft_claims 等后续阶段，可由主代理基于 interrupted 结果 +
 * 收口语义（patent_workflow 工具）或自定义 manifest 继续。
 *
 * 接线状态（2026-08）：本工具是原子执行路径的唯一生产消费方——此前 10 个内置
 * 原子 handler 与 createNuoSearchProvider 均无生产调用（详见 src/patent/workflow.ts
 * 头注释的"单一路径"原则：收口 + 原子两条路径并存，各有明确消费工具）。
 */

export function createPatentWorkflowRunTool(
  deps: PatentWorkflowRunDeps = {},
): SatiToolDefinition<PatentWorkflowRunInput> {
  const manifests = new Map(builtinPatentManifests.map(({ manifest }) => [manifest.id, manifest]));

  return {
    name: "patent_workflow_run",
    outputSchema: {
      type: "object",
      properties: {},
    },
    aliases: ["PatentWorkflowRun", "run_patent_atoms"],
    description:
      "Automatically execute a declarative patent workflow (atom stages) or a domain graph. Manifest path: " +
      "patent_disclosure_v1 (PFE extraction → prior-art search → per-feature novelty → review gate → claims draft), " +
      "patent_drafting_v1 (disclosure pipeline → prior-art compare → drafting: claims draft + specification draft + " +
      "deterministic spec validation + slop score gate; HITL at deconstruct/search/compare/disclosure/final). " +
      "Graph path (graph=novelty|inventiveness|enablement): runs a full domain graph (LLM nodes + patent search + " +
      "deterministic rule gate) in one call — e.g. graph=inventiveness runs the A22.3 three-step analysis end-to-end. " +
      "Provide the input as 'input'. The review gate pauses the run (reports interrupted + checkpointId); re-invoking " +
      "with resumeCheckpointId continues from the pause point (the gate pauses again), while approveCheckpointId " +
      "grants the gate and resumes past it. Manifest path: approveStageIds skips approved gates on rerun; " +
      "resumeCheckpointId (with caseId) resumes past completed stages from the manifest checkpoint. " +
      "When caseId is provided, run results, the Mermaid " +
      "diagram, and graph checkpoints are persisted under <caseDir>/workflow-runs/. Requires a model client.",
    kind: "session",
    domain: "patent",
    inputSchema: {
      type: "object",
      required: ["input"],
      additionalProperties: false,
      properties: {
        manifestId: {
          type: "string",
          description:
            "Workflow manifest id. Defaults to 'patent_disclosure_v1'; multiple built-in manifests declare atoms (claim-chart etc.) and run automatically.",
        },
        graph: {
          type: "string",
          enum: ["novelty", "inventiveness", "enablement"],
          description:
            "Domain graph to run: novelty (A22.2), inventiveness (A22.3 three-step), enablement (A26.3). " +
            "Runs all LLM/search/rule-gate nodes up to the approval gate, which pauses the run (HITL); " +
            "re-invoke with resumeCheckpointId to continue (the gate pauses again until approved). " +
            "Mutually exclusive with manifestId.",
        },
        resumeCheckpointId: {
          type: "string",
          description:
            "Graph-mode checkpoint id from a previous interrupted run; continues from that point instead of restarting.",
        },
        approveCheckpointId: {
          type: "string",
          description:
            "Graph-mode approval: grants the approval gate at this checkpoint (writes the grant marker) and resumes from it — the gate passes on replay and later nodes run. Mutually exclusive with resumeCheckpointId.",
        },
        approveStageIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Manifest-mode approval: stage ids of already-approved approval gates (e.g. ['review_gate']); reruns skip these gates and continue past them.",
        },
        caseId: {
          type: "string",
          description:
            "Optional case id. When provided, the run result is persisted to <caseDir>/workflow-runs/<runId>.json plus a Mermaid diagram.",
        },
        input: {
          type: "string",
          description: "Initial material (e.g. the technical disclosure text) consumed by the extract atoms.",
        },
        claimText: {
          type: "string",
          description:
            "Optional claim text (for graph=enablement): when provided, the enablement/conclude nodes judge the claimed technical solution; defaults to the input text.",
        },
        chartTargets: {
          type: "string",
          description:
            "Target objects JSON for the claim-chart stage ([{id,kind,title?,source_path?}], kind: prior-art|product); empty by default (elements only, row mapping deferred).",
        },
        maxResults: {
          type: "number",
          description: "Max prior-art search results (default 5).",
        },
        retrievalRounds: {
          type: "number",
          description:
            "Graph-mode retrieval-reflection rounds (default 2, 0 disables the reflection loop): when search coverage is insufficient the graph re-queries up to this many times before proceeding to closest.",
        },
        judgeSamples: {
          type: "number",
          description:
            "LLM Judge quality score (default off): when >0, scores the graph conclusion report 0-1 (median of N samples) and appends it to the result — advisory only, does not change the rule-gate verdict.",
        },
        judgeModels: {
          type: "array",
          items: { type: "string" },
          description:
            "Multi-model consensus judges (default off): modelHint ids (e.g. ['judge-a','judge-b'], each mapped via deps.modelHints). When provided, votes from multiple judges → median + spread-based disagreement detection → consensus verdict + Verdict Envelope (typed, hash-sealed). Takes precedence over judgeSamples.",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    async execute(input, context) {
      // 图模式：领域子图自动执行（与 manifest 路径互斥）。
      if (input.graph !== undefined) {
        return executeGraphRun(input, context, deps);
      }
      return runManifestWorkflow({ deps, manifests }, input, context);
    },
  };
}
