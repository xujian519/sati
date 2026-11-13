/**
 * patent_figure_generate 的**输出装配**（标号表 / 合规核算 / 附图索引）。
 *
 * 为什么独立成文件：生成工具本体只做「渲染 → 落盘 → 报告」三件事；标号表装配、
 * 合规核算与索引写入是三类**互不相干**的装配动作，留在工具文件里会让它越过体量上限
 * （800 行，见 scripts/check-architecture-boundaries.mjs 的 R3），也让「生成器」与
 * 「装配器」两件事在同一个文件里互相干扰。
 *
 * 三段职责：
 * 1. **结构化标号表**（`buildNumeralMap`）：组件标签 → 附图标记。标号表是「图面 ↔ 说明书」
 *    两向一致性的唯一权威，此前只落在 sidecar 与附图说明草稿里，模型在工具输出里拿不到。
 * 2. **法域合规核算**（`collectComplianceFindings`）：图号义务 / 字高下限 / 摘要附图缩放。
 *    独立于结构与渲染规则族（V/RC/PX/C）——它核的是**落版后的物理量**对照条文，且拿不到
 *    物理量时不拿估算值充数（见 compliance.ts 的模块说明）。
 * 3. **附图索引写入**（`writeFigureIndex`）：生成即入索引，使生成物可被
 *    `search_patent_figure` 直接检出（此前只有 analyze 写索引 ⇒ 生成物检索不到）。
 * 4. **交付物清单装配**（`buildDeliverableManifestForOutput`）：把产物文件的 sha256 / 字节数 /
 *    落盘时刻装配成清单，供核验侧比对「交出去的那份是不是案卷主路径上的那份」（DR4）。
 */

import { resolve } from "node:path";
import { figureSpecsToAnalysis } from "../../patent/figure/bridge.js";
import { DEFAULT_FIGURE_INDEX_RELATIVE_PATH, upsertFigureIndex } from "../../patent/figure/index-store.js";
// 交付物清单：barrel 导出由主代理统一补齐，此处直连子模块（与 `patentFigureCheck.ts` 的直连同例）。
import {
  buildDeliverableManifest,
  type DeliverableEntry,
  type DeliverableRole,
} from "../../patent/figuregen/deliverable-manifest.js";
import {
  assignFamilyNumerals,
  autoAssignNumerals,
  backfillRefsFromLabels,
  drawingComplianceFindings,
  figureNodes,
  type FigureSpec,
  type NumeralAssignment,
  type OfficeProfile,
} from "../../patent/figuregen/index.js";
import type { SatiToolRuntimeContext } from "../protocol/types.js";
import { resolveSatiWorkspacePath } from "./filesystem/pathSafety.js";

/** 渲染产物清单条目（sidecar 的 files 与 data.figures 共用）。 */
export type RenderedFigureFile = {
  path: string;
  figure_no: number;
  caption?: string;
  sheet?: { index: number; total: number; text: string };
  layout?: {
    file: string;
    page_scale: number;
    placed_width_mm: number;
    placed_height_mm: number;
    char_height_mm: number;
    warnings?: readonly string[];
  };
};

/**
 * 标号归一 + 自动分配（部署级开关开启时）。
 *
 * 顺序固定：**先回填、后分配**——
 * 1. 回填：label 尾部已有可见标号（括号形态）而 `ref` 缺失 ⇒ 补 `ref`
 *    （图上已经写着这个号，自动再发一个号会让同一节点带两个号）；
 * 2. 自动分配：仍无 `ref` 的节点按 100 系列（`100 + 100×(图号−1)`、步进 2）发号。
 *
 * **只改 `ref`，不改 label 文本**：可见标号的补画发生在渲染期（`applyVisibleNumerals`），
 * 放在渲染前做会让布局的盒宽预算与图面文字不同源（实测 ⇒ RC1 假阳性）。
 */
export function normalizeFigureNumerals(
  figures: readonly FigureSpec[],
  options: {
    readonly auto: boolean;
    /** per-call 发号起点（缺省按图号算 100 系列）。 */
    readonly start?: number;
    /** per-call 发号步进（缺省 2）。 */
    readonly step?: number;
    /** 保留号（字符串形态，如 "100"；跳过不分配）。 */
    readonly reserved?: readonly string[];
    /** 族标识：给出时同族各图**共享一个连续号段**（跨图续号）。 */
    readonly family?: string;
  },
): {
  figures: FigureSpec[];
  assignments: NumeralAssignment[];
  /** 族续号的实际起点与步进（仅 `family` 给出时出现，供报告出声）。 */
  family?: { family: string; start: number; step: number; applied: boolean };
} {
  if (options.family !== undefined) {
    // 族续号：跨图共享一个连续号段（对齐 DSH 的 figure_family 语义）。
    // 自动发号未开启时不发号——「共享号段」只有在真的发号时才有内容；
    // 此时如实回报 applied=false，让报告把「族声明了但号段没共享」说出来。
    if (!options.auto) {
      const out = figures.map(figure => backfillRefsFromLabels(figure));
      return {
        figures: out,
        assignments: [],
        family: { family: options.family, start: 0, step: 0, applied: false },
      };
    }
    const result = assignFamilyNumerals(figures, {
      family: options.family,
      ...(options.start === undefined ? {} : { start: options.start }),
      ...(options.step === undefined ? {} : { step: options.step }),
      ...(options.reserved === undefined ? {} : { reserved: options.reserved }),
    });
    return {
      figures: result.figures,
      assignments: result.assignments,
      family: { family: options.family, start: result.start, step: result.step, applied: true },
    };
  }
  const out: FigureSpec[] = [];
  const assignments: NumeralAssignment[] = [];
  for (const figure of figures) {
    const backfilled = backfillRefsFromLabels(figure);
    if (!options.auto) {
      out.push(backfilled);
      continue;
    }
    const assigned = autoAssignNumerals(backfilled, {
      ...(options.start === undefined ? {} : { start: options.start }),
      ...(options.step === undefined ? {} : { step: options.step }),
      ...(options.reserved === undefined ? {} : { reserved: options.reserved }),
    });
    out.push(assigned.figure);
    assignments.push(...assigned.assignments);
  }
  return { figures: out, assignments };
}

/** 单幅附图的结构化标号表条目。 */
export type FigureNumeralMapRow = {
  /** 附图标记（阿拉伯数字）。 */
  ref: number;
  /** 组件标签（渲染器逐字画出的可见文本，含标号）。 */
  label: string;
  /** 所属图号。 */
  figure_no: number;
};

/**
 * 单幅附图的结构化标号表（组件标签 → 附图标记）。
 *
 * 标号表是「图面 ↔ 说明书」两向一致性的唯一权威（对齐 DSH 的 `numeralMap`）：
 * 此前它只落在 sidecar 与附图说明草稿里，模型在工具输出里拿不到。
 */
export function buildNumeralMap(figure: FigureSpec): FigureNumeralMapRow[] {
  const rows: FigureNumeralMapRow[] = [];
  // 多面板附图：标号表要含各面板的组件（摊平口径），否则面板里的标记在输出里查不到。
  for (const node of figureNodes(figure)) {
    if (node.ref === undefined) continue;
    rows.push({ ref: node.ref, label: node.label, figure_no: figure.figure_no });
  }
  return rows;
}

/** 合规核算的一条结论（附图级）。 */
export type FigureComplianceRow = {
  figure_no: number;
  id: string;
  severity: string;
  message: string;
};

/**
 * 逐幅核「图号义务 / 字高下限 / 摘要附图缩放」。
 *
 * 物理量优先取落版页的度量（落版后纸面上的真实值）；没有落版页时退回图形自身的实测
 * 尺寸 + 源图字高（交付物就是这张图，它的物理尺寸即纸面尺寸）。
 */
export function collectComplianceFindings(args: {
  figures: readonly FigureSpec[];
  layouts: ReadonlyMap<number, { placed_width_mm: number; placed_height_mm: number; char_height_mm: number }>;
  measuredPaperSizes: readonly { figure_no: number; widthMm: number; heightMm: number }[];
  profile: OfficeProfile;
  figureCount: number;
  captionRendered: boolean;
  sourceCharMm: number;
}): FigureComplianceRow[] {
  const rows: FigureComplianceRow[] = [];
  for (const figure of args.figures) {
    const layout = args.layouts.get(figure.figure_no);
    const measured = args.measuredPaperSizes.find(item => item.figure_no === figure.figure_no);
    const metrics =
      layout !== undefined
        ? {
            placedWidthMm: layout.placed_width_mm,
            placedHeightMm: layout.placed_height_mm,
            charHeightMm: layout.char_height_mm,
          }
        : measured !== undefined
          ? {
              placedWidthMm: measured.widthMm,
              placedHeightMm: measured.heightMm,
              charHeightMm: args.sourceCharMm,
            }
          : undefined;
    for (const finding of drawingComplianceFindings({
      profile: args.profile,
      figureCount: args.figureCount,
      hasCaption: args.captionRendered,
      ...(figure.abstract === true ? { abstractFigure: true } : {}),
      ...(metrics === undefined ? {} : { metrics }),
    })) {
      rows.push({
        figure_no: figure.figure_no,
        id: finding.id,
        severity: finding.severity,
        message: finding.message,
      });
    }
  }
  return rows;
}

/**
 * 装配交付物清单（角色 + 文件名 → sha256 / 字节数 / 落盘时刻）。
 *
 * 清单是「交出去的那份是哪一份」的可核证据（对齐 DSH 的 verify-deliverable 交付物 manifest）：
 * 清单条目只存**文件名**（不存绝对路径），案卷整目录搬迁后仍可用，也不把家目录写进案卷。
 *
 * 边界：**只装配，不核验**（核验在 `patentFigureCheck` 侧，见 `checkDeliverableManifest`）。
 * 读不到的条目**不进清单**——调用方按「请求清单 − 返回清单」的差集即知哪些没登记，
 * 不得把"没写成"记成"已登记"。
 *
 * @param args.outputDir - 产物目录（绝对路径）。
 * @param args.files - 角色 + 文件名（相对产物目录）。
 * @returns 清单条目（顺序与请求一致）。
 */
export async function buildDeliverableManifestForOutput(args: {
  outputDir: string;
  files: readonly { readonly role: DeliverableRole; readonly file: string }[];
}): Promise<DeliverableEntry[]> {
  return buildDeliverableManifest(
    args.files.map(file => ({ role: file.role, path: resolve(args.outputDir, file.file) })),
  );
}

/**
 * 把生成物写入附图索引（生成即入索引）。
 *
 * 索引写入失败**降级但不静默**：返回 `note` 说明原因，由报告与 `data.indexed` 如实写明
 * 「未入索引」——不阻断产物交付（产物已落盘，可审计）。
 *
 * 门禁 fail 档抛错时**不写索引**：未过门禁的图不是可交付物，进检索索引会让
 * 「搜到的就是已交付的」这个隐含前提失效（调用方在抛错前不再走到这里）。
 */
export async function writeFigureIndex(args: {
  figures: readonly FigureSpec[];
  files: readonly { path: string; figure_no: number }[];
  context: SatiToolRuntimeContext;
}): Promise<{ indexed: boolean; note: string | undefined }> {
  try {
    const indexPath = resolveSatiWorkspacePath(DEFAULT_FIGURE_INDEX_RELATIVE_PATH, args.context, {
      forWrite: true,
    });
    if (!indexPath.ok) {
      return { indexed: false, note: `索引路径不可用：${indexPath.error.message}` };
    }
    if (args.context.permissionContext?.mode === "plan") {
      return { indexed: false, note: "plan 只读模式不写盘" };
    }
    const analyzedAt = (args.context.now?.() ?? new Date()).toISOString();
    const byNo = new Map(args.figures.map(figure => [figure.figure_no, figure]));
    let indexed = false;
    for (const file of args.files) {
      const spec = byNo.get(file.figure_no);
      if (spec === undefined) continue;
      const resolved = resolveSatiWorkspacePath(file.path, args.context, { mustExist: true });
      if (!resolved.ok) continue;
      const [analysis] = figureSpecsToAnalysis([spec]);
      if (analysis === undefined) continue;
      await upsertFigureIndex(indexPath.absolutePath, {
        imagePath: resolved.relativePath,
        analyzedAt,
        analysis: { ...analysis, imagePath: resolved.relativePath },
      });
      indexed = true;
    }
    return indexed ? { indexed: true, note: undefined } : { indexed: false, note: "产物路径不在工作区内，未入索引" };
  } catch (err) {
    return { indexed: false, note: err instanceof Error ? err.message : String(err) };
  }
}
