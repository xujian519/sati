/**
 * src/patent/figure — 附图智能分析核心。
 *
 * 两步法（PatentVision 图文对齐 + PatentLMM 领域引导的工程实现）：
 *   Step1 附图类型分类 + 整体理解（低风险先做，失败可降级）
 *   Step2 组件/连接/标记结构化提取 + 附图说明生成
 *
 * 模型调用走 `SatiToolModelClient` 形状（stream 流式收集），JSON 输出采用
 * 提示词约束 + 容错解析 + 单次重试，解析仍失败时降级返回而非报错。
 */

import type { CanonicalModelEvent, CanonicalModelRequest } from "../../model/index.js";
import { tryParseJson } from "../llm-json.js";
import { buildStep1Prompt, buildStep2Prompt, type Step1Result, type Step2Result } from "./prompts.js";
import {
  FIGURE_TYPE_NAMES,
  normalizeComponentKind,
  normalizeConnectionKind,
  normalizeFigureType,
  type FigureAnalysisResult,
  type FigureComponent,
  type FigureConnection,
  type FigureType,
} from "./types.js";

/** 与 SatiToolModelClient 形状兼容的最小模型客户端（避免 patent 域依赖 tool 层）。 */
export type FigureModelClient = {
  stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent>;
};

/** 默认模型（moonshot/kimi-k3：多模态、1M 上下文；sati.yaml 已配置 moonshot provider）。 */
export const DEFAULT_FIGURE_PROVIDER = "moonshot";
export const DEFAULT_FIGURE_MODEL = "kimi-k3";

export type FigureAnalyzerOptions = {
  provider?: string;
  model?: string;
  /** 单次模型调用最大输出 token。 */
  maxOutputTokens?: number;
  /**
   * 采样温度。默认不传（undefined）——由模型层 thinkingPlan 决定：
   * kimi-k3 等 thinking 模型仅接受 temperature=1，Sati 模型层会 omitTemperature。
   */
  temperature?: number;
  /** 失败重试次数（默认 1）。 */
  maxRetries?: number;
  /** 取消信号（工具层透传 context.abortSignal）。 */
  signal?: AbortSignal;
};

export type AnalyzePatentFigureInput = {
  /** 图片标识（仅用于结果回显；读图与预处理在调用方完成，见 preprocess.ts）。 */
  imagePath: string;
  /** 图片 base64。 */
  imageBase64: string;
  /** 图片 MIME 类型。 */
  imageMimeType: string;
  /** 图片字节数。 */
  imageBytes: number;
  /** 附图编号。 */
  figureNumber?: number;
  /** 权利要求/技术方案上下文（图文对齐，可选）。 */
  claimContext?: string;
  /** 发明名称（附图说明模板用，可选）。 */
  inventionName?: string;
};

/** 步骤标识（两步法；进入 buildRequest 的 metadata 供测试/追踪判别）。 */
export type FigureAnalysisPhase = "step1" | "step2";

/** Step1（分类）输出 token 预算：thinking 模型需为思考过程预留，800 会导致输出为空。 */
const STEP1_MAX_OUTPUT_TOKENS = 2000;

type RequestBuildOptions = {
  provider: string;
  model: string;
  maxOutputTokens: number;
  temperature: number | undefined;
  phase: FigureAnalysisPhase;
};

function buildRequest(
  input: AnalyzePatentFigureInput,
  prompt: string,
  opts: RequestBuildOptions,
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
    metadata: { tool: "analyze_patent_figure", phase: opts.phase },
  };
}

/** 流式收集模型文本输出；错误事件转为 Error。 */
async function collectModelText(
  model: FigureModelClient,
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

/** JSON 容错解析已收敛至 ../llm-json.js（tryParseJson），与 atoms 层共用。 */

async function callStep(
  model: FigureModelClient,
  input: AnalyzePatentFigureInput,
  prompt: string,
  maxOutputTokens: number,
  opts: {
    provider: string;
    modelId: string;
    temperature: number | undefined;
    signal?: AbortSignal;
    maxRetries: number;
    phase: FigureAnalysisPhase;
  },
): Promise<{ ok: true; raw: string } | { ok: false; error: string }> {
  const request = buildRequest(input, prompt, {
    provider: opts.provider,
    model: opts.modelId,
    maxOutputTokens,
    temperature: opts.temperature,
    phase: opts.phase,
  });
  let lastError: string | undefined;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const raw = await collectModelText(model, request, opts.signal);
      if (tryParseJson(raw) !== undefined) return { ok: true, raw };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, error: lastError ?? `模型未返回有效 JSON（尝试 ${opts.maxRetries + 1} 次）` };
}

function parseStep1(raw: string): Step1Result | undefined {
  const parsed = tryParseJson(raw);
  if (!parsed) return undefined;
  const result: Step1Result = {
    figure_type: typeof parsed.figure_type === "string" ? parsed.figure_type : "unknown",
    overall_description: typeof parsed.overall_description === "string" ? parsed.overall_description : "",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
  };
  if (Array.isArray(parsed.notes)) {
    result.notes = parsed.notes.filter((n): n is string => typeof n === "string");
  }
  return result;
}

function parseStep2(raw: string): Step2Result | undefined {
  const parsed = tryParseJson(raw);
  if (!parsed || !Array.isArray(parsed.components)) return undefined;
  const components: Step2Result["components"] = parsed.components
    .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object")
    .map(c => ({
      ref_number: typeof c.ref_number === "string" ? c.ref_number : String(c.ref_number ?? "U0"),
      name: typeof c.name === "string" ? c.name : "未命名部件",
      kind: typeof c.kind === "string" ? c.kind : "unknown",
      description: typeof c.description === "string" ? c.description : "",
    }));
  const connections: Step2Result["connections"] = Array.isArray(parsed.connections)
    ? parsed.connections
        .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object")
        .map(c => ({
          source: String(c.source ?? ""),
          target: String(c.target ?? ""),
          kind: typeof c.kind === "string" ? c.kind : "unknown",
          description: typeof c.description === "string" ? c.description : "",
        }))
    : [];
  const warnings: string[] = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === "string")
    : [];
  return {
    components,
    connections,
    figure_description: typeof parsed.figure_description === "string" ? parsed.figure_description : "",
    warnings,
  };
}

/** 规范化组件（枚举校验、空标号过滤）。 */
function normalizeComponents(raw: Step2Result["components"]): FigureComponent[] {
  const seen = new Set<string>();
  const components: FigureComponent[] = [];
  for (const c of raw) {
    const refNumber = c.ref_number.trim();
    if (!refNumber || seen.has(refNumber)) continue;
    seen.add(refNumber);
    components.push({
      refNumber,
      name: c.name.trim() || "未命名部件",
      kind: normalizeComponentKind(c.kind),
      description: (c.description ?? "").trim(),
    });
  }
  return components;
}

/** 规范化连接（过滤空端点与未知组件引用）。 */
function normalizeConnections(raw: Step2Result["connections"], refNumbers: Set<string>): FigureConnection[] {
  return raw
    .map(c => ({
      source: c.source.trim(),
      target: c.target.trim(),
      kind: normalizeConnectionKind(c.kind),
      description: (c.description ?? "").trim(),
    }))
    .filter(c => c.source !== "" && c.target !== "" && refNumbers.has(c.source) && refNumbers.has(c.target));
}

/** 附图说明兜底模板（模型未生成时确定性生成）。 */
export function buildFigureDescription(
  figureNumber: number,
  figureType: FigureType,
  inventionName: string | undefined,
  components: FigureComponent[],
): string {
  const typeName = FIGURE_TYPE_NAMES[figureType];
  const title = (inventionName ?? "装置").trim() || "装置";
  if (components.length === 0) {
    return `图${figureNumber}是本发明实施例提供的${title}的${typeName}。`;
  }
  const lines = [`图${figureNumber}是本发明实施例提供的${title}的${typeName}；`, "图中："];
  for (const c of components) {
    lines.push(`${c.refNumber}-${c.name}；`);
  }
  return lines.join("\n");
}

/** 检查标号连续性/异常，返回警告。 */
function checkReferenceNumbers(components: FigureComponent[]): string[] {
  const warnings: string[] = [];
  const numbers = components
    .map(c => c.refNumber)
    .filter(n => /^\d+$/.test(n))
    .map(Number)
    .sort((a, b) => a - b);
  if (numbers.length === 0) return warnings;
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] !== numbers[i - 1] + 1) {
      warnings.push(`附图标记可能不连续：${numbers[i - 1]} 后为 ${numbers[i]}`);
      break;
    }
  }
  return warnings;
}

/**
 * 执行附图智能分析（两步法）。
 *
 * 任一步模型调用失败均降级返回（figureType/组件为空 + warnings 说明原因），
 * 不抛出——供上层决定是否人工处理。
 */
export async function analyzePatentFigure(
  input: AnalyzePatentFigureInput,
  model: FigureModelClient,
  opts: FigureAnalyzerOptions = {},
): Promise<FigureAnalysisResult> {
  const provider = opts.provider ?? DEFAULT_FIGURE_PROVIDER;
  const modelId = opts.model ?? DEFAULT_FIGURE_MODEL;
  const maxOutputTokens = opts.maxOutputTokens ?? 4000;
  const maxRetries = opts.maxRetries ?? 1;
  const figureNumber = input.figureNumber ?? 1;
  const signal = opts.signal;
  const temperature = opts.temperature;

  // ---- Step1：分类 + 整体理解 ----
  const step1Prompt = buildStep1Prompt(figureNumber, input.claimContext);
  const step1Call = await callStep(model, input, step1Prompt, STEP1_MAX_OUTPUT_TOKENS, {
    provider,
    modelId,
    temperature,
    signal,
    maxRetries,
    phase: "step1",
  });

  let figureType: FigureType = "unknown";
  let overallDescription = "";
  // confidence 仅描述"附图类型分类"的置信度；0.5 表示分类未评估（Step1 失败），
  // 与组件提取的可用性（usable）解耦。
  let confidence = 0.5;
  let warnings: string[] = [];

  if (step1Call.ok) {
    const step1 = parseStep1(step1Call.raw);
    if (step1) {
      figureType = normalizeFigureType(step1.figure_type);
      overallDescription = step1.overall_description;
      confidence = Math.max(0, Math.min(1, step1.confidence || 0));
      warnings = step1.notes ?? [];
    } else {
      warnings.push("Step1 输出无法解析为有效 JSON，附图类型按 unknown 处理，分类置信度未评估");
    }
  } else {
    warnings.push(`Step1 分类失败（置信度未评估）：${step1Call.error}`);
  }

  // ---- Step2：组件/连接/标记 + 附图说明 ----
  let components: FigureComponent[] = [];
  let connections: FigureConnection[] = [];
  let figureDescription = "";

  const step2Prompt = buildStep2Prompt(figureNumber, figureType, overallDescription, input.claimContext);
  const step2Call = await callStep(model, input, step2Prompt, maxOutputTokens, {
    provider,
    modelId,
    temperature,
    signal,
    maxRetries,
    phase: "step2",
  });

  if (step2Call.ok) {
    const step2 = parseStep2(step2Call.raw);
    if (step2) {
      components = normalizeComponents(step2.components);
      const refNumbers = new Set(components.map(c => c.refNumber));
      connections = normalizeConnections(step2.connections, refNumbers);
      figureDescription = step2.figure_description.trim();
      warnings.push(...(step2.warnings ?? []));
      warnings.push(...checkReferenceNumbers(components));
    } else {
      warnings.push("Step2 输出无法解析为有效 JSON，组件提取结果为空");
    }
  } else {
    warnings.push(`Step2 分析失败：${step2Call.error}`);
  }

  if (!figureDescription) {
    figureDescription = buildFigureDescription(figureNumber, figureType, input.inventionName, components);
  }

  // ---- 确定性收尾 ----
  const uniqueWarnings = [...new Set(warnings.filter(w => w.length > 0))];
  // usable 仅反映"组件提取是否成功"（与分类置信度解耦）；分类失败时 confidence 为 0.5 中性值。
  const usable = components.length > 0;

  return {
    imagePath: input.imagePath,
    figureNumber,
    figureType,
    overallDescription,
    components,
    connections,
    figureDescription,
    confidence,
    warnings: uniqueWarnings,
    usable,
    // provider键/model键（非 Sati 会话展示用的 alias 格式，如 moonshotai/kimi-k3）。
    modelUsed: `${provider}/${modelId}`,
  };
}
