/**
 * patent_figure_check — 附图 ↔ 说明书文字部分双向标记核验（细则第 21 条）+ 结构一致性。
 *
 * V1 图号连续 / V2 图→文 / V3 文→图（保守 WARN）/ V4 标记一致性。
 * 输入为结构化 FigureSpec（与 patent_figure_generate 同契约）；已交付 SVG 的
 * data-ref 回读复核属 P1。fail 级发现 = 附图不得定稿（与 illustrator 完成标准一致）。
 */

import { checkFigures, type DocumentKind, type FigureSpec } from "../../patent/figuregen/index.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition } from "../protocol/types.js";
import { FIGURE_INPUT_SCHEMA_REF } from "./patentFigureSchema.js";

export type PatentFigureCheckInput = {
  figures: FigureSpec[];
  spec_text: string;
  document_kind?: string;
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
      "figures (V3, warn), and one-numeral-one-component consistency across figures (V4, hard fail). " +
      "Pass the full specification text (claims + description). Figures are not final until this check " +
      "reports ok=true. Opt-in tool.",
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["figures", "spec_text"],
      properties: {
        figures: {
          type: "array",
          minItems: 1,
          items: FIGURE_INPUT_SCHEMA_REF,
          description: "待核验附图（与 patent_figure_generate 的 figures 同契约）",
        },
        spec_text: { type: "string", description: "说明书文字部分全文（权利要求书 + 说明书，不含附图本身）" },
        document_kind: {
          type: "string",
          enum: ["invention", "utility"],
          description: "发明/实用新型（P0 仅记录，V9 实用新型必须有附图属 P1）",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      const documentKind: DocumentKind | undefined =
        input.document_kind === "utility" ? "utility" : input.document_kind === "invention" ? "invention" : undefined;
      try {
        const result = checkFigures(input.figures, input.spec_text);
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
          lines.push("", "依据：专利法实施细则（2023）第 21 条；完成标准：无 fail 级发现方可定稿附图。");
        }
        if (documentKind === "utility") {
          lines.push("（实用新型：附图为说明书组成部分，无附图不得提交——指南一部二章 7.3。）");
        }
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
