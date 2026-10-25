/**
 * src/patent/workflow — 一致性回退信号判定（纯函数）。
 *
 * 从 workflow.ts 拆出（A7 轮次 2）：信号正则编译/缓存 + 触发判定，
 * 独立可单测（否定词窗口、句界排除、g-flag lastIndex 重置语义锁定）。
 *
 * #734：`needsRedo` 是 manifest 与 graph 两条路径的**唯一**触发判定。
 * 结构化判据（严格 JSON 的 `gaps[]` / `consistent`）优先，正则仅兼容兜底；
 * 只声明结构化判据且输出不可解析时返回 `undefined`，调用方须写降级标记，
 * 不得静默当作「不需要回退」。
 */

import type { WorkflowStage } from "./types.js";

/** 否定词窗口（匹配位置前 12 字符）。 */
const NEGATION_WINDOW = 12;
const NEGATION_PATTERN = /[不未无没]/;

/** 结构化判据命中 JSON 的 `consistent:false` 时，`matchSignal` 的匹配样本。 */
const CONSISTENT_FALSE_MATCH = "consistent:false";

export type SignalMatch = {
  /** 命中的信号样本（用于审计/缺口 id 推导）。 */
  matched: string;
};

/**
 * 信号触发判定：匹配位置前窗口内出现否定词（不/未/无/没，无句界分隔）
 * 时视为否定性表述（"未发现不一致""不缺少任何特征"），不触发回退。
 *
 * JSON 感知（2026-08 修复）：输出为 JSON 对象且含布尔 consistent 字段时，
 * 以机器可读判据为准——consistent:false 直接命中回退（绕开否定词窗口对
 * issues 文案措辞的误判，如"无效果关联，孤立"中"孤立"前窗口含"无"），
 * consistent:true 不命中；非 JSON / 无该字段回退关键词扫描。
 */
export function matchSignal(text: string, signal: RegExp): SignalMatch | undefined {
  const consistent = tryParseConsistentField(text);
  if (consistent !== undefined) {
    return consistent ? undefined : { matched: CONSISTENT_FALSE_MATCH };
  }
  let match: RegExpExecArray | null;
  signal.lastIndex = 0; // 带 g 标志的正则跨调用保留 lastIndex：回退重入前必须重置，否则 exec 直接返回 null
  while ((match = signal.exec(text)) !== null) {
    const start = Math.max(0, match.index - NEGATION_WINDOW);
    const before = text.slice(start, match.index);
    if (!before.includes("。") && !before.includes("；") && !before.includes(";") && !NEGATION_PATTERN.test(before)) {
      return { matched: match[0] };
    }
    if (match[0].length === 0) signal.lastIndex += 1;
  }
  return undefined;
}

/** 布尔包装（既有单测与调用方语义不变）。 */
export function signalMatches(text: string, signal: RegExp): boolean {
  return matchSignal(text, signal) !== undefined;
}

type StructuredSignal = {
  /** 输出是否声明了 `gaps` 数组。 */
  hasGaps: boolean;
  /** gaps 条目数（含缺 id 的条目）。 */
  gapCount: number;
  /** gaps[].id（缺 id 时用 `gaps[i]` 占位，保证与条目一一对应）。 */
  gapIds: string[];
  /** `consistent` 布尔字段；缺省表示未声明。 */
  consistent?: boolean;
};

/** 严格 JSON 对象 → 结构化判据；非严格 JSON / 两个字段都缺 → undefined。 */
function parseStructuredSignal(text: string): StructuredSignal | undefined {
  const parsed = tryParseJsonObject(text);
  if (parsed === undefined) return undefined;
  const rawGaps = parsed.gaps;
  const hasGaps = Array.isArray(rawGaps);
  const gapIds = hasGaps
    ? rawGaps.map((gap, index) => {
        if (gap !== null && typeof gap === "object" && !Array.isArray(gap)) {
          const id = (gap as Record<string, unknown>).id;
          if (typeof id === "string" && id.trim().length > 0) return id;
        }
        return `gaps[${index}]`;
      })
    : [];
  const consistent = typeof parsed.consistent === "boolean" ? parsed.consistent : undefined;
  if (!hasGaps && consistent === undefined) return undefined;
  return {
    hasGaps,
    gapCount: hasGaps ? rawGaps.length : 0,
    gapIds,
    ...(consistent !== undefined ? { consistent } : {}),
  };
}

/** 尝试从输出文本解析 consistent 布尔字段（严格 JSON 对象；非布尔/解析失败返回 undefined）。 */
function tryParseConsistentField(text: string): boolean | undefined {
  const parsed = tryParseJsonObject(text);
  if (parsed === undefined) return undefined;
  const value = parsed.consistent;
  return typeof value === "boolean" ? value : undefined;
}

/** 严格 JSON 对象解析（非对象/解析失败返回 undefined）。 */
function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 非严格 JSON（LLM 输出杂散文本）：调用方回退。
  }
  return undefined;
}

/**
 * 回退判定结果。
 * - `redo`：是否需要回退；
 * - `gapIds`：结构化缺口 id（旧路径按命名空间派生）；
 * - `rationale`：触发来源说明，写入 RevisionRecord。
 */
export type RedoDecision = {
  redo: boolean;
  gapIds: string[];
  rationale: string;
};

/**
 * 一致性回退判定（manifest / graph 共用）。
 *
 * - `whenOutputGaps` 优先：严格 JSON 的 `gaps[]` 非空 → 回退；`gaps` 与
 *   `consistent` 并存时以 `gaps` 为准（缺口清单优先于总结论）；
 * - 结构化不可用且声明了 `whenOutputMatches` → 回退正则；
 * - 只声明 `whenOutputGaps` 且输出不可解析 → 返回 `undefined`（调用方写降级标记）。
 */
export function needsRedo(stage: WorkflowStage, output: string, signal?: RegExp): RedoDecision | undefined {
  const retry = stage.retry;
  if (retry === undefined) return undefined;

  if (retry.whenOutputGaps === true) {
    const structured = parseStructuredSignal(output);
    if (structured !== undefined) {
      const redo = structured.hasGaps ? structured.gapCount > 0 : structured.consistent === false;
      const rationale = structured.hasGaps
        ? `结构化 gaps:${structured.gapCount}${structured.gapIds.length > 0 ? `（${structured.gapIds.join("+")}）` : ""}`
        : `结构化 consistent:${String(structured.consistent)}`;
      const gapIds = structured.hasGaps ? structured.gapIds : redo ? [`consistent:${stage.id}`] : [];
      return { redo, gapIds, rationale };
    }
    if (retry.whenOutputMatches === undefined) return undefined;
  }

  const pattern = retry.whenOutputMatches;
  if (pattern === undefined) return undefined;
  const regex = signal ?? compileSignal(pattern);
  const match = matchSignal(output, regex);
  if (match === undefined) {
    return { redo: false, gapIds: [], rationale: `正则未命中: ${pattern}` };
  }
  return {
    redo: true,
    gapIds: deriveLegacyGapIds(output, match.matched, stage.id),
    rationale: `正则命中: ${match.matched}`,
  };
}

/**
 * 旧路径缺口 id 命名空间（避免与结构化 `gaps[].id` 混用）：
 * `rule:<ruleId>` / `element:<elementId>→<targetId>` / `pattern:<命中文本>`。
 */
function deriveLegacyGapIds(output: string, matched: string, stageId: string): string[] {
  if (matched === CONSISTENT_FALSE_MATCH) return [`consistent:${stageId}`];
  const parsed = tryParseJsonObject(output);
  if (parsed !== undefined) {
    const ruleId = parsed.ruleId;
    if (typeof ruleId === "string" && ruleId.trim().length > 0) return [`rule:${ruleId}`];
    const elementId = parsed.elementId;
    if (typeof elementId === "string" && elementId.trim().length > 0) {
      const targetId =
        typeof parsed.targetId === "string" && parsed.targetId.trim().length > 0 ? `→${parsed.targetId}` : "";
      return [`element:${elementId}${targetId}`];
    }
  }
  return [`pattern:${matched}`];
}

/** 编译信号正则（g 标志必需：signalMatches 用 exec 遍历全部匹配位置，无 g 时 exec 每次从头匹配 → 死循环）。 */
export function compileSignal(pattern: string): RegExp {
  return new RegExp(pattern, "gi");
}

/** 带缓存的信号获取（按阶段 id 缓存，避免每次执行/回退重新编译）。 */
export function signalFor(stage: WorkflowStage, cache: Map<string, RegExp>): RegExp | undefined {
  const pattern = stage.retry?.whenOutputMatches;
  if (pattern === undefined) return undefined;
  const cached = cache.get(stage.id);
  if (cached !== undefined) return cached;
  const compiled = compileSignal(pattern);
  cache.set(stage.id, compiled);
  return compiled;
}
