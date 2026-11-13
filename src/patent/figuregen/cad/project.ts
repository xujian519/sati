/**
 * src/patent/figuregen/cad — 结构图投影**编排**（一次 FreeCAD 运行 → 多视图 → 渲染 → 几何检查）。
 *
 * 用途：把"跑 FreeCAD + 绑定件号 + 渲染 + 几何级检查"这一串动作收在一处，让工具层
 * 只留"入参校验 / env 解析 / 产物落盘 / 报告"四件事。
 *
 * **与 DSH 的对应关系**：DSH 的 `freecad-renderer.ts` 同样"一次进程跑多视图"，同样在
 * 渲染前做件号锚点核对。本模块的差异是**分工**：DSH 把画图也放在脚本侧（`viewPartAsSvg`
 * 直接出 SVG 片段），本仓坚持"FreeCAD 只给 JSON、画图归 Sati"（黑白不变式、`data-ref`、
 * A4 版式、回读全部复用既有交付契约）⇒ 编排必须把**渲染**也纳入同一次调用。
 *
 * **架构差异与理由**：
 * - 编排放在 `cad/` 而不是工具层：工具文件已接近行数上限（800 行硬限），而"多视图 +
 *   锚点 + 剖面线交替"是 CAD 域的算法，不该挤在工具层；
 * - 编排**不碰文件系统**（落盘在 `artifacts.ts`）：于是"投影与渲染"的正确性可以在单测里
 *   用注入的 runner 验证，不必落盘；
 * - 失败语义保持既有契约：**先判几何（C1/C5）再出图**，几何不可交付时抛
 *   {@link CadProjectionError}（消息里保留"投影结果不可交付 / 图幅不可交付"字样，
 *   工具层原样转成 `tool_execution_failed`），绝不产出半成品。
 */

import type { Jurisdiction } from "../types.js";
import { bindCallouts, type CadCalloutBinding } from "./anchors.js";
import { checkCadProjection, type CadFinding } from "./checks.js";
import { projectViews, type CadRunner } from "./freecad.js";
import { renderCadSvg, type CadRefAnnotation, type CadRenderResult } from "./render-cad.js";
import { CAD_PROJECTION_VERSION, type CadEdgeTable, type CadPartFact, type CadView } from "./types.js";

/** 几何不可交付（出图前的 fail-closed）。 */
export class CadProjectionError extends Error {
  /** 触发失败的几何级检查发现（供工具层落进错误详情）。 */
  readonly findings: readonly CadFinding[];

  constructor(message: string, findings: readonly CadFinding[]) {
    super(message);
    this.name = "CadProjectionError";
    this.findings = findings;
  }
}

/** 一次投影的请求（编排层入参）。 */
export type CadProjectRequest = {
  /** freecadcmd 路径。 */
  cmd: string;
  /** STEP 路径。 */
  stepPath: string;
  /** 视图集（顺序即输出顺序；第一个是主视图，也是唯一可能被剖切的视图）。 */
  views: readonly CadView[];
  /** 全剖视图的剖切位置（毫米；只作用于主视图）。 */
  sectionOffsetMm?: number;
  /** 投影离散化容差（毫米）。 */
  toleranceMm?: number;
  /** 调用方显式给的附图标记（模型坐标锚点）。 */
  annotations: readonly CadRefAnnotation[];
  /** 是否为没有显式锚点的零件自动补件号。 */
  autoAnchors: boolean;
  /** 图号。 */
  figureNo: number;
  /** 目标法域（影响图号体例与标号字号）。 */
  jurisdiction?: Jurisdiction;
  /** 本案附图总幅数。 */
  figureCount?: number;
  /** 是否绘制隐藏线。 */
  hiddenLines: boolean;
  /** 注入点：单测传假运行器（不真跑 FreeCAD）。 */
  runner?: CadRunner;
};

/** 单个视图的投影结果。 */
export type CadProjectedView = {
  /** 视图名。 */
  view: CadView;
  /** 该视图的边表。 */
  table: CadEdgeTable;
  /** 该视图的渲染结果。 */
  render: CadRenderResult;
  /** 实际用于渲染的标注（显式 + 自动）。 */
  annotations: readonly CadRefAnnotation[];
  /** 件号 ↔ 零件的归属记录（与 `annotations` 同序）。 */
  bindings: readonly CadCalloutBinding[];
  /** 几何级检查发现（C1–C16）。 */
  findings: readonly CadFinding[];
  /** 判据口径说明（如"零件口径不适用"，如实声明而非静默通过）。 */
  notices: readonly string[];
};

/** 一次投影的产出。 */
export type CadProjectionOutcome = {
  /** 逐视图结果（顺序即输出顺序）。 */
  views: readonly CadProjectedView[];
  /** 每零件几何事实（顺序即件号归属口径）。 */
  parts: readonly CadPartFact[];
  /** 主视图（第一个视图）。 */
  primary: CadProjectedView;
};

/**
 * 跑一次结构图投影：一次 FreeCAD 运行产出全部视图，逐视图渲染并做几何级检查。
 *
 * 失败契约：
 * - 出图前的几何检查（C1 边数 / C5 剖切有效性）不通过 ⇒ 抛 {@link CadProjectionError}
 *   （fail-closed，不产出图）；
 * - 排版后的几何检查出现 fail ⇒ 同样抛 {@link CadProjectionError}；
 * - FreeCAD 侧失败（退出码非 0 / 输出不可解析）⇒ 由 `freecad.ts` 抛错，真因带 stderr。
 */
export async function projectCadViews(request: CadProjectRequest): Promise<CadProjectionOutcome> {
  const probes = request.annotations.map(
    annotation => [annotation.atMm[0], annotation.atMm[1], annotation.atMm[2]] as [number, number, number],
  );
  const payload = await projectViews({
    cmd: request.cmd,
    stepPath: request.stepPath,
    views: request.views,
    ...(request.sectionOffsetMm === undefined ? {} : { sectionOffsetMm: request.sectionOffsetMm }),
    ...(request.toleranceMm === undefined ? {} : { toleranceMm: request.toleranceMm }),
    anchorProbes: probes,
    ...(request.runner === undefined ? {} : { runner: request.runner }),
  });

  const projected: CadProjectedView[] = [];
  for (const table of payload.views) {
    // 件号归属先定（不依赖渲染）：归属与锚点核对是**测量**（脚本已给出），
    // C14/C15 因此能在出图前报出来——引线择位失败时也不会丢掉锚点问题。
    const binding = bindCallouts({
      explicit: request.annotations,
      checks: payload.anchors,
      parts: payload.parts,
      view: table.view,
      autoAnchors: request.autoAnchors,
      partFactsAvailable: payload.version === CAD_PROJECTION_VERSION,
    });
    // 几何级检查分两步：C1（边数）、C5（剖切有效性）、C14/C15（锚点归属与轮廓）
    // 先于出图 → fail-closed；C2/C3/C6–C13/C16 依赖排版（缩放/剖面线/标注落位）→ 渲染后。
    const edgeFindings = checkCadProjection({
      table,
      hiddenLines: request.hiddenLines,
      anchorChecks: payload.anchors,
      bindings: binding.bindings,
      parts: payload.parts,
    });
    const blocker = edgeFindings.find(finding => finding.severity === "fail");
    if (blocker !== undefined) {
      throw new CadProjectionError(`投影结果不可交付：${blocker.message}`, edgeFindings);
    }
    const render = renderCadSvg(table, {
      figureNo: request.figureNo,
      ...(request.jurisdiction === undefined ? {} : { jurisdiction: request.jurisdiction }),
      figureCount: request.figureCount ?? 1,
      hiddenLines: request.hiddenLines,
      ...(binding.annotations.length === 0 ? {} : { annotations: binding.annotations }),
    });
    const findings = [
      ...edgeFindings,
      ...checkCadProjection({
        table,
        render,
        hiddenLines: request.hiddenLines,
      }).filter(finding => finding.rule !== "C1" && finding.rule !== "C5"),
    ];
    const layoutBlocker = findings.find(finding => finding.severity === "fail");
    if (layoutBlocker !== undefined) {
      throw new CadProjectionError(`图幅不可交付：${layoutBlocker.message}`, findings);
    }
    projected.push({
      view: table.view,
      table,
      render,
      annotations: binding.annotations,
      bindings: binding.bindings,
      findings,
      notices: binding.notices,
    });
  }
  const primary = projected[0];
  if (primary === undefined) {
    throw new CadProjectionError("投影结果不可交付：没有产出任何视图", []);
  }
  return { views: projected, parts: payload.parts, primary };
}
