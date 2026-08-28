/**
 * patent_figure_check — 附图 ↔ 说明书文字部分双向标记核验（细则第 21 条）+ 结构一致性。
 *
 * V1 图号连续 / V2 图→文 / V3 文→图（保守 WARN）/ V4 标记一致性 /
 * V5 禁注释 / V7 画幅可辨 / V8 摘要附图 / V9 实用新型必须有附图。
 *
 * 入参两选一：结构化 figures（与 patent_figure_generate 同契约），或 svg_paths
 * （回读 patent_figure_generate 产出的 SVG，解析 data-ref 与"图N"标注，对已交付
 * 文件复核）。fail 级发现 = 附图不得定稿（与 illustrator 完成标准一致）。
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  checkFigures,
  parseFigureSvg,
  type DocumentKind,
  type FigureSpec,
  type Jurisdiction,
} from "../../patent/figuregen/index.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../protocol/types.js";
import { FIGURE_INPUT_SCHEMA_REF } from "./patentFigureSchema.js";

export type PatentFigureCheckInput = {
  figures?: FigureSpec[];
  svg_paths?: string[];
  spec_text: string;
  document_kind?: string;
  jurisdiction?: string;
};

export function createPatentFigureCheckTool(): SatiToolDefinition<PatentFigureCheckInput> {
  return {
    name: "patent_figure_check",
    outputSchema: { type: "object", properties: {} },
    aliases: ["PatentFigureCheck", "figure_check"],
    title: "Check Patent Figures",
    description:
      "Validate patent figures against the specification text (Rule 21 of the CNIPA Implementing " +
      "Regulations 2023): continuous figure numbering (V1), every reference numeral in a figure must " +
      "appear in the specification text (V2, hard fail), bracket-form numerals in the text missing from " +
      "figures (V3, warn), one-numeral-one-component consistency (V4, hard fail), plus annotation-like " +
      "labels (V5), canvas legibility (V7), abstract-figure designation (V8) and utility-model drawings " +
      "requirement (V9). Input: structured `figures` and/or `svg_paths` (re-parses SVGs produced by " +
      "patent_figure_generate). Pass the full specification text (claims + description). Figures are not " +
      "final until this check reports ok. Registered by default; pass `patentFigure: false` to skip.",
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["spec_text"],
      properties: {
        figures: {
          type: "array",
          minItems: 1,
          items: FIGURE_INPUT_SCHEMA_REF,
          description: "待核验附图（与 patent_figure_generate 的 figures 同契约）",
        },
        svg_paths: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description: "patent_figure_generate 产出的 SVG 文件路径（回读 data-ref 复核已交付文件）",
        },
        spec_text: {
          type: "string",
          description: "说明书文字部分全文（权利要求书 + 说明书，不含附图本身）",
        },
        document_kind: {
          type: "string",
          enum: ["invention", "utility"],
          description: "发明/实用新型（V9 实用新型必须有附图，US 辖区无此规则）",
        },
        jurisdiction: {
          type: "string",
          enum: ["cn", "us"],
          description:
            "Jurisdiction (default cn): us skips CN-only rules (V8 abstract figure, V9 utility model) and cites 37 CFR 1.84",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input, context: SatiToolRuntimeContext) {
      const documentKind: DocumentKind | undefined =
        input.document_kind === "utility" ? "utility" : input.document_kind === "invention" ? "invention" : undefined;
      const jurisdiction: Jurisdiction = input.jurisdiction === "us" ? "us" : "cn";

      const figures: FigureSpec[] = [...(input.figures ?? [])];
      for (const svgPath of input.svg_paths ?? []) {
        const absolute = isAbsolute(svgPath) ? svgPath : resolve(context.cwd, svgPath);
        let svg: string;
        try {
          svg = await readFile(absolute, "utf8");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new SatiToolRuntimeError("invalid_tool_input", `无法读取附图文件 ${svgPath}: ${message}`, {
            tool: "patent_figure_check",
            path: svgPath,
          });
        }
        let parsed;
        try {
          parsed = parseFigureSvg(svg);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new SatiToolRuntimeError("invalid_tool_input", `解析附图失败 ${svgPath}: ${message}`, {
            tool: "patent_figure_check",
            path: svgPath,
          });
        }
        figures.push({ figure_no: parsed.figureNo, kind: "flowchart", nodes: parsed.nodes, edges: [] });
      }
      if (figures.length === 0) {
        throw new SatiToolRuntimeError("invalid_tool_input", "figures 与 svg_paths 至少提供一项", {
          tool: "patent_figure_check",
        });
      }

      try {
        const result = checkFigures(figures, input.spec_text, {
          documentKind: documentKind,
          jurisdiction: jurisdiction,
        });
        const lines: string[] = [
          `核验${result.ok ? "通过" : "未通过"}（fail=${result.findings.filter(f => f.severity === "fail").length}, ` +
            `warn=${result.findings.filter(f => f.severity === "warn").length}）：`,
          `图内标记：${result.refsInFigures.join(", ") || "（无）"}`,
          `文内括号标记：${result.refsInText.join(", ") || "（无）"}`,
        ];
        if (result.findings.length > 0) {
          lines.push("");
          for (const finding of result.findings) {
            lines.push(
              `- [${finding.severity.toUpperCase()}] ${finding.rule}: ${finding.message}` +
                (finding.evidence ? `\n  ${finding.evidence.join("\n  ")}` : ""),
            );
          }
        }
        lines.push(
          "",
          jurisdiction === "us"
            ? "Basis: 37 CFR 1.84 (drawings); MPEP 608.02 (reference characters). Figures are final only with no fail-level findings."
            : "依据：专利法实施细则（2023）第 20/21 条、审查指南一部一章 4.3/4.5.2/4.6 与一部二章 7.3；无 fail 级发现方可定稿附图。",
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new SatiToolRuntimeError("tool_execution_failed", `patent_figure_check 执行失败: ${message}`, {
          tool: "patent_figure_check",
        });
      }
    },
  };
}
