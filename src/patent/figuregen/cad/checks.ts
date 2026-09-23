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
 * - C11 标号退化：无可用引线落位 ⇒ 标号就地画在锚点上（压在图上）→ warn。退化是引擎的
 *   兜底而不是静默改写，故必须可观测。
 *
 * 明确不做（诚实边界）：**最小线间距**检查需要先重建轮廓（相邻边共享端点，逐点距离必然
 * 为 0），属更大的一块工作；当前先以"边数/退化边/缩放"三项覆盖可判定的部分。
 */

import type { FigureCheckSeverity } from "../check.js";
import { boxesOverlap, boxWithin, type Box } from "../render-utils.js";
import type { CadEdgeTable } from "./types.js";

export type CadRuleId = "C1" | "C2" | "C3" | "C4" | "C5" | "C6" | "C7" | "C8" | "C9" | "C10" | "C11";

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
  };
  hiddenLines: boolean;
};

/**
 * 矩形（纸面毫米，SVG 坐标系：top < bottom）。
 *
 * 与择位引擎的 `LeaderBox` 同为轴对齐矩形，故判"压盖/越界"的谓词共用一个实现
 * （`render-utils.ts`）——两处各写一份会让"算不算压盖"的口径分头演进，而两侧各有测试，
 * 改一边不会让另一边变红。
 */
export type CadBox = Box;

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

  return findings;
}
