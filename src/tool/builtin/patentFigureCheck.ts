/**
 * patent_figure_check — 附图 ↔ 说明书文字部分双向标记核验（细则第 21 条）+ 结构一致性。
 *
 * V1 图号连续 / V2 图→文 / V3 文→图（保守 WARN）/ V4 标记一致性 /
 * V5 禁注释 / V7 画幅可辨 / V8 摘要附图 / V9 实用新型必须有附图。
 *
 * 交付面复核（DR 族）：DR1 位图/照片、DR2 横向摆放、DR3 整幅框线（吃已交付的 SVG），
 * 以及 **DR4 交付物清单漂移**（吃 sidecar 的 `deliverables` 清单：内容哈希 / 大小 / 缺文件 /
 * 新增未登记产物；时序门需输入件落盘时刻，本工具拿不到 ⇒ 如实记为未量测）。
 *
 * 入参两选一：结构化 figures（与 patent_figure_generate 同契约），或 svg_paths
 * （回读 patent_figure_generate 产出的 SVG，解析 data-ref 与"图N"标注，对已交付
 * 文件复核）。fail 级发现 = 附图不得定稿（与 illustrator 完成标准一致）。
 *
 * **矢量量测输出**（`measurements`）：svg_paths 通路把矢量源上**量到的数**一并给出
 * ——画布尺寸（mm）、文字元素数、实测最小字高（mm）、线宽分布、线段取向分布——并在
 * 报告文本里加一段「矢量量测」分面。判据结论（findings）说「哪里不对」，量测值说
 * 「图到底多大、线多粗、字多高」：只给 findings 时，模型无法判断"线宽 0.2mm 到底算
 * 细不细"、"字高 2mm 够不够"，只能靠猜。
 *
 * 与 deepseek-harness 的差异：DSH 的 `verify_patent_figure` 是**独立工具**（单独注册、
 * 单独调用，**只报告不阻断**），输出就是量测值 + findings；本仓不另起工具，而是把量测
 * 值**并入既有核验工具 `patent_figure_check` 的输出面**——量测与判据同源同一次遍历，
 * 结论与数不出两张皮，代价是取数必须带 svg_paths 走这条通路（结构化 figures 通路没有
 * SVG ⇒ 不给 measurements，不编造）。字段**语义**对齐 DSH（`min_font_mm` 取**实测**
 * 最小字高；线宽升序、取向按线段数降序），字段名随本仓输出契约用 snake_case。
 *
 * P2.5（issue #646）：execute 的 250 行按「入参归一 → SVG 回读 → 核验与报告」分层；
 * 回读循环与报告构造收敛到模块级函数，sheet/documentKind 归一收进 patentFigureShared.ts。
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import {
  analyzeImageBuffer,
  assertSafeSvg,
  checkFigureHierarchy,
  checkFigureRendering,
  checkFigures,
  figureSidecarFileName,
  isSvgSafetyError,
  parseFigureSvg,
  profileForJurisdiction,
  readFigureSidecars,
  toRenderCheckFindings,
  type FigureCheckFinding,
  type FigureCheckSeverity,
  type FigureSpec,
  type Jurisdiction,
  type OfficeProfile,
} from "../../patent/figuregen/index.js";
// 交付面复核（DR 族 + 图面用语终检）：barrel 导出由主代理统一补齐，此处直连子模块
// （与 `patentFigureSchema.js` 的直连同例），避免两处改动互相等待。
import { checkFigureDelivery } from "../../patent/figuregen/delivery-review.js";
// 实测最小字高：与 `verify_patent_figure` 的 `minFontMm` 同义（量出来的最小字高，
// 不是判据下限）。barrel 导出由主代理统一补齐，此处直连子模块（同上例）。
import { measureMinimumFontHeightMm } from "../../patent/figuregen/render-check.js";
// 交付物清单核验（DR4）：同样直连子模块（barrel 导出由主代理统一补齐）。
import {
  checkDeliverableManifest,
  classifyDeliverableFileName,
  deliverableFigureNo,
  type DeliverableFinding,
  type DeliverableRole,
} from "../../patent/figuregen/deliverable-manifest.js";
import { figureSpecsToAnalysis } from "../../patent/figure/bridge.js";
import { checkFigureConsistency } from "../../patent/figure/multi-figure-consistency.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../protocol/types.js";
import {
  buildCheckReportLines,
  dedupeDeliveryFindings,
  type DeliverableManifestCheck,
  type DeliveryCheckEntry,
  type PixelGateEntry,
  type RenderCheckEntry,
} from "./patentFigureCheckReport.js";
import {
  assertFigurePayloads,
  FIGURE_FINDING_SCHEMA,
  FIGURE_INPUT_SCHEMA_REF,
  FIGURE_MEASUREMENT_SCHEMA,
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
  /** 声明的图内层级边（父标记 → 直接子标记）；给出时跑 RC8 一致性核对。 */
  hierarchy?: { parent: number; child: number }[];
};

/**
 * 一幅被核验 SVG 的**矢量量测值**（输出面 `measurements` 的一条）。
 *
 * 字段语义对齐 deepseek-harness 的 `verify_patent_figure` 输出（DSH 用 camelCase，
 * 本仓输出契约统一 snake_case）：画布尺寸（mm）、文字元素数、实测最小字高（mm）、
 * 线宽分布（mm → 元素数，**升序**）、线段取向分布（0–180° → 线段数，**降序**）——
 * 两个分布的排序沿用 `render-check` 的既有排序，两处口径一致。
 *
 * 诚实口径（不编造）：
 * - 根元素未声明画布尺寸 ⇒ `width_mm`/`height_mm` **缺省**（不填 0）；
 * - 图中无文字 ⇒ `text_count = 0` 且 `min_font_mm` 缺省；
 * - 部分结构超出量测范围（CSS 类样式、`<use>`/`<image>` 引用等）⇒ 量测值只覆盖
 *   **量到的**部分，缺口由既有 RC0「未量测」发现明示（分面行里也标注）；
 * - 安全门拒绝 / SVG 不可解析 ⇒ **整次核验失败**（既有 fail-loud 语义，报错消息
 *   写明原因），不会产出半份量测值。
 */
export type FigureMeasurement = {
  /** 被量测的 SVG 产物路径（与传入的 svg_paths 一致，便于回指）。 */
  readonly path: string;
  /** 图号（回读到时给）。 */
  readonly figure_no?: number;
  /** 画布宽（毫米）；根元素未声明时缺省。 */
  readonly width_mm?: number;
  /** 画布高（毫米）；根元素未声明时缺省。 */
  readonly height_mm?: number;
  /** 文字元素数（量到的）。 */
  readonly text_count: number;
  /** 实测最小字高（毫米）；图中无文字时缺省。 */
  readonly min_font_mm?: number;
  /** 线宽分布（毫米 → 元素数），升序。 */
  readonly stroke_width_mm: readonly { readonly width_mm: number; readonly count: number }[];
  /** 线段取向分布（0–180° → 线段数），按线段数降序。 */
  readonly orientation_deg: readonly { readonly orientation_deg: number; readonly count: number }[];
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
 *
 * 量测值（画布/文字/线宽/取向）与渲染复核**同源**：一次 {@link checkFigureRendering}
 * 既有判据结论也有量到的数，最小字高另由 {@link measureMinimumFontHeightMm} 量一次
 * （实测值，不是判据下限）。
 */
async function readbackSvgFigures(
  svgPaths: readonly string[],
  cwd: string,
  tool: string,
  jurisdiction: Jurisdiction,
): Promise<{
  figures: FigureSpec[];
  numberedFigureNos: number[];
  readbackFigureNos: number[];
  renderChecks: RenderCheckEntry[];
  deliveryChecks: DeliveryCheckEntry[];
  measurements: FigureMeasurement[];
}> {
  const figures: FigureSpec[] = [];
  const numberedFigureNos: number[] = [];
  const readbackFigureNos: number[] = [];
  const renderChecks: RenderCheckEntry[] = [];
  const deliveryChecks: DeliveryCheckEntry[] = [];
  const measurements: FigureMeasurement[] = [];
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
    const renderReport = checkFigureRendering(svg);
    renderChecks.push({ path: svgPath, findings: toRenderCheckFindings(renderReport.findings) });
    // 同一遍量测的**数值**一并带出（画布/文字/线宽/取向）：判据说"哪里不对"，量测值说
    // "图到底多大、线多粗、字多高"。最小字高是实测值（与 DSH `verify_patent_figure` 的
    // `minFontMm` 同义），另量一次。
    const minFontMm = measureMinimumFontHeightMm(svg);
    measurements.push({
      path: svgPath,
      figure_no: parsed.figureNo,
      ...(renderReport.widthMm === undefined ? {} : { width_mm: renderReport.widthMm }),
      ...(renderReport.heightMm === undefined ? {} : { height_mm: renderReport.heightMm }),
      text_count: renderReport.textCount,
      ...(minFontMm === undefined ? {} : { min_font_mm: minFontMm }),
      stroke_width_mm: renderReport.strokeWidthMm.map(entry => ({
        width_mm: entry.widthMm,
        count: entry.count,
      })),
      orientation_deg: renderReport.orientationDeg.map(entry => ({
        orientation_deg: entry.orientationDeg,
        count: entry.count,
      })),
    });
    // 交付面复核（DR1 位图/照片、DR2 横向摆放、DR3 整幅框线 + 图面用语终检）：
    // 判据只看**已交付的这份 SVG**，与吃 FigureSpec 的 V* 规则互补（回读骨架拿不到
    // 边标签与图面用语，用语只能在 SVG 上核）。
    deliveryChecks.push({
      path: svgPath,
      figure_no: parsed.figureNo,
      findings: checkFigureDelivery(svg, { jurisdiction }).map(finding => ({
        rule: finding.rule,
        severity: finding.severity,
        message: finding.message,
        ...(finding.evidence === undefined ? {} : { evidence: [...finding.evidence] }),
      })),
    });
  }
  return { figures, numberedFigureNos, readbackFigureNos, renderChecks, deliveryChecks, measurements };
}

/**
 * 「矢量量测」分面：每幅一行——画布 mm、文字数与实测最小字高、线宽分布、取向分布。
 *
 * 为什么要在**报告文本**里也写一遍（不只给结构化 data）：模型读工具输出时先读文本，
 * 量测值若只在 data 里，模型多半不会去翻 ⇒ "线宽 0.2mm 算不算细"、"最小字高 2mm 够
 * 不够"这类问题就只能靠猜。文本面给出 ⇒ 模型能直接拿数说话。
 *
 * 排序口径与结构化输出一致：线宽升序、取向按线段数降序。取向项数多时只列前 8 项
 * （与 DSH `verify_patent_figure` 的报告口径同），完整分布见结构化 `measurements`。
 */
function buildMeasurementFacetLines(
  measurements: readonly FigureMeasurement[],
  renderChecks: readonly RenderCheckEntry[],
): string[] {
  if (measurements.length === 0) return [];
  const lines: string[] = ["", "矢量量测（矢量源量测值：画布尺寸、文字度量、线宽分布、线段取向分布）："];
  for (const measurement of measurements) {
    const canvas =
      measurement.width_mm === undefined || measurement.height_mm === undefined
        ? "根元素未声明画布尺寸"
        : `画布 ${measurement.width_mm}×${measurement.height_mm} 毫米`;
    const text =
      measurement.text_count === 0
        ? "无文字"
        : `文字 ${measurement.text_count} 个（最小字高 ${measurement.min_font_mm ?? "未量得"} 毫米）`;
    const strokes =
      measurement.stroke_width_mm.length === 0
        ? "无"
        : measurement.stroke_width_mm.map(entry => `${entry.width_mm}mm×${entry.count}`).join("、");
    const orientationHead = measurement.orientation_deg.slice(0, 8);
    const orientations =
      orientationHead.length === 0
        ? "无"
        : `${orientationHead.map(entry => `${entry.orientation_deg}°×${entry.count}`).join("、")}${
            measurement.orientation_deg.length > orientationHead.length
              ? `（共 ${measurement.orientation_deg.length} 项，完整分布见结构化 measurements）`
              : ""
          }`;
    // 部分结构超出量测范围时**如实标注**：量测值只覆盖量到的部分（RC0 说明缺口在哪）。
    const notMeasured = renderChecks.some(
      entry =>
        entry.path === measurement.path &&
        entry.findings.some(finding => finding.rule === "RC0" && finding.severity === "info"),
    );
    lines.push(
      `- ${measurement.path}${measurement.figure_no === undefined ? "" : `（图${measurement.figure_no}）`}：` +
        `${canvas}，${text}，线宽分布 ${strokes}，取向分布 ${orientations}` +
        (notMeasured ? "；部分结构超出量测范围（见上方 RC0 未量测说明，量测值只覆盖量到的部分）" : ""),
    );
  }
  return lines;
}

/**
 * 把分面插到「依据」条款之前：依据条款是报告的落款，量测分面属正文。
 *
 * 未找到落款行时退化为追加到末尾（不丢内容）。
 */
function insertLinesBeforeBasis(lines: readonly string[], facet: readonly string[]): string[] {
  if (facet.length === 0) return [...lines];
  const basisIndex = lines.findIndex(line => line.startsWith("依据：") || line.startsWith("Basis:"));
  if (basisIndex < 0) return [...lines, ...facet];
  const head = lines.slice(0, basisIndex);
  if (head.length > 0 && head[head.length - 1] === "") head.pop();
  return [...head, ...facet, "", ...lines.slice(basisIndex)];
}

/**
 * DR4 的级别映射：内容漂移 / 缺文件 = `fail`（交出去的不是登记的那份，或登记的那份不见了）；
 * 未登记产物 / 时序倒挂 = `warn`（可疑但未证伪）。
 */
const DELIVERABLE_SEVERITY: Record<DeliverableFinding["id"], FigureCheckSeverity> = {
  "file-missing": "fail",
  "hash-mismatch": "fail",
  "size-mismatch": "fail",
  "not-in-manifest": "warn",
  "stale-output": "warn",
};

/** 一条清单发现 → 一条 DR4 finding（图号可从产物文件名推出时带上）。 */
function toDeliverableFinding(finding: DeliverableFinding): FigureCheckFinding {
  const figureNo = finding.file === undefined ? undefined : deliverableFigureNo(finding.file);
  return {
    // DR4 已登记在 `FigureCheckRuleId`（check.ts，交付面族 DR1–DR4）。
    rule: "DR4",
    severity: DELIVERABLE_SEVERITY[finding.id],
    message: finding.message,
    ...(figureNo === undefined ? {} : { figure_nos: [figureNo] }),
    evidence: [finding.file ?? "（未指明文件）", ...(finding.evidence ?? [])],
  };
}

/**
 * 交付物清单核验：清单（sidecar 的 `deliverables`）↔ 当前目录的产物。
 *
 * 接入点是 `svg_paths` 通路——"已交付的那份"只在这条通路上是**文件**（结构化 `figures`
 * 通路没有产物目录，无从比对）。
 *
 * 范围口径：只比对**同一 output_name** 的产物（`<name>-…` 前缀）——同目录里别的 output
 * 的产物不是"本清单漏登记的产物"，报出来是噪音。sidecar 自身从两侧排除（清单写进
 * sidecar 的那一刻它的哈希就变了，自比必然报漂移）。
 *
 * 时序门（产物早于输入件）在本工具**不执行**：本工具拿到的是 spec_text **文本**，没有
 * 输入件的落盘时刻可比（清单契约里也没有输入件字段）⇒ 如实记为"未量测"，不判通过。
 */
async function runDeliverableManifestCheck(args: {
  svgPaths: readonly string[];
  cwd: string;
}): Promise<DeliverableManifestCheck | undefined> {
  const first = args.svgPaths[0];
  if (first === undefined) return undefined;
  const dir = dirname(isAbsolute(first) ? first : resolve(args.cwd, first));
  let sidecars;
  try {
    sidecars = await readFigureSidecars(dir);
  } catch (err) {
    return {
      status: "unavailable",
      dir,
      findings: [],
      note: `交付物清单一致性本次未核验（sidecar 读取失败：${err instanceof Error ? err.message : String(err)}）`,
    };
  }
  const carrier = sidecars.find(sidecar => sidecar.deliverables !== undefined);
  if (carrier === undefined) {
    return {
      status: "not-registered",
      dir,
      findings: [],
      note: "交付物清单未登记（sidecar 无 deliverables 字段），清单一致性本次未核验",
    };
  }
  const carrierFile = figureSidecarFileName(carrier.output_name);
  let dirEntries: string[];
  try {
    dirEntries = (await readdir(dir)).sort();
  } catch (err) {
    return {
      status: "unavailable",
      dir,
      findings: [],
      note: `交付物清单一致性本次未核验（产物目录不可读：${err instanceof Error ? err.message : String(err)}）`,
    };
  }
  const prefix = `${carrier.output_name}-`;
  const current: { role: DeliverableRole; path: string }[] = [];
  for (const name of dirEntries) {
    if (!name.startsWith(prefix)) continue;
    if (name === carrierFile) continue;
    const role = classifyDeliverableFileName(name);
    if (role === undefined) continue;
    current.push({ role, path: resolve(dir, name) });
  }
  const findings = await checkDeliverableManifest({
    manifest: (carrier.deliverables ?? []).filter(entry => entry.file !== carrierFile),
    current,
    // 输入件时刻来自 sidecar（可选）：没有登记 ⇒ 时序门不执行（报告如实声明）。
    ...(carrier.deliverableInputs === undefined ? {} : { inputs: carrier.deliverableInputs }),
  });
  return {
    status: "verified",
    dir,
    findings: findings.map(toDeliverableFinding),
    note: "",
  };
}

export function createPatentFigureCheckTool(): SatiToolDefinition<PatentFigureCheckInput> {
  return {
    name: "patent_figure_check",
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "findings", "refs_in_figures", "refs_in_text"],
      properties: {
        ok: {
          type: "boolean",
          description: "无 fail 级发现（结构规则 + 栅格像素门禁 + 渲染复核 + 交付面复核合并判定）",
        },
        findings: {
          type: "array",
          items: FIGURE_FINDING_SCHEMA,
          description: "结构规则（V*）与交付面复核（DR* 位图/横向/整幅框线、图面用语 V12–V14）发现",
        },
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
          description: "Delivered-SVG render checks (RC0-RC9); empty without svg_paths.",
        },
        measurements: {
          type: "array",
          items: FIGURE_MEASUREMENT_SCHEMA,
          description:
            "矢量量测值（画布尺寸/文字数/实测最小字高/线宽分布/取向分布，每幅一条）；" +
            "未走 svg_paths 通路时为空数组",
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
      "核验附图合规（CNIPA/PCT/USPTO）：结构规则 V1–V22、栅格像素门禁、已交付 SVG 渲染复核（RC）。" +
      "规则目录见 `patent-illustrator` skill；" +
      "只读。ok 为各通路 fail 合并判定；未提供的通路不核验，不得据此宣称全通过。" +
      "详见 skills/patent-illustrator/references/patent-tool-contracts/figure.md。",
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
          description: "FigureSpec 附图（契约同 patent_figure_generate）。",
        },
        svg_paths: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description: "已交付 SVG 路径（回读 data-ref）。",
        },
        image_paths: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description: "栅格附图路径（像素门禁；不做 OCR）。",
        },
        spec_text: {
          type: "string",
          description: "说明书文本（权利要求+说明书），V2/V3 用。",
        },
        claims_text: {
          type: "string",
          description: "权利要求文本（V10）。",
        },
        description_text: {
          type: "string",
          description: "说明书文本（V11）。",
        },
        document_kind: {
          type: "string",
          enum: ["invention", "utility"],
          description: "invention / utility（V9：实用新型须附图）。",
        },
        jurisdiction: {
          type: "string",
          enum: JURISDICTIONS,
          description: "cn(CNIPA) / us(USPTO) / pct。",
        },
        figure_count: {
          type: "integer",
          minimum: 1,
          description: "本案附图总幅数。",
        },
        sheet_index: {
          type: "integer",
          minimum: 1,
          description: "附图页序号（与 sheet_total 成对）。",
        },
        sheet_total: { type: "integer", minimum: 1, description: "附图页总页数。" },
        hierarchy: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["parent", "child"],
            properties: {
              parent: { type: "integer", description: "父标记号。" },
              child: { type: "integer", description: "直接子标记号。" },
            },
          },
          description: "声明的父→子标记边（RC8，warn 不阻断）。",
        },
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
        deliveryChecks,
        measurements,
      } = await readbackSvgFigures(svgPaths, context.cwd, tool, jurisdiction);
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
        // 交付面复核（DR 族）的 fail 与结构规则、像素门禁、渲染复核同权：位图/照片、
        // 横向摆放、整幅框线都是"交出去就不符合提交要求"的缺陷，不得只躺在报告里。
        const deliveryFindings: FigureCheckFinding[] = dedupeDeliveryFindings(
          result.findings,
          deliveryChecks.flatMap(entry =>
            entry.findings.map(finding => ({
              rule: finding.rule,
              severity: finding.severity,
              message: finding.message,
              figure_nos: [entry.figure_no],
              evidence: [entry.path, ...(finding.evidence ?? [])],
            })),
          ),
        );
        const deliveryFail = deliveryFindings.filter(finding => finding.severity === "fail").length;
        // 交付物清单核验（DR4）：与既有交付面复核同一通路（svg_paths ⇒ 产物是文件）。
        // fail 级（内容漂移 / 缺文件）与其它 fail 同权——交出去的不是登记的那份，
        // 不能只躺在报告里。
        const manifestCheck = await runDeliverableManifestCheck({ svgPaths, cwd: context.cwd });
        const manifestFindings = manifestCheck?.findings ?? [];
        const manifestFail = manifestFindings.filter(finding => finding.severity === "fail").length;
        // RC8（图内层级 ↔ 权利要求归属表述）：调用方声明了「父标记 → 直接子标记」的层级边时，
        // 与权利要求/说明书文本里的归属表述对拍。**只提示不阻断**（warn）：层级表述的
        // 抽取是启发式的，误报不能变成交付门禁。
        const hierarchyFindings =
          input.hierarchy === undefined
            ? []
            : checkFigureHierarchy({
                edges: input.hierarchy,
                claimText: input.claims_text ?? input.spec_text,
              });
        const ok = result.ok && pixelFail === 0 && renderCheckFail === 0 && deliveryFail === 0 && manifestFail === 0;

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
          deliveryChecks,
          manifestCheck,
          multiFigureConsistency,
          jurisdiction,
          hierarchyFindings,
        });
        // 量测分面进报告文本（模型先读文本；量测值只在 data 里多半读不到）。
        const reportLines = insertLinesBeforeBasis(lines, buildMeasurementFacetLines(measurements, renderChecks));
        return {
          content: [{ type: "text", text: reportLines.join("\n") }],
          data: {
            ok,
            findings: [...result.findings, ...deliveryFindings, ...manifestFindings, ...hierarchyFindings],
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
            measurements: measurements.map(entry => ({
              ...entry,
              stroke_width_mm: entry.stroke_width_mm.map(item => ({ ...item })),
              orientation_deg: entry.orientation_deg.map(item => ({ ...item })),
            })),
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
