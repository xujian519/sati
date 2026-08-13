/**
 * claim-chart 原子：权利要求要素级证据网格构建。
 *
 * 流程：LLM 产出要素拆分 + 逐行映射 → element-validator / mapping-machine /
 * pin-cite-validator（源文可读时）三关校验 → 非法打回重做（≤2 次，重做
 * prompt 附校验错误清单）→ gap 检测 → caseId 可用时落盘 json+md。
 */

import { readFileSync } from "node:fs";
import { type Atom } from "../../atom.js";
import { type PipelineState, type StageExecuteInput, type StageHandler, getStateString } from "../../handler.js";
import {
  DRAFT_NOTICE,
  type ChartMode,
  type ChartRow,
  type ChartTarget,
  type ClaimChart,
  type ClaimElement,
} from "../../../claim-chart/protocol/types.js";
import { validateElements } from "../../../claim-chart/runtime/element-validator.js";
import { validateRowMapping } from "../../../claim-chart/runtime/mapping-machine.js";
import { detectGaps } from "../../../claim-chart/runtime/gap-detector.js";
import { validatePinCite, verifyQuoteInSource } from "../../../claim-chart/runtime/pin-cite-validator.js";
import { loadClaimChart, saveClaimChart } from "../../../claim-chart/runtime/store.js";
import { callLlm, degraded, parseLlmJson, requireLlm, resolveInputText } from "./llm.js";

export const claimChartAtom: Atom = {
  name: "claim-chart",
  description: "权利要求要素级证据网格：要素编号 + 逐要素映射 + pin-cite + gap 检测",
  category: "compare",
  inputSchema: ["claim", "chart_targets", "chart_mode"],
  outputSchema: ["claim_chart_doc", "gap_list"],
};

const CHART_MODES: readonly string[] = ["infringement", "invalidity", "oa-response", "reexamination", "patentability"];
const ELEMENT_KINDS: readonly string[] = [
  "preamble",
  "transitional",
  "limitation",
  "means-plus-function",
  "markush-member",
];
const MAPPINGS: readonly string[] = [
  "literal",
  "literal-construction-dependent",
  "doe",
  "anticipation",
  "obviousness-combination",
  "partial",
  "not-found",
  "needs-evidence",
  "construction-dependent",
];

const CHART_SCHEMA = {
  type: "object",
  properties: {
    elements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "要素编号，如 1a/1b（数字+小写字母）" },
          claimNo: { type: "number", description: "权利要求序号" },
          text: { type: "string", description: "要素原文（必须为权利要求原文的连续子串，逐字引用）" },
          kind: { type: "string", enum: ELEMENT_KINDS },
        },
        required: ["id", "claimNo", "text", "kind"],
      },
    },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          elementId: { type: "string" },
          targetId: { type: "string" },
          quote: { type: "string", description: "目标对象对应内容的逐字引用（未找到时为空串）" },
          pinCite: { type: "string", description: "位置引用，格式 [D1 段[0032] 图3]" },
          mapping: { type: "string", enum: MAPPINGS },
        },
        required: ["elementId", "targetId", "quote", "pinCite", "mapping"],
      },
    },
  },
  required: ["elements", "rows"],
} as const;

const MAX_RETRIES = 2;

type TargetsParseResult = { targets: ChartTarget[]; error: string | null };

/** 解析目标对象列表：损坏 JSON / 非数组时给出可操作的错误（而非静默当空处理）。 */
function parseTargets(raw: string): TargetsParseResult {
  if (raw.trim().length === 0) return { targets: [], error: null };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { targets: parsed as ChartTarget[], error: null };
    return { targets: [], error: "输入 chart_targets 不是数组" };
  } catch {
    return { targets: [], error: "输入 chart_targets JSON 解析失败" };
  }
}

/**
 * 字段级形状防御：LLM 输出 malformed（缺字段 / 类型错误 / null 项）时返回
 * 错误清单，让非法输出回到打回重做路径，而不是在校验器内 TypeError 崩溃
 * （element-validator 的 stripWhitespace、mapping-machine 的 mapping 访问等）。
 */
function checkChartShape(elements: unknown[], rows: unknown[]): string[] {
  const errors: string[] = [];
  elements.forEach((el, i) => {
    if (el === null || typeof el !== "object" || Array.isArray(el)) {
      errors.push(`要素[${i}] 不是对象`);
      return;
    }
    const e = el as Record<string, unknown>;
    if (typeof e.id !== "string") errors.push(`要素[${i}] 缺少 id`);
    if (typeof e.claimNo !== "number") errors.push(`要素[${i}] 缺少 claimNo`);
    if (typeof e.text !== "string") errors.push(`要素[${i}] 缺少 text`);
    if (typeof e.kind !== "string") errors.push(`要素[${i}] 缺少 kind`);
  });
  rows.forEach((row, i) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      errors.push(`行[${i}] 不是对象`);
      return;
    }
    const r = row as Record<string, unknown>;
    if (typeof r.elementId !== "string") errors.push(`行[${i}] 缺少 elementId`);
    if (typeof r.targetId !== "string") errors.push(`行[${i}] 缺少 targetId`);
    if (typeof r.quote !== "string") errors.push(`行[${i}] 缺少 quote`);
    if (typeof r.pinCite !== "string") errors.push(`行[${i}] 缺少 pinCite`);
    if (typeof r.mapping !== "string") errors.push(`行[${i}] 缺少 mapping`);
  });
  return errors;
}

/**
 * 三关校验：返回错误列表（空 = 全部通过）。sourceText 经 sourceCache 提供
 * （execute 内预读一次，重做 attempt 间复用），读取失败统一报"源文件不可读"。
 */
function validateChart(
  elements: ClaimElement[],
  rows: ChartRow[],
  targets: ChartTarget[],
  mode: ChartMode,
  claim: string,
  sourceCache: Map<string, string>,
): string[] {
  const errors: string[] = [];
  errors.push(...checkChartShape(elements, rows));
  if (errors.length > 0) return errors; // 形状非法：跳过语义校验（避免二次崩溃），回到打回重做
  const elResult = validateElements(elements, claim);
  if (!elResult.ok) errors.push(...elResult.errors);
  const targetById = new Map(targets.map(t => [t.id, t]));
  for (const row of rows) {
    errors.push(...validateRowMapping(row, targetById.get(row.targetId), mode));
    const target = targetById.get(row.targetId);
    if (target?.sourcePath) {
      const sourceText = sourceCache.get(target.sourcePath);
      if (sourceText === undefined) {
        errors.push(`行 [${row.elementId}→${row.targetId}] 源文件不可读: ${target.sourcePath}`);
        continue;
      }
      const pin = validatePinCite(row.pinCite, sourceText);
      if (!pin.ok) errors.push(`行 [${row.elementId}→${row.targetId}] ${pin.reason}`);
      const quote = verifyQuoteInSource(row.quote, sourceText);
      if (!quote.ok) errors.push(`行 [${row.elementId}→${row.targetId}] ${quote.reason}`);
    }
  }
  return errors;
}

export class ClaimChartHandler implements StageHandler {
  readonly name = "claim-chart";
  readonly category = "compare" as const;

  async execute({ state, provider }: StageExecuteInput): Promise<PipelineState> {
    const missing = requireLlm(provider, "claim-chart");
    if (missing) return missing;
    const claim = resolveInputText(state, ["claim", "claim_text"], "");
    if (claim.trim().length === 0) {
      return degraded("claim-chart", "权利要求为空");
    }
    const targetsRes = parseTargets(getStateString(state, "chart_targets"));
    if (targetsRes.error) return degraded("claim-chart", targetsRes.error);
    const targets = targetsRes.targets;
    const modeRaw = getStateString(state, "chart_mode") || "invalidity";
    const mode = (CHART_MODES.includes(modeRaw) ? modeRaw : "invalidity") as ChartMode;

    // 预读目标源文件一次（重做 attempt 间复用，避免循环内重复 I/O）；
    // 读取失败不缓存，由 validateChart 对引用该源的每行报"源文件不可读"。
    const sourceCache = new Map<string, string>();
    for (const t of targets) {
      if (!t.sourcePath) continue;
      try {
        sourceCache.set(t.sourcePath, readFileSync(t.sourcePath, "utf8"));
      } catch {
        // 源文件不可读：留空缓存，错误归因下沉到行级校验
      }
    }

    const targetLines =
      targets.length === 0
        ? "（无目标对象 —— 只拆分要素，逐行映射留待后续补充）"
        : targets
            .map(
              t =>
                `- ${t.id || "(未命名目标)"}（${t.kind === "prior-art" ? "对比文件" : "被控产品"}${
                  t.title ? `：${t.title}` : ""
                }）`,
            )
            .join("\n");
    const basePrompt = [
      "你是专利权利要求分析专家。把权利要求拆分为编号要素，并逐要素映射到目标对象。",
      "",
      "【权利要求】",
      "```",
      claim.slice(0, 8000),
      "```",
      "",
      "【目标对象】",
      targetLines,
      "",
      "要求：",
      "- 要素编号为 数字+小写字母（1a/1b/1c…），按顺序连续",
      "- 要素 text 必须为权利要求原文的连续子串（逐字引用，不得改写）",
      "- 每个要素对每个目标产出一行：quote 为目标对象对应内容的逐字引用（未找到/证据不足时为空串）",
      "- pinCite 格式 [D1 段[0032] 图3]；mapping 取值：literal（字面对应）/literal-construction-dependent/doe（等同，仅侵权）/anticipation（单篇公开，仅对比文件）/obviousness-combination（组合公开，仅对比文件）/partial/not-found/needs-evidence/construction-dependent",
      `- 场景模式：${mode}`,
      "",
      "请严格输出 JSON。",
    ].join("\n");

    let prompt = basePrompt;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const res = await callLlm(provider, "claim-chart", prompt, { schema: CHART_SCHEMA, temperature: 0.1 });
      if (!res.ok) return res.error;
      const parsed = parseLlmJson(
        res.raw,
        (obj, raw) => {
          if (!Array.isArray(obj.elements) || !Array.isArray(obj.rows)) return null;
          return { elements: obj.elements as ClaimElement[], rows: obj.rows as ChartRow[], raw };
        },
        raw => ({ elements: [], rows: [], raw }),
      );
      const elements = parsed.elements as ClaimElement[];
      const rows = parsed.rows as ChartRow[];
      const errors = validateChart(elements, rows, targets, mode, claim, sourceCache);
      if (errors.length === 0) {
        const gaps = detectGaps(rows);
        const existing = provider?.caseId ? loadClaimChart(provider.caseId, "chart-1") : null;
        const verifiedById = new Map(
          (existing?.rows ?? []).filter(r => r.verified).map(r => [`${r.elementId}→${r.targetId}`, true]),
        );
        for (const row of rows) {
          row.state = row.mapping;
          row.verified = verifiedById.has(`${row.elementId}→${row.targetId}`);
        }
        const chart: ClaimChart = {
          chartId: "chart-1",
          mode,
          caseId: provider?.caseId ?? "",
          elements,
          claimNos: [...new Set(elements.map(el => el.claimNo))].sort((a, b) => a - b),
          targets,
          rows,
          gaps,
          draftNotice: DRAFT_NOTICE,
        };
        if (provider?.caseId) saveClaimChart(chart, provider.caseId);
        return {
          claim_chart_doc: JSON.stringify(chart, null, 2),
          gap_list: JSON.stringify(chart.gaps),
        };
      }
      if (attempt >= MAX_RETRIES) {
        return degraded("claim-chart", `校验失败且重做超限（${MAX_RETRIES} 次）: ${errors.slice(0, 5).join("；")}`);
      }
      prompt = `${basePrompt}\n\n【上一轮输出校验失败，请修正后重新输出】\n${errors.map(e => `- ${e}`).join("\n")}`;
    }
    // 理论上不可达（循环内每个 attempt 均已 return），保留作防御性兜底
    return degraded("claim-chart", "重做循环异常退出");
  }
}
