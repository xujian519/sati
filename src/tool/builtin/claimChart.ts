/**
 * claim_chart_build 工具：权利要求要素级证据网格构建（domain: patent）。
 *
 * 复用 ClaimChartHandler（原子）作为唯一实现 —— 工具层只做输入装配
 * （StageProvider 委托模型客户端，对齐 buildWorkflowProvider 模式）。
 */

import { ClaimChartHandler, type StageProvider } from "../../patent/atoms/index.js";
import type { ChartMode, ChartTarget, ClaimChart } from "../../patent/claim-chart/protocol/types.js";
import { DEFAULT_MODEL_ID, DEFAULT_MODEL_PROVIDER, type CanonicalModelRequest } from "../../model/index.js";
import type { SatiToolDefinition, SatiToolModelClient, SatiToolRuntimeContext } from "../protocol/types.js";

export type ClaimChartTargetInput = {
  id: string;
  kind: "prior-art" | "accused-product";
  title?: string;
  source_path?: string;
};

export type ClaimChartInput = {
  mode: ChartMode;
  claim_text: string;
  targets: ClaimChartTargetInput[];
  case_id?: string;
};

export type ClaimChartOutput = {
  chart: ClaimChart;
  json_path?: string;
  md_path?: string;
  gap_count: number;
};

export type ClaimChartBuildResult =
  | { ok: true; chart: ClaimChart; jsonPath?: string; mdPath?: string }
  | { ok: false; error: string };

/** 收集 stream 事件为完整文本（对齐 buildWorkflowProvider/collectModelText 模式）。 */
async function collectModelText(model: SatiToolModelClient, request: CanonicalModelRequest): Promise<string> {
  let text = "";
  for await (const event of model.stream(request)) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;
      case "error":
        throw new Error(`模型调用失败: ${event.error.message}`);
      default:
        break;
    }
  }
  return text;
}

/**
 * 纯函数入口（可测试）：装配 StageProvider → ClaimChartHandler.execute。
 * llm 参数缺省由工具层从 context.model 装配（见 createClaimChartTool）。
 */
export async function claimChartBuild(
  input: ClaimChartInput,
  llm: { callLLM?: StageProvider["callLLM"] },
): Promise<ClaimChartBuildResult> {
  if (input.claim_text.trim().length === 0) {
    return { ok: false, error: "claim_text 为空" };
  }
  if (!llm.callLLM) {
    return { ok: false, error: "未配置 LLM（模型客户端缺失），无法执行要素拆分与映射" };
  }
  const targets: ChartTarget[] = input.targets.map(t => ({
    id: t.id,
    kind: t.kind,
    title: t.title,
    sourcePath: t.source_path,
  }));
  const provider: StageProvider = {
    caseId: input.case_id,
    callLLM: llm.callLLM,
  };
  const handler = new ClaimChartHandler();
  const state = await handler.execute({
    state: {
      claim: input.claim_text,
      chart_targets: JSON.stringify(targets),
      chart_mode: input.mode,
    },
    provider,
  });
  if (typeof state._error === "string") {
    return { ok: false, error: state._error };
  }
  const doc = typeof state.claim_chart_doc === "string" ? state.claim_chart_doc : "{}";
  const chart = JSON.parse(doc) as ClaimChart;
  // 落盘路径透出（handler 在 caseId 存在时写 claim_chart_paths；无 caseId 不写该键）。
  const rawPaths = typeof state.claim_chart_paths === "string" ? state.claim_chart_paths : undefined;
  const paths = rawPaths !== undefined ? (JSON.parse(rawPaths) as { jsonPath: string; mdPath: string }) : undefined;
  return { ok: true, chart, jsonPath: paths?.jsonPath, mdPath: paths?.mdPath };
}

export function createClaimChartTool(): SatiToolDefinition<ClaimChartInput, ClaimChartOutput> {
  return {
    name: "claim_chart_build",
    title: "Build Patent Claim Chart",
    description:
      "构建权利要求对照表（claim chart）：把权利要求拆分为编号要素，逐要素映射到对比文件或产品证据（每行 pin-cite 引用），并输出 gap list（证据薄弱的要素）。适用于撰写（可专利性布局）、OA 答复、无效/复审、侵权比对等场景。",
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: {
          type: "string",
          enum: ["infringement", "invalidity", "oa-response", "reexamination", "patentability"],
          description:
            "场景模式：infringement=侵权（被控产品，支持 doe）/invalidity=无效/oa-response=审查意见答复/reexamination=复审/patentability=撰写前可专利性",
        },
        claim_text: { type: "string", description: "权利要求原文（需拆分的权利要求，可含多条）" },
        targets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", description: "目标标识，如 D1/D2/产品A" },
              kind: { type: "string", enum: ["prior-art", "accused-product"] },
              title: { type: "string", description: "目标名称（可选）" },
              source_path: { type: "string", description: "目标全文文件路径（提供时启用 pin-cite 与引用存在性校验）" },
            },
            required: ["id", "kind"],
          },
          description: "映射目标列表（对比文件/被控产品材料）",
        },
        case_id: { type: "string", description: "案卷 ID（提供时结果落盘 data/cases/<case_id>/outputs/）" },
      },
      required: ["mode", "claim_text", "targets"],
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context: SatiToolRuntimeContext) => {
      const model = context.model;
      const llm: { callLLM?: StageProvider["callLLM"] } = {};
      if (model) {
        llm.callLLM = async (prompt, opts) => {
          const outputSchema =
            opts?.jsonSchema !== undefined && typeof opts.jsonSchema === "object" && opts.jsonSchema !== null
              ? { name: "structured_output", schema: opts.jsonSchema as Record<string, unknown>, strict: true }
              : undefined;
          const request: CanonicalModelRequest = {
            provider: DEFAULT_MODEL_PROVIDER,
            model: DEFAULT_MODEL_ID,
            messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
            maxOutputTokens: 16000,
            temperature: opts?.temperature ?? 0,
            stream: true,
            ...(outputSchema !== undefined ? { outputSchema } : {}),
          };
          return collectModelText(model, request);
        };
      }
      const result = await claimChartBuild(input, llm);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `claim_chart_build 失败：${result.error}` }],
          metadata: { error: "claim_chart_build_failed" },
        };
      }
      const output: ClaimChartOutput = {
        chart: result.chart,
        json_path: result.jsonPath,
        md_path: result.mdPath,
        gap_count: result.chart.gaps.length,
      };
      return {
        content: [
          {
            type: "json",
            value: {
              mode: result.chart.mode,
              claim_nos: result.chart.claimNos,
              gap_count: result.chart.gaps.length,
              gaps: result.chart.gaps,
            },
          },
          // 落盘路径透出（对齐 patent_workflow 的"持久化: <路径>"惯例；无 caseId 时不加该行）。
          ...(result.jsonPath !== undefined && result.mdPath !== undefined
            ? [{ type: "text" as const, text: `落盘: ${result.jsonPath} + ${result.mdPath}` }]
            : []),
        ],
        data: output,
      };
    },
  };
}
