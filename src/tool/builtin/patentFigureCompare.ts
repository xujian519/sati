/**
 * patent_figure_compare — 生成侧声明的附图 ↔ 模型识图结果的附图标记比对（工具化暴露）。
 *
 * 核心能力早已以纯函数形式存在于 `src/patent/figure/figure-comparison.ts`
 * （`compareFigureAnalysis`），本文件**只做入参适配与结论透传**，不改核心模块逻辑：
 * - 核心模块比对的是「一幅图」的附图分析结果两侧（声明侧 / 识图侧）；
 * - 本工具的入参是**多幅图的两侧清单**，故按 `figure_no` 分组后逐幅调用核心模块，
 *   再把逐幅结论汇总成一份报告（发现 + 计数 + ok）。
 *
 * 入参 ↔ 核心模块契约（`FigureAnalysisResult.components[]`）的映射：
 *
 * | 工具入参 | 核心模块字段 | 说明 |
 * | --- | --- | --- |
 * | `refs[i]`（整数） | `components[i].refNumber`（字符串） | 纯数字标记 1..999；字母前缀标记（S101/U1）不参与比对 |
 * | `names[i]`（可选） | `components[i].name` | 与 `refs` 等长、按位对应；未命名填空串（空名不判名称冲突） |
 * | `types[i]`（可选） | `components[i].kind` | 与 `refs` 等长、按位对应；取值取 `FigureComponentKind`；缺省 `unknown` |
 * | `figure_no` | `figureNumber` | 同号的一对清单才互相比对 |
 *
 * 结论口径与核心模块一致：四类发现——缺标记 / 多标记 / 同号异名 / 同号异类型；
 * **任一发现 ⇒ `ok=false`**（有发现不等于通过，工具不替核心模块放宽结论）。
 * 工具层额外给每条发现补两个上下文字段：
 * - `figure_no`：多幅图时定位上下文（核心模块逐幅比对，不带图号）；
 * - `severity`：核心模块本身**不分等级**，工具层把四类发现统一记为 `fail`——它们都是
 *   「两侧不一致」，任一出现即不得按图文一致交付（与 `patent_figure_check` 的 fail 语义同源）。
 *
 * 诚实边界：
 * - 只比对纯数字标记（1..999）。字母前缀标记（S101/U1）**无法用本工具的入参表达**，
 *   也不参与核心模块的比对（核心模块口径如此，本工具不另立口径）。
 * - 两侧都为空 ⇒ 不做任何比对，直接 `invalid_tool_input`（零比对不是「通过」，是未核验）。
 * - 某一侧缺某幅图时，该幅按「空清单」参与比对（对侧标记全部计为缺标记/多标记），
 *   结论仍来自核心模块。
 */

import {
  compareFigureAnalysis,
  FIGURE_COMPONENT_KINDS,
  normalizeComponentKind,
  type FigureAnalysisResult,
  type FigureComponent,
  type FigureComponentKind,
} from "../../patent/figure/index.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiJsonSchema } from "../protocol/schema.js";
import type { SatiToolDefinition } from "../protocol/types.js";

/** 工具名（错误详情与报告文案里的自称）。 */
const TOOL_NAME = "patent_figure_compare";

/** 附图标记取值域（与核心模块可比对口径一致：纯数字 1..999）。 */
const MAX_COMPARABLE_REF = 999;

/** 一侧的单幅附图清单（声明侧与识图侧同构）。 */
export type PatentFigureCompareEntry = {
  /** 附图号（同一图号的声明侧与识图侧互相比对）。 */
  figure_no: number;
  /** 附图标记（纯数字 1..999；与 `names`/`types` 按位对应）。 */
  refs: number[];
  /** 部件名称（可选；与 `refs` 等长、按位对应；未命名填空串）。 */
  names?: string[];
  /** 部件类型（可选；与 `refs` 等长、按位对应；取值取 `FigureComponentKind`）。 */
  types?: string[];
};

/** 工具入参：声明侧清单 + 识图侧清单。 */
export type PatentFigureCompareInput = {
  /** 声明侧（出图时声明的附图标记清单）。 */
  declared: PatentFigureCompareEntry[];
  /** 识图侧（模型从图上识别出的附图标记清单）。 */
  analysis: PatentFigureCompareEntry[];
};

/** 工具输出的一条发现（核心模块发现 + 工具层上下文）。 */
export type PatentFigureCompareFinding = {
  /** 发现类型：缺标记 / 多标记 / 同号异名 / 同号异类型。 */
  readonly kind: "missing-component" | "extra-component" | "name-mismatch" | "type-mismatch";
  /** 严重度（核心模块不分等级，四类发现统一记 fail）。 */
  readonly severity: "fail";
  /** 所属图号（多幅比对时的定位上下文）。 */
  readonly figure_no: number;
  /** 涉及的附图标记。 */
  readonly ref: string;
  /** 人类可读说明（核心模块原文，中文）。 */
  readonly message: string;
  /** 证据行（声明侧与识图侧的取值）。 */
  readonly evidence?: readonly string[];
};

/** 逐幅的计数与结论。 */
export type PatentFigureCompareFigure = {
  readonly figure_no: number;
  readonly declared_count: number;
  readonly analysis_count: number;
  readonly ok: boolean;
};

/** 工具输出（canonical data）。 */
export type PatentFigureCompareOutput = {
  /** 无发现即 true（核心模块 `consistent` 的口径）。 */
  readonly ok: boolean;
  /** 逐条发现（跨幅汇总）。 */
  readonly findings: readonly PatentFigureCompareFinding[];
  /** 声明侧参与比对的去重标记数（跨幅合计）。 */
  readonly declared_count: number;
  /** 识图侧参与比对的去重标记数（跨幅合计）。 */
  readonly analysis_count: number;
  /** 实际比对的图数（两侧图号的并集）。 */
  readonly figure_count: number;
  /** 逐幅计数与结论。 */
  readonly figures: readonly PatentFigureCompareFigure[];
  /** 一句话结论（逐幅核心摘要串联）。 */
  readonly summary: string;
};

/** 单侧清单的 JSON Schema（声明侧与识图侧同构）。 */
const COMPARE_SIDE_SCHEMA: SatiJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["figure_no", "refs"],
  properties: {
    figure_no: { type: "integer", minimum: 1, description: "附图号（同号两侧互比）" },
    refs: {
      type: "array",
      items: { type: "integer", minimum: 1 },
      description: "附图标记（1..999；与 names/types 按位对应）",
    },
    names: {
      type: "array",
      items: { type: "string" },
      description: "部件名称（可选；与 refs 等长）",
    },
    types: {
      type: "array",
      items: { type: "string", enum: [...FIGURE_COMPONENT_KINDS] },
      description: "部件类型（可选；与 refs 等长）",
    },
  },
};

/** 发现项的 JSON Schema。 */
const FINDING_SCHEMA: SatiJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "severity", "figure_no", "ref", "message"],
  properties: {
    kind: {
      type: "string",
      enum: ["missing-component", "extra-component", "name-mismatch", "type-mismatch"],
      description: "缺标记 / 多标记 / 同号异名 / 同号异类型",
    },
    severity: { type: "string", enum: ["fail"], description: "严重度（四类统一记 fail）" },
    figure_no: { type: "integer", minimum: 1, description: "所属图号" },
    ref: { type: "string", description: "涉及的附图标记" },
    message: { type: "string", description: "发现说明" },
    evidence: { type: "array", items: { type: "string" }, description: "证据行" },
  },
};

/** 逐幅计数的 JSON Schema。 */
const FIGURE_SCHEMA: SatiJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["figure_no", "declared_count", "analysis_count", "ok"],
  properties: {
    figure_no: { type: "integer", minimum: 1 },
    declared_count: { type: "integer", minimum: 0 },
    analysis_count: { type: "integer", minimum: 0 },
    ok: { type: "boolean" },
  },
};

/** 入参校验失败（fail-loud：不静默丢件，也不把未核验说成通过）。 */
function invalidInput(message: string, details: Record<string, unknown> = {}): SatiToolRuntimeError {
  return new SatiToolRuntimeError("invalid_tool_input", message, { tool: TOOL_NAME, ...details });
}

/** 判断是否为合法的组件类型取值。 */
function isComponentKind(value: string): value is FigureComponentKind {
  return (FIGURE_COMPONENT_KINDS as readonly string[]).includes(value);
}

/**
 * 校验单幅清单（JSON Schema 不校验 `minimum`/数组长度，运行时兜底）。
 *
 * @param entry 单幅清单。
 * @param side 侧别（declared / analysis），用于错误信息定位。
 */
function assertEntry(entry: PatentFigureCompareEntry, side: "declared" | "analysis"): void {
  const where = { side, figure_no: entry.figure_no };
  if (!Number.isInteger(entry.figure_no) || entry.figure_no < 1) {
    throw invalidInput(`${side} 侧 figure_no 应为 ≥1 的整数（收到 ${String(entry.figure_no)}）`, where);
  }
  if (!Array.isArray(entry.refs)) {
    throw invalidInput(`${side} 侧图${entry.figure_no} 的 refs 应为数组`, where);
  }
  entry.refs.forEach(ref => {
    if (!Number.isInteger(ref) || ref < 1 || ref > MAX_COMPARABLE_REF) {
      throw invalidInput(
        `${side} 侧图${entry.figure_no} 的附图标记应为 1..${String(MAX_COMPARABLE_REF)} 的整数（收到 ${String(ref)}）：` +
          "字母前缀标记（S101/U1）不参与附图标记比对",
        where,
      );
    }
  });
  if (entry.names !== undefined) {
    if (!Array.isArray(entry.names) || entry.names.length !== entry.refs.length) {
      throw invalidInput(
        `${side} 侧图${entry.figure_no} 的 names 长度须与 refs 一致（names ${String(entry.names?.length)} ≠ refs ` +
          `${String(entry.refs.length)}）：未命名的标记请填空串`,
        where,
      );
    }
    entry.names.forEach(name => {
      if (typeof name !== "string") {
        throw invalidInput(`${side} 侧图${entry.figure_no} 的 names 只能是字符串`, where);
      }
    });
  }
  if (entry.types !== undefined) {
    if (!Array.isArray(entry.types) || entry.types.length !== entry.refs.length) {
      throw invalidInput(
        `${side} 侧图${entry.figure_no} 的 types 长度须与 refs 一致（types ${String(entry.types?.length)} ≠ refs ` +
          `${String(entry.refs.length)}）：未指定类型的标记请填 unknown`,
        where,
      );
    }
    entry.types.forEach(type => {
      if (typeof type !== "string" || !isComponentKind(type)) {
        throw invalidInput(
          `${side} 侧图${entry.figure_no} 的 types 取值非法（收到 ${String(type)}）：合法取值为 ` +
            FIGURE_COMPONENT_KINDS.join(" / "),
          where,
        );
      }
    });
  }
}

/**
 * 一侧清单 → 按图号索引（同时校验入参；同侧重复图号直接拒绝）。
 *
 * @param entries 单侧清单。
 * @param side 侧别（declared / analysis）。
 * @returns 图号 → 清单。
 */
function indexSide(
  entries: readonly PatentFigureCompareEntry[],
  side: "declared" | "analysis",
): Map<number, PatentFigureCompareEntry> {
  const index = new Map<number, PatentFigureCompareEntry>();
  for (const entry of entries) {
    assertEntry(entry, side);
    if (index.has(entry.figure_no)) {
      throw invalidInput(`${side} 侧出现重复图号 ${String(entry.figure_no)}：一幅图只能有一条清单`, {
        side,
        figure_no: entry.figure_no,
      });
    }
    index.set(entry.figure_no, entry);
  }
  return index;
}

/**
 * 单幅清单 → 核心模块的分析结果骨架。
 *
 * 骨架字段（imagePath / figureType / connections 等）与比对无关，按核心模块的
 * 契约填中性值：核心模块只读 `components[]`（refNumber / name / kind）。
 *
 * @param entry 单幅清单（缺省为空清单：该图在本侧没有声明）。
 * @param figureNo 图号。
 * @returns 分析结果骨架。
 */
function toAnalysisResult(entry: PatentFigureCompareEntry | undefined, figureNo: number): FigureAnalysisResult {
  const components: FigureComponent[] = (entry?.refs ?? []).map((ref, index) => ({
    refNumber: String(ref),
    name: entry?.names?.[index] ?? "",
    kind: normalizeComponentKind(entry?.types?.[index]),
    description: "",
  }));
  return {
    imagePath: "",
    figureNumber: figureNo,
    figureType: "unknown",
    overallDescription: "",
    components,
    connections: [],
    figureDescription: "",
    confidence: 1,
    warnings: [],
    usable: true,
    modelUsed: "",
  };
}

/**
 * 报告文本：逐幅摘要 + 逐条发现（发现带图号与证据行）。
 *
 * @param output 工具输出。
 * @returns 报告行。
 */
function buildReportLines(output: PatentFigureCompareOutput): string[] {
  const lines: string[] = [];
  const head =
    output.findings.length === 0
      ? `附图比对：${String(output.figure_count)} 幅，两侧一致（无发现）。`
      : `附图比对：${String(output.figure_count)} 幅，发现 ${String(output.findings.length)} 处不一致。`;
  lines.push(head);
  for (const figure of output.figures) {
    lines.push(
      `- 图${String(figure.figure_no)}：声明 ${String(figure.declared_count)} 个标记，识图 ${String(figure.analysis_count)} 个。`,
    );
  }
  for (const finding of output.findings) {
    lines.push(`- [${finding.kind}] 图${String(finding.figure_no)} 标记 ${finding.ref}：${finding.message}`);
    if (finding.evidence !== undefined && finding.evidence.length > 0) {
      lines.push(`  证据：${finding.evidence.join(" / ")}`);
    }
  }
  lines.push(output.summary);
  return lines;
}

export function createPatentFigureCompareTool(): SatiToolDefinition<
  PatentFigureCompareInput,
  PatentFigureCompareOutput
> {
  return {
    name: "patent_figure_compare",
    aliases: ["PatentFigureCompare", "figure_compare"],
    title: "Compare Patent Figure Analysis",
    description:
      "Compare declared patent figure callouts against recognized callouts. Provide two per-figure lists: " +
      "`declared` (declared at generation time) and `analysis` (recognized on the figure, e.g. from " +
      "analyze_patent_figure). Each entry: figure_no plus numeric refs 1-999, optional per-ref names and " +
      "component types aligned by index. Reports missing callouts, extra callouts, same-number name mismatches " +
      "and same-number type mismatches; ok is false whenever any discrepancy is found. Letter-prefixed callouts " +
      "(S101/U1) are out of scope. Rule catalog: `patent-illustrator` skill.",
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["declared", "analysis"],
      properties: {
        declared: {
          type: "array",
          items: COMPARE_SIDE_SCHEMA,
          description: "Declared side (per figure).",
        },
        analysis: {
          type: "array",
          items: COMPARE_SIDE_SCHEMA,
          description: "Analysis side (per figure).",
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "findings", "declared_count", "analysis_count", "figure_count", "figures", "summary"],
      properties: {
        ok: { type: "boolean", description: "两侧一致即 true；任一发现即 false" },
        findings: { type: "array", items: FINDING_SCHEMA, description: "四类不一致发现" },
        declared_count: { type: "integer", minimum: 0, description: "声明侧去重标记数" },
        analysis_count: { type: "integer", minimum: 0, description: "识图侧去重标记数" },
        figure_count: { type: "integer", minimum: 0, description: "实际比对的图数" },
        figures: { type: "array", items: FIGURE_SCHEMA, description: "逐幅计数与结论" },
        summary: { type: "string", description: "一句话结论" },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input: PatentFigureCompareInput): Promise<{
      content: { type: "text"; text: string }[];
      data: PatentFigureCompareOutput;
    }> {
      const declaredIndex = indexSide(input.declared ?? [], "declared");
      const analysisIndex = indexSide(input.analysis ?? [], "analysis");
      if (declaredIndex.size === 0 && analysisIndex.size === 0) {
        throw invalidInput("declared 与 analysis 至少提供一幅附图的清单（零比对不是「通过」，是未核验）");
      }

      const figureNos = [...new Set([...declaredIndex.keys(), ...analysisIndex.keys()])].sort(
        (left, right) => left - right,
      );
      const findings: PatentFigureCompareFinding[] = [];
      const figures: PatentFigureCompareFigure[] = [];
      const summaries: string[] = [];
      let declaredCount = 0;
      let analysisCount = 0;

      for (const figureNo of figureNos) {
        const report = compareFigureAnalysis(
          toAnalysisResult(declaredIndex.get(figureNo), figureNo),
          toAnalysisResult(analysisIndex.get(figureNo), figureNo),
        );
        declaredCount += report.expectedCount;
        analysisCount += report.actualCount;
        for (const finding of report.findings) {
          findings.push({
            kind: finding.kind,
            severity: "fail",
            figure_no: figureNo,
            ref: finding.ref,
            message: finding.message,
            ...(finding.evidence === undefined ? {} : { evidence: [...finding.evidence] }),
          });
        }
        figures.push({
          figure_no: figureNo,
          declared_count: report.expectedCount,
          analysis_count: report.actualCount,
          ok: report.consistent,
        });
        summaries.push(`图${String(figureNo)}：${report.summary}`);
      }

      const output: PatentFigureCompareOutput = {
        ok: findings.length === 0,
        findings,
        declared_count: declaredCount,
        analysis_count: analysisCount,
        figure_count: figureNos.length,
        figures,
        summary: summaries.join(" "),
      };

      return {
        content: [{ type: "text", text: buildReportLines(output).join("\n") }],
        data: output,
      };
    },
  };
}
