/**
 * patent_figure_check — **报告文本构建**（结论行 + 结构/像素/渲染复核分面 + 多图一致性 + 依据条款）。
 *
 * 为什么单列：`patentFigureCheck.ts` 因交付面复核（DR 族）与交付物清单核验（DR4）增长到
 * 804 行，越过仓库的 800 行单文件上限（`scripts/check-architecture-boundaries.mjs` 的
 * file-size 规则）⇒ 把报告构建整块搬到这里（**纯搬迁，不改行为**），与同族先例一致
 * （`patentFigureReport.ts` 为 `patent_figure_generate` 做同一件事）。
 *
 * 本模块只做**措辞与排版**：判定结论由 `checkFigures` / 像素门禁 / 渲染复核 / 交付面复核
 * 各自给出，本模块把它们的发现按分面写成人能直接照做的行式摘要。
 */

import {
  checkFigures,
  type FigureCheckFinding,
  type FigureCheckRuleId,
  type FigureCheckSeverity,
  type FigureSpec,
  type Jurisdiction,
  type PixelFinding,
  type PixelMetrics,
} from "../../patent/figuregen/index.js";

/** 栅格图核查条目（报告面：文件名 + 指标 + 发现）。 */
export type PixelGateEntry = PixelMetrics & { name: string; findings: PixelFinding[] };

/** 一张已交付 SVG 的渲染复核结果（报告面：文件 + 发现）。 */
export type RenderCheckEntry = {
  path: string;
  findings: { rule: string; severity: FigureCheckSeverity; message: string }[];
};

/** 一张已交付 SVG 的交付面复核结果（DR 族 + 图面用语终检；报告面：文件 + 发现）。 */
export type DeliveryCheckEntry = {
  path: string;
  figure_no: number;
  findings: {
    rule: FigureCheckRuleId;
    severity: FigureCheckSeverity;
    message: string;
    evidence?: string[];
  }[];
};

/**
 * 交付物清单核验（DR4）的接入结果。
 *
 * 三种结局**如实区分**（不把"没量测"呈现成"已核验通过"）：
 * - `verified`：清单在册，已对目录现状比对（发现并入 check.findings）；
 * - `not-registered`：sidecar 无 `deliverables` 字段 ⇒ **不判**，报告注明"清单一致性未核验"；
 * - `unavailable`：sidecar / 目录读不了 ⇒ **不判**，报告注明未核验与原因。
 */
export type DeliverableManifestCheck = {
  status: "verified" | "not-registered" | "unavailable";
  /** 被核验的产物目录。 */
  dir: string | undefined;
  /** DR4 发现（rule 固定 "DR4"）。 */
  findings: FigureCheckFinding[];
  /** 报告行（如实说明本次是否核验过）。 */
  note: string;
};

/**
 * 交付面用语发现 ↔ 结构侧用语发现的**去重**。
 *
 * 同一处英文 label 在两条通路上都会命中 V13：结构侧（回读骨架 → `checkFigures`）按规则
 * 聚合成一条 + 多行证据；交付侧（`checkFigureDelivery` 逐命中）逐条列。两条都报 ⇒
 * 同一处缺陷在报告里出现两次，会把真缺陷淹没（也让人误以为有两处问题）。
 *
 * 去重口径：同规则号 + **被引号引起来的命中片段**（本仓的证据行用「…」标命中文本）
 * 已被结构侧报过 ⇒ 交付侧那条不重复报。引不出片段的发现（DR 族、像素门等）一律保留。
 */
function quotedFragments(text: string): string[] {
  return [...text.matchAll(/「([^」]*)」/gu)].map(match => match[1] ?? "").filter(fragment => fragment.length > 0);
}

/** 交付侧发现去重（只压「结构侧已报过的同一处用语缺陷」，不改级别、不删新缺陷）。 */
export function dedupeDeliveryFindings(
  structureFindings: readonly FigureCheckFinding[],
  deliveryFindings: readonly FigureCheckFinding[],
): FigureCheckFinding[] {
  const byRule = new Map<string, Set<string>>();
  for (const finding of structureFindings) {
    const known = byRule.get(finding.rule) ?? new Set<string>();
    for (const fragment of quotedFragments(finding.message)) known.add(fragment);
    for (const evidence of finding.evidence ?? []) {
      for (const fragment of quotedFragments(evidence)) known.add(fragment);
    }
    byRule.set(finding.rule, known);
  }
  return deliveryFindings.filter(finding => {
    const fragments = [
      ...quotedFragments(finding.message),
      ...(finding.evidence ?? []).flatMap(evidence => quotedFragments(evidence)),
    ];
    if (fragments.length === 0) return true;
    const known = byRule.get(finding.rule);
    if (known === undefined) return true;
    return !fragments.every(fragment => known.has(fragment));
  });
}

/** 报告文本：结论行 + 结构/像素/渲染复核分面 + 多图一致性 + 依据条款。 */
export function buildCheckReportLines(args: {
  ok: boolean;
  result: ReturnType<typeof checkFigures>;
  figures: FigureSpec[];
  svgPaths: readonly string[];
  numberedFigureNos: number[];
  pixelResults: PixelGateEntry[];
  renderChecks: RenderCheckEntry[];
  deliveryChecks: DeliveryCheckEntry[];
  manifestCheck: DeliverableManifestCheck | undefined;
  multiFigureConsistency: { summary: string; warnings: string[] } | undefined;
  jurisdiction: Jurisdiction;
  /** RC8（图内层级 ↔ 权利要求归属表述）发现；未声明层级时为空数组。 */
  hierarchyFindings?: readonly { rule: "RC8"; severity: "warn"; message: string; evidence?: readonly string[] }[];
}): string[] {
  const { ok, result, figures, svgPaths, numberedFigureNos, pixelResults, renderChecks } = args;
  const deliveryFindings = dedupeDeliveryFindings(
    result.findings,
    args.deliveryChecks.flatMap(entry => entry.findings.map(finding => ({ ...finding, figure_no: entry.figure_no }))),
  );
  const manifestFindings = args.manifestCheck?.findings ?? [];
  const failCount =
    result.findings.filter(f => f.severity === "fail").length +
    pixelResults.flatMap(r => r.findings).filter(f => f.severity === "fail").length +
    renderChecks.flatMap(entry => entry.findings).filter(f => f.severity === "fail").length +
    deliveryFindings.filter(f => f.severity === "fail").length +
    manifestFindings.filter(f => f.severity === "fail").length;
  const warnCount =
    result.findings.filter(f => f.severity === "warn").length +
    pixelResults.flatMap(r => r.findings).filter(f => f.severity === "warn").length +
    renderChecks.flatMap(entry => entry.findings).filter(f => f.severity === "warn").length +
    deliveryFindings.filter(f => f.severity === "warn").length +
    manifestFindings.filter(f => f.severity === "warn").length;
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
    ...(args.hierarchyFindings === undefined || args.hierarchyFindings.length === 0
      ? []
      : [
          `图内层级核对（RC8）：${String(args.hierarchyFindings.length)} 条不一致` +
            `——${args.hierarchyFindings.map(finding => finding.message).join("；")}`,
        ]),
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

  if (args.deliveryChecks.length > 0) {
    lines.push(
      "",
      "已交付 SVG 的交付面复核（DR1 位图/照片、DR2 横向摆放、DR3 整幅框线；图面用语终检沿用 V12/V13/V14 规则号）：",
    );
    for (const entry of args.deliveryChecks) {
      const fails = entry.findings.filter(finding => finding.severity === "fail").length;
      lines.push(
        `- ${entry.path}（图${entry.figure_no}）：${
          entry.findings.length === 0 ? "无发现" : `${entry.findings.length} 项（fail=${fails}）`
        }`,
      );
      for (const finding of entry.findings) {
        lines.push(
          `  [${finding.severity.toUpperCase()}] ${finding.rule}: ${finding.message}` +
            (finding.evidence ? `\n    ${finding.evidence.join("\n    ")}` : ""),
        );
      }
    }
  }

  // 交付物清单一致性（DR4）：清单 ↔ 当前目录的产物。
  // 未核验（无清单 / sidecar 读不了）也**如实写出来**——"没量测"不得呈现成"已核验通过"。
  if (args.manifestCheck !== undefined) {
    const manifest = args.manifestCheck;
    lines.push("");
    if (manifest.status === "verified") {
      lines.push("交付物清单一致性（DR4：清单 ↔ 当前产物目录）：");
      lines.push(
        `- ${manifest.dir ?? "（目录未知）"}：${
          manifest.findings.length === 0 ? "清单与目录现状一致（无发现）" : `${manifest.findings.length} 项`
        }`,
      );
      for (const finding of manifest.findings) {
        lines.push(
          `  [${finding.severity.toUpperCase()}] ${finding.rule}: ${finding.message}` +
            (finding.evidence ? `\n    ${finding.evidence.join("\n    ")}` : ""),
        );
      }
      lines.push("- 时序门（渲染件晚于输入件）：本次未执行——核验入口只拿到说明书文本，无输入件落盘时刻可比");
    } else {
      lines.push(`交付物清单一致性（DR4）：${manifest.note}`);
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
