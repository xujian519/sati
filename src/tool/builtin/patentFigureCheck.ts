/**
 * patent_figure_check — 附图 ↔ 说明书文字部分双向标记核验（细则第 21 条）+ 结构一致性。
 *
 * V1 图号连续 / V2 图→文 / V3 文→图（保守 WARN）/ V4 标记一致性 /
 * V5 禁注释 / V7 画幅可辨 / V8 摘要附图 / V9 实用新型必须有附图。
 *
 * 入参两选一：结构化 figures（与 patent_figure_generate 同契约），或 svg_paths
 * （回读 patent_figure_generate 产出的 SVG，解析 data-ref 与"图N"标注，对已交付
 * 文件复核）。fail 级发现 = 附图不得定稿（与 illustrator 完成标准一致）。
 *
 * P2.5（issue #646）：execute 的 250 行按「入参归一 → SVG 回读 → 核验与报告」分层；
 * 回读循环与报告构造收敛到模块级函数，sheet/documentKind 归一收进 patentFigureShared.ts。
 */

import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import {
  analyzeImageBuffer,
  assertSafeSvg,
  checkFigureRendering,
  checkFigures,
  isSvgSafetyError,
  parseFigureSvg,
  profileForJurisdiction,
  toRenderCheckFindings,
  type FigureCheckSeverity,
  type FigureSpec,
  type Jurisdiction,
  type OfficeProfile,
  type PixelFinding,
  type PixelMetrics,
} from "../../patent/figuregen/index.js";
import { figureSpecsToAnalysis } from "../../patent/figure/bridge.js";
import { checkFigureConsistency } from "../../patent/figure/multi-figure-consistency.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../protocol/types.js";
import {
  assertFigurePayloads,
  FIGURE_FINDING_SCHEMA,
  FIGURE_INPUT_SCHEMA_REF,
  JURISDICTIONS,
  PIXEL_IMAGE_SCHEMA,
  toFigureCount,
  toJurisdiction,
} from "./patentFigureSchema.js";
import { toDocumentKind, validateSheetArgs } from "./patentFigureShared.js";

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

/** 一张已交付 SVG 的渲染复核结果（报告面：文件 + 发现）。 */
type RenderCheckEntry = {
  path: string;
  findings: { rule: string; severity: FigureCheckSeverity; message: string }[];
};

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

/**
 * 已交付 SVG 回读：安全门 → 解析图号/标记 → 组装回读骨架 → 矢量源几何量测。
 * `kind` 是**占位**（flowchart）：SVG 通常不携带图型（本仓曲线图产物例外——根元素写
 * `data-dsh-kind="chart"`，但那只供渲染复核挑选适用判据），原图型与方向已不可知——占位只影响
 * V19/V20/V21 的保守跳过，画幅判据由 readbackFigureNos 明确排除，不靠占位决定。
 */
async function readbackSvgFigures(
  svgPaths: readonly string[],
  cwd: string,
  tool: string,
): Promise<{
  figures: FigureSpec[];
  numberedFigureNos: number[];
  readbackFigureNos: number[];
  renderChecks: RenderCheckEntry[];
}> {
  const figures: FigureSpec[] = [];
  const numberedFigureNos: number[] = [];
  const readbackFigureNos: number[] = [];
  const renderChecks: RenderCheckEntry[] = [];
  for (const svgPath of svgPaths) {
    const absolute = isAbsolute(svgPath) ? svgPath : resolve(cwd, svgPath);
    let svg: string;
    try {
      svg = await readFile(absolute, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SatiToolRuntimeError("invalid_tool_input", `无法读取附图文件 ${svgPath}: ${message}`, {
        tool,
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
        tool,
        path: svgPath,
      });
    }
    let parsed;
    try {
      parsed = parseFigureSvg(svg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SatiToolRuntimeError("invalid_tool_input", `解析附图失败 ${svgPath}: ${message}`, {
        tool,
        path: svgPath,
      });
    }
    figures.push({ figure_no: parsed.figureNo, kind: "flowchart", nodes: parsed.nodes, edges: [] });
    readbackFigureNos.push(parsed.figureNo);
    if (parsed.numbered) numberedFigureNos.push(parsed.figureNo);
    // 几何量测在矢量源上做：线段位置/线宽/字号即渲染输入，不需要栅格化器。这一条覆盖
    // `V*` 结构规则**判不到**的面（回读骨架没有图型、方向与布局，看不出"画出来是什么样"）。
    renderChecks.push({ path: svgPath, findings: toRenderCheckFindings(checkFigureRendering(svg).findings) });
  }
  return { figures, numberedFigureNos, readbackFigureNos, renderChecks };
}

/** 报告文本：结论行 + 结构/像素/渲染复核分面 + 多图一致性 + 依据条款。 */
function buildCheckReportLines(args: {
  ok: boolean;
  result: ReturnType<typeof checkFigures>;
  figures: FigureSpec[];
  svgPaths: readonly string[];
  numberedFigureNos: number[];
  pixelResults: PixelGateEntry[];
  renderChecks: RenderCheckEntry[];
  multiFigureConsistency: { summary: string; warnings: string[] } | undefined;
  jurisdiction: Jurisdiction;
}): string[] {
  const { ok, result, figures, svgPaths, numberedFigureNos, pixelResults, renderChecks } = args;
  const failCount =
    result.findings.filter(f => f.severity === "fail").length +
    pixelResults.flatMap(r => r.findings).filter(f => f.severity === "fail").length +
    renderChecks.flatMap(entry => entry.findings).filter(f => f.severity === "fail").length;
  const warnCount =
    result.findings.filter(f => f.severity === "warn").length +
    pixelResults.flatMap(r => r.findings).filter(f => f.severity === "warn").length +
    renderChecks.flatMap(entry => entry.findings).filter(f => f.severity === "warn").length;
  const lines: string[] = [
    `核验${ok ? "通过" : "未通过"}（fail=${failCount}, warn=${warnCount}）：`,
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

  if (renderChecks.length > 0) {
    lines.push(
      "",
      "已交付 SVG 的渲染复核（矢量源几何量测：文字是否被线条贯穿、文字与图线净距、点划线是否被同位置实线覆盖、相邻零件剖面线可否区分、内容是否越出画布）：",
    );
    for (const entry of renderChecks) {
      const fails = entry.findings.filter(finding => finding.severity === "fail").length;
      lines.push(
        `- ${entry.path}：${entry.findings.length === 0 ? "无发现" : `${entry.findings.length} 项（fail=${fails}）`}`,
      );
      for (const finding of entry.findings) {
        lines.push(`  [${finding.severity.toUpperCase()}] ${finding.rule}: ${finding.message}`);
      }
    }
  }

  // 多图一致性（≥2 幅时自动跑，复用既有纯函数）：跨图标记/名称冲突 +
  // 图文对齐（电学档 R1/C2 与机械档 壳体(10) 分别对齐，见 figure/bridge.ts）。
  // 单图无"跨图"可言，不跑（避免制造噪音）。
  if (args.multiFigureConsistency !== undefined) {
    lines.push("", "多图一致性检查：", `- ${args.multiFigureConsistency.summary}`);
    for (const warning of args.multiFigureConsistency.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  lines.push(
    "",
    args.jurisdiction === "cn"
      ? "依据：专利法实施细则（2023）第 20/21/22 条、审查指南一部一章 4.3/4.5.2/4.6、五部一章 4.2/4.3/5.6 与一部二章 7.3；无 fail 级发现方可定稿附图。"
      : args.jurisdiction === "us"
        ? "Basis: 37 CFR 1.84 (drawings, incl. (g) margins, (k) scale, (p) reference characters, (u) view numbering) and MPEP 608.02. Figures are final only with no fail-level findings."
        : "Basis: PCT Rule 11.5/11.6/11.13, Administrative Instructions Section 207 and PCT Applicant's Guide IP 5.141/5.150. Figures are final only with no fail-level findings.",
  );
  return lines;
}

export function createPatentFigureCheckTool(): SatiToolDefinition<PatentFigureCheckInput> {
  return {
    name: "patent_figure_check",
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "findings", "refs_in_figures", "refs_in_text"],
      properties: {
        ok: { type: "boolean", description: "无 fail 级发现（结构规则 + 栅格像素门禁合并判定）" },
        findings: { type: "array", items: FIGURE_FINDING_SCHEMA, description: "结构规则（V*）发现" },
        refs_in_figures: { type: "array", items: { type: "integer" }, description: "图内出现的附图标记" },
        refs_in_text: { type: "array", items: { type: "integer" }, description: "文字部分以括号出现的标记" },
        pixel_images: {
          type: "array",
          items: PIXEL_IMAGE_SCHEMA,
          description: "栅格附图的像素级核查指标与发现（未提供 image_paths 时为空数组）",
        },
        render_check: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "findings"],
            properties: {
              path: { type: "string" },
              findings: { type: "array", items: FIGURE_FINDING_SCHEMA },
            },
          },
          description: "Delivered-SVG render checks (RC0-RC5); empty without svg_paths.",
        },
        multi_figure_consistency: {
          type: "object",
          additionalProperties: false,
          required: ["summary", "warnings"],
          properties: {
            summary: { type: "string" },
            warnings: { type: "array", items: { type: "string" } },
          },
          description: "≥2 幅时跑的多图一致性结论（单幅时不出现）",
        },
      },
    },
    aliases: ["PatentFigureCheck", "figure_check"],
    title: "Check Patent Figures",
    description:
      "Check patent figure compliance for CNIPA / PCT / USPTO: structural rules V1-V21, raster pixel gate " +
      "(black-and-white, line width, DPI, paper size), and delivered-SVG render checks. Provide FigureSpec " +
      "figures and/or svg_paths / image_paths plus spec_text. Returns findings, pixel_images, render checks, " +
      "and a deterministic ok verdict. Rule catalog: `patent-illustrator` skill. Use after " +
      "patent_figure_generate or for third-party figures.",
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
          description: "FigureSpec figures (same contract as patent_figure_generate).",
        },
        svg_paths: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description: "Delivered SVG paths to read back data-ref.",
        },
        image_paths: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description: "Raster figures for the pixel gate; no OCR.",
        },
        spec_text: {
          type: "string",
          description: "Specification text (claims + description) for V2/V3.",
        },
        claims_text: {
          type: "string",
          description: "Optional claims text (V10).",
        },
        description_text: {
          type: "string",
          description: "Optional description text (V11).",
        },
        document_kind: {
          type: "string",
          enum: ["invention", "utility"],
          description: "invention / utility (V9 utility requires drawings).",
        },
        jurisdiction: {
          type: "string",
          enum: JURISDICTIONS,
          description: "cn (CNIPA) / us (USPTO) / pct.",
        },
        figure_count: {
          type: "integer",
          minimum: 1,
          description: "Total figure count in the case.",
        },
        sheet_index: {
          type: "integer",
          minimum: 1,
          description: "Sheet index (paired with sheet_total).",
        },
        sheet_total: { type: "integer", minimum: 1, description: "Total sheets." },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input, context: SatiToolRuntimeContext) {
      const tool = "patent_figure_check";
      const documentKind = toDocumentKind(input.document_kind);
      const jurisdiction = toJurisdiction(input.jurisdiction);
      const profile = profileForJurisdiction(jurisdiction);
      const sheet = validateSheetArgs(input, tool);
      const figures: FigureSpec[] = [...(input.figures ?? [])];
      // 结构性校验只针对**调用方给出的结构化附图**：svg_paths 回读的骨架没有 nodes/chart 载荷
      // （回读的观测对象是图号与标记），套用"必须有节点"的约束会误伤那条通路。
      assertFigurePayloads(input.figures ?? [], tool);
      const svgPaths = input.svg_paths ?? [];
      // 已交付 SVG 的图号观测（V15/V16 的判据：图号的**可见形态**只在交付文件里可观测）与
      // 矢量源渲染复核（`RC*`：在 SVG 源上量测几何事实，与吃 FigureSpec 的 V* 规则互补）。
      const {
        figures: readbackFigures,
        numberedFigureNos,
        readbackFigureNos,
        renderChecks,
      } = await readbackSvgFigures(svgPaths, context.cwd, tool);
      figures.push(...readbackFigures);
      const imagePaths = input.image_paths ?? [];
      if (figures.length === 0 && imagePaths.length === 0) {
        throw new SatiToolRuntimeError("invalid_tool_input", "figures / svg_paths / image_paths 至少提供一项", {
          tool,
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
        // 渲染复核的 fail 与结构规则、像素门禁同权：RC1（文字被线贯穿）与 RC5（内容越出画布）
        // 都是"交付出去就读不出/看不到"的缺陷，不得只躺在报告里。
        const renderCheckFail = renderChecks
          .flatMap(entry => entry.findings)
          .filter(finding => finding.severity === "fail").length;
        const ok = result.ok && pixelFail === 0 && renderCheckFail === 0;

        let multiFigureConsistency: { summary: string; warnings: string[] } | undefined;
        if (figures.length >= 2) {
          const consistency = checkFigureConsistency(figureSpecsToAnalysis(figures), input.spec_text);
          multiFigureConsistency = { summary: consistency.summary, warnings: [...consistency.warnings] };
        }

        const lines = buildCheckReportLines({
          ok,
          result,
          figures,
          svgPaths,
          numberedFigureNos,
          pixelResults,
          renderChecks,
          multiFigureConsistency,
          jurisdiction,
        });
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          data: {
            ok,
            findings: result.findings,
            refs_in_figures: result.refsInFigures,
            refs_in_text: result.refsInText,
            pixel_images: pixelResults.map(entry => ({
              name: entry.name,
              width: entry.width,
              height: entry.height,
              dpi: entry.dpi,
              dpiEstimated: entry.dpiEstimated,
              inkRatio: entry.inkRatio,
              midGrayRatio: entry.midGrayRatio,
              ...(entry.linePx === undefined ? {} : { linePx: entry.linePx }),
              ...(entry.medianLinePx === undefined ? {} : { medianLinePx: entry.medianLinePx }),
              ...(entry.printedWidthMm === undefined ? {} : { printedWidthMm: entry.printedWidthMm }),
              ...(entry.printedHeightMm === undefined ? {} : { printedHeightMm: entry.printedHeightMm }),
              ...(entry.printedLineMm === undefined ? {} : { printedLineMm: entry.printedLineMm }),
              ...(entry.printedLineShrunkMm === undefined ? {} : { printedLineShrunkMm: entry.printedLineShrunkMm }),
              ...(entry.declaredFigureNo === undefined ? {} : { declaredFigureNo: entry.declaredFigureNo }),
              findings: entry.findings,
            })),
            render_check: renderChecks,
            ...(multiFigureConsistency === undefined ? {} : { multi_figure_consistency: multiFigureConsistency }),
          },
        };
      } catch (err) {
        // 与 patent_figure_generate/project 同法：`SatiToolRuntimeError` 原样透传，保住 `code`
        // 与 `details`（入参校验的 `invalid_tool_input` 不能被折叠成执行环境故障）。
        if (err instanceof SatiToolRuntimeError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new SatiToolRuntimeError("tool_execution_failed", `patent_figure_check 执行失败: ${message}`, {
          tool,
        });
      }
    },
  };
}
