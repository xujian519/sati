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
 *
 * 交付物清单（顶层**可选**字段 `deliverables`）是产物契约的另一面：sidecar 记录"画成了什么"，
 * 清单记录"交出去的那份是哪一份"（sha256 / 字节数 / 落盘时刻）。它是**可选**字段 ⇒ 不升
 * `version`（升版本会让既有案卷的 sidecar 一律解析失败），旧 sidecar 仍可解析。
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CadFinding } from "./cad/checks.js";
import type { FigureCheckFinding, FigureCheckResult } from "./check.js";
import { parseDeliverableEntries, type DeliverableEntry } from "./deliverable-manifest.js";
import { officeForJurisdiction, type TargetOffice } from "./office-profile.js";
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

/**
 * 几何来源（可选）：CAD 投影图不由 `FigureSpec` 决定画幅，而由投影几何 + 适配缩放决定
 * ⇒ 记录来源与投影参数，使核验/审计能区分"本模块排版的图"与"投影来的图"。
 */
export type FigureSidecarGeometry = {
  source: "cad";
  view: string;
  /** 适配 A4 可印区的缩放系数（≤1）。 */
  scale: number;
  width_mm: number;
  height_mm: number;
  hidden_lines: boolean;
  /** 全剖视图的剖切参数与剖面线统计（整视图时缺省）。 */
  section?: { offset_mm: number; cut_faces: number; hatch_segments: number };
  /** 图面已标注的附图标记（升序无关，按调用方顺序；未标注时缺省）。 */
  ref_numerals?: number[];
  /**
   * 引线择位的最终结果（纸面毫米，相对锚点）。`strict_failure` 在成功落盘的图上恒为 false：
   * strict 失败在出图前抛出，不会写出 sidecar。字段是可选追加，不升 sidecar 版本——
   * 旧文件没有这一项，解析器只校验 version / figures / spec.nodes。
   */
  label_placements?: readonly {
    ref: number;
    offset_mm: readonly [number, number];
    degraded: boolean;
    strict_failure: boolean;
  }[];
  /** 投影期的几何级检查（几何判据不重跑：记录当时结论供审计）。 */
  findings?: CadFinding[];
};

export type FigureSidecarFigure = {
  figure_no: number;
  /** SVG 文件名（相对 sidecar 所在目录）。 */
  file: string;
  spec: FigureSpec;
  geometry?: FigureSidecarGeometry;
  /** 图号标注（未编号时缺省——单幅在 PCT/US 不得编号，见 office-profile.ts）。 */
  caption?: string;
  /** 附图页页码（声明了页数时记录，供审计"页码体例是否与档案一致"）。 */
  sheet?: FigureSidecarSheet;
  /** 提交落版页摘要（`fit_to_page` 产出时记录）。 */
  layout?: FigureSidecarLayout;
  /**
   * 提交**拼版页**摘要（多视图共页时记录）。
   *
   * 与 `layout` **并列而非替换**：`layout` 的语义是"一幅图落版的纸面度量"（单图口径），
   * 拼版页的度量是"多格共页的网格 + 统一缩放"，两件事不同 ⇒ 不塞进同一个字段里当两义
   * （一处字段两义 ⇒ 下游只能靠猜哪个是哪个）。故另立可选字段，旧 sidecar 无此字段仍合法。
   */
  sheet_layout?: FigureSidecarSheetLayout;
};

/** 附图页页码：文本按档案体例生成（`1/3` 或顺序数字），index/total 保留结构。 */
export type FigureSidecarSheet = { index: number; total: number; text: string };

/** 落版页摘要：产物文件名 + 落版缩放与纸面尺寸（版式判据与实际排版可对照）。 */
export type FigureSidecarLayout = {
  file: string;
  page_scale: number;
  placed_width_mm: number;
  placed_height_mm: number;
  char_height_mm: number;
  warnings?: readonly string[];
};

/**
 * 拼版页摘要：网格形状 + **统一**缩放 + 字高核验结论。
 *
 * 为什么单独一个类型：`FigureSidecarLayout` 是单图落版的度量（纸面宽高 + 字高）；
 * 拼版页的度量是"多格共页"（几列几行、每格多大、所有格共用的缩放系数、字高是否达标）。
 * 两种度量字段名相近但含义不同，硬塞进一个字段会让下游靠猜。
 */
export type FigureSidecarSheetLayout = {
  /** 拼版页文件名（相对 sidecar 所在目录）。 */
  file: string;
  /** 拼版格数（视图数）。 */
  cells: number;
  /** 网格列数。 */
  columns: number;
  /** 网格行数。 */
  rows: number;
  /** 统一缩放系数（所有格共用；≤ 1）。 */
  page_scale: number;
  /** 单格宽（毫米）。 */
  cell_width_mm: number;
  /** 单格高（毫米）。 */
  cell_height_mm: number;
  /** 拼版后图内字高（毫米）。 */
  char_height_mm: number;
  /** 再缩 2/3 后的字高（毫米）。 */
  reduced_char_height_mm: number;
  /** 法域字高下限（毫米）；档案未登记时缺省。 */
  min_char_height_mm?: number;
  /** 字高下限的性质（条文 / 实践）。 */
  min_char_height_basis?: "statute" | "practice";
  /** 拼版后字高是否满足法域下限（不满足时 `warnings` 里必有一条说明）。 */
  char_height_compliant: boolean;
  /** 逐格落版事实（视图 → 纸面尺寸 + 图号）。 */
  placements: readonly {
    view: string;
    width_mm: number;
    height_mm: number;
    caption?: string;
  }[];
  /** 版式告警（字高不合规等**如实报出**）。 */
  warnings?: readonly string[];
};

export type FigureSidecar = {
  version: number;
  /** 落盘时刻（审计用；**不参与任何判定**）。 */
  generated_at: string;
  output_name: string;
  renderer: string;
  jurisdiction: Jurisdiction;
  /** 法域档案键（与 jurisdiction 同源，显式落盘便于审计"按哪套纸面常数出的图"）。 */
  office?: TargetOffice;
  document_kind?: DocumentKind;
  /**
   * 产物是否已做「文本转路径」（字形换成轮廓路径，交付物不再依赖读者机器上的字体）。
   *
   * 记录它是为了**回读语义**：转路径后图面上的文字不再是 `<text>`，`parseFigureSvg` 的
   * 「可见图号」观测（`numbered`，属性不算）会读不到——那**不等于**图号不存在。下游
   * （`figure-gate`）据此以生成期事实（`figures[].caption`）替代该观测，而不是把"读不到"
   * 当成"没有"、进而让 V15「多幅须编号」误报。
   */
  text_to_path?: boolean;
  /**
   * 交付物清单（**可选**）：交付物的角色 / 文件名 / sha256 / 字节数 / 落盘时刻。
   *
   * 为什么是可选字段而不是升版本：清单是**产物契约的自然延伸**（sidecar 本就是产物契约），
   * 旧 sidecar 没有这一项仍然合法可解析 ⇒ 不升 `version`（升版本会让既有案卷的 sidecar
   * 一律解析失败，见 `parseFigureSidecar` 的版本断言）。
   *
   * 清单**不得登记承载它的那份 sidecar**（自指：清单写进 sidecar 的那一刻，sidecar 的
   * 哈希就变了，下一次核验必然报内容漂移）。
   */
  deliverables?: DeliverableEntry[];
  /**
   * 输入件的落盘时刻（时序门的数据来源）。
   *
   * 「渲染件晚于输入件」是交付可审计的一条硬证据：输入（模型/源图）改了却没重投影，
   * 交出去的那份就不是对应当前输入的那份。**可选**字段：没有文件型输入的生成路径
   * （FigureSpec 是模型在内存里给的）不登记 ⇒ 时序门**不执行**（如实声明，不假装通过）。
   */
  deliverableInputs?: { label: string; mtimeMs: number }[];
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
  /** 本批产出（figure_no 与文件名/绝对路径；CAD 图另带几何来源与投影参数）。 */
  files: readonly {
    figure_no: number;
    path: string;
    geometry?: FigureSidecarGeometry;
    caption?: string;
    sheet?: FigureSidecarSheet;
    layout?: FigureSidecarLayout;
    sheet_layout?: FigureSidecarSheetLayout;
  }[];
  figures: readonly FigureSpec[];
  check: FigureCheckResult;
  /** 生成期核验是否跳过文本侧规则（生成期恒为 true）。 */
  skipTextRules: boolean;
  /** 产物是否已做文本转路径（缺省 false；转路径的产物文字不可回读，见 FigureSidecar.text_to_path）。 */
  textToPath?: boolean;
  /** 落盘时刻；缺省取当前时间（调用方注入可测性）。 */
  generatedAt?: string;
  /**
   * 交付物清单（可选）：装配时逐个算出的 sha256 / 字节数 / 落盘时刻。
   * 缺省 = 不登记清单（旧行为；核验侧据此声明"清单一致性未核验"，不判通过）。
   */
  deliverables?: readonly DeliverableEntry[];
  /** 输入件的落盘时刻（可选；缺省 ⇒ 时序门不执行）。 */
  deliverableInputs?: readonly { label: string; mtimeMs: number }[];
};

/** 组装 sidecar 负载（纯函数：不触盘，便于单测断言结构与无损性）。 */
export function buildFigureSidecar(input: BuildFigureSidecarInput): FigureSidecar {
  const fileByNo = new Map(input.files.map(file => [file.figure_no, basename(file.path)]));
  const geometryByNo = new Map(
    input.files.flatMap(file => (file.geometry === undefined ? [] : [[file.figure_no, file.geometry] as const])),
  );
  const extrasByNo = new Map(
    input.files.map(file => [
      file.figure_no,
      {
        ...(file.caption === undefined ? {} : { caption: file.caption }),
        ...(file.sheet === undefined ? {} : { sheet: file.sheet }),
        ...(file.layout === undefined ? {} : { layout: file.layout }),
        ...(file.sheet_layout === undefined ? {} : { sheet_layout: file.sheet_layout }),
      },
    ]),
  );
  return {
    version: FIGURE_SIDECAR_VERSION,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    output_name: input.outputName,
    renderer: input.renderer,
    jurisdiction: input.jurisdiction,
    office: officeForJurisdiction(input.jurisdiction),
    ...(input.documentKind === undefined ? {} : { document_kind: input.documentKind }),
    ...(input.textToPath === true ? { text_to_path: true } : {}),
    ...(input.deliverables === undefined ? {} : { deliverables: [...input.deliverables] }),
    ...(input.deliverableInputs === undefined ? {} : { deliverableInputs: [...input.deliverableInputs] }),
    check: {
      stage: "generation",
      skip_text_rules: input.skipTextRules,
      ok: input.check.ok,
      findings: input.check.findings,
    },
    figures: [...input.figures]
      .sort((a, b) => a.figure_no - b.figure_no)
      .map(figure => {
        const geometry = geometryByNo.get(figure.figure_no);
        return {
          figure_no: figure.figure_no,
          file: fileByNo.get(figure.figure_no) ?? `fig${figure.figure_no}.svg`,
          spec: figure,
          ...(geometry === undefined ? {} : { geometry }),
          ...(extrasByNo.get(figure.figure_no) ?? {}),
        };
      }),
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
  // 交付物清单（可选字段）：**旧 sidecar 没有这一项是合法的**（不升版本，见 FigureSidecar.deliverables）；
  // 存在但结构不合法则报错——清单坏了必须报错，不能被当作"没有清单"静默通过。
  parseDeliverableEntries(record.deliverables);
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

/**
 * 读取目录内**全部** sidecar（按文件名升序，保证确定性）。
 *
 * 与 {@link findFigureSidecar}（只取首个，供"本案是否有附图留痕"的判断）不同：分次生成
 * 时同一目录会有多份 sidecar，跨调用核对附图标记必须看到全部留痕——只看第一份会漏掉
 * 后几次调用分配的标号，进而把重复标号判成通过。
 * @param dir - 目录；不存在时返回空数组（调用方按"该目录无附图"处理）。
 * @returns 已解析的 sidecar（顺序与文件名升序一致）。
 */
export async function readFigureSidecars(dir: string): Promise<FigureSidecar[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const matches = entries.filter(name => name.endsWith("-figures.json")).sort((a, b) => a.localeCompare(b));
  const sidecars: FigureSidecar[] = [];
  for (const name of matches) {
    try {
      const sidecar = await readFigureSidecar(join(dir, name));
      if (sidecar !== undefined) sidecars.push(sidecar);
    } catch (err) {
      // 带文件名重抛：跨调用核对失败时调用方要能定位到具体是哪一份留痕坏了。
      throw new TypeError(`读取附图 sidecar ${name} 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return sidecars;
}
