import {
  patentNoveltyManifest,
  runWorkflow,
  validateWorkflowManifest,
  type WorkflowManifest,
} from "../../patent/index.js";
import { StageHandlerRegistry } from "../../patent/atoms/index.js";
import type { SatiToolDefinition } from "../protocol/types.js";

export type PatentWorkflowStageOutput = {
  /** 与 manifest.stages[].id 对应的阶段 id。 */
  stageId: string;
  /** 该阶段的分析输出文本（由主代理按阶段完成分析后提供）。 */
  text: string;
};

export type PatentWorkflowInput = {
  /** 工作流 manifest id（缺省 "patent_novelty_v1" = 内置专利新颖性分析五阶段）。 */
  manifestId?: string;
  /** 各阶段输出（缺省按顺序对应 manifest 全部阶段）。 */
  outputs?: PatentWorkflowStageOutput[];
  /** 案例标识（用于结果记录，可含 {caseId} 占位）。 */
  caseId?: string;
};

/**
 * `patent_workflow` — 声明式专利工作流执行工具。
 *
 * 按内置/自定义 WorkflowManifest 的声明式阶段顺序执行：
 * 主代理按 manifest 各阶段（解析→检索→对比→结论→人工确认）逐步完成分析，
 * 将各阶段文本传入本工具做结果组装、完整性校验（degraded 标记）与摘要生成。
 * 确定性执行，无 LLM 调用；用于专利新颖性分析等结构化流程的产物收口。
 *
 * 注意：本工具传**空 StageHandlerRegistry**（禁用原子执行）——阶段输出由主代理
 * 提供、工具只做收口校验；真正需要原子自动执行（handler 内部调 LLM/检索）时，
 * 调用方应注入已注册内置原子的注册表与 provider（见 src/patent/atoms）。
 */
export function createPatentWorkflowTool(): SatiToolDefinition<PatentWorkflowInput> {
  const manifests = new Map<string, WorkflowManifest>([[patentNoveltyManifest.id, patentNoveltyManifest]]);

  return {
    name: "patent_workflow",
    aliases: ["PatentWorkflow", "run_patent_workflow"],
    description:
      "Run a declarative patent workflow: validates the manifest, assembles per-stage outputs into a " +
      "structured WorkflowRunResult with degraded-step marking and a summary. Built-in manifest " +
      "patent_novelty_v1 (parse → search → compare → conclude → approval). Use to finalize multi-stage " +
      "patent analyses (e.g. novelty) with a single verifiable result record.",
    kind: "session",
    inputSchema: {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: {
        manifestId: {
          type: "string",
          description: "Workflow manifest id. Defaults to 'patent_novelty_v1'.",
        },
        caseId: {
          type: "string",
          description: "Optional case id for result records.",
        },
        outputs: {
          type: "array",
          description: "Per-stage outputs keyed by stage id. Missing stages are marked degraded.",
          items: {
            type: "object",
            required: ["stageId", "text"],
            additionalProperties: false,
            properties: {
              stageId: { type: "string" },
              text: { type: "string" },
            },
          },
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      const manifest = manifests.get(input.manifestId ?? patentNoveltyManifest.id);
      if (!manifest) {
        const available = [...manifests.keys()].join(", ");
        return {
          content: [
            {
              type: "text",
              text: `patent_workflow: 未知 manifest "${input.manifestId}"（可用: ${available}）`,
            },
          ],
        };
      }
      try {
        validateWorkflowManifest(manifest);
      } catch (err) {
        return { content: [{ type: "text", text: `patent_workflow: manifest 校验失败: ${(err as Error).message}` }] };
      }

      const byId = new Map((input.outputs ?? []).map(o => [o.stageId, o.text]));
      // 空注册表：禁用原子执行，保持"主代理产出 → 工具收口"语义（无 LLM 调用）。
      const result = await runWorkflow(manifest, { caseId: input.caseId }, async stage => byId.get(stage.id) ?? "", {
        handlers: new StageHandlerRegistry(),
      });

      const lines = result.stages.map(s => {
        const flag = s.degraded ? "⚠️ 降级" : "✅";
        return `- ${flag} ${s.stageId} (${s.strategy}): ${s.output.length > 0 ? `${s.output.slice(0, 80)}${s.output.length > 80 ? "…" : ""}` : "(无输出)"}`;
      });
      return {
        content: [
          {
            type: "text",
            text: [
              `patent_workflow(${result.manifestId}): ${result.summary}`,
              ...lines,
              `完成状态: ${result.completed ? "completed" : "incomplete（有降级阶段）"}`,
            ].join("\n"),
          },
        ],
      };
    },
  };
}
