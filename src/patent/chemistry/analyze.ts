/**
 * src/patent/chemistry — 化学式识别核心。
 *
 * 三路流程（对齐 src/patent/figure/analyze.ts 的模型调用与降级哲学）：
 * - 图片：两步 VLM（Step1 类型判定 → Step2 多候选 SMILES 提取）+ RDKit 校验选优；
 * - 名称：单步 VLM name→SMILES（H2 选 a）+ RDKit 校验；
 * - 文本：三级流水线（正则候选 → LLM 复核筛选/名称转换 → RDKit 校验）。
 *
 * 模型调用走 `SatiToolModelClient` 形状（stream 流式收集），JSON 输出采用
 * 提示词约束 + 容错解析 + 单次重试，解析仍失败时降级返回而非报错。
 * 防幻觉三重闭环（评审 H1）：RDKit 校验 + 多候选选优 + 低置信度/全部非法 →
 * needHumanReview=true 走 HITL。
 */

import type { CanonicalModelEvent, CanonicalModelRequest } from "../../model/index.js";
import { tryParseJson } from "../llm-json.js";
import {
  buildNameToSmilesPrompt,
  buildStep1Prompt,
  buildStep2Prompt,
  buildTextReviewPrompt,
  type Step1Result,
  type StructureResult,
  type TextReviewResult,
} from "./prompts.js";
import { validateSmiles, type SmilesValidationResult } from "./smiles.js";
import { extractChemicalCandidates, isValidHillFormula } from "./text.js";
import type { ChemicalKind, ChemicalSmilesCandidate, ChemicalStructureResult } from "./types.js";

/** 与 SatiToolModelClient 形状兼容的最小模型客户端（避免 patent 域依赖 tool 层）。 */
export type ChemistryModelClient = {
  stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent>;
};

/** 默认模型（moonshot/kimi-k3：多模态、1M 上下文；与 figure 模块一致）。 */
export const DEFAULT_CHEMISTRY_PROVIDER = "moonshot";
export const DEFAULT_CHEMISTRY_MODEL = "kimi-k3";

/** 可用性置信度门槛：低于此值进入人工复核。 */
export const CHEMISTRY_MIN_CONFIDENCE = 0.6;

export type ChemistryAnalyzerOptions = {
  provider?: string;
  model?: string;
  /** 单次模型调用最大输出 token。 */
  maxOutputTokens?: number;
  /** 采样温度。默认不传——由模型层 thinkingPlan 决定（kimi-k3 仅接受 temperature=1）。 */
  temperature?: number;
  /** 失败重试次数（默认 1）。 */
  maxRetries?: number;
  /** 取消信号（工具层透传 context.abortSignal）。 */
  signal?: AbortSignal;
};

/** 阶段标识（进入 buildRequest 的 metadata 供测试/追踪判别）。 */
export type ChemistryPhase = "step1" | "step2" | "name" | "review";

export type ChemicalImageInput = {
  /** 图片标识（仅用于结果回显；读图与预处理在调用方完成）。 */
  imagePath: string;
  /** 图片 base64。 */
  imageBase64: string;
  /** 图片 MIME 类型。 */
  imageMimeType: string;
  /** 图片字节数。 */
  imageBytes: number;
  /** 权利要求/技术方案上下文（图文对齐，可选）。 */
  claimContext?: string;
};

type BuildRequestOptions = {
  provider: string;
  model: string;
  maxOutputTokens: number;
  temperature: number | undefined;
  phase: ChemistryPhase;
};

function buildImageRequest(
  input: ChemicalImageInput,
  prompt: string,
  opts: BuildRequestOptions,
): CanonicalModelRequest {
  return {
    provider: opts.provider,
    model: opts.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image",
            source: "base64",
            data: input.imageBase64,
            mimeType: input.imageMimeType,
            bytes: input.imageBytes,
            detail: "auto",
          },
        ],
      },
    ],
    maxOutputTokens: opts.maxOutputTokens,
    temperature: opts.temperature,
    stream: true,
    metadata: { tool: "recognize_chemical_structure", phase: opts.phase },
  };
}

function buildTextRequest(prompt: string, opts: BuildRequestOptions): CanonicalModelRequest {
  return {
    provider: opts.provider,
    model: opts.model,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    maxOutputTokens: opts.maxOutputTokens,
    temperature: opts.temperature,
    stream: true,
    metadata: { tool: "recognize_chemical_structure", phase: opts.phase },
  };
}

/** 流式收集模型文本输出；错误事件转为 Error。 */
async function collectModelText(
  model: ChemistryModelClient,
  request: CanonicalModelRequest,
  signal: AbortSignal | undefined,
): Promise<string> {
  let text = "";
  for await (const event of model.stream(request, signal)) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;
      case "error":
        throw new Error(`模型调用失败: ${event.error?.message ?? "unknown"}`);
      default:
        break;
    }
  }
  return text.trim();
}

async function callPhase(
  model: ChemistryModelClient,
  request: CanonicalModelRequest,
  opts: { signal?: AbortSignal; maxRetries: number },
): Promise<{ ok: true; raw: string } | { ok: false; error: string }> {
  let lastError: string | undefined;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const raw = await collectModelText(model, request, opts.signal);
      if (tryParseJson(raw) !== undefined) return { ok: true, raw };
    } catch (error) {
      // 评审 M2：用户取消不应被视为失败并重试——直接终止本阶段
      if (opts.signal?.aborted) {
        return { ok: false, error: "模型调用已取消" };
      }
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, error: lastError ?? `模型未返回有效 JSON（尝试 ${opts.maxRetries + 1} 次）` };
}

// ---------------------------------------------------------------------------
// JSON 容错解析（字段级降级，与 figure parseStep1/parseStep2 同风格）
// ---------------------------------------------------------------------------

function parseStep1(raw: string): Step1Result | undefined {
  const parsed = tryParseJson(raw);
  if (!parsed) return undefined;
  const kind = typeof parsed.kind === "string" ? parsed.kind : null;
  return {
    is_chemical: parsed.is_chemical !== false,
    kind: kind === "formula" || kind === "structure" || kind === "markush" ? kind : null,
    overall_description: typeof parsed.overall_description === "string" ? parsed.overall_description : "",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    notes: Array.isArray(parsed.notes) ? parsed.notes.filter((n): n is string => typeof n === "string") : [],
  };
}

function parseStructureResult(raw: string): StructureResult | undefined {
  const parsed = tryParseJson(raw);
  if (!parsed || !Array.isArray(parsed.candidates)) return undefined;
  const kind = typeof parsed.kind === "string" ? parsed.kind : "structure";
  const candidates = parsed.candidates
    .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object")
    .map(c => ({
      smiles: typeof c.smiles === "string" ? c.smiles : null,
      confidence: typeof c.confidence === "number" ? c.confidence : 0,
    }))
    .filter(c => c.smiles !== null);
  return {
    kind: kind === "formula" || kind === "markush" ? kind : "structure",
    candidates,
    names: Array.isArray(parsed.names) ? parsed.names.filter((n): n is string => typeof n === "string") : [],
    formula: typeof parsed.formula === "string" ? parsed.formula : undefined,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((w): w is string => typeof w === "string") : [],
  };
}

function parseTextReview(raw: string): TextReviewResult | undefined {
  const parsed = tryParseJson(raw);
  if (!parsed) return undefined;
  const kind = typeof parsed.kind === "string" ? parsed.kind : "structure";
  const names = Array.isArray(parsed.names)
    ? parsed.names
        .filter((n): n is Record<string, unknown> => n !== null && typeof n === "object")
        .map(n => ({
          name: typeof n.name === "string" ? n.name : "",
          smiles: typeof n.smiles === "string" ? n.smiles : null,
          confidence: typeof n.confidence === "number" ? n.confidence : 0,
        }))
        .filter(n => n.name.length > 0)
    : [];
  return {
    kind: kind === "formula" || kind === "markush" ? kind : "structure",
    kept_formulas: Array.isArray(parsed.kept_formulas)
      ? parsed.kept_formulas.filter((f): f is string => typeof f === "string")
      : [],
    kept_smiles: Array.isArray(parsed.kept_smiles)
      ? parsed.kept_smiles.filter((s): s is string => typeof s === "string")
      : [],
    names,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((w): w is string => typeof w === "string") : [],
  };
}

// ---------------------------------------------------------------------------
// 候选处理（防幻觉闭环核心）
// ---------------------------------------------------------------------------

type ProcessedCandidates = {
  candidates: ChemicalSmilesCandidate[];
  chosenIndex: number;
  canonicalSmiles?: string;
  formula?: string;
  confidence: number;
  needHumanReview: boolean;
  usable: boolean;
  warnings: string[];
};

/** 逐条 RDKit 校验候选，在合法候选中取置信度最高者（评审 M1）；全非法/低置信度/降级 → 人工复核。 */
async function processCandidates(raw: Array<{ smiles: string; confidence: number }>): Promise<ProcessedCandidates> {
  const warnings: string[] = [];
  let degraded = false;

  const candidates: ChemicalSmilesCandidate[] = [];
  const validations: SmilesValidationResult[] = [];
  for (const { smiles, confidence } of raw) {
    const validation = await validateSmiles(smiles);
    if (validation.degraded) degraded = true;
    validations.push(validation);
    candidates.push({
      smiles,
      canonicalSmiles: validation.ok ? validation.canonicalSmiles : undefined,
      confidence,
      valid: validation.ok,
      validationError: validation.ok ? undefined : validation.error,
    });
  }

  // 评审 M1：不按模型输出顺序取首个合法者，而在合法候选中选置信度最高者
  let chosenIndex = -1;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate.valid) continue;
    if (chosenIndex < 0 || candidate.confidence > (candidates[chosenIndex]?.confidence ?? 0)) chosenIndex = i;
  }
  const chosen = chosenIndex >= 0 ? candidates[chosenIndex] : undefined;
  const confidence = chosen?.confidence ?? 0;
  const chosenFormula = chosenIndex >= 0 ? validations[chosenIndex]?.formula : undefined;

  if (degraded) {
    warnings.push("RDKit 不可用，SMILES 仅通过语法预检，结构合法性未验证");
  }
  if (chosenIndex < 0) {
    const errors = candidates.map(c => c.validationError ?? "未知错误").join("；");
    warnings.push(`全部候选未通过校验：${errors}`);
  } else if (confidence < CHEMISTRY_MIN_CONFIDENCE) {
    warnings.push(`选定候选置信度 ${confidence.toFixed(2)} 低于门槛 ${CHEMISTRY_MIN_CONFIDENCE}`);
  }
  for (const c of candidates) {
    if (!c.valid) {
      warnings.push(`候选 ${JSON.stringify(c.smiles.slice(0, 40))} 校验失败：${c.validationError ?? ""}`);
    }
  }

  const needHumanReview = chosenIndex < 0 || confidence < CHEMISTRY_MIN_CONFIDENCE || degraded;
  return {
    candidates,
    chosenIndex,
    canonicalSmiles: chosen?.canonicalSmiles,
    formula: chosenFormula,
    confidence,
    needHumanReview,
    usable: !needHumanReview,
    warnings,
  };
}

/** 图片两步法：Step1 类型判定 → Step2 多候选提取 + 校验。 */
export async function analyzeChemicalImage(
  input: ChemicalImageInput,
  model: ChemistryModelClient,
  opts: ChemistryAnalyzerOptions = {},
): Promise<ChemicalStructureResult> {
  const provider = opts.provider ?? DEFAULT_CHEMISTRY_PROVIDER;
  const modelId = opts.model ?? DEFAULT_CHEMISTRY_MODEL;
  const maxOutputTokens = opts.maxOutputTokens ?? 4000;
  const maxRetries = opts.maxRetries ?? 1;
  const signal = opts.signal;
  const temperature = opts.temperature;
  const warnings: string[] = [];

  const step1Call = await callPhase(
    model,
    buildImageRequest(input, buildStep1Prompt(input.claimContext), {
      provider,
      model: modelId,
      maxOutputTokens: 2000,
      temperature,
      phase: "step1",
    }),
    { signal, maxRetries },
  );

  let step1: Step1Result | undefined;
  if (step1Call.ok) {
    step1 = parseStep1(step1Call.raw);
    if (!step1) warnings.push("Step1 输出无法解析为有效 JSON，按化学结构图处理");
  } else {
    warnings.push(`Step1 判定失败：${step1Call.error}`);
  }
  const isChemical = step1 ? step1.is_chemical !== false && step1.kind !== null : true;
  if (step1 && step1.is_chemical === false) {
    warnings.push("Step1 判定图片非化学图示");
  }
  const kind: ChemicalKind = isChemical && step1?.kind ? step1.kind : "structure";

  const step2Call = await callPhase(
    model,
    buildImageRequest(input, buildStep2Prompt(step1?.overall_description ?? "", input.claimContext), {
      provider,
      model: modelId,
      maxOutputTokens,
      temperature,
      phase: "step2",
    }),
    { signal, maxRetries },
  );

  const modelUsed = `${provider}/${modelId}`;
  if (!step2Call.ok) {
    return {
      imagePath: input.imagePath,
      kind,
      candidates: [],
      chosenIndex: -1,
      names: [],
      confidence: step1?.confidence ?? 0,
      warnings: [...warnings, `Step2 分析失败：${step2Call.error}`],
      needHumanReview: true,
      usable: false,
      modelUsed,
    };
  }

  const step2 = parseStructureResult(step2Call.raw);
  if (!step2) {
    return {
      imagePath: input.imagePath,
      kind,
      candidates: [],
      chosenIndex: -1,
      names: [],
      confidence: step1?.confidence ?? 0,
      warnings: [...warnings, "Step2 输出无法解析为有效 JSON，识别结果为空"],
      needHumanReview: true,
      usable: false,
      modelUsed,
    };
  }
  warnings.push(...(step2.warnings ?? []));

  // 纯分子式图：无 SMILES 候选，公式字段须先过 Hill 记法校验（评审 H1）
  if (step2.kind === "formula" && step2.candidates.length === 0) {
    const formula = step2.formula?.trim();
    const formulaValid = Boolean(formula) && isValidHillFormula(formula as string);
    const confidence = step1?.confidence ?? 0;
    const usable = formulaValid && confidence >= CHEMISTRY_MIN_CONFIDENCE;
    const extraWarnings = usable
      ? []
      : formulaValid
        ? ["分子式置信度不足，需人工确认"]
        : [`分子式 ${JSON.stringify(formula ?? "")} 未通过 Hill 记法校验，需人工确认`];
    return {
      imagePath: input.imagePath,
      kind: "formula",
      candidates: [],
      chosenIndex: -1,
      formula: formulaValid ? formula : undefined,
      names: step2.names,
      confidence: formulaValid ? confidence : 0,
      warnings: [...warnings, ...extraWarnings],
      needHumanReview: !usable,
      usable,
      modelUsed,
    };
  }

  const processed = await processCandidates(
    step2.candidates.map(c => ({ smiles: c.smiles as string, confidence: c.confidence })),
  );
  return {
    imagePath: input.imagePath,
    kind: step2.kind,
    candidates: processed.candidates,
    chosenIndex: processed.chosenIndex,
    canonicalSmiles: processed.canonicalSmiles,
    formula: step2.formula ?? processed.formula,
    names: step2.names,
    confidence: processed.confidence,
    warnings: [...warnings, ...processed.warnings],
    needHumanReview: processed.needHumanReview,
    usable: processed.usable,
    modelUsed,
  };
}

/** 名称→SMILES 单步流（H2 选 a）+ RDKit 校验。 */
export async function analyzeChemicalName(
  name: string,
  model: ChemistryModelClient,
  opts: ChemistryAnalyzerOptions = {},
): Promise<ChemicalStructureResult> {
  const provider = opts.provider ?? DEFAULT_CHEMISTRY_PROVIDER;
  const modelId = opts.model ?? DEFAULT_CHEMISTRY_MODEL;
  const maxOutputTokens = opts.maxOutputTokens ?? 4000;
  const maxRetries = opts.maxRetries ?? 1;
  const modelUsed = `${provider}/${modelId}`;

  const call = await callPhase(
    model,
    buildTextRequest(buildNameToSmilesPrompt(name), {
      provider,
      model: modelId,
      maxOutputTokens,
      temperature: opts.temperature,
      phase: "name",
    }),
    { signal: opts.signal, maxRetries },
  );

  if (!call.ok) {
    return {
      sourceText: name,
      kind: "structure",
      candidates: [],
      chosenIndex: -1,
      names: [name],
      confidence: 0,
      warnings: [`名称转换失败：${call.error}`],
      needHumanReview: true,
      usable: false,
      modelUsed,
    };
  }

  const result = parseStructureResult(call.raw);
  if (!result) {
    return {
      sourceText: name,
      kind: "structure",
      candidates: [],
      chosenIndex: -1,
      names: [name],
      confidence: 0,
      warnings: ["名称转换输出无法解析为有效 JSON"],
      needHumanReview: true,
      usable: false,
      modelUsed,
    };
  }

  const processed = await processCandidates(
    result.candidates.map(c => ({ smiles: c.smiles as string, confidence: c.confidence })),
  );
  return {
    sourceText: name,
    kind: result.kind,
    candidates: processed.candidates,
    chosenIndex: processed.chosenIndex,
    canonicalSmiles: processed.canonicalSmiles,
    formula: result.formula ?? processed.formula,
    names: result.names.length > 0 ? result.names : [name],
    confidence: processed.confidence,
    warnings: [...(result.warnings ?? []), ...processed.warnings],
    needHumanReview: processed.needHumanReview,
    usable: processed.usable,
    modelUsed,
  };
}

/** 文本三级流水线：正则候选 → LLM 复核/名称转换 → RDKit 校验。 */
export async function analyzeChemicalText(
  text: string,
  model: ChemistryModelClient,
  opts: ChemistryAnalyzerOptions = {},
): Promise<ChemicalStructureResult> {
  const provider = opts.provider ?? DEFAULT_CHEMISTRY_PROVIDER;
  const modelId = opts.model ?? DEFAULT_CHEMISTRY_MODEL;
  const maxOutputTokens = opts.maxOutputTokens ?? 4000;
  const maxRetries = opts.maxRetries ?? 1;
  const modelUsed = `${provider}/${modelId}`;

  const { formulas, smilesTokens } = extractChemicalCandidates(text);
  const call = await callPhase(
    model,
    buildTextRequest(buildTextReviewPrompt(text, formulas, smilesTokens), {
      provider,
      model: modelId,
      maxOutputTokens,
      temperature: opts.temperature,
      phase: "review",
    }),
    { signal: opts.signal, maxRetries },
  );

  const warnings: string[] = [];
  if (!call.ok) {
    // 降级：无 LLM 复核时仅用正则候选（语法预检后返回），需人工复核
    const fallbackCandidates = smilesTokens.map((smiles, index) => ({
      smiles,
      confidence: Math.max(0.5 - index * 0.1, 0),
    }));
    const processed = await processCandidates(fallbackCandidates);
    return {
      sourceText: text.slice(0, 2000),
      kind: fallbackCandidates.length > 0 ? "structure" : "formula",
      candidates: processed.candidates,
      chosenIndex: processed.chosenIndex,
      canonicalSmiles: processed.canonicalSmiles,
      formula: formulas[0],
      names: [],
      confidence: processed.confidence,
      warnings: [...warnings, `LLM 复核失败，降级为仅正则候选：${call.error}`, ...processed.warnings],
      needHumanReview: true,
      usable: false,
      modelUsed,
    };
  }

  const review = parseTextReview(call.raw);
  if (!review) {
    return {
      sourceText: text.slice(0, 2000),
      kind: "structure",
      candidates: [],
      chosenIndex: -1,
      names: [],
      confidence: 0,
      warnings: [...warnings, "文本复核输出无法解析为有效 JSON"],
      needHumanReview: true,
      usable: false,
      modelUsed,
    };
  }
  warnings.push(...(review.warnings ?? []));

  // 组装候选：LLM 保留的 SMILES + 名称转换的 SMILES（去重）
  const seen = new Set<string>();
  const rawCandidates: Array<{ smiles: string; confidence: number }> = [];
  for (const smiles of review.kept_smiles) {
    const s = smiles.trim();
    if (s.length > 0 && !seen.has(s)) {
      seen.add(s);
      // 评审 M6：正则召回候选的置信度压线 0.6 会绕过阈值防线——降为 0.5 强制进入人工复核
      rawCandidates.push({ smiles: s, confidence: 0.5 });
    }
  }
  for (const n of review.names) {
    if (n.smiles && n.smiles.trim().length > 0 && !seen.has(n.smiles)) {
      seen.add(n.smiles);
      rawCandidates.push({ smiles: n.smiles, confidence: n.confidence });
    }
  }

  // 纯分子式文本：无 SMILES 候选时采用公式字段——须先过 Hill 记法校验（评审 H1）
  if (rawCandidates.length === 0 && review.kept_formulas.length > 0) {
    const formula = review.kept_formulas[0];
    const formulaValid = isValidHillFormula(formula);
    return {
      sourceText: text.slice(0, 2000),
      kind: "formula",
      candidates: [],
      chosenIndex: -1,
      formula: formulaValid ? formula : undefined,
      names: review.names.map(n => n.name),
      confidence: formulaValid ? 0.8 : 0,
      warnings: formulaValid
        ? warnings
        : [...warnings, `分子式 ${JSON.stringify(formula)} 未通过 Hill 记法校验，需人工确认`],
      needHumanReview: !formulaValid,
      usable: formulaValid,
      modelUsed,
    };
  }

  if (rawCandidates.length === 0) {
    return {
      sourceText: text.slice(0, 2000),
      kind: review.kind,
      candidates: [],
      chosenIndex: -1,
      names: review.names.map(n => n.name),
      formula: review.kept_formulas[0],
      confidence: 0,
      warnings: [...warnings, "未提取到任何 SMILES 或分子式候选"],
      needHumanReview: true,
      usable: false,
      modelUsed,
    };
  }

  const processed = await processCandidates(rawCandidates);
  return {
    sourceText: text.slice(0, 2000),
    kind: review.kind,
    candidates: processed.candidates,
    chosenIndex: processed.chosenIndex,
    canonicalSmiles: processed.canonicalSmiles,
    formula: review.kept_formulas[0] ?? processed.formula,
    names: review.names.map(n => n.name),
    confidence: processed.confidence,
    warnings: [...warnings, ...processed.warnings],
    needHumanReview: processed.needHumanReview,
    usable: processed.usable,
    modelUsed,
  };
}

/** 统一入口：按输入类型分派（text/name → 文本流；image → 两步流）。 */
export async function recognizeChemicalStructure(
  input: ChemicalImageInput & { text?: string },
  model: ChemistryModelClient,
  opts: ChemistryAnalyzerOptions = {},
): Promise<ChemicalStructureResult> {
  if (input.text !== undefined && input.text.trim().length > 0 && !input.imageBase64) {
    // 单行化合物名称（无空格/换行且不含正则候选）走名称转换，其余走文档文本流
    const trimmed = input.text.trim();
    const { formulas, smilesTokens } = extractChemicalCandidates(trimmed);
    const looksLikeSingleName = !/[\s\n，。；、]/.test(trimmed) && formulas.length === 0 && smilesTokens.length === 0;
    return looksLikeSingleName
      ? analyzeChemicalName(trimmed, model, opts)
      : analyzeChemicalText(input.text, model, opts);
  }
  return analyzeChemicalImage(input, model, opts);
}
