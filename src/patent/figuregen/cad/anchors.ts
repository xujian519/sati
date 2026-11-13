/**
 * src/patent/figuregen/cad — 件号 ↔ 零件的归属口径、锚点选取与核对。
 *
 * 用途：把"零件几何事实 + 调用方给的锚点"装配成"每个件号落在哪个零件、锚在哪"的可查
 * 对应关系，并按需为**没有显式锚点**的零件自动选取锚点。
 *
 * **与 DSH 的对应关系**：DSH 的 `freecad-structure-script.ts` 里 `resolve_auto_anchors`
 * 为"没给 `point3d` 的件号"在**该零件的真实顶点**里挑一个投影后离轮廓中心最远的点，
 * `verify_callout_owners` 再按零件真实几何核对显式锚点（容差 0.5mm，与本模块同值）。
 * 本模块与之同构，但把两件事拆开：
 * - **几何测量在 FreeCAD 侧**（`distToShape` 只有那边有几何），本模块只做**归属口径**
 *   与**政策**（显式优先、顺序即归属、不适用时如实声明）；
 * - DSH 的件号归属由调用方用 `model`（模型下标）显式声明；本仓**不能改 `inputSchema`**
 *   （改动会使 llm-replay fixture 失配），故归属改为**几何判定**：锚点落在哪个零件上，
 *   就归属哪个零件，并把判定结果写进产物（manifest / sidecar），让下游不必猜。
 *
 * **架构差异与理由**：归属判定放在 TS 侧而非脚本侧，是因为"显式优先 / 自动补齐 / 不适用
 * 时声明"是**政策**（随调用方意图变化），而"某点离哪个零件多远"是**测量**（只取决于模型）。
 * 两者分开后，政策可以在单测里用录制的测量结果验证，不必真跑 FreeCAD。
 *
 * **「在投影包围盒之外」的实现口径（重要，勿误读）**：
 * 一个落在零件**表面**上的点，其投影必然落在该零件的投影轮廓之内（轮廓就是表面投影的
 * 并集）⇒ "既在表面上又严格在投影包围盒之外"在几何上不可兼得。本模块取的是：
 * - 建议锚点 = 零件表面采样点中**投影离轮廓中心最远**者 ⇒ 它的投影恰在投影包围盒的**边界**
 *   （引线自轮廓向外引出，不横穿零件面）；
 * - 再沿包围盒的外法向**外推 0.05mm**（`CAD_ANCHOR_OUTSET_MM`）⇒ 投影位置严格在包围盒之外，
 *   而它到零件表面的距离仍是 0.05mm < 容差 0.5mm ⇒ "落在该零件表面上"这条按容差口径成立。
 * 两端都满足，且偏移量小到打印后不可观察。
 */

import type { CadRefAnnotation } from "./render-cad.js";
import { CAD_ANCHOR_TOLERANCE_MM, type CadAnchorCheck, type CadPartFact, type CadView } from "./types.js";

/** 锚点外推量（毫米，投影平面内）：把引线起点推到零件投影包围盒之外。 */
export const CAD_ANCHOR_OUTSET_MM = 0.05;

/** 包围盒边界比较的容差（毫米，投影平面内）：浮点噪声不该被当成"在边界上"。 */
const BBOX_EPSILON_MM = 1e-6;

/** 件号锚点的来源。 */
export type CadCalloutSource = "explicit" | "auto";

/** 一个件号与零件的归属记录（件号 → 零件序号 → 锚点坐标）。 */
export type CadCalloutBinding = {
  /** 件号（附图标记号）。 */
  ref: number;
  /** 归属零件下标；null = 不落在任何零件上（见 C14）。 */
  partIndex: number | null;
  /** 锚点（模型坐标，毫米）。 */
  anchorMm: [number, number, number];
  /** 锚点来源：调用方显式给出 / 按零件顺序自动选取。 */
  source: CadCalloutSource;
  /** 自动件号是否已把锚点外推到零件投影包围盒之外（显式件号恒为 false）。 */
  outsetApplied: boolean;
};

/** 锚点归属的结果。 */
export type CadAnchorBinding = {
  /** 实际用于渲染的标注（显式在前、自动在后，顺序稳定）。 */
  annotations: CadRefAnnotation[];
  /** 与 `annotations` 同序的归属记录。 */
  bindings: CadCalloutBinding[];
  /** 显式锚点中"不落在任何零件上"的件号（C14 的输入）。 */
  unboundRefs: number[];
  /** 判据不适用或口径说明（如实声明，不静默通过）。 */
  notices: string[];
};

/**
 * 把锚点推出零件的投影包围盒（沿包围盒的外法向）。
 *
 * 返回投影平面内的偏移量（毫米）。锚点已在边界上时按"取极值的那一维"外推；
 * 锚点严格在包围盒内部时返回零偏移（此时由 C15 报"引线将横穿零件面"，不偷偷挪点）。
 */
export function anchorOutsetMm(
  projected: readonly [number, number],
  bbox: { min: readonly [number, number]; max: readonly [number, number] },
  marginMm: number = CAD_ANCHOR_OUTSET_MM,
): [number, number] {
  let dx = 0;
  let dy = 0;
  if (projected[0] >= bbox.max[0] - BBOX_EPSILON_MM) dx = marginMm;
  else if (projected[0] <= bbox.min[0] + BBOX_EPSILON_MM) dx = -marginMm;
  if (projected[1] >= bbox.max[1] - BBOX_EPSILON_MM) dy = marginMm;
  else if (projected[1] <= bbox.min[1] + BBOX_EPSILON_MM) dy = -marginMm;
  return [dx, dy];
}

/**
 * 装配件号 ↔ 零件的归属，并按需自动补齐锚点。
 *
 * 规则（顺序即口径）：
 * 1. **显式优先**：调用方给了 `at_mm` 的件号一律沿用（不改既有语义），其归属由
 *    几何测量给出（锚点落在哪个零件上就归属哪个）；
 * 2. **顺序即归属**：零件序号 = STEP 中 solid 的出现顺序；自动件号按零件顺序依次取
 *    该零件的**建议锚点**，件号取"未被显式占用"的最小正整数（确定性、可复现）；
 * 3. **不适用时如实声明**：模型没有 solid ⇒ 零件口径不适用（不报"通过"，也不误报
 *    C14）；模型只有 1 个 solid ⇒ 归属无歧义（归属按唯一零件记录）。
 */
export function bindCallouts(args: {
  /** 调用方显式给的标注（顺序即 refs 顺序）。 */
  explicit: readonly CadRefAnnotation[];
  /** 脚本测得的锚点归属（与 `explicit` 同序；缺失表示未核对）。 */
  checks: readonly CadAnchorCheck[];
  /** 每零件几何事实（顺序即零件序号）。 */
  parts: readonly CadPartFact[];
  /** 当前视图（取零件的逐视图事实）。 */
  view: CadView;
  /** 是否为没有显式锚点的零件自动补件号。 */
  autoAnchors: boolean;
  /**
   * 载荷里**是否带零件事实**。
   *
   * 缺省 true。历史载荷（v2：单视图平铺、没有零件事实）传 false ⇒ 口径说明必须写
   * "产物不含零件事实（未核对）"，**不得**写成"模型没有 solid"——后者是对模型的断言，
   * 而我们只是没测（AGENTS.md 第 11 条：不得把「未量测」呈现成「通过」，也不得把
   * 「没测」呈现成「测得没有」）。
   */
  partFactsAvailable?: boolean;
}): CadAnchorBinding {
  const { explicit, checks, parts, view, autoAnchors } = args;
  const annotations: CadRefAnnotation[] = [];
  const bindings: CadCalloutBinding[] = [];
  const unboundRefs: number[] = [];
  const notices: string[] = [];
  const covered = new Set<number>();

  const partFactsAvailable = args.partFactsAvailable ?? true;
  if (!partFactsAvailable) {
    notices.push("投影产物不含零件事实（历史载荷）：附图标记的零件归属未核对（未量测，既不判通过，也不误报 C14）");
  } else if (parts.length === 0) {
    notices.push("模型没有 solid（零件口径不适用）：附图标记的零件归属未核对（既不判通过，也不误报 C14）");
  }

  explicit.forEach((annotation, index) => {
    const check = checks[index];
    let partIndex = check?.ownerPart ?? null;
    if (parts.length === 1) {
      // 唯一零件：归属无歧义（按唯一零件记录），"指错零件"的风险不存在
      partIndex = 0;
      notices.push("模型只有 1 个 solid：件号归属无歧义（按唯一零件记录），多零件归属核对不适用");
    }
    if (partIndex === null) {
      unboundRefs.push(annotation.ref);
    } else {
      covered.add(partIndex);
    }
    annotations.push(annotation);
    bindings.push({
      ref: annotation.ref,
      partIndex,
      anchorMm: [annotation.atMm[0], annotation.atMm[1], annotation.atMm[2]],
      source: "explicit",
      outsetApplied: false,
    });
  });

  if (autoAnchors && parts.length > 0) {
    const used = new Set(explicit.map(annotation => annotation.ref));
    for (const part of parts) {
      if (covered.has(part.index)) continue;
      const fact = part.views[view];
      if (fact === undefined) {
        notices.push(`零件 ${part.index} 在视图 ${view} 下没有投影事实：未自动补件号`);
        continue;
      }
      const ref = smallestUnusedRef(used);
      used.add(ref);
      const offset = anchorOutsetMm(fact.suggestedAnchorProjected, fact.projectedBBox);
      annotations.push({
        ref,
        atMm: fact.suggestedAnchor,
        anchorOffsetMm: offset,
      });
      bindings.push({
        ref,
        partIndex: part.index,
        anchorMm: [fact.suggestedAnchor[0], fact.suggestedAnchor[1], fact.suggestedAnchor[2]],
        source: "auto",
        outsetApplied: offset[0] !== 0 || offset[1] !== 0,
      });
    }
  }

  return { annotations, bindings, unboundRefs, notices };
}

/** 最小的未被占用的正整数件号（确定性；件号空间 1–999）。 */
export function smallestUnusedRef(used: ReadonlySet<number>): number {
  for (let candidate = 1; candidate <= 999; candidate += 1) {
    if (!used.has(candidate)) return candidate;
  }
  throw new TypeError("附图标记件号已用尽（1–999）");
}

/**
 * 锚点是否落在该零件的表面/包围盒上（容差口径）。
 *
 * 口径与 FreeCAD 侧一致：先看**表面**（距离 ≤ 容差），再看**包围盒**（落在盒内或距盒
 * ≤ 容差）——落在零件内部的点（如孔心）到表面的距离大于容差，但它落在包围盒内 ⇒ 合法。
 */
export function anchorOnPart(
  check: CadAnchorCheck | undefined,
  toleranceMm: number = CAD_ANCHOR_TOLERANCE_MM,
): boolean {
  if (check === undefined) return false;
  if (check.onPart) return true;
  const surface = check.surfaceDistanceMm;
  const box = check.bboxDistanceMm;
  if (surface !== undefined && surface <= toleranceMm) return true;
  if (box !== undefined && box <= toleranceMm) return true;
  return false;
}
