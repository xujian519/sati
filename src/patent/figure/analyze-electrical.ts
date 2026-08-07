/**
 * src/patent/figure — 电学深度分析（Step3）。
 *
 * 对判定为 circuit/schematic 的附图做符号级深度分析：
 *   Step3a 提示词注入电学符号知识库（GB/T 4728 简化，symbols/loader.ts）
 *   Step3b 多模态模型结构化提取：元件（符号/类别/参数/引脚）+ 网络（nets）+ 网表
 *   Step3c 确定性校验（validator.ts，对标 chemistry/RDKit 防幻觉闭环）
 *
 * 与 analyze.ts 的 FigureModelClient 形状兼容（结构类型），自包含实现
 * 流式收集，避免与 analyze.ts 形成循环依赖。
 */

import type { CanonicalModelEvent, CanonicalModelRequest } from "../../model/index.js";
import { tryParseJson } from "../llm-json.js";
import { buildStep3Prompt, type Step3Result } from "./prompts.js";
import {
  normalizeElectricalCategory,
  type ElectricalAnalysis,
  type ElectricalComponent,
  type ElectricalNet,
} from "./types.js";
import { validateElectricalAnalysis } from "./validator.js";

/** 默认模型（与 analyze.ts 保持一致：moonshot/kimi-k3 多模态）。 */
export const DEFAULT_FIGURE_PROVIDER = "moonshot";
export const DEFAULT_FIGURE_MODEL = "kimi-k3";

/** 与 SatiToolModelClient 形状兼容的最小模型客户端（结构类型，与 analyze.ts 互兼容）。 */
export type FigureModelClient = {
  stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent>;
};

export type AnalyzeElectricalInput = {
  /** 图片标识（仅用于结果回显）。 */
  imagePath: string;
  /** 图片 base64。 */
  imageBase64: string;
  /** 图片 MIME 类型。 */
  imageMimeType: string;
  /** 图片字节数。 */
  imageBytes: number;
  /** 附图编号。 */
  figureNumber: number;
  /** Step1 整体描述（提示词上下文）。 */
  overallDescription: string;
  /** 权利要求/技术方案上下文（图文对齐，可选）。 */
  claimContext?: string;
};

export type AnalyzeElectricalOptions = {
  provider?: string;
  model?: string;
  maxOutputTokens?: number;
  temperature?: number | undefined;
  maxRetries?: number;
  signal?: AbortSignal;
};

/** Step3 输出 token 预算（thinking 模型需预留思考空间）。 */
const STEP3_MAX_OUTPUT_TOKENS = 4000;

function buildRequest(
  input: AnalyzeElectricalInput,
  prompt: string,
  opts: { provider: string; model: string; maxOutputTokens: number; temperature: number | undefined },
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
    metadata: { tool: "analyze_patent_figure", phase: "step3" },
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

/** 解析 Step3 JSON（容错：字段缺省/类型错误取安全默认值）。 */
function parseStep3(raw: string): Step3Result | undefined {
  const parsed = tryParseJson(raw);
  if (!parsed || !Array.isArray(parsed.electrical_components)) return undefined;

  const components: Step3Result["electrical_components"] = parsed.electrical_components
    .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object")
    .map(c => ({
      ref: typeof c.ref === "string" ? c.ref : "",
      symbol: typeof c.symbol === "string" ? c.symbol : "unknown",
      category: typeof c.category === "string" ? c.category : "unknown",
      name: typeof c.name === "string" ? c.name : "未知元件",
      value: typeof c.value === "string" ? c.value : undefined,
      terminal_count: typeof c.terminal_count === "number" ? c.terminal_count : undefined,
    }));

  const nets: Step3Result["nets"] = Array.isArray(parsed.nets)
    ? parsed.nets
        .filter((n): n is Record<string, unknown> => n !== null && typeof n === "object")
        .map(n => ({
          name: typeof n.name === "string" ? n.name : "",
          connected_refs: Array.isArray(n.connected_refs)
            ? n.connected_refs.filter((r): r is string => typeof r === "string")
            : [],
        }))
    : [];

  return {
    electrical_components: components,
    nets,
    netlist: typeof parsed.netlist === "string" ? parsed.netlist : undefined,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((w): w is string => typeof w === "string") : [],
  };
}

/** 规范化元件（去重、标号统一大写、枚举校验）。 */
function normalizeComponents(raw: Step3Result["electrical_components"]): ElectricalComponent[] {
  const seen = new Set<string>();
  const components: ElectricalComponent[] = [];
  for (const c of raw) {
    const ref = c.ref.trim().toUpperCase();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    components.push({
      ref,
      symbol: c.symbol.trim() || "unknown",
      category: normalizeElectricalCategory(c.category),
      name: c.name.trim() || "未知元件",
      value: c.value && c.value.trim().length > 0 ? c.value.trim() : undefined,
      terminalCount: c.terminal_count,
    });
  }
  return components;
}

/** 规范化网络（去重、空引用过滤）。 */
function normalizeNets(raw: Step3Result["nets"]): ElectricalNet[] {
  const seen = new Set<string>();
  const nets: ElectricalNet[] = [];
  for (const n of raw) {
    const name = n.name.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const refs = [...new Set(n.connected_refs.map(r => r.trim()).filter(r => r.length > 0))];
    nets.push({ name, connectedRefs: refs });
  }
  return nets;
}

/**
 * 执行电学深度分析（Step3）。
 *
 * 模型调用失败/JSON 解析失败均降级返回（analysis 为空 + warnings 说明），
 * 不抛出——由 analyze.ts 决定整体 usable 判定（Step3 失败不回归 Step1/2 结果）。
 */
export async function analyzeElectricalFigure(
  input: AnalyzeElectricalInput,
  model: FigureModelClient,
  opts: AnalyzeElectricalOptions = {},
): Promise<{ analysis?: ElectricalAnalysis; warnings: string[] }> {
  const provider = opts.provider ?? DEFAULT_FIGURE_PROVIDER;
  const modelId = opts.model ?? DEFAULT_FIGURE_MODEL;
  const maxOutputTokens = opts.maxOutputTokens ?? STEP3_MAX_OUTPUT_TOKENS;
  const maxRetries = opts.maxRetries ?? 1;
  const signal = opts.signal;
  const temperature = opts.temperature;

  const prompt = buildStep3Prompt(input.figureNumber, input.overallDescription, input.claimContext);
  const request = buildRequest(input, prompt, { provider, model: modelId, maxOutputTokens, temperature });

  let raw: string | undefined;
  let lastError: string | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const text = await collectModelText(model, request, signal);
      if (tryParseJson(text) !== undefined) {
        raw = text;
        break;
      }
      lastError = `模型未返回有效 JSON（尝试 ${attempt + 1}/${maxRetries + 1}）`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  if (raw === undefined) {
    return { warnings: [`Step3 电学深度分析失败：${lastError ?? "unknown"}`] };
  }

  const step3 = parseStep3(raw);
  if (!step3) {
    return { warnings: ["Step3 输出无法解析为有效 JSON，电学分析结果为空"] };
  }

  const analysis: ElectricalAnalysis = {
    components: normalizeComponents(step3.electrical_components),
    nets: normalizeNets(step3.nets),
    ...(step3.netlist && step3.netlist.trim().length > 0 ? { netlist: step3.netlist.trim() } : {}),
  };

  const validation = validateElectricalAnalysis(analysis, input.claimContext);
  const warnings = [...new Set([...(step3.warnings ?? []), ...validation.warnings])];
  return { analysis, warnings };
}
