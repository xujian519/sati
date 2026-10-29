/**
 * patent_figure_generate 的**复核与跨调用核对**：生成期渲染门禁（`SATI_FIGURE_RENDER_GATE`）、
 * 图面复核（RC1–RC7）与既有 sidecar 的占用核对。
 *
 * 从生成工具拆出的原因：这三件事都是"在已生成的 SVG / 既有留痕上做量测"，与渲染管线和
 * 入参校验无关；留在 `patentFigureGenerate.ts` 会让那个文件越过模块体量上限，也会让
 * "门禁档位"这类运维决策混进工具定义里。
 */

import {
  checkFigureRendering,
  checkFigures,
  minCharHeight,
  stripRefMark,
  toRenderCheckFindings,
  uniformFigureZoom,
  type FigureSidecar,
  type FigureSpec,
  type OfficeProfile,
} from "../../patent/figuregen/index.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";

/** 生成期核验结果的类型（结构规则 + 本次合并的渲染复核与跨调用发现）。 */
export type FigureCheck = ReturnType<typeof checkFigures>;

/**
 * 生成期渲染复核门禁档位（`SATI_FIGURE_RENDER_GATE`）。
 *
 * - `off`：不跑复核，但报告里明确写「未量测」——"没跑"不能呈现成"通过"（AGENTS 第 11 条）；
 * - `warn`（缺省）：跑复核并报告，不阻断生成；
 * - `fail`：跑复核，出现 fail 级发现时在**产物与 sidecar 全部落盘后**抛错（产物可审计，
 *   sidecar 仍记录完整发现，调用方据报错修复后重生成）。
 */
export type FigureRenderGate = "off" | "warn" | "fail";

export const FIGURE_RENDER_GATE_ENV = "SATI_FIGURE_RENDER_GATE";

export function resolveRenderGate(env: NodeJS.ProcessEnv = process.env): FigureRenderGate {
  const value = (env[FIGURE_RENDER_GATE_ENV] ?? "").trim().toLowerCase();
  if (value === "") return "warn";
  if (value === "off" || value === "warn" || value === "fail") return value;
  throw new SatiToolRuntimeError(
    "invalid_tool_input",
    `非法 ${FIGURE_RENDER_GATE_ENV} "${value}"（可用: off, warn, fail）`,
    { tool: "patent_figure_generate" },
  );
}

/**
 * 对**已落盘前**的渲染结果跑图面复核（RC1–RC7），返回带图号的发现。
 *
 * 字数下限按交付口径折算：法域档案的最小字高（毫米，纸面）除以统一缩放系数，得到
 * 「源图坐标下允许的最小字高」。这样 RC7 与 V7 用的是同一法域档案，但 RC7 量的是
 * **每个实际文字元素**（能看见节点字够大而边标签不够的情形）。
 */
export function reviewRenderedFigures(args: {
  renderedSvgs: ReadonlyMap<number, string>;
  paperSizes: readonly { figure_no: number; widthMm: number; heightMm: number }[];
  profile: OfficeProfile;
  gate: FigureRenderGate;
}): FigureCheck["findings"] {
  if (args.gate === "off") {
    return [
      {
        rule: "RC0",
        severity: "info",
        message:
          `渲染复核未运行（${FIGURE_RENDER_GATE_ENV}=off）：RC1–RC7 的图面缺陷本次未量测，` + "不能视为已核验无问题",
      },
    ];
  }
  const ceiling = minCharHeight(args.profile);
  const zoom = uniformFigureZoom(
    args.paperSizes.map(size => ({ widthMm: size.widthMm, heightMm: size.heightMm })),
    args.profile,
  );
  const minFontMm = ceiling !== undefined && Number.isFinite(zoom) && zoom > 0 ? ceiling.mm / zoom : undefined;

  const findings: FigureCheck["findings"] = [];
  for (const [figureNo, svg] of [...args.renderedSvgs].sort((a, b) => a[0] - b[0])) {
    try {
      const review = checkFigureRendering(svg, minFontMm === undefined ? {} : { minFontMm });
      for (const finding of toRenderCheckFindings(review.findings)) {
        findings.push({ ...finding, message: `图${figureNo} ${finding.message}`, figure_nos: [figureNo] });
      }
    } catch (err) {
      // 量测被拒（超限体量/非 SVG 根元素）时如实记一条未量测：该幅没有核验，不等于通过。
      findings.push({
        rule: "RC0",
        severity: "info",
        message: `图${figureNo} 渲染复核未能量测：${err instanceof Error ? err.message : String(err)}（该幅未核验，不等于通过）`,
        figure_nos: [figureNo],
      });
    }
  }
  return findings;
}

/** 图内可见标号的提取：优先 `ref`，缺省从 label 末尾的「(20)」式标记读取（渲染器逐字画 label）。 */
const LABEL_NUMERAL = /[（(]\s*(\d{1,3})\s*[)）]\s*$/u;

function numeralOf(node: { ref?: number; label: string }): number | undefined {
  if (typeof node.ref === "number") return node.ref;
  const match = LABEL_NUMERAL.exec(node.label.trim());
  return match === null ? undefined : Number(match[1]);
}

/**
 * 跨调用一致性：以同目录既有 sidecar 为**单一事实源**核对图号与附图标记占用。
 *
 * 为什么只核对、不自动续号：Sati 的 `FigureNode.label` 已承载**可见标号文本**
 * （如「处理模块(20)」），渲染器逐字画 label；自动填 `ref` 不会产生可见标号，改 label
 * 又会静默篡改专利文本。故这里报告占用与冲突，由调用方（模型/代理师）决定如何续号。
 */
export function crossCallReview(args: { figures: readonly FigureSpec[]; priorSidecars: readonly FigureSidecar[] }): {
  findings: FigureCheck["findings"];
  lines: string[];
} {
  if (args.priorSidecars.length === 0) {
    return { findings: [], lines: ["- 跨调用一致性：输出目录无既有 sidecar（首次生成，无标号可续）"] };
  }
  const names = args.priorSidecars.map(sidecar => sidecar.output_name).join("、");
  const lines: string[] = [`- 跨调用一致性：已复核既有 sidecar ${String(args.priorSidecars.length)} 份（${names}）`];
  const findings: FigureCheck["findings"] = [];

  // 图号占用：同一案卷目录内图号应唯一（细则第 21 条「按图1、图2……顺序编号」）。
  const priorFigNo = new Map<number, string>();
  for (const sidecar of args.priorSidecars) {
    for (const figure of sidecar.figures) {
      if (!priorFigNo.has(figure.figure_no)) priorFigNo.set(figure.figure_no, sidecar.output_name);
    }
  }
  const duplicatedNos = args.figures.map(figure => figure.figure_no).filter(no => priorFigNo.has(no));
  if (duplicatedNos.length > 0) {
    const detail = duplicatedNos.map(no => `图${no}（前序 ${priorFigNo.get(no) ?? "?"}）`).join("、");
    findings.push({
      rule: "V1",
      severity: "warn",
      message: `图号 ${detail} 已被既有 sidecar 占用：同一案卷的图号应唯一，续号请从未占用的下一个号开始`,
      figure_nos: [...new Set(duplicatedNos)].sort((a, b) => a - b),
    });
    lines.push(`- 图号占用冲突：${detail}`);
  } else {
    lines.push("- 图号占用：本次图号在既有 sidecar 中均未出现");
  }

  // 附图标记占用：同一标记跨图应始终指同一部件（名称不一致即冲突）。
  const slots = new Map<number, { name: string; where: string }[]>();
  const record = (spec: FigureSpec, source: string): void => {
    for (const node of spec.nodes) {
      const numeral = numeralOf(node);
      if (numeral === undefined) continue;
      const name = stripRefMark(node.label).trim();
      const list = slots.get(numeral) ?? [];
      list.push({ name, where: `${source}（${name}）` });
      slots.set(numeral, list);
    }
  };
  for (const sidecar of args.priorSidecars) {
    for (const figure of sidecar.figures) record(figure.spec, `前序「${sidecar.output_name}」图${figure.figure_no}`);
  }
  for (const figure of args.figures) record(figure, `本次图${figure.figure_no}`);

  for (const [numeral, entries] of [...slots].sort((a, b) => a[0] - b[0])) {
    const names = new Set(entries.map(entry => entry.name));
    if (names.size <= 1) continue;
    lines.push(
      `- [WARN] 附图标记 ${String(numeral)} 的指向不一致：${entries.map(entry => entry.where).join(" / ")}` +
        "——同一标记须始终指同一部件",
    );
  }
  const occupied = [...slots.keys()].sort((a, b) => a - b);
  if (occupied.length > 0) lines.push(`- 已占用的附图标记：${occupied.join("、")}`);
  return { findings, lines };
}
