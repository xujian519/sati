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
  assertSafeSvg,
  checkFigures,
  isSvgSafetyError,
  parseFigureSvg,
  profileForJurisdiction,
  type DocumentKind,
  type FigureSpec,
  type Jurisdiction,
  type OfficeProfile,
} from "../../patent/figuregen/index.js";
import { figureSpecsToAnalysis } from "../../patent/figure/bridge.js";
import { checkFigureConsistency } from "../../patent/figure/multi-figure-consistency.js";
import { analyzeImageBuffer, type PixelFinding, type PixelMetrics } from "../../patent/figuregen/pixel-gate.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../protocol/types.js";
import {
  assertFigurePayloads,
  FIGURE_INPUT_SCHEMA_REF,
  JURISDICTIONS,
  toFigureCount,
  toJurisdiction,
  toSheet,
} from "./patentFigureSchema.js";

export type PatentFigureCheckInput = {
  figures?: FigureSpec[];
  svg_paths?: string[];
  image_paths?: string[];
  spec_text: string;
  claims_text?: string;
  description_text?: string;
  document_kind?: string;
  jurisdiction?: string;
  figure_count?: number;
  sheet_index?: number;
  sheet_total?: number;
};

/** 栅格图核查条目（报告面：文件名 + 指标 + 发现）。 */
type PixelGateEntry = PixelMetrics & { name: string; findings: PixelFinding[] };

/**
 * 栅格附图逐张做像素级核查（sharp 动态导入在 `analyzeImageBuffer` 内）。
 *
 * 读盘/解码失败**fail-explicit**：栅格图的核验路径只有这一条，静默跳过等于"零门禁
 * 假装已核验"（与 `readback.ts` 对外部 SVG 的诚实声明不同——那里至少还有结构契约）。
 */
async function runPixelGateForPaths(
  paths: readonly string[],
  cwd: string,
  office: OfficeProfile["office"],
): Promise<PixelGateEntry[]> {
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
      const { metrics, findings } = await analyzeImageBuffer(buffer, { name: basename(imagePath), office });
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
      "Regulations 2023): figure numbering, figure-to-text and text-to-figure numeral consistency, " +
      "one-numeral-one-component, annotation-like labels, drawing-surface wording (annotation prefixes, " +
      "body references, dimension/scale indications, trailing punctuation, figure number inside the " +
      "drawing, non-Chinese wording, numeral shape), claim/description numeral-bracket conventions, " +
      "canvas legibility against the per-office printable area and minimum character height, conditional " +
      "view numbering (single view must not be numbered under PCT/US), sheet numbering, abstract-figure " +
      "designation and the utility-model drawings requirement. Every finding names its rule id and cites " +
      "the governing provision, so the report is self-explanatory. Pass the full specification text " +
      "(claims + description). Input: structured `figures`, `svg_paths` (re-parses SVGs produced by " +
      "patent_figure_generate) and/or `image_paths` for raster drawings (customer scans, CAD exports, " +
      "third-party images), which get a pixel-level check instead: black-and-white purity, minimum line " +
      "width, DPI and printed size against the printable area (no OCR — the figure number must be declared " +
      "via the file name). Figures are not final until this check reports ok. Rules and their workflow are " +
      "documented in the `patent-illustrator` skill. Registered by default; pass `patentFigure: false` to skip.",
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
          description: "说明书文字部分全文（权利要求书 + 说明书，不含附图本身）；V2/V3 的判定文本",
        },
        claims_text: {
          type: "string",
          description:
            "权利要求书文本（可选）：提供时替代启发式分节作为权利要求面，使 V10（权利要求中附图标记须置于括号内）的判定不再依赖小节标题",
        },
        description_text: {
          type: "string",
          description:
            "说明书正文文本（可选）：提供时替代启发式分节作为正文面（V11 判定面）。若含附图说明小节，其括号引用也会被 V11 计为正文引用",
        },
        document_kind: {
          type: "string",
          enum: ["invention", "utility"],
          description: "发明/实用新型（V9 实用新型必须有附图，US 辖区无此规则）",
        },
        jurisdiction: {
          type: "string",
          enum: JURISDICTIONS,
          description:
            "Target office (default cn): cn=CNIPA (CN-only rules V8/V9/V10/V11 + 图N numbering), us=USPTO " +
            "(37 CFR 1.84 profile, FIG. N numbering), pct=PCT (PCT Rule 11 profile, Fig. N numbering, CN " +
            "bracket rules V10/V11 not applied)",
        },
        figure_count: {
          type: "integer",
          minimum: 1,
          description:
            "本案附图总幅数（缺省取本次核验的附图数）：分次生成/只核验单幅时须声明——它决定图号是否" +
            "应当出现（单幅在 pct/us 不得编号）与纸面尺寸判据",
        },
        sheet_index: {
          type: "integer",
          minimum: 1,
          description: "附图页序号（与 sheet_total 成对声明；多页附图未声明时 V17 提示）",
        },
        sheet_total: { type: "integer", minimum: 1, description: "附图页总页数（成对声明；≥2 时 V17 核验页码声明）" },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input, context: SatiToolRuntimeContext) {
      const documentKind: DocumentKind | undefined =
        input.document_kind === "utility" ? "utility" : input.document_kind === "invention" ? "invention" : undefined;
      const jurisdiction: Jurisdiction = toJurisdiction(input.jurisdiction);
      const profile = profileForJurisdiction(jurisdiction);
      const sheet = toSheet({ sheet_index: input.sheet_index, sheet_total: input.sheet_total });

      const figures: FigureSpec[] = [...(input.figures ?? [])];
      // 结构性校验只针对**调用方给出的结构化附图**：svg_paths 回读的骨架没有 nodes/chart 载荷
      // （回读的观测对象是图号与标记），套用"必须有节点"的约束会误伤那条通路。
      assertFigurePayloads(input.figures ?? [], "patent_figure_check");
      // 已交付 SVG 的图号观测（V15/V16 的判据：图号的**可见形态**只在交付文件里可观测）。
      const numberedFigureNos: number[] = [];
      // 回读骨架的图号：画幅不由本模块布局决定，须逐图排除出 V7 的画幅判据。
      const readbackFigureNos: number[] = [];
      const svgPaths = input.svg_paths ?? [];
      for (const svgPath of svgPaths) {
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
        // 跨信任边界读盘：外部 SVG 先过安全门（大小上限 + 拒 DOCTYPE/ENTITY/CDATA），
        // 再进解析器（解析器自身不设安全边界，见 figuregen/svg-safety.ts）。
        try {
          assertSafeSvg(svg);
        } catch (err) {
          if (!isSvgSafetyError(err)) throw err;
          throw new SatiToolRuntimeError("invalid_tool_input", `附图 ${svgPath} 未通过安全检查: ${err.message}`, {
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
        // `kind` 是**占位**：SVG 里没有图型信息（回读只认 `<g>` 的 id/data-ref 与 `<text>`），
        // 原图型与方向已不可知。占位为 flowchart 只影响 V19（"实用新型全为曲线图"不会误报）
        // 与 V20/V21（曲线图专有规则保守跳过）——画幅判据则由下面传出的 skipLayoutFigureNos
        // 明确排除，不靠这个占位来决定。
        figures.push({ figure_no: parsed.figureNo, kind: "flowchart", nodes: parsed.nodes, edges: [] });
        readbackFigureNos.push(parsed.figureNo);
        if (parsed.numbered) numberedFigureNos.push(parsed.figureNo);
      }
      const imagePaths = input.image_paths ?? [];
      if (figures.length === 0 && imagePaths.length === 0) {
        throw new SatiToolRuntimeError("invalid_tool_input", "figures / svg_paths / image_paths 至少提供一项", {
          tool: "patent_figure_check",
        });
      }

      try {
        // 只有栅格图时无 FigureSpec 可核：跳过结构规则（已如实声明），只跑像素门禁。
        // 显式分面（claims_text/description_text）提供时替代启发式分节，使 V10/V11 不再
        // 依赖小节标题（调用方通常已知道分界）。
        const explicitFaces =
          input.claims_text !== undefined || input.description_text !== undefined
            ? {
                ...(input.claims_text === undefined ? {} : { claims: input.claims_text }),
                ...(input.description_text === undefined
                  ? {}
                  : { description: input.description_text, descriptionSansBrief: input.description_text }),
              }
            : undefined;
        const result = checkFigures(figures, input.spec_text, {
          documentKind: documentKind,
          jurisdiction: jurisdiction,
          figureCount: toFigureCount(input.figure_count, figures.length),
          ...(svgPaths.length === 0 ? {} : { numberedFigureNos }),
          // 回读骨架逐图排除出 V7 画幅判据（结构化 figures 与 svg_paths 混给时，前者照判）。
          ...(readbackFigureNos.length === 0 ? {} : { skipLayoutFigureNos: readbackFigureNos }),
          ...(sheet === undefined ? {} : { sheetIndex: sheet.index, sheetTotal: sheet.total }),
          ...(explicitFaces === undefined ? {} : { faces: explicitFaces }),
          ...(figures.length === 0 ? { skipTextRules: true, skipLayoutRules: true } : {}),
        });
        const pixelResults = await runPixelGateForPaths(imagePaths, context.cwd, profile.office);
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
          ...(result.bracketRules === undefined ? [] : [`括号规则：${result.bracketRules.reason}`]),
          ...(svgPaths.length === 0
            ? []
            : [
                `图号观测（已交付 SVG）：${
                  numberedFigureNos.length === 0 ? "均无图号标注" : `图${numberedFigureNos.join("、图")} 带图号`
                }`,
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
          jurisdiction === "cn"
            ? "依据：专利法实施细则（2023）第 20/21/22 条、审查指南一部一章 4.3/4.5.2/4.6、五部一章 4.2/4.3/5.6 与一部二章 7.3；无 fail 级发现方可定稿附图。"
            : jurisdiction === "us"
              ? "Basis: 37 CFR 1.84 (drawings, incl. (g) margins, (k) scale, (p) reference characters, (u) view numbering) and MPEP 608.02. Figures are final only with no fail-level findings."
              : "Basis: PCT Rule 11.5/11.6/11.13, Administrative Instructions Section 207 and PCT Applicant's Guide IP 5.141/5.150. Figures are final only with no fail-level findings.",
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (err) {
        // 与 patent_figure_generate/project 同法：`SatiToolRuntimeError` 原样透传，保住 `code`
        // 与 `details`（入参校验的 `invalid_tool_input` 不能被折叠成执行环境故障）。
        if (err instanceof SatiToolRuntimeError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new SatiToolRuntimeError("tool_execution_failed", `patent_figure_check 执行失败: ${message}`, {
          tool: "patent_figure_check",
        });
      }
    },
  };
}
