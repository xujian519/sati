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
    "tool_execution_failed",
    `${FIGURE_TEXT_TO_PATH_ENV} 已开启但未找到 Inkscape：${inkscapeInstallHint()}`,
    { tool },
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
