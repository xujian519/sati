/**
 * patent_figure_annotate — 向**已交付** SVG 补写附图标记（可见标号）+ 登记核对。
 *
 * 能力来源（纯函数模块，本工具不改其逻辑）：
 * - `annotateSvgWithReferences`：在既有 SVG 的 `<text>` 图元上追加「名称(20)」形态的可见标号
 *   （本仓惯例，无空格，与 `stripRefMark` / `normalizeRefLabel` 同一词法）；
 * - `validateSvgReferences`：回读图面上出现的附图标记，核对是否都在登记集合内。
 *
 * 为什么需要它：`patent_figure_generate` 把附图标记写进 **data-ref 属性**（机器可读、图面
 * 上看不见）；读者要靠「说明书里的 20」对上「图上的哪个部件」，图面必须**看得见** (20)。
 * 本工具补的就是这一步：已交付 SVG 读进来 → 补写可见标号 → 写回新文件。
 *
 * 诚实口径（**不把"没标上"说成"已标注"**）：
 * - `written`：本次**真的写进文件**的标记（按标注前后字面量增量判定，不是"模块说命中了"）；
 * - `already_present`：图面本来就带该标记（模块不重复追加），**不算**本次写入；
 * - `unmatched`：图面上找不到对应文字 ⇒ 未写入，报告里逐条点名（ref + 定位文字）；
 * - `validation.unknown`：图面上出现、但不在本次登记（本次请求的 ref 集合）内的标记
 *   ——此前批次写入的标记也会落在这里，如实报出，不静默吞掉。
 *
 * 路径口径：相对路径按 `context.cwd` 解析；`output_path` 缺省时在输入文件同目录写
 * `<stem>-annotated.svg`（原件保留，不就地覆盖）；输出目录不存在时 `mkdir -p`。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import {
  annotateSvgWithReferences,
  validateSvgReferences,
  type SvgAnnotateResult,
  type SvgReferenceRequest,
  type SvgUnmatchedReference,
} from "../../patent/figuregen/svg-annotate.js";
import { isSvgSafetyError } from "../../patent/figuregen/svg-safety.js";
import { REF_NUMERAL_PRACTICAL_MAX } from "../../patent/figuregen/numeral.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../protocol/types.js";

/** 一条待写入的附图标记（工具入参形态）。 */
export type PatentFigureAnnotateReference = {
  /** 附图标记（阿拉伯数字，1..999）；写入形态为 `(ref)`。 */
  readonly ref: number;
  /** 图面上用来定位的可见文字（子串匹配，大小写不敏感）；缺省时用 `(ref)` 形态。 */
  readonly label?: string;
};

/** 工具入参。 */
export type PatentFigureAnnotateInput = {
  /** 要补写标记的 SVG 文件路径（相对路径按工作目录解析）。 */
  readonly svg_path: string;
  /** 要写入的附图标记（至少 1 条）。 */
  readonly references: readonly PatentFigureAnnotateReference[];
  /** 输出路径；缺省时在输入文件同目录写 `<stem>-annotated.svg`。 */
  readonly output_path?: string;
  /** 只校验与计算，不落盘。 */
  readonly dry_run?: boolean;
};

/** 一条标记的处理结果（输出面 `written` / `already_present` / `unmatched` 的一条）。 */
export type PatentFigureAnnotateRefEntry = {
  /** 附图标记数字。 */
  readonly ref: number;
  /** 定位文字（图面上的可见文字；缺省时是 `(ref)` 形态）。 */
  readonly label: string;
};

/** 工具 canonical 输出（受 `outputSchema` 约束）。 */
export type PatentFigureAnnotateOutput = {
  /** 标注后 SVG 的落盘路径（`dry_run` 时为空串）。 */
  readonly annotated_path: string;
  /** 本次真的写入文件的标记。 */
  readonly written: readonly PatentFigureAnnotateRefEntry[];
  /** 图面本来就带该标记（未重复写入）。 */
  readonly already_present: readonly PatentFigureAnnotateRefEntry[];
  /** 图面上找不到对应文字、未写入的标记。 */
  readonly unmatched: readonly PatentFigureAnnotateRefEntry[];
  /** 回读核对：登记集合与图面上出现但未登记的标记。 */
  readonly validation: {
    /** 本次登记（请求）的标记集合（去重升序）。 */
    readonly known: readonly number[];
    /** 图面上出现、但不在登记集合内的标记（去重升序）。 */
    readonly unknown: readonly number[];
  };
  /** 全部请求标记都已落到图面（本次写入或图面已有）。 */
  readonly ok: boolean;
  /** 是否只算不写。 */
  readonly dry_run: boolean;
  /** 输入 SVG 路径。 */
  readonly source_path: string;
};

/** 内部归一后的标记（`text` 是模块侧用来定位的文字）。 */
type NormalizedReference = {
  readonly ref: number;
  readonly label: string;
  readonly text: string;
};

/** 标记的处理状态。 */
type RefStatus = "written" | "already_present" | "unmatched";

/** 归一后带状态的标记。 */
type ClassifiedReference = {
  readonly ref: number;
  readonly label: string;
  readonly status: RefStatus;
};

/** 工具名（错误详情与报告文本共用）。 */
const TOOL = "patent_figure_annotate";

/** 错误消息里的取值描述（帮调用方看清"到底传了什么"）。 */
function describeValue(value: unknown): string {
  if (typeof value === "string") return `字符串 ${JSON.stringify(value)}`;
  if (value === null) return "null";
  if (Array.isArray(value)) return `数组（长度 ${value.length}）`;
  if (typeof value === "object") return "对象";
  return `${typeof value} ${String(value)}`;
}

/** 取非空字符串（否则抛可操作的入参错误）。 */
function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SatiToolRuntimeError("invalid_tool_input", `${field} 必须是非空字符串（当前：${describeValue(value)}）`, {
      tool: TOOL,
      field,
    });
  }
  return value;
}

/**
 * 归一 `references`：校验附图标记取值，缺省定位文字用 `(ref)` 形态。
 *
 * 附图标记上限取 {@link REF_NUMERAL_PRACTICAL_MAX}（三位数实务上限）：超过它的数字更可能是
 * 年份/页码，且回读核对侧不计入附图标记形态 ⇒ 放行会写出**核验器看不见**的标号，不如当场拒。
 */
function normalizeReferences(value: unknown): NormalizedReference[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SatiToolRuntimeError(
      "invalid_tool_input",
      `references 必须是非空数组（至少 1 条 {ref, label?}；当前：${describeValue(value)}）`,
      { tool: TOOL, field: "references" },
    );
  }
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new SatiToolRuntimeError(
        "invalid_tool_input",
        `references[${index}] 必须是对象 {ref, label?}（当前：${describeValue(item)}）`,
        {
          tool: TOOL,
          field: `references[${index}]`,
        },
      );
    }
    const record = item as Record<string, unknown>;
    const ref = record.ref;
    if (typeof ref !== "number" || !Number.isInteger(ref) || ref < 1 || ref > REF_NUMERAL_PRACTICAL_MAX) {
      throw new SatiToolRuntimeError(
        "invalid_tool_input",
        `references[${index}].ref 必须是 1..${REF_NUMERAL_PRACTICAL_MAX} 的整数附图标记（当前：${describeValue(ref)}）`,
        { tool: TOOL, field: `references[${index}].ref` },
      );
    }
    const rawLabel = record.label;
    if (rawLabel !== undefined && typeof rawLabel !== "string") {
      throw new SatiToolRuntimeError(
        "invalid_tool_input",
        `references[${index}].label 必须是字符串（当前：${describeValue(rawLabel)}）`,
        { tool: TOOL, field: `references[${index}].label` },
      );
    }
    // 定位文字缺省（或空串）时用 `(ref)` 形态：图面上已经带该标记的图元才匹配得到。
    const label = typeof rawLabel === "string" && rawLabel.trim() !== "" ? rawLabel.trim() : `(${ref})`;
    return { ref, label, text: label };
  });
}

/** 解析输出路径：缺省时在输入文件同目录写 `<stem>-annotated.svg`。 */
function resolveOutputPath(outputPath: unknown, inputAbsolutePath: string, cwd: string): string {
  if (outputPath === undefined) {
    const extension = extname(inputAbsolutePath);
    const stem = extension === "" ? basename(inputAbsolutePath) : basename(inputAbsolutePath, extension);
    return resolve(dirname(inputAbsolutePath), `${stem}-annotated.svg`);
  }
  const requested = requireNonEmptyString(outputPath, "output_path");
  return isAbsolute(requested) ? requested : resolve(cwd, requested);
}

/**
 * 统计字面量 `(numeral)` 在 SVG 文本中的出现次数。
 *
 * 只用于**差分**：模块只插入 `(${numeral})` 一种字面量，故
 * `count(after) - count(before)` 就是本次写入该标记的次数（属性/注释里的同形字面量在前后
 * 两侧同样计入，差值仍只反映真实写入）。
 */
function countMarkLiteral(svg: string, numeral: number): number {
  const literal = `(${numeral})`;
  let count = 0;
  let index = svg.indexOf(literal);
  while (index !== -1) {
    count += 1;
    index = svg.indexOf(literal, index + literal.length);
  }
  return count;
}

/**
 * 判定每条请求的最终去向：**写入了 / 图面已有 / 未命中**。
 *
 * - 未命中：模块给出的未命中清单按传入顺序回指到输入下标（清单本身不含下标，靠"文本 + 标记"
 *   逐条对齐；重复请求按出现次序配对）。
 * - 写入名额：每个标记的"名额"= 标注前后该标记字面量的增量。模块对同一图元只处理一次
 *   （先命中先得），且图元已带该标记时不重复追加 ⇒ 增量即真实写入次数。按输入顺序领取
 *   名额，与模块"先命中先得"的次序一致。
 */
function classifyReferences(
  references: readonly NormalizedReference[],
  unmatchedFromModule: readonly SvgUnmatchedReference[],
  before: string,
  after: string,
): ClassifiedReference[] {
  const unmatchedIndexes = new Set<number>();
  const consumed = new Set<number>();
  for (const entry of unmatchedFromModule) {
    const index = references.findIndex(
      (reference, i) => !consumed.has(i) && reference.text === entry.text && reference.ref === entry.numeral,
    );
    if (index >= 0) {
      consumed.add(index);
      unmatchedIndexes.add(index);
    }
  }

  const slots = new Map<number, number>();
  for (const reference of references) {
    if (!slots.has(reference.ref)) {
      slots.set(reference.ref, countMarkLiteral(after, reference.ref) - countMarkLiteral(before, reference.ref));
    }
  }

  return references.map((reference, index) => {
    if (unmatchedIndexes.has(index)) {
      return { ref: reference.ref, label: reference.label, status: "unmatched" };
    }
    const remaining = slots.get(reference.ref) ?? 0;
    if (remaining > 0) {
      slots.set(reference.ref, remaining - 1);
      return { ref: reference.ref, label: reference.label, status: "written" };
    }
    return { ref: reference.ref, label: reference.label, status: "already_present" };
  });
}

/** 报告里的一条标记写法：`(20)→「处理模块」`。 */
function formatRefEntry(entry: PatentFigureAnnotateRefEntry): string {
  return `(${entry.ref})→「${entry.label}」`;
}

/** 报告里的一组标记（空组返回空串，避免留下"："后面什么都没有）。 */
function formatRefEntries(entries: readonly PatentFigureAnnotateRefEntry[]): string {
  if (entries.length === 0) return "";
  return ` — ${entries.map(formatRefEntry).join("、")}`;
}

/** 报告正文（模型先读文本，结构化值在 data 里）。 */
function buildReportLines(args: {
  readonly sourcePath: string;
  readonly annotatedPath: string;
  readonly dryRun: boolean;
  readonly requested: readonly PatentFigureAnnotateRefEntry[];
  readonly written: readonly PatentFigureAnnotateRefEntry[];
  readonly alreadyPresent: readonly PatentFigureAnnotateRefEntry[];
  readonly unmatched: readonly PatentFigureAnnotateRefEntry[];
  readonly known: readonly number[];
  readonly unknown: readonly number[];
  readonly ok: boolean;
}): string[] {
  const lines: string[] = [];
  lines.push("附图标记补写（patent_figure_annotate）");
  lines.push(`输入 SVG：${args.sourcePath}`);
  lines.push(args.dryRun ? "输出 SVG：（dry_run：只校验与计算，未落盘）" : `输出 SVG：${args.annotatedPath}`);
  lines.push(`请求标记：${args.requested.length} 条${formatRefEntries(args.requested)}`);
  lines.push(`已写入（可见标号）：${args.written.length} 条${formatRefEntries(args.written)}`);
  lines.push(`图面已有（未重复写入）：${args.alreadyPresent.length} 条${formatRefEntries(args.alreadyPresent)}`);
  lines.push(`未命中（未写入）：${args.unmatched.length} 条${formatRefEntries(args.unmatched)}`);
  lines.push(
    `登记核对：本次登记 ${args.known.length} 个标记（图面出现但不在登记集合内：${args.unknown.length} 个${
      args.unknown.length === 0 ? "" : ` — ${args.unknown.map(value => `(${value})`).join("、")}`
    }）`,
  );
  lines.push(
    args.ok
      ? "结论：全部请求标记均已落到图面（本次写入或图面已有）"
      : `结论：未全部标注（未命中 ${args.unmatched.length} 条，对应文字未在图面上找到）`,
  );
  return lines;
}

/** 读盘失败 → 可操作的错误（区分"文件不存在"与"读不了"）。 */
function toReadError(error: unknown, absolutePath: string, givenPath: string, cwd: string): SatiToolRuntimeError {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") {
    return new SatiToolRuntimeError(
      "file_not_found",
      `附图 SVG 不存在：${absolutePath}（传入 svg_path=${givenPath}，相对路径按工作目录 ${cwd} 解析）`,
      { tool: TOOL, path: absolutePath },
    );
  }
  return new SatiToolRuntimeError("tool_execution_failed", `读取附图 SVG 失败（${absolutePath}）：${message}`, {
    tool: TOOL,
    path: absolutePath,
  });
}

export function createPatentFigureAnnotateTool(): SatiToolDefinition<
  PatentFigureAnnotateInput,
  PatentFigureAnnotateOutput
> {
  return {
    name: "patent_figure_annotate",
    aliases: ["PatentFigureAnnotate", "figure_annotate"],
    title: "Annotate Patent Figure References",
    description:
      'Append patent reference numerals (visible marks such as "处理模块(20)") to a delivered SVG and verify ' +
      "the visible marks against the registered set. Provide svg_path plus references [{ref, label}]: ref is the " +
      "numeral to write (1..999), label is the visible text to locate (substring, case-insensitive; defaults to " +
      'the "(ref)" form). Writes <stem>-annotated.svg unless output_path is given; dry_run computes without ' +
      "writing. Returns written / already_present / unmatched marks, the registration check and ok. " +
      "Reference-mark rules: `patent-illustrator` skill.",
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["svg_path", "references"],
      properties: {
        svg_path: {
          type: "string",
          description: "SVG file to annotate (relative paths resolve against the workspace cwd).",
        },
        references: {
          type: "array",
          minItems: 1,
          description:
            "Marks to write: ref = numeral (1..999), label = visible text to locate " +
            '(substring, case-insensitive; defaults to the "(ref)" form).',
          items: {
            type: "object",
            additionalProperties: false,
            required: ["ref"],
            properties: {
              ref: { type: "integer", minimum: 1, description: "Reference numeral, written as (ref)." },
              label: {
                type: "string",
                description: 'Visible text on the figure to locate (e.g. "处理模块"); defaults to "(ref)".',
              },
            },
          },
        },
        output_path: {
          type: "string",
          description: "Output path; defaults to <stem>-annotated.svg next to the input SVG.",
        },
        dry_run: {
          type: "boolean",
          description: "Compute and validate only, do not write any file (default false).",
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "annotated_path",
        "written",
        "already_present",
        "unmatched",
        "validation",
        "ok",
        "dry_run",
        "source_path",
      ],
      properties: {
        annotated_path: { type: "string", description: "Written SVG path (empty on dry_run)." },
        written: {
          type: "array",
          description: "Marks actually written into the file this run.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["ref", "label"],
            properties: {
              ref: { type: "integer" },
              label: { type: "string" },
            },
          },
        },
        already_present: {
          type: "array",
          description: "Marks already visible on the figure (not re-written).",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["ref", "label"],
            properties: {
              ref: { type: "integer" },
              label: { type: "string" },
            },
          },
        },
        unmatched: {
          type: "array",
          description: "Marks whose target text was not found on the figure (not written).",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["ref", "label"],
            properties: {
              ref: { type: "integer" },
              label: { type: "string" },
            },
          },
        },
        validation: {
          type: "object",
          additionalProperties: false,
          required: ["known", "unknown"],
          properties: {
            known: { type: "array", items: { type: "integer" }, description: "Registered marks (this request)." },
            unknown: {
              type: "array",
              items: { type: "integer" },
              description: "Marks visible on the figure but outside the registered set.",
            },
          },
        },
        ok: { type: "boolean", description: "Every requested mark is on the figure (written now or already there)." },
        dry_run: { type: "boolean" },
        source_path: { type: "string" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    async execute(input, context: SatiToolRuntimeContext) {
      const givenPath = requireNonEmptyString(input.svg_path, "svg_path");
      const sourceAbsolute = isAbsolute(givenPath) ? givenPath : resolve(context.cwd, givenPath);
      const references = normalizeReferences(input.references);
      const dryRun = input.dry_run === true;
      const annotatedAbsolute = resolveOutputPath(input.output_path, sourceAbsolute, context.cwd);

      let originalSvg: string;
      try {
        originalSvg = await readFile(sourceAbsolute, "utf8");
      } catch (error) {
        throw toReadError(error, sourceAbsolute, givenPath, context.cwd);
      }

      const requests: SvgReferenceRequest[] = references.map(reference => ({
        text: reference.text,
        numeral: reference.ref,
      }));

      let annotated: SvgAnnotateResult;
      try {
        annotated = annotateSvgWithReferences(originalSvg, requests);
      } catch (error) {
        if (isSvgSafetyError(error)) {
          throw new SatiToolRuntimeError(
            "invalid_tool_input",
            `附图 SVG 未通过安全门（${error.code}）：${error.message}（路径 ${sourceAbsolute}）`,
            { tool: TOOL, path: sourceAbsolute, reason: error.code },
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new SatiToolRuntimeError(
          "tool_execution_failed",
          `patent_figure_annotate 标注失败（${sourceAbsolute}）：${message}`,
          {
            tool: TOOL,
            path: sourceAbsolute,
          },
        );
      }

      const classified = classifyReferences(references, annotated.unmatched, originalSvg, annotated.svg);
      const written = classified.filter(entry => entry.status === "written");
      const alreadyPresent = classified.filter(entry => entry.status === "already_present");
      const unmatched = classified.filter(entry => entry.status === "unmatched");

      // 回读核对：登记集合 = 本次请求的标记（去重升序）；图面上出现但不在集合内的标记如实报出。
      const known = [...new Set(references.map(reference => reference.ref))].sort((a, b) => a - b);
      let unknown: readonly number[];
      try {
        unknown = validateSvgReferences(annotated.svg, known).unknown;
      } catch (error) {
        if (isSvgSafetyError(error)) {
          throw new SatiToolRuntimeError(
            "invalid_tool_input",
            `附图 SVG 未通过安全门（${error.code}）：${error.message}（路径 ${sourceAbsolute}）`,
            { tool: TOOL, path: sourceAbsolute, reason: error.code },
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new SatiToolRuntimeError(
          "tool_execution_failed",
          `patent_figure_annotate 回读核对失败（${sourceAbsolute}）：${message}`,
          { tool: TOOL, path: sourceAbsolute },
        );
      }

      if (!dryRun) {
        try {
          await mkdir(dirname(annotatedAbsolute), { recursive: true });
          await writeFile(annotatedAbsolute, annotated.svg, "utf8");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new SatiToolRuntimeError(
            "tool_execution_failed",
            `写入标注后的附图失败（${annotatedAbsolute}）：${message}`,
            { tool: TOOL, path: annotatedAbsolute },
          );
        }
      }

      const toEntry = (entry: ClassifiedReference): PatentFigureAnnotateRefEntry => ({
        ref: entry.ref,
        label: entry.label,
      });
      const writtenEntries = written.map(toEntry);
      const alreadyPresentEntries = alreadyPresent.map(toEntry);
      const unmatchedEntries = unmatched.map(toEntry);
      const requestedEntries = references.map(reference => ({ ref: reference.ref, label: reference.label }));
      // 未命中即"没标上" ⇒ 不判成功（已写入 / 图面已有都算落到图面）。
      const ok = unmatchedEntries.length === 0;

      const reportLines = buildReportLines({
        sourcePath: sourceAbsolute,
        annotatedPath: annotatedAbsolute,
        dryRun,
        requested: requestedEntries,
        written: writtenEntries,
        alreadyPresent: alreadyPresentEntries,
        unmatched: unmatchedEntries,
        known,
        unknown,
        ok,
      });

      const output: PatentFigureAnnotateOutput = {
        annotated_path: dryRun ? "" : annotatedAbsolute,
        written: writtenEntries,
        already_present: alreadyPresentEntries,
        unmatched: unmatchedEntries,
        validation: { known, unknown: [...unknown] },
        ok,
        dry_run: dryRun,
        source_path: sourceAbsolute,
      };

      return {
        content: [{ type: "text", text: reportLines.join("\n") }],
        data: output,
      };
    },
  };
}
