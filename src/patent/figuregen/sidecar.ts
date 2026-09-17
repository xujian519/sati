/**
 * src/patent/figuregen — 附图产物 sidecar（v1 契约）。
 *
 * 核验需要两样东西，而二者在时间上分离：**FigureSpec**（V1/V4/V5/V7/V8/V9）在生成时
 * 就有，**说明书文本**（V2/V3）要到定稿时才齐。工作流阶段是透传的，主代理只能把路径
 * 写进阶段文本，下游无法结构化消费 ⇒ 生成时把 spec 完整落盘为 sidecar，下游在有文本
 * 时可零信息损耗地重跑全部规则（重跑不必回到模型）。
 *
 * 文件命名：与 SVG 同目录的 `<output_name>-figures.json`（`figureSidecarFileName`）。
 * `figures[].file` 存**文件名**而非绝对路径：sidecar 与图由本工具在同一目录成对产出，
 * 相对解析让案卷整目录搬迁（改工作目录/换机器）后仍可用，也不把家目录写进案卷产物。
 *
 * findings 只有**一份**（sidecar 顶层 `check`），不按图拆分：finding 自带 `figure_nos`
 * （V1/V2/V3/V8/V9 天然是集合级判定），按图复制会制造两份真相。
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FigureCheckFinding, FigureCheckResult } from "./check.js";
import type { DocumentKind, FigureSpec, Jurisdiction } from "./types.js";

/** sidecar 契约版本（结构变更须升版本并同步本模块的解析校验）。 */
export const FIGURE_SIDECAR_VERSION = 1;

/** 生成期核验快照：skip_text_rules 表示 V2/V3 未参与（生成期无说明书文本）。 */
export type FigureSidecarCheck = {
  stage: "generation";
  skip_text_rules: boolean;
  ok: boolean;
  findings: FigureCheckFinding[];
};

export type FigureSidecarFigure = {
  figure_no: number;
  /** SVG 文件名（相对 sidecar 所在目录）。 */
  file: string;
  spec: FigureSpec;
};

export type FigureSidecar = {
  version: number;
  /** 落盘时刻（审计用；**不参与任何判定**）。 */
  generated_at: string;
  output_name: string;
  renderer: string;
  jurisdiction: Jurisdiction;
  document_kind?: DocumentKind;
  check: FigureSidecarCheck;
  figures: FigureSidecarFigure[];
};

/** sidecar 文件名：`<output_name>-figures.json`。 */
export function figureSidecarFileName(outputName: string): string {
  return `${outputName}-figures.json`;
}

export type BuildFigureSidecarInput = {
  outputName: string;
  renderer: string;
  jurisdiction: Jurisdiction;
  documentKind?: DocumentKind;
  /** 本批产出（figure_no 与文件名/绝对路径）。 */
  files: readonly { figure_no: number; path: string }[];
  figures: readonly FigureSpec[];
  check: FigureCheckResult;
  /** 生成期核验是否跳过文本侧规则（生成期恒为 true）。 */
  skipTextRules: boolean;
  /** 落盘时刻；缺省取当前时间（调用方注入可测性）。 */
  generatedAt?: string;
};

/** 组装 sidecar 负载（纯函数：不触盘，便于单测断言结构与无损性）。 */
export function buildFigureSidecar(input: BuildFigureSidecarInput): FigureSidecar {
  const fileByNo = new Map(input.files.map(file => [file.figure_no, basename(file.path)]));
  return {
    version: FIGURE_SIDECAR_VERSION,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    output_name: input.outputName,
    renderer: input.renderer,
    jurisdiction: input.jurisdiction,
    ...(input.documentKind === undefined ? {} : { document_kind: input.documentKind }),
    check: {
      stage: "generation",
      skip_text_rules: input.skipTextRules,
      ok: input.check.ok,
      findings: input.check.findings,
    },
    figures: [...input.figures]
      .sort((a, b) => a.figure_no - b.figure_no)
      .map(figure => ({
        figure_no: figure.figure_no,
        file: fileByNo.get(figure.figure_no) ?? `fig${figure.figure_no}.svg`,
        spec: figure,
      })),
  };
}

/**
 * 解析 sidecar 文本（结构不合法即抛错，fail-loud）。
 *
 * 只校验本模块消费所需的最小结构：version / figures[].file / figures[].spec.nodes。
 * 手工改坏的 sidecar 必须报错而非被当作"空附图集"静默通过。
 */
export function parseFigureSidecar(text: string): FigureSidecar {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new TypeError(`附图 sidecar 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("附图 sidecar 顶层应为对象");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== FIGURE_SIDECAR_VERSION) {
    throw new TypeError(`附图 sidecar 版本不支持: ${String(record.version)}（期望 ${FIGURE_SIDECAR_VERSION}）`);
  }
  if (!Array.isArray(record.figures)) {
    throw new TypeError("附图 sidecar 缺少 figures 数组");
  }
  for (const [index, entry] of record.figures.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`附图 sidecar figures[${index}] 应为对象`);
    }
    const figure = entry as Record<string, unknown>;
    if (typeof figure.figure_no !== "number") {
      throw new TypeError(`附图 sidecar figures[${index}].figure_no 应为数字`);
    }
    if (typeof figure.file !== "string" || figure.file.length === 0) {
      throw new TypeError(`附图 sidecar figures[${index}].file 应为非空字符串`);
    }
    const spec = figure.spec;
    if (spec === null || typeof spec !== "object" || !Array.isArray((spec as Record<string, unknown>).nodes)) {
      throw new TypeError(`附图 sidecar figures[${index}].spec 应为含 nodes 数组的 FigureSpec`);
    }
  }
  return parsed as FigureSidecar;
}

/** 读取并解析 sidecar（文件不存在 → undefined，由调用方决定是否报错）。 */
export async function readFigureSidecar(path: string): Promise<FigureSidecar | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return parseFigureSidecar(text);
}

/**
 * 在目录内定位首个 sidecar（按文件名升序，保证确定性）；无则返回 undefined。
 * 目录不存在同样返回 undefined（调用方按"该目录无附图"处理）。
 */
export async function findFigureSidecar(dir: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const matches = entries.filter(name => name.endsWith("-figures.json")).sort((a, b) => a.localeCompare(b));
  const first = matches[0];
  return first === undefined ? undefined : join(dir, first);
}
