/**
 * src/tool/builtin/analyzePatentFigure — analyze_patent_figure 工具。
 *
 * 专利附图智能分析：读取工作区内的附图图片，经多模态模型（默认 kimi-k3，
 * 可配置）两步分析——附图类型分类/整体理解 → 组件/连接/附图标记提取 +
 * 附图说明生成（专利格式）。输出结构化结果供撰写（draft_specification 的
 * drawing_descriptions）与校验（附图标记一致性）管线消费。
 *
 * 分析成功后结果自动写入附图索引（.sati/figures-index.json），供
 * search_patent_figure 检索；索引写入失败不影响分析结果返回（索引为可选增强）。
 *
 * 方法依据：PatentVision（图文对齐）与 PatentLMM（附图领域引导）论文，
 * 见 src/patent/figure/prompts.ts 的说明。
 */

import { supportsInputModality } from "../../model/protocol/multimodal.js";
import { analyzePatentFigure, DEFAULT_FIGURE_MODEL, DEFAULT_FIGURE_PROVIDER } from "../../patent/figure/analyze.js";
import { analysisToFigureSpec } from "../../patent/figure/bridge.js";
import { checkFigures } from "../../patent/figuregen/check.js";
import type { FigureCheckRuleId } from "../../patent/figuregen/check.js";
import { DEFAULT_FIGURE_INDEX_RELATIVE_PATH, upsertFigureIndex } from "../../patent/figure/index-store.js";
import { loadFigureImage } from "../../patent/figure/preprocess.js";
import type { FigureAnalysisResult } from "../../patent/figure/types.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition } from "../protocol/types.js";
import { resolveSatiWorkspacePath } from "./filesystem/pathSafety.js";

export type AnalyzePatentFigureInput = {
  /** 附图图片路径（工作区相对或绝对路径）。 */
  image_path: string;
  /** 附图编号（默认 1，用于附图说明"图N"）。 */
  figure_number?: number;
  /** 权利要求/技术方案上下文（图文对齐，提高识别准确率，可选）。 */
  claim_context?: string;
  /** 发明名称（附图说明模板用，可选）。 */
  invention_name?: string;
};

export type AnalyzePatentFigureOutput = FigureAnalysisResult;

/** 文字面核验只会用到这些规则（其余规则对"单图分析结果"无意义或不可归因，见下）。 */
const TEXT_FACE_RULES: readonly FigureCheckRuleId[] = ["V2", "V3", "V4", "V5"];

/**
 * 分析结果 → 无几何 FigureSpec 骨架 → 文字面确定性核验（细则第 21 条）。
 *
 * 价值：栅格图（客户扫描件 / CAD 导出 / 他人绘制的图）此前只能得到模型判断，
 * 进不了规则核验轨；经骨架转换后可与 `claim_context` 做确定性的图文标记对齐。
 *
 * 只用文字面规则、且**只作提示**：`skipLayoutRules` 跳过 V7（画幅与字号由原图决定，
 * 用本模块布局结果判属错误归因）；V1 图号连续性/摘要附图属图集级判定，单图分析下
 * 无意义；核验发现不改变结构化输出（`data`），仅追加一段文本供调用方决策。
 */
function buildTextFaceAdvisory(result: FigureAnalysisResult, claimContext?: string): string[] {
  if (claimContext === undefined || claimContext.trim().length === 0) return [];
  const skeleton = analysisToFigureSpec(result);
  if (skeleton === undefined) return [];
  const findings = checkFigures([skeleton], claimContext, { skipLayoutRules: true }).findings.filter(finding =>
    TEXT_FACE_RULES.includes(finding.rule),
  );
  const header =
    `图文标记核验（分析结果 ↔ claim_context；仅文字面规则，图幅/图集级规则不适用）：` +
    (findings.length === 0 ? "无发现" : `${findings.length} 条待确认`);
  return [
    header,
    ...findings.map(
      finding =>
        `- [${finding.severity.toUpperCase()}] ${finding.rule}: ${finding.message}` +
        (finding.evidence ? `\n  ${finding.evidence.join("\n  ")}` : ""),
    ),
  ];
}

export type CreateAnalyzePatentFigureToolOptions = {
  /** 模型 provider（默认 moonshot）。 */
  provider?: string;
  /** 多模态模型（默认 kimi-k3）。 */
  model?: string;
  /** 图片字节预算（默认 5 MiB）。 */
  maxImageBytes?: number;
};

export function createAnalyzePatentFigureTool(
  options: CreateAnalyzePatentFigureToolOptions = {},
): SatiToolDefinition<AnalyzePatentFigureInput, AnalyzePatentFigureOutput> {
  const provider = options.provider ?? DEFAULT_FIGURE_PROVIDER;
  const model = options.model ?? DEFAULT_FIGURE_MODEL;
  const maxImageBytes = options.maxImageBytes;

  return {
    name: "analyze_patent_figure",
    outputSchema: {
      type: "object",
      required: ["figureType", "usable", "components", "warnings"],
      properties: {
        figureType: { type: "string" },
        usable: { type: "boolean" },
        components: { type: "array" },
        warnings: { type: "array" },
      },
    },
    title: "Analyze Patent Figure",
    description:
      "分析专利说明书附图：识别附图类型（结构图/流程图/电路图/方框图/示意图/分解图/剖视图）、提取组件与连接关系、" +
      "核对附图标记并生成专利格式的附图说明文字。当用户提供附图图片并要求撰写附图说明、理解附图内容、" +
      "核对附图标记一致性时使用。可传入权利要求或技术方案文本作为上下文提升识别准确率。" +
      "分析结果自动写入附图索引（.sati/figures-index.json）供 search_patent_figure 检索；plan 只读模式下不写盘。",
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      required: ["image_path"],
      additionalProperties: false,
      properties: {
        image_path: {
          type: "string",
          description: "附图图片路径（工作区相对或绝对路径，支持 jpg/png/gif/webp）",
        },
        figure_number: {
          type: "number",
          description: "附图编号（默认 1，用于附图说明“图N”）",
        },
        claim_context: {
          type: "string",
          description: "权利要求或技术方案文本（图文对齐，可显著提高组件识别准确率）",
        },
        invention_name: {
          type: "string",
          description: "发明名称（用于附图说明模板，如“一种供热管道电位采集装置”）",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const modelClient = context.model;
      if (!modelClient) {
        return {
          content: [
            {
              type: "text",
              text: "错误：当前运行环境未注入模型客户端（analyze_patent_figure 需要多模态模型），无法执行附图分析。",
            },
          ],
          metadata: { error: "unsupported_tool", hint: "model_client_missing" },
        };
      }

      // 阶段四 T3：模态门禁——模型显式声明且不含 image 时提前拒绝并点名模型，
      // 避免读图/解码后才发现模型不可用（fail-loud 优先于静默降级）。
      // modelMultimodal 未注入（未知能力）时不拦截，保持原有行为。
      // 判定复用 supportsInputModality（与 assertInputModality 同一事实源）；
      // 此处返回结构化错误结果而非抛错，保持工具层「输入级拒绝返回结果」惯例。
      if (context.modelMultimodal !== undefined && !supportsInputModality(context.modelMultimodal, "image")) {
        return {
          content: [
            {
              type: "text",
              text: "错误：当前模型不支持图片输入（analyze_patent_figure 需要多模态视觉模型）。请在模型配置中切换到支持视觉的模型后重试。",
            },
          ],
          metadata: { error: "unsupported_tool", hint: "model_not_vision_capable" },
        };
      }

      const resolved = resolveSatiWorkspacePath(input.image_path, context, { mustExist: true });
      if (!resolved.ok) {
        throw new SatiToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
      }

      let prepared: Awaited<ReturnType<typeof loadFigureImage>>;
      try {
        prepared = await loadFigureImage(resolved.absolutePath, maxImageBytes);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new SatiToolRuntimeError("invalid_tool_input", message);
      }

      const result = await analyzePatentFigure(
        {
          imagePath: resolved.relativePath,
          imageBase64: prepared.buffer.toString("base64"),
          imageMimeType: prepared.mimeType,
          imageBytes: prepared.bytes,
          figureNumber: input.figure_number,
          claimContext: input.claim_context,
          inventionName: input.invention_name,
        },
        modelClient,
        { provider, model, signal: context.abortSignal },
      );

      // 分析结果自动写入附图索引（供 search_patent_figure 检索）。
      // 索引为可选增强：写入失败静默降级，不阻断分析结果返回。
      // plan 只读模式下不写盘：工具声明 isReadOnly，plan 模式对只读工具自动
      // 放行，索引写入会静默绕过只读约束，故显式门控。
      let indexed = false;
      try {
        const indexPath = resolveSatiWorkspacePath(DEFAULT_FIGURE_INDEX_RELATIVE_PATH, context, { forWrite: true });
        if (indexPath.ok && context.permissionContext?.mode !== "plan") {
          await upsertFigureIndex(indexPath.absolutePath, {
            imagePath: result.imagePath,
            analyzedAt: (context.now?.() ?? new Date()).toISOString(),
            analysis: result,
          });
          indexed = true;
        }
      } catch {
        // 索引写入失败 → indexed=false，仅标记未入索引，不影响本次分析结果。
        indexed = false;
      }

      const advisory = buildTextFaceAdvisory(result, input.claim_context);
      return {
        content: [
          { type: "json", value: result },
          ...(advisory.length === 0 ? [] : [{ type: "text" as const, text: advisory.join("\n") }]),
        ],
        data: result,
        metadata: {
          domain: "patent",
          figureType: result.figureType,
          componentCount: result.components.length,
          usable: result.usable,
          indexed,
          modelUsed: result.modelUsed,
          imageBytes: prepared.bytes,
          visionWarnings: result.warnings.length,
        },
      };
    },
  };
}
