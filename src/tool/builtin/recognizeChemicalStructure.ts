/**
 * src/tool/builtin/recognizeChemicalStructure — recognize_chemical_structure 工具。
 *
 * 化学式识别：读取工作区内的化学结构图（图片模式，经多模态模型两步分析）或
 * 文档文本（文本模式，三级流水线：正则候选 → LLM 复核/名称转换 → RDKit 校验），
 * 输出多候选 SMILES + RDKit 校验结果，供撰写/校验管线消费。
 *
 * 防幻觉闭环（评审 H1）：候选逐条经 RDKit 校验取首个合法者；全部非法或置信度
 * 不足时 needHumanReview=true，上层进入人工确认而非直接采信。
 *
 * PDF 前置（G4）：本工具不直接解析 PDF——图片模式输入须为附件解析层已导出的
 * 图片（jpeg/png/gif/webp）；文本模式可传 PDF 文本层提取结果。
 *
 * 识别成功后结果自动写入化学索引（.sati/chemistry-index.json）；索引写入失败
 * 不影响结果返回（索引为可选增强），plan 只读模式下不写盘。
 */

import { createHash } from "node:crypto";
import {
  analyzeChemicalImage,
  DEFAULT_CHEMISTRY_MODEL,
  DEFAULT_CHEMISTRY_PROVIDER,
  recognizeChemicalStructure,
  type ChemicalStructureResult,
} from "../../patent/chemistry/index.js";
import { DEFAULT_CHEMISTRY_INDEX_RELATIVE_PATH, upsertChemistryIndex } from "../../patent/chemistry/index-store.js";
import { loadFigureImage } from "../../patent/figure/preprocess.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition } from "../protocol/types.js";
import { resolveSatiWorkspacePath } from "./filesystem/pathSafety.js";

export type RecognizeChemicalStructureMode = "image" | "text" | "auto";

export type RecognizeChemicalStructureInput = {
  /** 化学结构图图片路径（工作区相对或绝对路径；PDF 页请先经附件解析导出图片）。 */
  image_path?: string;
  /** 文档文本（说明书/权利要求片段；或单独的化合物名称）。 */
  text?: string;
  /** 识别模式：image 走图片两步法；text 走文本三级流水线；auto 按输入分派（默认）。 */
  mode?: RecognizeChemicalStructureMode;
  /** 权利要求/技术方案上下文（图文对齐，可选）。 */
  claim_context?: string;
};

export type RecognizeChemicalStructureOutput = ChemicalStructureResult;

export type CreateRecognizeChemicalStructureToolOptions = {
  /** 模型 provider（默认 moonshot）。 */
  provider?: string;
  /** 多模态模型（默认 kimi-k3）。 */
  model?: string;
  /** 图片字节预算（默认 5 MiB）。 */
  maxImageBytes?: number;
};

/** 文本来源索引键：text:<sha256 前缀>。 */
function textSourceKey(text: string): string {
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  return `text:${hash}`;
}

export function createRecognizeChemicalStructureTool(
  options: CreateRecognizeChemicalStructureToolOptions = {},
): SatiToolDefinition<RecognizeChemicalStructureInput, RecognizeChemicalStructureOutput> {
  const provider = options.provider ?? DEFAULT_CHEMISTRY_PROVIDER;
  const model = options.model ?? DEFAULT_CHEMISTRY_MODEL;
  const maxImageBytes = options.maxImageBytes;

  return {
    name: "recognize_chemical_structure",
    title: "Recognize Chemical Structure",
    description:
      "识别化学式/化学结构：从化学结构图（图片模式，多模态模型两步分析 + RDKit 校验）或文档文本（文本模式，" +
      "正则候选 → LLM 复核/化合物名称转 SMILES → RDKit 校验）中提取多候选 SMILES、分子式与化合物名称。" +
      "当交底书/说明书/权利要求含化学结构式（含 Markush 广义结构）、分子式或化合物名称需要转 SMILES 时使用。" +
      "注意：本工具不直接解析 PDF——图片模式输入须为已导出的图片（jpeg/png/gif/webp），文本模式可传 PDF 文本层提取结果。" +
      "识别结果自动写入化学索引（.sati/chemistry-index.json）；结果含 needHumanReview 标记时需人工确认后再采信。",
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        image_path: {
          type: "string",
          description: "化学结构图图片路径（工作区相对或绝对路径，支持 jpg/png/gif/webp；PDF 页请先导出为图片）",
        },
        text: {
          type: "string",
          description: "文档文本片段（说明书/权利要求）或单独的化合物名称（name→SMILES）",
        },
        mode: {
          type: "string",
          enum: ["image", "text", "auto"],
          description: "识别模式：image 走图片两步法；text 走文本三级流水线；auto 按输入分派（默认）",
        },
        claim_context: {
          type: "string",
          description: "权利要求或技术方案文本（图文对齐，可提高识别准确率）",
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
              text: "错误：当前运行环境未注入模型客户端（recognize_chemical_structure 需要多模态模型），无法执行化学式识别。",
            },
          ],
          metadata: { error: "unsupported_tool", hint: "model_client_missing" },
        };
      }

      const mode: RecognizeChemicalStructureMode = input.mode ?? (input.image_path ? "image" : "text");
      if (mode === "image" && !input.image_path) {
        throw new SatiToolRuntimeError("invalid_tool_input", "image 模式必须提供 image_path。");
      }
      if (mode === "text" && !input.text?.trim()) {
        throw new SatiToolRuntimeError("invalid_tool_input", "text 模式必须提供非空 text。");
      }

      let result: ChemicalStructureResult;
      let sourceKey: string;

      if (mode === "image") {
        const resolved = resolveSatiWorkspacePath(input.image_path as string, context, { mustExist: true });
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
        result = await analyzeChemicalImage(
          {
            imagePath: resolved.relativePath,
            imageBase64: prepared.buffer.toString("base64"),
            imageMimeType: prepared.mimeType,
            imageBytes: prepared.bytes,
            claimContext: input.claim_context,
          },
          modelClient,
          { provider, model, signal: context.abortSignal },
        );
        sourceKey = resolved.relativePath;
      } else {
        const text = input.text as string;
        // auto 模式下带 image_path 且 text 同时存在时以图片为准（上方已按 image 分支处理）
        result = await recognizeChemicalStructure(
          { text, imagePath: "", imageBase64: "", imageMimeType: "", imageBytes: 0 },
          modelClient,
          { provider, model, signal: context.abortSignal },
        );
        sourceKey = textSourceKey(text);
      }

      // 识别结果自动写入化学索引（供后续检索/校验管线消费）。
      // 索引为可选增强：写入失败静默降级，不阻断识别结果返回。
      // plan 只读模式下不写盘：工具声明 isReadOnly，plan 模式对只读工具自动
      // 放行，索引写入会静默绕过只读约束，故显式门控。
      let indexed = false;
      try {
        const indexPath = resolveSatiWorkspacePath(DEFAULT_CHEMISTRY_INDEX_RELATIVE_PATH, context, { forWrite: true });
        if (indexPath.ok && context.permissionContext?.mode !== "plan") {
          await upsertChemistryIndex(indexPath.absolutePath, {
            sourceKey,
            analyzedAt: (context.now?.() ?? new Date()).toISOString(),
            analysis: result,
          });
          indexed = true;
        }
      } catch {
        indexed = false;
      }

      return {
        content: [{ type: "json", value: result }],
        data: result,
        metadata: {
          domain: "patent",
          mode,
          kind: result.kind,
          usable: result.usable,
          needHumanReview: result.needHumanReview,
          chosenIndex: result.chosenIndex,
          indexed,
        },
      };
    },
  };
}
