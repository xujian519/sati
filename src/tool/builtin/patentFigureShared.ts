/**
 * patent_figure_* 三工具共用的入参管线（tool 层）。
 *
 * P2.5（issue #646）从三个 execute 里逐字重复的逻辑收敛到此。为什么值得单列：
 * - **textToPath Inkscape 探测**（先探测、后落盘，fail-loud）此前在 generate 与
 *   project 各写一遍；
 * - **sheet 成对校验**此前在三个工具各写一遍——check 还曾经对"只给一个"静默忽略，
 *   调用方以为声明了页码、实际 V17 未生效（假保证）。同一组入参三个工具必须给同一结论；
 * - **outputDir / output_name / documentKind** 归一化同理（schema.ts 已收 JSON Schema，
 * 这里收运行时收窄，两层分工不变）。
 *
 * 边界（诚实声明）：本模块只管**入参管线**——渲染、几何检查、产物装配与报告措辞仍归
 * 各工具（figuregen/deliverables.ts 收产物装配，本模块不收）。
 */

import { isAbsolute, resolve } from "node:path";
import {
  FIGURE_TEXT_TO_PATH_ENV,
  INKSCAPE_CMD_ENV,
  inkscapeInstallHint,
  isFigureTextToPathEnabled,
  resolveInkscapeCmd,
  type DocumentKind,
  type FigureSpec,
  type InkscapeProbe,
} from "../../patent/figuregen/index.js";
import { caseOutputsDir } from "../../patent/paths.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import { toSheet } from "./patentFigureSchema.js";

/** `SATI_FIGURE_TEXT_TO_PATH` 开启时的 Inkscape 探测（先探测、后落盘，防半成品目录）。 */
export function resolveInkscapeProbe(tool: string): InkscapeProbe | undefined {
  if (!isFigureTextToPathEnabled()) return undefined;
  try {
    const probe = resolveInkscapeCmd();
    if (probe !== undefined) return probe;
  } catch (err) {
    throw new SatiToolRuntimeError(
      "invalid_tool_input",
      `${FIGURE_TEXT_TO_PATH_ENV} 已开启，但 ${INKSCAPE_CMD_ENV} 指向的可执行文件不可用：${
        err instanceof Error ? err.message : String(err)
      }`,
      { tool },
    );
  }
  throw new SatiToolRuntimeError(
    "setup_required",
    `${FIGURE_TEXT_TO_PATH_ENV} 已开启但未找到 Inkscape：${inkscapeInstallHint()}`,
    { tool },
  );
}

/**
 * 落版参数：**部署级环境变量打底 + per-call 入参优先**（旋转角与图号/页码字号）。
 *
 * 两层形态的分工：落版体例（不同事务所的提交体例不同）属**部署级**，用环境变量承载
 * 与 `SATI_FIGURE_RENDER_GATE` / `SATI_FIGURE_FONT_MM` 的既有口径一致；而「这一幅图
 * 要转 90°」「这次图号用 4mm 字」是**本次调用**的显式选择 ⇒ 批次 B-1（重录窗口）
 * 接上了 per-call 入参（`submission` 对象），**入参优先、env 兜底**。
 *
 * 非法值（旋转角不是 0/90/180/270、字号非正数）在**落盘前** fail-loud，不静默回落。
 */

/** 落版旋转角的环境变量（0/90/180/270；缺省 0 = 不旋转）。 */
export const FIGURE_ROTATE_DEG_ENV = "SATI_FIGURE_ROTATE_DEG";
/** 图号字号的环境变量（毫米；缺省按模块默认值）。 */
export const FIGURE_CAPTION_FONT_MM_ENV = "SATI_FIGURE_CAPTION_FONT_MM";
/** 图形与图号间距的环境变量（毫米；缺省按模块默认值）。 */
export const FIGURE_CAPTION_GAP_MM_ENV = "SATI_FIGURE_CAPTION_GAP_MM";
/** 页码字号的环境变量（毫米；缺省按模块默认值）。 */
export const FIGURE_SHEET_FONT_MM_ENV = "SATI_FIGURE_SHEET_FONT_MM";

/** 读取正数毫米值；未设返回 undefined（用模块默认值），非法值 fail-loud。 */
function readPositiveMm(env: NodeJS.ProcessEnv, name: string, tool: string): number | undefined {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new SatiToolRuntimeError("invalid_tool_input", `非法 ${name} "${raw}"（须为正的毫米数）`, { tool });
  }
  return value;
}

/** 落版参数（部署级解析）。 */
export type SubmissionStyleOptions = {
  readonly rotateDeg: number;
  readonly captionFontMm: number | undefined;
  readonly captionGapMm: number | undefined;
  readonly sheetFontMm: number | undefined;
};

/**
 * 落版参数的 **per-call 覆盖**（工具入参形态）。
 *
 * 与部署级 env 的关系：**per-call 优先，env 兜底**（两者都保留，见
 * `docs/notes/implemented/2026-11-12-figure-dsh-alignment-batch-b0.md` 的
 * 「per-call vs env」取舍）。env 是体例/部署级默认值，入参是本次调用的显式选择。
 */
export type SubmissionStyleOverride = {
  readonly rotateDeg?: number;
  readonly captionFontMm?: number;
  readonly captionGapMm?: number;
  readonly sheetFontMm?: number;
};

/** 落版参数（部署级解析 + per-call 覆盖）。 */
export function resolveSubmissionStyle(
  env: NodeJS.ProcessEnv = process.env,
  tool = "patent_figure_generate",
  override?: SubmissionStyleOverride,
): SubmissionStyleOptions {
  const rawRotate = (env[FIGURE_ROTATE_DEG_ENV] ?? "").trim();
  const envRotateDeg = rawRotate === "" ? 0 : Number(rawRotate);
  if (!Number.isFinite(envRotateDeg) || ![0, 90, 180, 270].includes(envRotateDeg)) {
    throw new SatiToolRuntimeError(
      "invalid_tool_input",
      `非法 ${FIGURE_ROTATE_DEG_ENV} "${rawRotate}"（可用: 0 / 90 / 180 / 270）`,
      { tool },
    );
  }
  const rotateDeg = override?.rotateDeg ?? envRotateDeg;
  if (![0, 90, 180, 270].includes(rotateDeg)) {
    throw new SatiToolRuntimeError("invalid_tool_input", `非法 rotate_deg ${rotateDeg}（可用: 0 / 90 / 180 / 270）`, {
      tool,
    });
  }
  return {
    rotateDeg,
    captionFontMm: pickPositiveMm(
      override?.captionFontMm,
      readPositiveMm(env, FIGURE_CAPTION_FONT_MM_ENV, tool),
      "caption_font_mm",
      tool,
    ),
    captionGapMm: pickPositiveMm(
      override?.captionGapMm,
      readPositiveMm(env, FIGURE_CAPTION_GAP_MM_ENV, tool),
      "caption_gap_mm",
      tool,
    ),
    sheetFontMm: pickPositiveMm(
      override?.sheetFontMm,
      readPositiveMm(env, FIGURE_SHEET_FONT_MM_ENV, tool),
      "sheet_font_mm",
      tool,
    ),
  };
}

/** per-call 优先；per-call 给了非法值（<=0 或非有限数）当场报错，不静默回落 env。 */
function pickPositiveMm(
  overrideValue: number | undefined,
  envValue: number | undefined,
  label: string,
  tool: string,
): number | undefined {
  if (overrideValue === undefined) return envValue;
  if (!Number.isFinite(overrideValue) || overrideValue <= 0) {
    throw new SatiToolRuntimeError("invalid_tool_input", `非法 ${label} ${overrideValue}（须为正的毫米数）`, { tool });
  }
  return overrideValue;
}

/**
 * 自动标号开关（部署级）：`SATI_FIGURE_AUTO_NUMBERING=off|on`（缺省 off）。
 *
 * 开启后给「既无 `ref`、图面也没有可见标号」的节点按 100 系列发号（每幅图一个系列：
 * 图1→100、图2→200，步进 2）。默认关：自动发号会改写图面（新增可见标号），
 * 属需要显式选择的部署策略。
 */
export const FIGURE_AUTO_NUMBERING_ENV = "SATI_FIGURE_AUTO_NUMBERING";

export function resolveAutoNumbering(env: NodeJS.ProcessEnv = process.env, tool = "patent_figure_generate"): boolean {
  const raw = (env[FIGURE_AUTO_NUMBERING_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "off") return false;
  if (raw === "on") return true;
  throw new SatiToolRuntimeError("invalid_tool_input", `非法 ${FIGURE_AUTO_NUMBERING_ENV} "${raw}"（可用: off / on）`, {
    tool,
  });
}

/**
 * 只有内置渲染器能画的图型（graphviz 画不出 ⇒ 整体 fail-loud）。
 *
 * 为什么整体拒绝而不是「先画前几幅再报错」：graphviz 通路画不出坐标轴、生命线、
 * 元件符号、面板网格 —— 静默出一张错图比报错更坏（错图会被当成合规产物交付）。
 * 校验必须在**落盘之前**做，避免留下半成品目录。
 *
 * @returns 该图不可由 graphviz 绘制的原因（可渲染时返回 undefined）。
 */
export function builtinOnlyFigureReason(figure: FigureSpec): string | undefined {
  if (figure.kind === "chart") return "坐标轴与数据曲线";
  if (figure.kind === "sequence") return "生命线与消息时序";
  if (figure.kind === "circuit") return "电路元件符号";
  if (figure.panels !== undefined && figure.panels.length > 0) return "面板网格";
  if (figure.section !== undefined && figure.section.parts.length > 0) return "剖面轮廓与剖面线";
  return undefined;
}

/** 图型名（用于报错文案）。 */
function figureKindLabel(figure: FigureSpec): string {
  if (figure.kind === "chart") return "曲线图";
  if (figure.kind === "sequence") return "时序图";
  if (figure.kind === "circuit") return "电路图";
  if (figure.panels !== undefined && figure.panels.length > 0) return "多面板附图";
  if (figure.section !== undefined && figure.section.parts.length > 0) return "剖视图";
  return figure.kind;
}

/** 渲染通路不支持某些图型时，整体 fail-loud（落盘前）。 */
export function assertBuiltinRenderableFigures(
  figures: readonly FigureSpec[],
  renderer: string,
  rendererEnv: string,
  tool: string,
): void {
  const unsupported = figures.find(figure => builtinOnlyFigureReason(figure) !== undefined);
  if (unsupported === undefined) return;
  const reason = builtinOnlyFigureReason(unsupported) ?? "";
  throw new SatiToolRuntimeError(
    "tool_execution_failed",
    `图${unsupported.figure_no} 是${figureKindLabel(unsupported)}（kind="${unsupported.kind}"），` +
      `${rendererEnv} 通路（${renderer}）无法绘制${reason}：` +
      `请去掉 ${rendererEnv} 或设为 builtin 后重试（这些图型走内置矢量渲染器）`,
    { tool, figure_no: unsupported.figure_no },
  );
}

/** 输出目录：显式 output_dir 优先，其次案卷目录，缺省 .sati/figures/（cwd 相对）。 */
export function resolveFigureOutputDir(input: { output_dir?: string; case_id?: string }, cwd: string): string {
  return input.output_dir !== undefined
    ? isAbsolute(input.output_dir)
      ? input.output_dir
      : resolve(cwd, input.output_dir)
    : input.case_id !== undefined
      ? resolve(cwd, caseOutputsDir(input.case_id))
      : resolve(cwd, ".sati", "figures");
}

/** 输出文件名主干校验（generate 与 project 同一正则；schema 之外的长度/字符兜底）。 */
export function assertFigureOutputName(outputName: unknown, tool: string): asserts outputName is string {
  if (typeof outputName !== "string" || !/^[A-Za-z0-9._\-\u4e00-\u9fa5]{1,100}$/u.test(outputName)) {
    throw new SatiToolRuntimeError("invalid_tool_input", `非法 output_name: ${JSON.stringify(outputName)}`, {
      tool,
    });
  }
}

/** document_kind 运行时收窄（schema enum 之外的取值按缺省处理，三工具同规）。 */
export function toDocumentKind(value: unknown): DocumentKind | undefined {
  return value === "utility" ? "utility" : value === "invention" ? "invention" : undefined;
}

/**
 * 附图页声明校验（三工具同规）：成对给出且均 ≥1，index 不得超出 total。
 * 只给一个即抛错——页码体例由法域档案决定，缺一项无法判定，静默忽略是假保证。
 */
export function validateSheetArgs(
  input: { sheet_index?: unknown; sheet_total?: unknown },
  tool: string,
): { index: number; total: number } | undefined {
  const sheet = toSheet(input);
  if (sheet === undefined && (input.sheet_index !== undefined || input.sheet_total !== undefined)) {
    throw new SatiToolRuntimeError(
      "invalid_tool_input",
      "sheet_index 与 sheet_total 须成对给出且均 ≥1（附图页码体例由法域档案决定，缺一项无法判定）",
      { tool },
    );
  }
  if (sheet !== undefined && sheet.index > sheet.total) {
    throw new SatiToolRuntimeError("invalid_tool_input", `sheet_index ${sheet.index} 超出 sheet_total ${sheet.total}`, {
      tool,
    });
  }
  return sheet;
}
