/**
 * scripts/figure-benchmark/gen-compliance.ts — 生成侧合规基准（渲染 + 门禁的确定性指标）。
 *
 * 用途（`docs/patent-figure-hardening-plan.md` §6.2 评测扩展）：把"渲染器 + 核验器"的现状
 * 固化成可比对数字，作为 P0-4（介质锚定）/ P1-2（字宽度量）的回归护栏——阈值或度量漂移时
 * 基线比对转红，而不是等到 A4 打印稿被分页切断才发现。
 *
 * 指标（全部确定性：无模型、无网络、无私有数据；输入集见 `gen-cases.ts`）：
 * - 画幅：每图纸面毫米 + 是否单独落进**该法域档案**的可印区（V7 page_fit 的原始素材）
 * - 版式：同文档统一缩放系数（`html.ts` 版式与 V7 判据共用）与缩放后打印字高分布；
 *   是否按档案标注图号（单幅在 pct/us 不编号）与该法域的字高下限
 * - 规则：V1–V17 命中数（按严重度）+ 文字面分节是否生效（V10/V11 覆盖率）
 *
 * 用法：
 *   tsx scripts/figure-benchmark/gen-compliance.ts            # 与基线比对，漂移即非零退出
 *   tsx scripts/figure-benchmark/gen-compliance.ts --update   # 重写基线（PR 内须说明为何更新）
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  FIGURE_FONT_SIZE,
  checkFigures,
  layoutFigure,
  minCharHeight,
  printableArea,
  printedFontMm,
  profileForJurisdiction,
  pxToMm,
  shouldRenderCaption,
  uniformFigureZoom,
} from "../../src/patent/figuregen/index.js";
import { GENERATION_BENCHMARK_CASES, type GenBenchmarkCase } from "./gen-cases.js";

/** 基线文件（入库；改动即须在 PR 内说明理由）。 */
export const GEN_BENCHMARK_BASELINE_RELATIVE_PATH = "tests/fixtures/patent/figuregen-bench/baseline.json";

/** 数值分布（毫米/字高类指标）。 */
export type GenMetricDistribution = {
  min: number;
  median: number;
  max: number;
};

export type GenFigureMetrics = {
  figure_no: number;
  width_mm: number;
  height_mm: number;
  /** 单图独立落进 A4 可印区（与同文档统一缩放无关）。 */
  fits_printable_area: boolean;
  /** 同文档统一缩放后的打印字高（mm）。 */
  printed_font_mm: number;
};

export type GenCaseMetrics = {
  id: string;
  title: string;
  /** 法域档案键（纸面常数与编号体例的来源）。 */
  office: string;
  jurisdiction: string;
  /** 本用例的图幅数（图号条件性的输入）与是否按档案标注图号。 */
  figure_count: number;
  caption_rendered: boolean;
  /** 该法域的字高下限与来源性质（statute=条文数值 / practice=实践下限）。 */
  min_char_height_mm: { mm: number; basis: string };
  /** 低于字高下限的图数（V7 font_size 的原始素材）。 */
  font_below_limit: number;
  figures: GenFigureMetrics[];
  /** 同文档统一缩放系数。 */
  zoom: number;
  /** 单图独立落进可印区的比例。 */
  page_fit_rate: number;
  printed_font_mm: GenMetricDistribution;
  /** 规则命中数：rule → 严重度计数。 */
  rule_hits: Record<string, { fail: number; warn: number; info: number }>;
  fail_findings: number;
  warn_findings: number;
  ok: boolean;
  /** 文字面分节结论（V10/V11 是否真正生效；分节失败必须如实可见）。 */
  spec_faces: { sectioned: boolean; reason: string };
};

export type GenBenchmarkMetrics = {
  cases: GenCaseMetrics[];
  totals: {
    figures: number;
    page_fit_rate: number;
    printed_font_mm: GenMetricDistribution;
    /** 规则命中总数（各严重度合计）。 */
    rule_hits: Record<string, number>;
    fail_findings: number;
    warn_findings: number;
    /** 低于本用例法域字高下限的图数合计（V7 font_size 的汇总面）。 */
    font_below_limit: number;
    /** 分节生效的用例数 / 用例总数。 */
    spec_faces_sectioned: { sectioned: number; total: number };
  };
};

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function distribution(values: readonly number[], digits: number): GenMetricDistribution {
  if (values.length === 0) return { min: 0, median: 0, max: 0 };
  return {
    min: round(Math.min(...values), digits),
    median: round(median(values), digits),
    max: round(Math.max(...values), digits),
  };
}

/** 单用例指标（渲染画幅 + 核验结论；纯函数，可重算）。 */
export function computeCaseMetrics(benchmarkCase: GenBenchmarkCase): GenCaseMetrics {
  const jurisdiction = benchmarkCase.jurisdiction ?? "cn";
  const profile = profileForJurisdiction(jurisdiction);
  const area = printableArea(profile);
  const figureCount = benchmarkCase.figureCount ?? benchmarkCase.figures.length;
  // 画幅必须与渲染同源：不编号时少一条标注带（见 check.ts 的同名判据）
  const captionRendered = shouldRenderCaption(profile, figureCount);
  const sizes = benchmarkCase.figures.map(figure => {
    const layout = layoutFigure(figure, { caption: captionRendered });
    return { figure_no: figure.figure_no, widthMm: pxToMm(layout.width), heightMm: pxToMm(layout.height) };
  });
  const zoom = uniformFigureZoom(sizes, profile);
  const printedFontMmValue = round(printedFontMm(FIGURE_FONT_SIZE, zoom), 3);
  const limit = minCharHeight(profile) ?? { mm: 0, basis: "none" };
  const figures: GenFigureMetrics[] = sizes.map(size => ({
    figure_no: size.figure_no,
    width_mm: round(size.widthMm, 3),
    height_mm: round(size.heightMm, 3),
    fits_printable_area: size.widthMm <= area.widthMm && size.heightMm <= area.heightMm,
    printed_font_mm: printedFontMmValue,
  }));

  const check = checkFigures(benchmarkCase.figures, benchmarkCase.specText, {
    jurisdiction,
    figureCount,
    ...(benchmarkCase.numberedFigureNos === undefined ? {} : { numberedFigureNos: benchmarkCase.numberedFigureNos }),
    ...(benchmarkCase.documentKind === undefined ? {} : { documentKind: benchmarkCase.documentKind }),
  });

  const hitMap = new Map<string, { fail: number; warn: number; info: number }>();
  for (const finding of check.findings) {
    const hits = hitMap.get(finding.rule) ?? { fail: 0, warn: 0, info: 0 };
    hits[finding.severity] += 1;
    hitMap.set(finding.rule, hits);
  }
  const rule_hits: Record<string, { fail: number; warn: number; info: number }> = {};
  for (const rule of [...hitMap.keys()].sort()) rule_hits[rule] = hitMap.get(rule)!;

  const fitted = figures.filter(figure => figure.fits_printable_area).length;
  return {
    id: benchmarkCase.id,
    title: benchmarkCase.title,
    office: profile.office,
    jurisdiction,
    figure_count: figureCount,
    caption_rendered: captionRendered,
    min_char_height_mm: { mm: limit.mm, basis: limit.basis },
    font_below_limit: figures.filter(figure => limit.mm > 0 && figure.printed_font_mm < limit.mm).length,
    figures,
    zoom: round(zoom, 4),
    page_fit_rate: figures.length === 0 ? 0 : round(fitted / figures.length, 4),
    printed_font_mm: distribution(
      figures.map(figure => figure.printed_font_mm),
      3,
    ),
    rule_hits,
    fail_findings: check.findings.filter(finding => finding.severity === "fail").length,
    warn_findings: check.findings.filter(finding => finding.severity === "warn").length,
    ok: check.ok,
    spec_faces: {
      sectioned: check.specFaces?.sectioned ?? false,
      reason: check.specFaces?.reason ?? "未返回分节结论",
    },
  };
}

/** 全案指标（逐用例 + 汇总）。 */
export function computeBenchmarkMetrics(
  cases: readonly GenBenchmarkCase[] = GENERATION_BENCHMARK_CASES,
): GenBenchmarkMetrics {
  const caseMetrics = cases.map(computeCaseMetrics);
  const figures = caseMetrics.flatMap(item => item.figures);
  const fitted = figures.filter(figure => figure.fits_printable_area).length;
  const ruleTotals = new Map<string, number>();
  for (const item of caseMetrics) {
    for (const [rule, hits] of Object.entries(item.rule_hits)) {
      ruleTotals.set(rule, (ruleTotals.get(rule) ?? 0) + hits.fail + hits.warn + hits.info);
    }
  }
  const rule_hits: Record<string, number> = {};
  for (const rule of [...ruleTotals.keys()].sort()) rule_hits[rule] = ruleTotals.get(rule)!;

  return {
    cases: caseMetrics,
    totals: {
      figures: figures.length,
      page_fit_rate: figures.length === 0 ? 0 : round(fitted / figures.length, 4),
      printed_font_mm: distribution(
        figures.map(figure => figure.printed_font_mm),
        3,
      ),
      rule_hits,
      fail_findings: caseMetrics.reduce((sum, item) => sum + item.fail_findings, 0),
      warn_findings: caseMetrics.reduce((sum, item) => sum + item.warn_findings, 0),
      font_below_limit: caseMetrics.reduce((sum, item) => sum + item.font_below_limit, 0),
      spec_faces_sectioned: {
        sectioned: caseMetrics.filter(item => item.spec_faces.sectioned).length,
        total: caseMetrics.length,
      },
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 逐字段比对基线（返回可读漂移清单，空数组表示一致）。
 *
 * 不直接 deepEqual 是为了让失败信息指出**哪一项**漂了（`cases[2].figures[0].height_mm: 239 → 355`），
 * 而不是把两棵 JSON 树整篇打印出来。
 */
export function collectMetricDrift(expected: unknown, actual: unknown, basePath = ""): string[] {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return [`${basePath}.length: ${expected.length} → ${actual.length}`];
    }
    return expected.flatMap((item, index) => collectMetricDrift(item, actual[index], `${basePath}[${index}]`));
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    return keys.flatMap(key =>
      collectMetricDrift(expected[key], actual[key], basePath.length === 0 ? key : `${basePath}.${key}`),
    );
  }
  if (expected === actual) return [];
  return [`${basePath}: ${JSON.stringify(expected)} → ${JSON.stringify(actual)}`];
}

/** 解析基线 JSON（结构不合法即 fail-loud，不静默当作"无基线"）。 */
export function parseBaseline(text: string): GenBenchmarkMetrics {
  const parsed: unknown = JSON.parse(text);
  if (!isPlainObject(parsed) || !Array.isArray(parsed.cases) || !isPlainObject(parsed.totals)) {
    throw new Error("基线缺少 cases/totals 字段（用 --update 重新生成）");
  }
  return parsed as unknown as GenBenchmarkMetrics;
}

/** 基线路径（相对仓库根；测试与 CLI 共用）。 */
export function baselinePath(cwd: string): string {
  return path.resolve(cwd, GEN_BENCHMARK_BASELINE_RELATIVE_PATH);
}

function printMetrics(metrics: GenBenchmarkMetrics): void {
  console.log("用例                          档案   图数/共  图号  统一缩放  页内率  最小字高 下限   fail  warn  分节");
  for (const item of metrics.cases) {
    console.log(
      [
        item.id.padEnd(26),
        item.office.padStart(6),
        `${item.figures.length}/${item.figure_count}`.padStart(8),
        (item.caption_rendered ? "有" : "无").padStart(5),
        item.zoom.toFixed(3).padStart(8),
        item.page_fit_rate.toFixed(2).padStart(6),
        item.printed_font_mm.min.toFixed(2).padStart(8),
        `${item.min_char_height_mm.mm}${item.min_char_height_mm.basis === "practice" ? "(惯例)" : ""}`.padStart(10),
        String(item.fail_findings).padStart(6),
        String(item.warn_findings).padStart(5),
        item.spec_faces.sectioned ? "是" : "否",
      ].join(" "),
    );
  }
  const totals = metrics.totals;
  console.log(
    `合计: ${totals.figures} 图，页内率 ${totals.page_fit_rate.toFixed(2)}，` +
      `打印字高 ${totals.printed_font_mm.min.toFixed(2)}–${totals.printed_font_mm.max.toFixed(2)}mm，` +
      `fail ${totals.fail_findings} / warn ${totals.warn_findings}，低于字高下限 ${totals.font_below_limit} 图，` +
      `规则命中 ${
        Object.entries(totals.rule_hits)
          .map(([rule, count]) => `${rule}×${count}`)
          .join(" ") || "无"
      }`,
  );
}

async function main(): Promise<void> {
  const update = process.argv.includes("--update");
  const metrics = computeBenchmarkMetrics();
  printMetrics(metrics);

  const target = baselinePath(process.cwd());
  if (update) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
    console.log(`基线已更新: ${target}`);
    return;
  }

  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch {
    console.error(`基线缺失: ${target}（用 --update 生成）`);
    process.exitCode = 1;
    return;
  }
  const drift = collectMetricDrift(parseBaseline(raw), metrics);
  if (drift.length > 0) {
    console.error(`生成侧合规指标漂移 ${drift.length} 处（预期 → 实际）：`);
    for (const line of drift.slice(0, 20)) console.error(`  - ${line}`);
    if (drift.length > 20) console.error(`  …其余 ${drift.length - 20} 处`);
    console.error("确认变更符合预期后用 --update 刷新基线，并在 PR 中说明理由。");
    process.exitCode = 1;
    return;
  }
  console.log("生成侧合规指标与基线一致。");
}

// 仅在"直接运行脚本"时执行（测试 import 本模块只取纯函数，见 tests/scripts/figure-benchmark/）。
const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error("生成侧基准运行失败:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
