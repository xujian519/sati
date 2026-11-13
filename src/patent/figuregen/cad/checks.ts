/**
 * src/patent/figuregen/cad — 几何级检查（CAD 图特有的确定性判据）。
 *
 * 为什么单列：V 规则吃 FigureSpec 的布局与文字，而 CAD 图的画幅由**投影几何**决定
 * （`render-cad` 按可印区适配缩放），文字面往往为空（标记由代理师后续标注）⇒ 需要
 * 一组针对"投影结果本身"的检查。规则号 `C*` 与 `V*`/`PX*` 分列：它们不是法规条款，
 * 而是"这张投影图能不能清楚交付"的工程判据。
 *
 * 判据（全部确定性、无模型）：
 * - C1 边数：可见边为 0 → fail（投影为空/方向错误）
 * - C2 退化短边：可见边总长 < 阈值 → warn（打印后不可辨的碎边）
 * - C3 适配缩放：为适配 A4 可印区而缩放的比例过低 → warn（线宽同比例变细，建议分幅/改比例）
 * - C4 隐藏线：开启隐藏线 → info（CNIPA 实务以剖视图表达内部结构，虚线不得妨碍标记线）
 * - C5 剖切有效性：请求了剖切但没有剖切面 → fail（剖切面落在模型范围之外，图会退化成
 *   整视图而**看不到剖面线**——名义剖视图与实交付不符，属交付缺陷）
 * - C6 剖面线可辨性：有剖切面但一条剖面线也画不出来 → warn（剖切面在纸面过小）
 * - C7 标注重叠：两个附图标记的标号框相交 → warn（标号糊在一起不可读）
 * - C8 标注锚点：锚点投影落在绘制几何范围之外 → warn（锚点多半写错了：投影图内没有该处）
 * - C9 标号越界：标号框超出图幅 → fail（会被画幅裁掉，图面上只剩半截数字）
 * - C10 钉死落位的后果：`label_offset_mm` 指定的标号压在图内内容上、或引线与主线条共线重叠
 *   （打印后分不清哪条是标记线，指南一部一章 4.3）、或引线穿过别的标号/与别的引线交叉
 *   → warn。**引擎择位的落位不会触发本规则**（择位判据已排除），故本规则实际是"钉死偏移
 *   的体检"：谁把标号钉到了主线条上，谁在这里被报出来。
 * - C11 标号退化：无可用引线落位 ⇒ 标号就地画在锚点上（压在图上）→ warn。只出现在
 *   `mode: "degrade"` 的调用方。CAD 走 strict，放不下时不会产出这张图。
 * - C12 标号压盖图号注记：标号框与图下方的"图N"注记框相交 → warn。两者都读不出；注记已
 *   作为择位障碍（正常落位不会触发），本规则兜住钉死落位与旧产物。
 * - C13 引线 strict 失败：候选耗尽，{@link LeaderPlacementError}。图还没画出来，本函数
 *   不在渲染结果上事后扫描，而由 {@link findingForLeaderPlacementError} 把错误收成 fail，
 *   说明里写明减少标记、拆图或钉死偏移。
 * - C14 锚点不落在零件上：附图标记的锚点既不在任何零件的表面、也不在任何零件的包围盒
 *   内（容差 0.5mm）→ warn（引线可能指向错误位置/错误零件，不静默画出去）
 * - C15 引线横穿零件面：锚点的**投影位置**落在其归属零件的投影轮廓内部（离轮廓 >0.5mm）
 *   → warn（引线会从零件面里穿出来；建议把锚点移到零件轮廓外缘）
 * - C16 剖面线方向交替：报出各剖切面的剖面线方向（相邻零件方向相反，GB/T 4457.5）→ info
 *
 * 明确不做（诚实边界）：**最小线间距**检查需要先重建轮廓（相邻边共享端点，逐点距离必然
 * 为 0），属更大的一块工作；当前先以"边数/退化边/缩放"三项覆盖可判定的部分。
 */

import type { FigureCheckSeverity } from "../check.js";
import { LEADER_PLACEMENT_GUIDANCE, type LeaderPlacementError } from "../leader-line.js";
import { boxesOverlap, boxWithin, type Box } from "../render-utils.js";
import type { CadCalloutBinding } from "./anchors.js";
import {
  CAD_ANCHOR_TOLERANCE_MM,
  projectModelPoints,
  type CadAnchorCheck,
  type CadEdgeTable,
  type CadPartFact,
} from "./types.js";

export type CadRuleId =
  | "C1"
  | "C2"
  | "C3"
  | "C4"
  | "C5"
  | "C6"
  | "C7"
  | "C8"
  | "C9"
  | "C10"
  | "C11"
  | "C12"
  | "C13"
  | "C14"
  | "C15"
  | "C16";

export type CadFinding = {
  rule: CadRuleId;
  severity: FigureCheckSeverity;
  message: string;
  evidence?: string[];
};

/** C2 阈值：可见边总长下限（毫米）——低于此值的碎边打印后不可辨。 */
export const CAD_MIN_VISIBLE_EDGE_LENGTH_MM = 0.2;
/** C3 阈值：适配缩放低于此值判 warn（线宽与字高同比例缩小）。 */
export const CAD_MIN_FIT_SCALE = 0.5;

/** 边长（折线累加，毫米）。 */
export function polylineLengthMm(points: readonly (readonly [number, number])[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return length;
}

export type CadCheckInput = {
  table: CadEdgeTable;
  /**
   * 渲染结果（缩放/纸面尺寸/剖面线与标注落位）。**缺省时跳过依赖排版的 C2/C3/C6–C9**
   * ——C1（边数）与 C5（剖切有效性）不依赖排版，故调用方可在渲染前先跑一轮把
   * "投影为空""没切开"拦在出图之前。
   */
  render?: {
    scale: number;
    widthMm: number;
    heightMm: number;
    /** 剖面线段数（0 而存在剖切面 ⇒ C6）。 */
    hatchSegments?: number;
    /** 标注落位（纸面毫米）。 */
    labels?: readonly {
      ref: number;
      anchorMm: [number, number];
      labelMm: [number, number];
      boxMm: CadBox;
      /** 引线折线（C10）；旧调用方不给则跳过 C10。 */
      leaderMm?: readonly { from: { x: number; y: number }; to: { x: number; y: number } }[];
      /** 是否退化（C11）。 */
      degraded?: boolean;
      /** 钉死落位的后果（C10）。 */
      conflicts?: readonly string[];
    }[];
    /** 绘制几何（不含标注）的纸面范围（C8）。 */
    geometryBoundsMm?: CadBox;
    /** 图号注记的纸面包围盒（C12；无图号时缺省）。 */
    captionBoxMm?: CadBox;
    /** 各剖切面的剖面线方向角（度；C16 报出）。 */
    hatchAnglesDeg?: readonly number[];
  };
  hiddenLines: boolean;
  /**
   * 显式锚点的归属核对**测量**（与调用方的标注顺序一致）。
   *
   * 缺省或长度不足 ⇒ 锚点类判据（C14/C15）**不适用**（不报"通过"；由调用方在报告里
   * 如实声明判据未适用）。
   */
  anchorChecks?: readonly CadAnchorCheck[];
  /**
   * 件号 ↔ 零件的归属记录（C15 需要归属零件的投影包围盒）。
   */
  bindings?: readonly CadCalloutBinding[];
  /** 每零件几何事实（C15 需要零件的投影包围盒）。 */
  parts?: readonly CadPartFact[];
};

/**
 * 矩形（纸面毫米，SVG 坐标系：top < bottom）。
 *
 * 与择位引擎的 `LeaderBox` 同为轴对齐矩形，故判"压盖/越界"的谓词共用一个实现
 * （`render-utils.ts`）——两处各写一份会让"算不算压盖"的口径分头演进，而两侧各有测试，
 * 改一边不会让另一边变红。
 */
export type CadBox = Box;

/**
 * 把 strict 择位失败收成 C13。渲染结果不存在（fail-closed），所以不能等
 * {@link checkCadProjection} 去扫一张没画出来的图。
 */
export function findingForLeaderPlacementError(error: LeaderPlacementError): CadFinding {
  return {
    rule: "C13",
    severity: "fail",
    message: error.message,
    evidence: [...error.unplaceableIds.map(id => `标记 ${id} 无满足硬约束的引线落位`), LEADER_PLACEMENT_GUIDANCE],
  };
}

/** 几何级检查（纯函数）。 */
export function checkCadProjection(input: CadCheckInput): CadFinding[] {
  const findings: CadFinding[] = [];
  const visible = input.table.edges.filter(edge => edge.kind === "visible");
  const cutFaces = input.table.cutFaces ?? [];

  if (visible.length === 0) {
    findings.push({
      rule: "C1",
      severity: "fail",
      message: `视图 ${input.table.view} 的投影没有可见边（几何不可见或方向错误），不得出图`,
      evidence: [
        `可见边 0，隐藏边 ${input.table.edges.filter(edge => edge.kind === "hidden").length}`,
        `曲线类型：${JSON.stringify(input.table.curveKinds)}`,
      ],
    });
  } else {
    findings.push({
      rule: "C1",
      severity: "info",
      message: `投影边：可见 ${visible.length} 条，隐藏 ${input.table.edges.filter(edge => edge.kind === "hidden").length} 条（视图 ${input.table.view}）`,
    });
  }

  const degenerate = visible
    .map(edge => ({ edge, length: polylineLengthMm(edge.points) }))
    .filter(entry => entry.length < CAD_MIN_VISIBLE_EDGE_LENGTH_MM);
  if (input.render !== undefined && degenerate.length > 0) {
    findings.push({
      rule: "C2",
      severity: "warn",
      message: `有 ${degenerate.length} 条可见边短于 ${CAD_MIN_VISIBLE_EDGE_LENGTH_MM}mm（打印后不可辨），建议降低投影容差或简化几何`,
      evidence: degenerate.slice(0, 5).map(entry => `边长 ${entry.length.toFixed(3)}mm（${entry.edge.curve}）`),
    });
  }

  if (input.render !== undefined && input.render.scale < CAD_MIN_FIT_SCALE) {
    findings.push({
      rule: "C3",
      severity: "warn",
      message:
        `为适配 A4 可印区需缩放到 ${(input.render.scale * 100).toFixed(0)}%（低于 ${CAD_MIN_FIT_SCALE * 100}%）：` +
        "线宽与后续标注字高会同比例变细，建议按视图分幅或改用更合适的视图",
      evidence: [`几何纸面尺寸 ${input.render.widthMm.toFixed(1)}×${input.render.heightMm.toFixed(1)}mm`],
      // 注：evidence 与 C3 同源（渲染结果），故仅在 render 存在时可达
    });
  }

  if (input.hiddenLines) {
    findings.push({
      rule: "C4",
      severity: "info",
      message: "已绘制隐藏线（虚线）：CNIPA 实务以剖视图表达内部结构，请确认虚线不妨碍附图标记线",
    });
  }

  // C5 剖切有效性：名义剖视图必须真的切到材料（否则图上没有剖面线，与"剖视图"名不符）
  if (input.table.section !== undefined && cutFaces.length === 0) {
    const [min, max] = input.table.section.model_extent_mm;
    findings.push({
      rule: "C5",
      severity: "fail",
      message:
        `剖切面位于 ${input.table.section.offset_mm}mm，未切开任何材料（模型沿视线方向范围为 ` +
        `${min}–${max}mm）：剖切退化为整视图，图上不会出现剖面线，与"剖视图"不符`,
      evidence: [
        `视图 ${input.table.view}；剖切面须落在模型范围内部（不含端点）`,
        `模型沿视线方向范围 ${min}–${max}mm，剖切偏移 ${input.table.section.offset_mm}mm`,
      ],
    });
  } else if (input.table.section !== undefined) {
    findings.push({
      rule: "C5",
      severity: "info",
      message: `剖切有效：视图 ${input.table.view} 在 ${input.table.section.offset_mm}mm 处剖开，得到 ${cutFaces.length} 个剖切面`,
    });
  }

  // C6 剖面线可辨性：有剖切面但一条线也画不出（剖切面在纸面过小）
  if (input.render !== undefined && cutFaces.length > 0 && input.render.hatchSegments === 0) {
    findings.push({
      rule: "C6",
      severity: "warn",
      message:
        `剖切面在纸面上过小，剖面线无法表达（缩放到 ${(input.render.scale * 100).toFixed(0)}% 后不足一条剖面线），` +
        "建议改用更小范围的剖切、放大视图或分幅出图",
      evidence: [`剖切面数 ${cutFaces.length}，剖面线段数 ${input.render.hatchSegments ?? 0}`],
    });
  }

  // C7 标注重叠 / C8 锚点越界（均依赖渲染落位）
  const labels = input.render?.labels ?? [];
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      if (boxesOverlap(labels[i]!.boxMm, labels[j]!.boxMm)) {
        findings.push({
          rule: "C7",
          severity: "warn",
          message: `附图标记 ${labels[i]!.ref} 与 ${labels[j]!.ref} 的标号重叠，无法分辨`,
          evidence: [
            `标记 ${labels[i]!.ref} 标号位置 (${labels[i]!.labelMm[0].toFixed(1)}, ${labels[i]!.labelMm[1].toFixed(1)})mm，` +
              `标记 ${labels[j]!.ref} 标号位置 (${labels[j]!.labelMm[0].toFixed(1)}, ${labels[j]!.labelMm[1].toFixed(1)})mm`,
            "可经 label_offset_mm 显式指定标号位置（纸面毫米偏移）",
          ],
        });
      }
    }
  }
  const bounds = input.render?.geometryBoundsMm;
  if (bounds !== undefined) {
    const outside = labels.filter(
      label =>
        label.anchorMm[0] < bounds.left - 1e-6 ||
        label.anchorMm[0] > bounds.right + 1e-6 ||
        label.anchorMm[1] < bounds.top - 1e-6 ||
        label.anchorMm[1] > bounds.bottom + 1e-6,
    );
    if (outside.length > 0) {
      findings.push({
        rule: "C8",
        severity: "warn",
        message: `有 ${outside.length} 个附图标记的锚点落在投影几何范围之外（该处图面上没有几何，锚点坐标多半写错）`,
        evidence: outside
          .slice(0, 5)
          .map(
            label =>
              `标记 ${label.ref} 锚点 (${label.anchorMm[0].toFixed(1)}, ${label.anchorMm[1].toFixed(1)})mm 超出图内范围 ` +
              `x ${bounds.left.toFixed(1)}–${bounds.right.toFixed(1)}mm、y ${bounds.top.toFixed(1)}–${bounds.bottom.toFixed(1)}mm`,
          ),
      });
    }
  }

  // C9 标号越界：标号框必须落在纸面内（超出会被 SVG 画幅裁掉，图面上只剩半截数字）
  if (input.render !== undefined && labels.length > 0) {
    const page = { left: 0, top: 0, right: input.render.widthMm, bottom: input.render.heightMm };
    const clipped = labels.filter(label => !boxWithin(label.boxMm, page));
    if (clipped.length > 0) {
      findings.push({
        rule: "C9",
        severity: "fail",
        message:
          `有 ${clipped.length} 个附图标记的标号超出图幅 ${input.render.widthMm.toFixed(1)}×${input.render.heightMm.toFixed(1)}mm` +
          "（会被裁掉，图面上只剩半截数字）",
        evidence: [
          ...clipped
            .slice(0, 5)
            .map(
              label =>
                `标记 ${label.ref} 标号框 x ${label.boxMm.left.toFixed(1)}–${label.boxMm.right.toFixed(1)}mm、` +
                `y ${label.boxMm.top.toFixed(1)}–${label.boxMm.bottom.toFixed(1)}mm 超出图幅`,
            ),
          "可用 label_offset_mm 收紧标号位置，或减少同时标注的附图标记",
        ],
      });
    }
  }

  // C10 钉死落位的后果：引擎择位不会留下冲突，故有冲突必是 label_offset_mm 钉出来的
  const conflicted = labels.filter(label => (label.conflicts ?? []).length > 0);
  if (conflicted.length > 0) {
    findings.push({
      rule: "C10",
      severity: "warn",
      message:
        `有 ${conflicted.length} 个标记的显式落位（label_offset_mm）与图面冲突：` +
        "标记线与主线条分不清、或引线穿过别的标号（指南一部一章 4.3：标记线与主线条不得互相妨碍）",
      evidence: [
        ...conflicted.slice(0, 5).flatMap(label => label.conflicts!.map(conflict => `标记 ${label.ref}：${conflict}`)),
        "去掉 label_offset_mm 让引擎自行择位（引擎会避开图内线条与已放标号）",
      ],
    });
  }

  // C11 标号退化：无可用落位 ⇒ 就地标号（压在图上），必须可观测而不是静默降级
  const degraded = labels.filter(label => label.degraded === true);
  if (degraded.length > 0) {
    findings.push({
      rule: "C11",
      severity: "warn",
      message:
        `有 ${degraded.length} 个标记找不到可用的引线落位，退化为就地标号（无引线，标号压在图上）：` +
        "请显式指定该标记的落位，或减少同时标注的标记",
      evidence: degraded.slice(0, 5).map(label => `标记 ${label.ref} 标号落在锚点上，无引线`),
    });
  }

  // C12 标号压盖图号注记：图下方的"图N"与标号都是要读的文字，重叠即两者都读不出。
  // 择位已把注记框当障碍（正常落位不会触发），这里兜住钉死落位与旧产物。
  const captionBox = input.render?.captionBoxMm;
  if (captionBox !== undefined) {
    const covered = labels.filter(label => boxesOverlap(label.boxMm, captionBox));
    if (covered.length > 0) {
      findings.push({
        rule: "C12",
        severity: "warn",
        message: `有 ${covered.length} 个附图标记的标号压盖了图号注记，标号与图号都无法完整读出`,
        evidence: [
          ...covered
            .slice(0, 5)
            .map(
              label =>
                `标记 ${label.ref} 标号框 x ${label.boxMm.left.toFixed(1)}–${label.boxMm.right.toFixed(1)}mm、` +
                `y ${label.boxMm.top.toFixed(1)}–${label.boxMm.bottom.toFixed(1)}mm 与图号注记相交`,
            ),
          "去掉 label_offset_mm 让引擎自行择位（注记已作为择位障碍）",
        ],
      });
    }
  }

  // C16 剖面线方向交替：相邻零件的剖面线方向相反（GB/T 4457.5），
  // 否则图面上相邻材料区域糊成一片、不可分辨。
  const hatchAngles = input.render?.hatchAnglesDeg;
  if (hatchAngles !== undefined && hatchAngles.length > 0) {
    const distinct = [...new Set(hatchAngles)].sort((left, right) => left - right);
    findings.push({
      rule: "C16",
      severity: "info",
      message:
        `剖面线方向：${hatchAngles.map(angle => `${angle}°`).join(" / ")}` +
        `（${hatchAngles.length} 个剖切面，方向取值 ${distinct.join("° / ")}°，相邻件方向相反以示区分）`,
      evidence:
        distinct.length < 2 ? ["只有一种方向：多个相邻零件的剖面线将无法区分（应检查剖切面是否真的相邻）"] : undefined,
    });
  }

  // C14 锚点不落在零件上：锚点既不在任何零件表面、也不在任何零件包围盒内（容差 0.5mm）
  // ⇒ 引线可能指向错误位置/错误零件。必须报出来，而不是静默画一条指错的引线。
  const anchorChecks = input.anchorChecks ?? [];
  if (anchorChecks.length > 0) {
    const offPart = anchorChecks.filter(check => !check.onPart);
    if (offPart.length > 0) {
      findings.push({
        rule: "C14",
        severity: "warn",
        message:
          `有 ${offPart.length} 个附图标记的锚点不落在任何零件上（既不在零件表面，也不在零件包围盒内，` +
          `容差 ${CAD_ANCHOR_TOLERANCE_MM}mm）：引线可能指向错误位置`,
        evidence: offPart.slice(0, 5).map(check => {
          const nearest =
            check.nearestPart === undefined
              ? "（模型没有零件可比对）"
              : `最近的零件 ${check.nearestPart} 距表面 ${
                  check.nearestSurfaceDistanceMm === undefined ? "未知" : check.nearestSurfaceDistanceMm.toFixed(3)
                }mm`;
          return `锚点 (${check.point.map(value => value.toFixed(2)).join(", ")})mm，${nearest}`;
        }),
      });
    }
  }

  // C15 引线横穿零件面：锚点的投影位置落在归属零件的投影轮廓内部（离轮廓 > 0.5mm）
  // ⇒ 引线会从零件面里穿出。建议把锚点移到零件轮廓外缘（自动件号已按此口径选取）。
  const bindings = input.bindings ?? [];
  const parts = input.parts ?? [];
  if (bindings.length > 0 && parts.length > 0) {
    const inside: string[] = [];
    for (const binding of bindings) {
      if (binding.partIndex === null) continue;
      const part = parts.find(entry => entry.index === binding.partIndex);
      if (part === undefined) continue;
      const fact = part.views[input.table.view];
      if (fact === undefined) continue;
      const [u, v] = projectModelPoints(input.table.axes, [binding.anchorMm])[0]!;
      const { min, max } = fact.projectedBBox;
      const depth = Math.min(u - min[0], max[0] - u, v - min[1], max[1] - v);
      if (depth > CAD_ANCHOR_TOLERANCE_MM) {
        inside.push(
          `视图 ${input.table.view}：标记 ${binding.ref}（零件 ${binding.partIndex}）` +
            `锚点投影落在零件轮廓内 ${depth.toFixed(1)}mm`,
        );
      }
    }
    if (inside.length > 0) {
      findings.push({
        rule: "C15",
        severity: "warn",
        message:
          `有 ${inside.length} 个附图标记的锚点落在其零件的投影轮廓内部（离轮廓 >${CAD_ANCHOR_TOLERANCE_MM}mm）：` +
          "引线将横穿零件面，建议把锚点移到零件轮廓外缘",
        evidence: inside.slice(0, 5),
      });
    }
  }

  return findings;
}
