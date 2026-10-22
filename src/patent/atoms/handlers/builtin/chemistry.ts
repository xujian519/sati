/**
 * src/patent/atoms/handlers/builtin/chemistry — 化学结构识别原子。
 *
 * W-03：为 patent_drafting_v1 的 chemistry 阶段声明 atom，使化学领域交底书
 * 自动触发化学结构识别（SMILES/InChI/化学名/图像），无需主代理"记得"调用工具。
 *
 * 领域检测：文本含化学关键词（化学/SMILES/InChI/分子式/化合物等）时触发；
 * 非化学领域直接透传（返回空产物，不降级）。
 *
 * 降级策略：
 * - provider 缺失 → markDegraded（不阻断管线）
 * - 化学分析失败 → markDegraded + 保留原文
 */

import type { PipelineState, StageExecuteInput, StageHandler, StageProvider } from "../../handler.js";
import type { Atom } from "../../atom.js";
import {
  recognizeChemicalStructure,
  type ChemicalStructureResult,
  type ChemistryModelClient,
} from "../../../chemistry/index.js";
import type { CanonicalModelEvent, CanonicalModelRequest } from "../../../../model/index.js";
import { degraded, requireLlm, resolveInputText } from "./llm.js";

/** 化学领域关键词（命中任一即触发化学结构识别）。 */
const CHEMISTRY_KEYWORDS = [
  "化学",
  "化合物",
  "分子式",
  "SMILES",
  "InChI",
  "结构式",
  "化学式",
  "有机物",
  "无机物",
  "催化剂",
  "配体",
  "配位",
  "合成",
  "反应",
  "试剂",
  "溶剂",
  "聚合物",
  "单体",
  "共聚",
] as const;

/** 检测文本是否属于化学领域。 */
function isChemistryDomain(text: string): boolean {
  return CHEMISTRY_KEYWORDS.some(kw => text.includes(kw));
}

/**
 * 将 StageProvider.callLLM 适配为 ChemistryModelClient.stream。
 * chemistry 模块使用流式接口，而 StageProvider 使用同步 callLLM；
 * 此适配器将 callLLM 结果包装为单次 text_delta 事件。
 */
function adaptProviderToChemistryClient(provider: StageProvider): ChemistryModelClient {
  return {
    async *stream(request: CanonicalModelRequest, _signal?: AbortSignal): AsyncIterable<CanonicalModelEvent> {
      const prompt = request.messages[0]?.content?.[0]?.type === "text" ? request.messages[0].content[0].text : "";
      const result = await provider.callLLM!(prompt, {
        temperature: request.temperature,
      });
      yield { type: "text_delta", text: result } as CanonicalModelEvent;
    },
  };
}

/** chemistry-analyze 原子契约。 */
export const chemistryAnalyzeAtom: Atom = {
  name: "chemistry-analyze",
  description: "化学结构识别（SMILES/InChI/化学名/图像；非化学领域自动跳过）",
  category: "extract",
  inputSchema: ["text", "input"],
  outputSchema: ["chemistry_result", "chemistry_smiles", "chemistry_formula"],
};

/**
 * 化学结构识别处理器。
 *
 * 执行逻辑：
 * 1. 读取输入文本
 * 2. 检测是否化学领域（关键词匹配）；非化学 → 返回空产物（不降级）
 * 3. 化学领域 → 调用 recognizeChemicalStructure
 * 4. 成功 → 写入 chemistry_result / chemistry_smiles / chemistry_formula
 * 5. 失败 → 降级（degraded）+ 保留原文供后续阶段处理
 */
export class ChemistryAnalyzeHandler implements StageHandler {
  readonly name = "chemistry-analyze";
  readonly category = "extract" as const;

  async execute({ state, provider }: StageExecuteInput): Promise<PipelineState> {
    // 读取输入文本（优先 text/input 键）
    const text = resolveInputText(state, ["text", "input", "chemistry_input"], "text");
    if (text.trim().length === 0) {
      return degraded("chemistry-analyze", "输入文本为空");
    }

    // 非化学领域 → 跳过（不降级，返回空产物）
    if (!isChemistryDomain(text)) {
      return {
        chemistry_result: JSON.stringify({ skipped: true, reason: "非化学领域" }),
        chemistry_smiles: "",
        chemistry_formula: "",
      };
    }

    // provider 检查
    const llmMissing = requireLlm(provider, "chemistry-analyze");
    if (llmMissing !== null) {
      return llmMissing;
    }

    // 调用化学结构识别（适配 provider → ChemistryModelClient）
    try {
      const client = adaptProviderToChemistryClient(provider!);
      // recognizeChemicalStructure 要求 ChemicalImageInput 形状，但 text-only 场景
      // 仅需传 { text } 即可走文本分析路径（无 imageBase64 时跳过图像分析）。
      const result = await recognizeChemicalStructure(
        { text, imagePath: "", imageBase64: "", imageMimeType: "", imageBytes: 0 },
        client,
        {},
      );
      return formatChemistryResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return degraded("chemistry-analyze", `化学结构识别失败: ${message}`);
    }
  }
}

/** 格式化化学识别结果为 PipelineState。 */
function formatChemistryResult(result: ChemicalStructureResult): PipelineState {
  const chosen = result.chosenIndex >= 0 ? result.candidates[result.chosenIndex] : undefined;
  const smiles = chosen?.canonicalSmiles ?? chosen?.smiles ?? "";
  // formula 在 result 顶层（非 candidate），由 RDKit InChI 提取或文本模式候选。
  const formula = result.formula ?? "";

  return {
    chemistry_result: JSON.stringify({
      kind: result.kind,
      usable: result.usable,
      confidence: result.confidence,
      needHumanReview: result.needHumanReview,
      warnings: result.warnings,
      candidateCount: result.candidates.length,
    }),
    chemistry_smiles: smiles,
    chemistry_formula: formula,
  };
}
