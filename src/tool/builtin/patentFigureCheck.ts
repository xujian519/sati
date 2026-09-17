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
import { basename, isAbsolute, resolve } from "node:path";
import {
  checkFigures,
  parseFigureSvg,
  type DocumentKind,
  type FigureSpec,
  type Jurisdiction,
} from "../../patent/figuregen/index.js";
import { figureSpecsToAnalysis } from "../../patent/figure/bridge.js";
import { checkFigureConsistency } from "../../patent/figure/multi-figure-consistency.js";
import { analyzeImageBuffer, type PixelFinding, type PixelMetrics } from "../../patent/figuregen/pixel-gate.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../protocol/types.js";
import { FIGURE_INPUT_SCHEMA_REF } from "./patentFigureSchema.js";

export type PatentFigureCheckInput = {
  figures?: FigureSpec[];
  svg_paths?: string[];
  image_paths?: string[];
  spec_text: string;
  document_kind?: string;
  jurisdiction?: string;
};

/** 栅格图核查条目（报告面：文件名 + 指标 + 发现）。 */
type PixelGateEntry = PixelMetrics & { name: string; findings: PixelFinding[] };

/**
 * 栅格附图逐张做像素级核查（sharp 动态导入在 `analyzeImageBuffer` 内）。
 *
 * 读盘/解码失败**fail-explicit**：栅格图的核验路径只有这一条，静默跳过等于"零门禁
 * 假装已核验"（与 `readback.ts` 对外部 SVG 的诚实声明不同——那里至少还有结构契约）。
 */
async function runPixelGateForPaths(paths: readonly string[], cwd: string): Promise<PixelGateEntry[]> {
  const entries: PixelGateEntry[] = [];
  for (const imagePath of paths) {
    const absolute = isAbsolute(imagePath) ? imagePath : resolve(cwd, imagePath);
    let buffer: Buffer;
    try {
      buffer = await readFile(absolute);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SatiToolRuntimeError("invalid_tool_input", `无法读取附图图片 ${imagePath}: ${message}`, {
        tool: "patent_figure_check",
        path: imagePath,
      });
    }
    try {
      const { metrics, findings } = await analyzeImageBuffer(buffer, { name: basename(imagePath) });
      entries.push({ ...metrics, name: basename(imagePath), findings });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SatiToolRuntimeError(
        "tool_execution_failed",
        `栅格附图像素级核查失败 ${imagePath}: ${message}（该核查依赖 sharp 解码图片）`,
        { tool: "patent_figure_check", path: imagePath },
      );
    }
  }
  return entries;
}

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
      "labels (V5), unfiled bracket-less numerals in the claims face (V10, hard fail; Rule 22 requires " +
      "reference numerals in claims to be parenthesised) and bracketed numerals in the description face " +
      "(V11, warn; the description convention is name-then-numeral). V10/V11 need a successful heuristic " +
      "split of the text into claims/description faces — when the split fails the report says so and both " +
      "rules stay silent. Also: canvas legibility (V7), abstract-figure designation (V8) and utility-model drawings " +
      "requirement (V9). Input: structured `figures`, `svg_paths` (re-parses SVGs produced by " +
      "patent_figure_generate) and/or `image_paths` for raster drawings (customer scans, CAD exports, third-party " +
      "images) which get a pixel-level check instead: black-and-white purity, minimum line width, DPI and printed " +
      "size against the A4 printable area (no OCR — the figure number must be declared via the file name). " +
      "Pass the full specification text (claims + description). Figures are not " +
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
        image_paths: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description:
            "非本工具产出的栅格附图路径（客户扫描件/CAD 导出/他人绘制的图，支持 jpg/png/gif/webp）：做像素级合规核查（黑白性、线宽、DPI、纸面尺寸）。不做 OCR——图号存在性需由文件名（如 xxx-fig3.png）或调用方声明，未声明会给出提示",
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
      const imagePaths = input.image_paths ?? [];
      if (figures.length === 0 && imagePaths.length === 0) {
        throw new SatiToolRuntimeError("invalid_tool_input", "figures / svg_paths / image_paths 至少提供一项", {
          tool: "patent_figure_check",
        });
      }

      try {
        // 只有栅格图时无 FigureSpec 可核：跳过结构规则（已如实声明），只跑像素门禁。
        const result = checkFigures(figures, input.spec_text, {
          documentKind: documentKind,
          jurisdiction: jurisdiction,
          ...(figures.length === 0 ? { skipTextRules: true, skipLayoutRules: true } : {}),
        });
        const pixelResults = await runPixelGateForPaths(imagePaths, context.cwd);
        const pixelFail = pixelResults.flatMap(r => r.findings.filter(f => f.severity === "fail")).length;
        const pixelWarn = pixelResults.flatMap(r => r.findings.filter(f => f.severity === "warn")).length;
        const lines: string[] = [
          `核验${result.ok && pixelFail === 0 ? "通过" : "未通过"}（fail=` +
            `${result.findings.filter(f => f.severity === "fail").length + pixelFail}, ` +
            `warn=${result.findings.filter(f => f.severity === "warn").length + pixelWarn}）：`,
          figures.length === 0
            ? "结构规则：未提供结构化附图（仅栅格图，本次不适用）"
            : `图内标记：${result.refsInFigures.join(", ") || "（无）"}`,
          ...(figures.length === 0 ? [] : [`文内括号标记：${result.refsInText.join(", ") || "（无）"}`]),
          ...(result.specFaces === undefined
            ? []
            : [
                `文字面分节：${result.specFaces.sectioned ? "已分节" : "未分节"}${
                  result.specFaces.sectioned ? "" : "（V10/V11 未生效）"
                }——${result.specFaces.reason}`,
              ]),
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
        if (pixelResults.length > 0) {
          lines.push("", "栅格附图像素级核查（非本工具产出的图；不做 OCR，图号需声明）：");
          for (const entry of pixelResults) {
            lines.push(
              `- ${entry.name}：${entry.width}×${entry.height}px，${entry.dpi}DPI${
                entry.dpiEstimated ? "（估算）" : ""
              }，纸面约 ${entry.printedWidthMm?.toFixed(1)}×${entry.printedHeightMm?.toFixed(1)}mm，` +
                `非白占比 ${(entry.inkRatio * 100).toFixed(2)}%，中间灰占比 ${(entry.midGrayRatio * 100).toFixed(1)}%` +
                (entry.linePx === undefined ? "" : `，最细线宽约 ${entry.linePx}px`),
            );
            for (const finding of entry.findings) {
              lines.push(
                `  [${finding.severity.toUpperCase()}] ${finding.rule}: ${finding.message}` +
                  (finding.evidence ? `\n    ${finding.evidence.join("\n    ")}` : ""),
              );
            }
          }
        }

        // 多图一致性（≥2 幅时自动跑，复用既有纯函数）：跨图标记/名称冲突 +
        // 图文对齐（电学档 R1/C2 与机械档 壳体(10) 分别对齐，见 figure/bridge.ts）。
        // 单图无"跨图"可言，不跑（避免制造噪音）。
        if (figures.length >= 2) {
          const consistency = checkFigureConsistency(figureSpecsToAnalysis(figures), input.spec_text);
          lines.push("", "多图一致性检查：", `- ${consistency.summary}`);
          for (const warning of consistency.warnings) {
            lines.push(`- ${warning}`);
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
