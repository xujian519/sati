import { builtinPatentManifests, formatManifestCatalog } from "../../patent/index.js";
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
      required: ["completed"],
      properties: {
        // Manifest path (WorkflowRunResult)
        manifestId: { type: "string" },
        caseType: { type: "string" },
        completed: { type: "boolean" },
        stages: { type: "array", items: { type: "object", additionalProperties: true } },
        degradedSteps: { type: "array", items: { type: "string" } },
        summary: { type: "string" },
        persistWarning: { type: "string" },
        // Graph path (GraphRunResult)
        state: { type: "object", additionalProperties: true },
        steps: { type: "integer" },
        degraded: { type: "array", items: { type: "object", additionalProperties: true } },
        nodeDurations: { type: "array", items: { type: "object", additionalProperties: true } },
        // Both paths
        interrupted: { type: "object", additionalProperties: true },
      },
    },
    aliases: ["PatentWorkflowRun", "run_patent_atoms"],
    description:
      "Execute a patent workflow (atom stages) or a domain graph (LLM + search + rule gate): manifest path runs " +
      "the manifest, graph path (novelty|inventiveness|enablement|citation_check) runs a subgraph. Approval " +
      "gates pause the run; resumeCheckpointId continues and approveCheckpointId/approveStageIds grant the gate. " +
      "With caseId, runs and checkpoints persist under <caseDir>/workflow-runs/. Requires a model client. " +
      "Orchestration entries: patent_workflow_assemble (assemble/validate only), patent_workflow_run (execute), " +
      "patent_docket (case lifecycle). Built-in manifests: " +
      formatManifestCatalog() +
      ".",
    kind: "session",
    domain: "patent",
    inputSchema: {
      type: "object",
      required: ["input"],
      additionalProperties: false,
      properties: {
        manifestId: {
          type: "string",
          description: "Manifest id (default patent_disclosure_v1).",
        },
        graph: {
          type: "string",
          enum: ["novelty", "inventiveness", "enablement", "citation_check"],
          description:
            "Domain graph: novelty (A22.2), inventiveness (A22.3), enablement (A26.3), citation_check (no LLM). " +
            "Mutually exclusive with manifestId.",
        },
        resumeCheckpointId: {
          type: "string",
          description: "Graph checkpoint id from an interrupted run.",
        },
        approveCheckpointId: {
          type: "string",
          description: "Grant the approval gate at this checkpoint and resume.",
        },
        approveStageIds: {
          type: "array",
          items: { type: "string" },
          description: "Manifest approval: approved gate stage ids (e.g. ['review_gate']).",
        },
        caseId: {
          type: "string",
          description: "Persist run artifacts under <caseDir>/workflow-runs/.",
        },
        input: {
          type: "string",
          description: "Initial material (e.g. disclosure text).",
        },
        claimText: {
          type: "string",
          description: "Claim text for graph=enablement (defaults to input).",
        },
        chartTargets: {
          type: "string",
          description: "Claim-chart targets JSON ([{id,kind,...}]; kind prior-art|product).",
        },
        maxResults: {
          type: "number",
          description: "Max search results (default 5).",
        },
        retrievalRounds: {
          type: "number",
          description: "Graph retrieval reflection rounds (default 2; 0 disables).",
        },
        judgeSamples: {
          type: "number",
          description: "LLM judge samples; >0 adds a 0-1 advisory score.",
        },
        judgeModels: {
          type: "array",
          items: { type: "string" },
          description: "Multi-judge modelHint ids → consensus verdict + Verdict Envelope.",
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
