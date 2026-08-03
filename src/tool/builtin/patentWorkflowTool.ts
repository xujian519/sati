import {
  aggregate,
  defaultPatentRules,
  formatRuleResults,
  patentDisclosureManifest,
  patentNoveltyManifest,
  runWorkflow,
  validateWorkflowManifest,
  RuleEngine,
  type RuleCheckResult,
  type Verdict,
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
  /**
   * 确定性规则检查域（覆盖 manifest 默认映射）。逗号分隔多域，如 "patent_novelty,patent_disclosure"；
   * 传空串禁用检查。缺省按 manifest caseType 推导（novelty_search → patent_novelty；
   * disclosure_analysis → patent_disclosure,patent_claims）。
   */
  checkDomain?: string;
};

/** manifest caseType → 确定性规则检查域（dual-track 判定的"确定性轨"）。 */
const MANIFEST_CHECK_DOMAINS: Record<string, string[]> = {
  novelty_search: ["patent_novelty"],
  disclosure_analysis: ["patent_disclosure", "patent_claims"],
};

/** 解析本次调用的检查域；返回空数组 = 跳过确定性门。 */
function resolveCheckDomains(manifest: WorkflowManifest, checkDomain?: string): string[] {
  if (checkDomain === "") return [];
  if (checkDomain !== undefined) {
    return checkDomain
      .split(",")
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }
  return MANIFEST_CHECK_DOMAINS[manifest.caseType] ?? [];
}

/** 规则检查结果摘要（一行）：verdict + 失败数。 */
function summarizeCheck(verdict: Verdict, failures: readonly RuleCheckResult[]): string {
  const label = verdict === "pass" ? "✅ 通过" : verdict === "needs_revision" ? "⚠️ 需修改" : "⛔ 阻断";
  return failures.length === 0 ? `确定性门: ${label}` : `确定性门: ${label}（${failures.length} 项规则失败）`;
}

/**
 * `patent_workflow` — 声明式专利工作流执行工具。
 *
 * 按内置/自定义 WorkflowManifest 的声明式阶段顺序执行：
 * 主代理按 manifest 各阶段（解析→检索→对比→结论→人工确认）逐步完成分析，
 * 将各阶段文本传入本工具做结果组装、完整性校验（degraded 标记）与摘要生成。
 * 确定性执行，无 LLM 调用；用于专利新颖性分析等结构化流程的产物收口。
 *
 * 自 v0.1.0 起接入 **dual-track 确定性规则门**（src/patent/checker）：对全部非降级
 * 阶段产出拼接文本运行 defaultPatentRules 判定（按 manifest caseType 映射检查域，
 * 可用 checkDomain 覆盖），将 pass / needs_revision / blocked 判级与失败明细
 * 拼入工具输出——撰写/答复产出在收口时过一遍确定性审查，供主代理据此修订或放行。
 *
 * 注意：本工具传**空 StageHandlerRegistry**（禁用原子执行）——阶段输出由主代理
 * 提供、工具只做收口校验；真正需要原子自动执行（handler 内部调 LLM/检索）时，
 * 调用方应注入已注册内置原子的注册表与 provider（见 src/patent/atoms）。
 */
export function createPatentWorkflowTool(): SatiToolDefinition<PatentWorkflowInput> {
  const manifests = new Map<string, WorkflowManifest>([
    [patentNoveltyManifest.id, patentNoveltyManifest],
    [patentDisclosureManifest.id, patentDisclosureManifest],
  ]);

  return {
    name: "patent_workflow",
    aliases: ["PatentWorkflow", "run_patent_workflow"],
    description:
      "Run a declarative patent workflow: validates the manifest, assembles per-stage outputs into a " +
      "structured WorkflowRunResult with degraded-step marking and a summary, then runs the deterministic " +
      "rule gate (dual-track checker) over the outputs and appends the pass/needs_revision/blocked verdict. " +
      "Built-in manifests: patent_novelty_v1 (parse → search → compare → conclude → approval) and " +
      "patent_disclosure_v1 (preprocess → extract → merge → consistency → report → approval). Use to finalize " +
      "multi-stage patent analyses (novelty / disclosure) with a single verifiable result record.",
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
        checkDomain: {
          type: "string",
          description:
            "Deterministic rule-check domains (comma-separated, e.g. 'patent_novelty,patent_disclosure'). " +
            "Overrides the manifest default mapping; empty string disables the rule gate.",
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

      // 确定性规则门：对全部非降级阶段产出拼接文本评估（dual-track 的确定性轨）。
      const checkDomains = resolveCheckDomains(manifest, input.checkDomain);
      const checkSection = checkDomains.length > 0 ? runRuleGate(result, checkDomains) : "";

      return {
        content: [
          {
            type: "text",
            text: [
              `patent_workflow(${result.manifestId}): ${result.summary}`,
              ...lines,
              `完成状态: ${result.completed ? "completed" : "incomplete（有降级阶段）"}`,
              ...(checkSection !== "" ? [checkSection] : []),
            ].join("\n"),
          },
        ],
      };
    },
  };
}

/**
 * 执行确定性规则门：拼接非降级阶段产出 → defaultPatentRules 按域评估 → 聚合判级，
 * 返回 Markdown 报告片段（含判级结论行 + 失败明细表；全部通过时仅结论行）。
 */
export function runRuleGate(
  result: { stages: { degraded: boolean; output: string }[] },
  domains: readonly string[],
): string {
  const text = result.stages
    .filter(s => !s.degraded && s.output.trim().length > 0 && !s.output.startsWith("[WORKFLOW_DEGRADED]"))
    .map(s => s.output)
    .join("\n");
  const engine = new RuleEngine();
  engine.registerMany(defaultPatentRules());
  const failures = engine.evaluate(text, { domain: domains });
  const verdict = aggregate(failures);
  const summary = summarizeCheck(verdict, failures);
  return `${summary}\n${formatRuleResults(failures, verdict)}`;
}
