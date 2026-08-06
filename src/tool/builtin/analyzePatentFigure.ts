/**
 * src/tool/builtin/analyzePatentFigure — analyze_patent_figure 工具。
 *
 * 专利附图智能分析：读取工作区内的附图图片，经多模态模型（默认 kimi-k3，
 * 可配置）两步分析——附图类型分类/整体理解 → 组件/连接/附图标记提取 +
 * 附图说明生成（专利格式）。输出结构化结果供撰写（draft_specification 的
 * drawing_descriptions）与校验（附图标记一致性）管线消费。
 *
 * 方法依据：PatentVision（图文对齐）与 PatentLMM（附图领域引导）论文，
 * 见 src/patent/figure/prompts.ts 的说明。
 */

import { analyzePatentFigure, DEFAULT_FIGURE_MODEL, DEFAULT_FIGURE_PROVIDER } from "../../patent/figure/analyze.js";
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
    title: "Analyze Patent Figure",
    description:
      "分析专利说明书附图：识别附图类型（结构图/流程图/电路图/方框图/示意图/分解图/剖视图）、提取组件与连接关系、" +
      "核对附图标记并生成专利格式的附图说明文字。当用户提供附图图片并要求撰写附图说明、理解附图内容、" +
      "核对附图标记一致性时使用。可传入权利要求或技术方案文本作为上下文提升识别准确率。",
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

      return {
        content: [{ type: "json", value: result }],
        data: result,
        metadata: {
          domain: "patent",
          figureType: result.figureType,
          componentCount: result.components.length,
          usable: result.usable,
        },
      };
    },
  };
}
