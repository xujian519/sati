/**
 * src/patent/figuregen — 图外引线标号择位（纯函数、确定性）。
 *
 * 附图标记有两种画法：写在部件轮廓内（流程/框图的节点文本）与**向图外引**（机械制图常规：
 * 零件上只画引线，标号离开图形）。本模块只解决后者需要的**落位决策**：给定必须标出的锚点，
 * 挑一组标号落位与引线，使
 *
 * - 标号不压盖图内内容、不压盖别的标号；
 * - 引线不与主线条**共线重叠**、不穿过别的标号、不与别的引线相交；
 * - 标号完整落在画幅内。
 *
 * 依据：指南一部一章 4.3「附图中的线条应当均匀清晰」与「剖面线、标记线与主线条不得互相
 * 妨碍」。判据只否「共线重叠」，不否「正交穿越」：锚点在零件内部时，引线出图必然穿过轮廓。
 *
 * **候选网格（命名常量，改权重或网格必须同时改这里）**：
 * - 方向：{@link LEADER_DIRECTION_COUNT} 个绝对角，从 {@link LEADER_DIRECTION_PHASE_DEG}
 *   起、步长 {@link LEADER_DIRECTION_STEP_DEG}。相位把方向从 0°/90°/180°/270° 错开，
 *   斜段不会与轴对齐的轮廓糊成一条直线。
 * - 环距：{@link LEADER_RING_COUNT} 档，在 `minLeaderMm`…`maxLeaderMm` 上均匀取样
 *   （约 12×4 = 48 个候选）。`stepMm` 只为旧调用方保留，**引擎不再读取**。
 * - 折线：锚点 →（可选肘点）→ 水平短划 → 标号。斜段离水平小于
 *   {@link LEADER_ELBOW_OMIT_DEG} 时省略肘点，避免画出零长折角。水平短划是进入标号的
 *   常规末段，不是被相位禁掉的「整条引线都是水平/垂直」。
 * - 评分（越小越好）：引线长度 × {@link LEADER_SCORE_LENGTH_PER_MM}
 *   + 偏离首选方向的角度 × {@link LEADER_SCORE_DIR_DEVIATION_PER_DEG}
 *   + 擦边 × {@link LEADER_SCORE_SCRAPE_PER_MM}
 *   + 拥挤 × {@link LEADER_SCORE_CROWDING_PER_MM}。
 *   同分按「短环优先、更接近首选方向的固定序」打破，无随机。
 *
 * **硬拒绝与回溯**：先丢掉越界、压盖障碍、与主线条共线的候选（静态），再丢掉与已放
 * 标号/引线冲突的候选（动态），取分数最低者。放不下时按 {@link LEADER_BACKTRACK_ROUNDS}
 * 回改先前自由标号的次优候选（搜索节点另有 {@link LEADER_BACKTRACK_NODE_CAP}）。
 * 钉死偏移不参与择位、也不被回溯改写，只审计。
 *
 * **失败语义**：`mode: "degrade"`（缺省，示意图 / FigureSpec）退化为就地标号并告警；
 * `mode: "strict"`（CAD 调用方传入）抛 {@link LeaderPlacementError}，列出放不下的 id。
 * 画不出必须比画出分不清的标记线更响亮。
 *
 * 模块吃抽象几何（点/矩形/线段），与渲染器解耦。不扩画布：图幅必须落在受理局可印区内。
 */

import { GLYPH_ASCENT_RATIO, GLYPH_DESCENT_RATIO, boxEntryAlongRay, glyphBox, textWidthMm } from "./glyph-box.js";
import { boxesOverlap, boxWithin, GEOMETRY_EPS, type Box } from "./render-utils.js";

/** 标号文本框（与 CAD 的 `CadBox` 同构：同为轴对齐矩形，故几何谓词共用一份实现）。 */
export type LeaderBox = Box;
export type LeaderPoint = { x: number; y: number };
export type LeaderSegment = { from: LeaderPoint; to: LeaderPoint };

/** 放不下时的契约。CAD 传 `strict`；示意图缺省 `degrade`。 */
export type LeaderPlacementMode = "degrade" | "strict";

/** 标注目标：一个必须被标出的锚点（纸面坐标）。 */
export type LeaderTarget = {
  /**
   * 稳定 id（落位报告与告警用；**须唯一**）。
   *
   * 重复 id 由 {@link planLeaderLines} 拒绝：落位与调用方**按下标对齐**，两个同 id 的目标会
   * 取到同一个落位——图面上两个标号精确重叠、先出现的锚点引线消失，而落位报告零告警。
   */
  id: string;
  /** 标号文本（数字，或 `10a` 这类带后缀的标记）。 */
  text: string;
  /** 引线起点（纸面坐标）：图上那个被标记的位置。 */
  anchor: LeaderPoint;
  /**
   * 调用方钉死的标号偏移（纸面毫米，相对锚点）。给了就**照用**：不做择位、不做规避、
   * 回溯也不改写。由此产生的压盖/共线/越界记进 {@link LeaderPlacement.conflicts}。
   */
  pinnedOffsetMm?: readonly [number, number];
};

/** 图面已有的占用（障碍）。 */
export type LeaderObstacles = {
  /** 不得被标号压盖的矩形（图内实心区、轮廓的外接框）。 */
  boxes?: readonly LeaderBox[];
  /** 引线不得与之共线重叠的线段（主线条、剖面线）。 */
  segments?: readonly LeaderSegment[];
};

export type LeaderLineOptions = {
  /** 标号字号（毫米）：决定标号框尺寸。 */
  fontSizeMm: number;
  /** 引线止于标号外缘的间隙（毫米）：引线不压标号文字。 */
  gapMm: number;
  /** 最短环距（毫米）：斜段长度的下界。 */
  minLeaderMm: number;
  /** 最长环距（毫米）。 */
  maxLeaderMm: number;
  /**
   * 旧的长度步进（毫米）。环距网格已改为 {@link LEADER_RING_COUNT}，本字段不再参与枚举，
   * 保留是为了不打断既有调用方的对象字面量。
   */
  stepMm?: number;
  /** 标号必须完整落在此框内（纸面毫米；通常为图幅）。缺省不限制。 */
  canvas?: LeaderBox;
  /** 择位基向的参照点（通常是图形中心）：标号优先摆在「远离它」的方向。 */
  figureCenter?: LeaderPoint;
  /** 标号框与障碍矩形的最小净距（毫米）；缺省 {@link DEFAULT_CLEARANCE_MM}。 */
  clearanceMm?: number;
  /** 引线与主线条夹角小于此值（度）且相距很近 ⇒ 判共线不可分；缺省 15°。 */
  collinearAngleDeg?: number;
  /** 共线判定的最大间距（毫米）；缺省 {@link DEFAULT_COLLINEAR_GAP_MM}。 */
  collinearGapMm?: number;
  /**
   * 候选耗尽时的语义。缺省 `degrade`（示意图不因一个标号放不下而整图失败）。
   * CAD 必须显式传 `strict`。
   */
  mode?: LeaderPlacementMode;
};

export type LeaderPlacement = {
  id: string;
  text: string;
  /** 引线起点（= target.anchor）。 */
  anchor: LeaderPoint;
  /** 标号文本锚点（`text-anchor="middle"` 的 x 与基线 y）。 */
  labelPoint: LeaderPoint;
  /** 标号相对锚点的偏移（毫米）：钉死时等于调用方给的偏移。 */
  offsetMm: readonly [number, number];
  /** 标号文本框（纸面毫米）。 */
  box: LeaderBox;
  /** 引线折线（锚点 → 可选肘点 → 水平短划末端）；退化时为空。 */
  leader: readonly LeaderSegment[];
  /** 是否由调用方钉死。 */
  pinned: boolean;
  /** 是否退化（无可用落位：就地标号、无引线）。strict 成功路径恒为 false。 */
  degraded: boolean;
  /**
   * 钉死落位的后果（引线面 + 标号压盖图内内容）。引擎择位的落位恒为空数组。
   */
  conflicts: readonly string[];
};

export type LeaderPlan = {
  placements: LeaderPlacement[];
  /** 退化告警（顺序 = 目标顺序；无退化则为空）。strict 失败不返回计划，改为抛错。 */
  warnings: string[];
};

/**
 * strict 模式下候选耗尽。`unplaceableIds` 是在钉死标号与「回溯预算内能放下的自由标号」
 * 都就位之后仍然放不下的 id（目标顺序）。
 */
export class LeaderPlacementError extends Error {
  readonly unplaceableIds: readonly string[];
  readonly strictFailure = true as const;

  constructor(unplaceableIds: readonly string[]) {
    const list = unplaceableIds.length > 0 ? unplaceableIds.join("、") : "（未知）";
    super(
      `标记 ${list} 在 strict 模式下无可用引线落位` +
        `（${LEADER_DIRECTIONS_DEG.length} 个方向 × 至多 ${LEADER_RING_COUNT} 档环距的候选均被硬约束拒绝）。` +
        LEADER_PLACEMENT_GUIDANCE,
    );
    this.name = "LeaderPlacementError";
    this.unplaceableIds = [...unplaceableIds];
  }
}

/** 类型守卫：工具层与检查层用来把择位失败收成可读报告，而不是当成未知异常。 */
export function isLeaderPlacementError(error: unknown): error is LeaderPlacementError {
  return error instanceof LeaderPlacementError;
}

/**
 * strict 失败时给调用方的处置说明（减少标记 / 拆图 / 钉死偏移）。
 * 错误消息、C13 与渲染复核的出口共用这一句，避免三处各写一套。
 */
export const LEADER_PLACEMENT_GUIDANCE = "请减少同时标注的标记、把本图拆成多幅，或用 label_offset_mm 钉死偏移";

/** 共线/交叉判定的容差（择位与审计共用，保证两处口径一致）。 */
type LeaderTolerance = { collinearAngleDeg: number; collinearGapMm: number; gapMm: number };

/** 标号框与障碍的最小净距（毫米）。 */
export const DEFAULT_CLEARANCE_MM = 0.5;
/** 共线判定的夹角阈值（度）：小于它且相距很近的引线与线条打印后分不清。 */
export const DEFAULT_COLLINEAR_ANGLE_DEG = 15;
/** 共线判定的最大间距（毫米）：约等于附图线宽（0.35mm）的两倍。 */
export const DEFAULT_COLLINEAR_GAP_MM = 0.7;
/**
 * 旧的长度步进。环距已改由 {@link LEADER_RING_COUNT} 取样；常量保留，供仍引用它的调用方编译。
 */
export const DEFAULT_LEADER_STEP_MM = 1.5;

/** 方向相位（度）：12 个绝对角从这里起算，从而避开 0/90/180/270。 */
export const LEADER_DIRECTION_PHASE_DEG = 15;
/** 方向步长（度）。12 × 30° 覆盖全圆。 */
export const LEADER_DIRECTION_STEP_DEG = 30;
/** 方向个数。 */
export const LEADER_DIRECTION_COUNT = 12;
/**
 * 绝对方向（度，SVG 坐标：0° 为 +x，正角转向 +y 即页面下方）。
 * 顺序固定：15, 45, …, 345。择位时再按「离首选方向的角距、然后下标」重排。
 */
export const LEADER_DIRECTIONS_DEG: readonly number[] = Array.from(
  { length: LEADER_DIRECTION_COUNT },
  (_, index) => LEADER_DIRECTION_PHASE_DEG + index * LEADER_DIRECTION_STEP_DEG,
);
/** 环距档数（含最短与最长）。`min == max` 时实际只生成 1 档。 */
export const LEADER_RING_COUNT = 4;
/** 水平短划的可见长度（毫米）：肘点到标号外缘再退间隙之前的那一段。 */
export const LEADER_STUB_MM = 4;
/**
 * 斜段与水平的夹角小于此值（度）时省略肘点。12 向的最小偏离是相位 15°，大于本值，
 * 故自由候选总是「斜段 + 水平短划」；本阈值只留给接近水平的钉死方向以外的将来扩展。
 */
export const LEADER_ELBOW_OMIT_DEG = 5;
/** 有界回溯：一条搜索路径上，除各标号的最优候选外，最多再偏离这么多次。 */
export const LEADER_BACKTRACK_ROUNDS = 3;
/** 回溯搜索的节点上限。触顶即视为耗尽（strict 抛错 / degrade 退化），避免组合爆炸。 */
export const LEADER_BACKTRACK_NODE_CAP = 64;

/** 引线长度权重（每毫米）。越短越好。 */
export const LEADER_SCORE_LENGTH_PER_MM = 1;
/** 偏离首选方向的权重（每度）。首选方向是「远离图心」。 */
export const LEADER_SCORE_DIR_DEVIATION_PER_DEG = 0.05;
/** 擦边权重（每毫米）：引线贴着已有线条走、但还没到共线硬拒绝的程度。 */
export const LEADER_SCORE_SCRAPE_PER_MM = 2;
/** 擦边起算距离（毫米）：远于此距离不记擦边分。 */
export const LEADER_SCRAPE_BAND_MM = 1.5;
/** 拥挤权重（每毫米）：标号框贴近障碍或其它标号、但还没压盖。 */
export const LEADER_SCORE_CROWDING_PER_MM = 1.5;
/** 拥挤起算净距（毫米）：远于此距离不记拥挤分。 */
export const LEADER_CROWDING_BAND_MM = 2;

/** 本模块的几何容差（与共享谓词同一取值：见 render-utils.ts 的 GEOMETRY_EPS）。 */
const EPS = GEOMETRY_EPS;

type SearchContext = LeaderTolerance & {
  obstacles: Required<LeaderObstacles>;
  placed: LeaderPlacement[];
  clearanceMm: number;
  canvas: LeaderBox | undefined;
};

type LeaderGeometry = {
  labelPoint: LeaderPoint;
  box: LeaderBox;
  leader: LeaderSegment[];
};

type StaticCandidate = LeaderGeometry & {
  /** 长度 + 方向偏离 + 对障碍的擦边/拥挤。动态项在落位时另加。 */
  staticScore: number;
  /** 同分时的稳定序号：短环、更接近首选方向者更小。 */
  order: number;
  directionDeg: number;
  ringMm: number;
};

/**
 * 标号文本框（纸面毫米）：与复核侧共用 `glyphBox` 的字符宽度与升降比例。
 *
 * 择位与复核必须用同一模型，否则一侧躲开了、另一侧仍报「文字被线条贯穿」。
 */
export function labelBoxOf(text: string, fontSizeMm: number, labelPoint: LeaderPoint): LeaderBox {
  const box = glyphBox(text, [labelPoint.x, labelPoint.y], fontSizeMm, "middle");
  return { left: box.minX, top: box.minY, right: box.maxX, bottom: box.maxY };
}

/**
 * 自由候选的折线几何：斜段终点（肘点）对齐标号框的垂直中线，水平短划停在框外 `gapMm`。
 *
 * 返回的 `box` 与 {@link labelBoxOf} / `glyphBox` 同一矩形。几何退化（零长度）时返回 undefined。
 */
export function buildLeaderGeometry(args: {
  anchor: LeaderPoint;
  directionDeg: number;
  ringMm: number;
  text: string;
  fontSizeMm: number;
  gapMm: number;
}): LeaderGeometry | undefined {
  if (!(args.ringMm > EPS) || !(args.fontSizeMm > EPS)) return undefined;
  const radians = (normalizeDeg(args.directionDeg) * Math.PI) / 180;
  const direction: [number, number] = [Math.cos(radians), Math.sin(radians)];
  const halfWidth = textWidthMm(args.text, args.fontSizeMm) / 2;
  const baselineShift = (args.fontSizeMm * (GLYPH_ASCENT_RATIO - GLYPH_DESCENT_RATIO)) / 2;
  const sign = direction[0] >= 0 ? 1 : -1;
  const omitElbow = Math.abs(direction[1]) <= Math.sin((LEADER_ELBOW_OMIT_DEG * Math.PI) / 180);

  const elbow: LeaderPoint = omitElbow
    ? args.anchor
    : { x: args.anchor.x + direction[0] * args.ringMm, y: args.anchor.y + direction[1] * args.ringMm };
  const along = omitElbow ? args.ringMm : LEADER_STUB_MM;
  const labelPoint: LeaderPoint = {
    x: elbow.x + sign * (along + args.gapMm + halfWidth),
    y: elbow.y + baselineShift,
  };
  const box = labelBoxOf(args.text, args.fontSizeMm, labelPoint);
  const stubEnd: LeaderPoint = {
    x: sign > 0 ? box.left - args.gapMm : box.right + args.gapMm,
    y: elbow.y,
  };
  if (Math.hypot(stubEnd.x - elbow.x, stubEnd.y - elbow.y) <= EPS) return undefined;

  const leader: LeaderSegment[] = [];
  if (!omitElbow && Math.hypot(elbow.x - args.anchor.x, elbow.y - args.anchor.y) > EPS) {
    leader.push({ from: args.anchor, to: elbow });
  }
  leader.push({ from: omitElbow ? args.anchor : elbow, to: stubEnd });
  return { labelPoint, box, leader };
}

/**
 * 最短环上，标号框相对锚点的最大外伸（毫米）。CAD 预留带用它，避免按「只有斜段、没有短划」
 * 留边，把 strict 模式的合法落位裁出画幅。
 */
export function leaderOutwardReachMm(text: string, fontSizeMm: number, minLeaderMm: number, gapMm: number): number {
  const anchor: LeaderPoint = { x: 0, y: 0 };
  let reach = 0;
  for (const directionDeg of LEADER_DIRECTIONS_DEG) {
    const geometry = buildLeaderGeometry({
      anchor,
      directionDeg,
      ringMm: minLeaderMm,
      text,
      fontSizeMm,
      gapMm,
    });
    if (geometry === undefined) continue;
    reach = Math.max(
      reach,
      Math.abs(geometry.box.left - anchor.x),
      Math.abs(geometry.box.right - anchor.x),
      Math.abs(geometry.box.top - anchor.y),
      Math.abs(geometry.box.bottom - anchor.y),
    );
  }
  return reach;
}

function expandBox(box: LeaderBox, by: number): LeaderBox {
  return { left: box.left - by, top: box.top - by, right: box.right + by, bottom: box.bottom + by };
}

function pointInBox(point: LeaderPoint, box: LeaderBox): boolean {
  return (
    point.x >= box.left - EPS && point.x <= box.right + EPS && point.y >= box.top - EPS && point.y <= box.bottom + EPS
  );
}

function orientation(a: LeaderPoint, b: LeaderPoint, c: LeaderPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: LeaderPoint, b: LeaderPoint, p: LeaderPoint): boolean {
  return (
    Math.min(a.x, b.x) - EPS <= p.x &&
    p.x <= Math.max(a.x, b.x) + EPS &&
    Math.min(a.y, b.y) - EPS <= p.y &&
    p.y <= Math.max(a.y, b.y) + EPS
  );
}

/** 两线段是否相交（含端点接触与共线重叠）。 */
export function segmentsIntersect(a: LeaderSegment, b: LeaderSegment): boolean {
  const d1 = orientation(b.from, b.to, a.from);
  const d2 = orientation(b.from, b.to, a.to);
  const d3 = orientation(a.from, a.to, b.from);
  const d4 = orientation(a.from, a.to, b.to);
  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) {
    return true;
  }
  if (Math.abs(d1) <= EPS && onSegment(b.from, b.to, a.from)) return true;
  if (Math.abs(d2) <= EPS && onSegment(b.from, b.to, a.to)) return true;
  if (Math.abs(d3) <= EPS && onSegment(a.from, a.to, b.from)) return true;
  if (Math.abs(d4) <= EPS && onSegment(a.from, a.to, b.to)) return true;
  return false;
}

function segmentIntersectsBox(segment: LeaderSegment, box: LeaderBox): boolean {
  if (pointInBox(segment.from, box) || pointInBox(segment.to, box)) return true;
  const corners: LeaderPoint[] = [
    { x: box.left, y: box.top },
    { x: box.right, y: box.top },
    { x: box.right, y: box.bottom },
    { x: box.left, y: box.bottom },
  ];
  for (let index = 0; index < corners.length; index += 1) {
    const edge: LeaderSegment = { from: corners[index]!, to: corners[(index + 1) % corners.length]! };
    if (segmentsIntersect(segment, edge)) return true;
  }
  return false;
}

function pointLineDistance(point: LeaderPoint, line: LeaderSegment): number | undefined {
  const dx = line.to.x - line.from.x;
  const dy = line.to.y - line.from.y;
  const length = Math.hypot(dx, dy);
  if (length < EPS) return undefined;
  return Math.abs((point.x - line.from.x) * dy - (point.y - line.from.y) * dx) / length;
}

function pointSegmentDistance(point: LeaderPoint, line: LeaderSegment): number {
  const dx = line.to.x - line.from.x;
  const dy = line.to.y - line.from.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < EPS * EPS) return Math.hypot(point.x - line.from.x, point.y - line.from.y);
  const raw = ((point.x - line.from.x) * dx + (point.y - line.from.y) * dy) / lengthSq;
  const t = Math.min(1, Math.max(0, raw));
  return Math.hypot(point.x - (line.from.x + dx * t), point.y - (line.from.y + dy * t));
}

/** 不相交线段的最短距离；相交为 0。最短距离落在端点上，故四点垂距足够。 */
function segmentDistance(a: LeaderSegment, b: LeaderSegment): number {
  if (segmentsIntersect(a, b)) return 0;
  return Math.min(
    pointSegmentDistance(a.from, b),
    pointSegmentDistance(a.to, b),
    pointSegmentDistance(b.from, a),
    pointSegmentDistance(b.to, a),
  );
}

/** 两框的净距（重叠为 0；角对角时取欧氏距离）。 */
function boxSeparation(a: LeaderBox, b: LeaderBox): number {
  const gapX = Math.max(a.left - b.right, b.left - a.right);
  const gapY = Math.max(a.top - b.bottom, b.top - a.bottom);
  if (gapX <= 0 && gapY <= 0) return 0;
  if (gapX > 0 && gapY > 0) return Math.hypot(gapX, gapY);
  return Math.max(gapX, gapY);
}

/** 两线段的夹角（度，归一到 0–90；零长线段返回 0）。 */
export function segmentAngleDeg(a: LeaderSegment, b: LeaderSegment): number {
  const ax = a.to.x - a.from.x;
  const ay = a.to.y - a.from.y;
  const bx = b.to.x - b.from.x;
  const by = b.to.y - b.from.y;
  const lengthA = Math.hypot(ax, ay);
  const lengthB = Math.hypot(bx, by);
  if (lengthA < EPS || lengthB < EPS) return 0;
  const cos = Math.abs((ax * bx + ay * by) / (lengthA * lengthB));
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

/**
 * 引线是否「顺着某条已有线条走」（夹角小 **且** 引线远端仍贴在该线条所在直线上）。
 *
 * 只用引线远端：引线常从线条上出发，整段最小距离必然为 0，会把「小角度离开」误杀。
 */
function leaderGluesToLine(leader: LeaderSegment, line: LeaderSegment, tolerance: LeaderTolerance): boolean {
  if (segmentAngleDeg(leader, line) >= tolerance.collinearAngleDeg) return false;
  const far = pointLineDistance(leader.to, line);
  return far !== undefined && far < tolerance.collinearGapMm;
}

/** 同一锚点扇形展开时，起点共点是构造使然。只切从锚点出发的那一段。 */
function trimAtAnchor(leader: LeaderSegment, gapMm: number): LeaderSegment {
  const dx = leader.to.x - leader.from.x;
  const dy = leader.to.y - leader.from.y;
  const length = Math.hypot(dx, dy);
  if (length <= gapMm + EPS) return leader;
  return {
    from: { x: leader.from.x + (dx / length) * gapMm, y: leader.from.y + (dy / length) * gapMm },
    to: leader.to,
  };
}

function startsAt(segment: LeaderSegment, point: LeaderPoint): boolean {
  return Math.hypot(segment.from.x - point.x, segment.from.y - point.y) <= EPS;
}

function preparedSegment(segment: LeaderSegment, anchor: LeaderPoint, gapMm: number): LeaderSegment {
  return startsAt(segment, anchor) ? trimAtAnchor(segment, gapMm) : segment;
}

function segmentsConflict(a: LeaderSegment, b: LeaderSegment, tolerance: LeaderTolerance): boolean {
  if (segmentsIntersect(a, b)) return true;
  return leaderGluesToLine(a, b, tolerance) || leaderGluesToLine(b, a, tolerance);
}

function polylinesConflict(
  a: readonly LeaderSegment[],
  anchorA: LeaderPoint,
  b: readonly LeaderSegment[],
  anchorB: LeaderPoint,
  tolerance: LeaderTolerance,
): boolean {
  for (const segmentA of a) {
    const trimmedA = preparedSegment(segmentA, anchorA, tolerance.gapMm);
    for (const segmentB of b) {
      const trimmedB = preparedSegment(segmentB, anchorB, tolerance.gapMm);
      if (segmentsConflict(trimmedA, trimmedB, tolerance)) return true;
    }
  }
  return false;
}

function normalizeDeg(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function angularDistance(a: number, b: number): number {
  const raw = Math.abs(normalizeDeg(a) - normalizeDeg(b));
  return Math.min(raw, 360 - raw);
}

function preferredAngleDeg(anchor: LeaderPoint, center: LeaderPoint | undefined): number {
  if (center === undefined) return 270;
  const dx = anchor.x - center.x;
  const dy = anchor.y - center.y;
  if (Math.hypot(dx, dy) < EPS) return 270;
  return normalizeDeg((Math.atan2(dy, dx) * 180) / Math.PI);
}

function rankedDirections(preferredDeg: number): number[] {
  return LEADER_DIRECTIONS_DEG.map((deg, index) => ({ deg, index, delta: angularDistance(deg, preferredDeg) }))
    .sort((a, b) => a.delta - b.delta || a.index - b.index)
    .map(item => item.deg);
}

function ringLengths(minMm: number, maxMm: number): number[] {
  const max = Math.max(minMm, maxMm);
  if (LEADER_RING_COUNT <= 1 || max - minMm < EPS) return [minMm];
  const rings: number[] = [];
  for (let index = 0; index < LEADER_RING_COUNT; index += 1) {
    rings.push(minMm + ((max - minMm) * index) / (LEADER_RING_COUNT - 1));
  }
  return rings;
}

function polylineLength(leader: readonly LeaderSegment[]): number {
  let length = 0;
  for (const segment of leader) {
    length += Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y);
  }
  return length;
}

function scrapePenalty(
  leader: readonly LeaderSegment[],
  anchor: LeaderPoint,
  lines: readonly LeaderSegment[],
  tolerance: LeaderTolerance,
): number {
  let penalty = 0;
  for (const segment of leader) {
    const trimmed = preparedSegment(segment, anchor, tolerance.gapMm);
    for (const line of lines) {
      if (leaderGluesToLine(trimmed, line, tolerance)) continue;
      const distance = segmentDistance(trimmed, line);
      if (distance < LEADER_SCRAPE_BAND_MM) {
        penalty += (LEADER_SCRAPE_BAND_MM - distance) * LEADER_SCORE_SCRAPE_PER_MM;
      }
    }
  }
  return penalty;
}

function crowdingPenalty(box: LeaderBox, others: readonly LeaderBox[]): number {
  let penalty = 0;
  for (const other of others) {
    const gap = boxSeparation(box, other);
    if (gap < LEADER_CROWDING_BAND_MM) {
      penalty += (LEADER_CROWDING_BAND_MM - gap) * LEADER_SCORE_CROWDING_PER_MM;
    }
  }
  return penalty;
}

function staticRejected(geometry: LeaderGeometry, anchor: LeaderPoint, context: SearchContext): boolean {
  if (context.canvas !== undefined && !boxWithin(geometry.box, context.canvas)) return true;
  for (const obstacle of context.obstacles.boxes) {
    if (boxesOverlap(geometry.box, expandBox(obstacle, context.clearanceMm))) return true;
  }
  for (const segment of geometry.leader) {
    const trimmed = preparedSegment(segment, anchor, context.gapMm);
    for (const line of context.obstacles.segments) {
      if (leaderGluesToLine(trimmed, line, context)) return true;
    }
    if (segmentIntersectsBox(segment, geometry.box)) return true;
  }
  return false;
}

function dynamicRejected(geometry: LeaderGeometry, anchor: LeaderPoint, context: SearchContext): boolean {
  for (const placed of context.placed) {
    if (boxesOverlap(geometry.box, expandBox(placed.box, context.clearanceMm))) return true;
  }
  for (const segment of geometry.leader) {
    for (const placed of context.placed) {
      if (segmentIntersectsBox(segment, placed.box)) return true;
    }
  }
  for (const placed of context.placed) {
    if (polylinesConflict(geometry.leader, anchor, placed.leader, placed.anchor, context)) return true;
  }
  return false;
}

function staticCandidates(target: LeaderTarget, options: LeaderLineOptions, context: SearchContext): StaticCandidate[] {
  const preferred = preferredAngleDeg(target.anchor, options.figureCenter);
  const directions = rankedDirections(preferred);
  const rings = ringLengths(options.minLeaderMm, options.maxLeaderMm);
  const candidates: StaticCandidate[] = [];
  for (const [ringIndex, ringMm] of rings.entries()) {
    for (const [directionRank, directionDeg] of directions.entries()) {
      const geometry = buildLeaderGeometry({
        anchor: target.anchor,
        directionDeg,
        ringMm,
        text: target.text,
        fontSizeMm: options.fontSizeMm,
        gapMm: options.gapMm,
      });
      if (geometry === undefined || staticRejected(geometry, target.anchor, context)) continue;
      const deviation = angularDistance(directionDeg, preferred);
      const staticScore =
        polylineLength(geometry.leader) * LEADER_SCORE_LENGTH_PER_MM +
        deviation * LEADER_SCORE_DIR_DEVIATION_PER_DEG +
        scrapePenalty(geometry.leader, target.anchor, context.obstacles.segments, context) +
        crowdingPenalty(geometry.box, context.obstacles.boxes);
      candidates.push({
        ...geometry,
        staticScore,
        order: ringIndex * LEADER_DIRECTION_COUNT + directionRank,
        directionDeg,
        ringMm,
      });
    }
  }
  candidates.sort((a, b) => a.staticScore - b.staticScore || a.order - b.order);
  return candidates;
}

function dynamicPenalty(candidate: StaticCandidate, anchor: LeaderPoint, context: SearchContext): number {
  const placedBoxes = context.placed.map(placement => placement.box);
  const placedLines = context.placed.flatMap(placement => [...placement.leader]);
  return crowdingPenalty(candidate.box, placedBoxes) + scrapePenalty(candidate.leader, anchor, placedLines, context);
}

function rankDynamic(
  candidates: readonly StaticCandidate[],
  anchor: LeaderPoint,
  context: SearchContext,
): StaticCandidate[] {
  const ranked: { candidate: StaticCandidate; score: number }[] = [];
  for (const candidate of candidates) {
    if (dynamicRejected(candidate, anchor, context)) continue;
    ranked.push({ candidate, score: candidate.staticScore + dynamicPenalty(candidate, anchor, context) });
  }
  ranked.sort((a, b) => a.score - b.score || a.candidate.order - b.candidate.order);
  return ranked.map(item => item.candidate);
}

/** 归一化方向；零向量返回 undefined。 */
function normalizeDirection(vector: readonly [number, number]): [number, number] | undefined {
  const length = Math.hypot(vector[0], vector[1]);
  if (length < EPS) return undefined;
  return [vector[0] / length, vector[1] / length];
}

/**
 * 钉死落位的引线：沿调用方给的方向，止于字框外缘再退间隙。不改成肘点折线——钉死是显式坐标。
 */
function leaderOf(
  anchor: LeaderPoint,
  direction: readonly [number, number],
  length: number,
  text: string,
  fontSizeMm: number,
  gapMm: number,
): LeaderSegment[] {
  const labelPoint: LeaderPoint = {
    x: anchor.x + direction[0] * length,
    y: anchor.y + direction[1] * length,
  };
  const entry = boxEntryAlongRay(
    glyphBox(text, [labelPoint.x, labelPoint.y], fontSizeMm, "middle"),
    [anchor.x, anchor.y],
    direction,
  );
  if (entry === undefined) return [];
  const endDistance = entry - gapMm;
  if (endDistance <= EPS) return [];
  return [
    {
      from: anchor,
      to: { x: anchor.x + direction[0] * endDistance, y: anchor.y + direction[1] * endDistance },
    },
  ];
}

function placementFromGeometry(
  target: LeaderTarget,
  geometry: LeaderGeometry,
  options: LeaderLineOptions,
  pinned: boolean,
): LeaderPlacement {
  return {
    id: target.id,
    text: target.text,
    anchor: target.anchor,
    labelPoint: geometry.labelPoint,
    offsetMm: [geometry.labelPoint.x - target.anchor.x, geometry.labelPoint.y - target.anchor.y],
    box: geometry.box,
    leader: geometry.leader,
    pinned,
    degraded: false,
    conflicts: [],
  };
}

function pinnedPlacement(target: LeaderTarget, options: LeaderLineOptions): LeaderPlacement {
  const offset = target.pinnedOffsetMm ?? [0, 0];
  const direction = normalizeDirection(offset);
  const length = Math.hypot(offset[0], offset[1]);
  const labelPoint: LeaderPoint = { x: target.anchor.x + offset[0], y: target.anchor.y + offset[1] };
  return placementFromGeometry(
    target,
    {
      labelPoint,
      box: labelBoxOf(target.text, options.fontSizeMm, labelPoint),
      leader:
        direction === undefined
          ? []
          : leaderOf(target.anchor, direction, length, target.text, options.fontSizeMm, options.gapMm),
    },
    options,
    true,
  );
}

function degradedPlacement(target: LeaderTarget, options: LeaderLineOptions): LeaderPlacement {
  const placement = placementFromGeometry(
    target,
    { labelPoint: target.anchor, box: labelBoxOf(target.text, options.fontSizeMm, target.anchor), leader: [] },
    options,
    false,
  );
  return { ...placement, degraded: true, offsetMm: [0, 0] };
}

function degradeWarning(text: string, rings: number): string {
  return (
    `标记 ${text} 无可用引线落位（${LEADER_DIRECTIONS_DEG.length} 个方向 × ${rings} 档环距均被占：` +
    "标号会压盖图内内容/其它标号，或引线与主线条共线、与其它引线相交）" +
    `⇒ 退化为就地标号（无引线）。${LEADER_PLACEMENT_GUIDANCE}`
  );
}

/**
 * 钉死落位的后果审计（不做规避）。与择位共用几何谓词和容差，口径不漂移。
 */
function auditPinnedPlacement(
  placement: LeaderPlacement,
  selfIndex: number,
  others: readonly LeaderPlacement[],
  obstacles: Required<LeaderObstacles>,
  context: SearchContext,
): string[] {
  const conflicts: string[] = [];
  const record = (message: string): void => {
    if (!conflicts.includes(message)) conflicts.push(message);
  };
  for (const obstacle of obstacles.boxes) {
    if (boxesOverlap(placement.box, expandBox(obstacle, context.clearanceMm))) {
      record("标号压在图形或图号注记上（与图内内容的占位框重叠），标号读不出来");
      break;
    }
  }
  for (const leader of placement.leader) {
    const trimmed = preparedSegment(leader, placement.anchor, context.gapMm);
    for (const line of obstacles.segments) {
      if (leaderGluesToLine(trimmed, line, context)) {
        record("引线与主线条共线重叠（夹角过小且贴得很近），打印后分不清哪条是标记线");
        break;
      }
    }
  }
  for (const [otherIndex, other] of others.entries()) {
    if (otherIndex === selfIndex) continue;
    for (const leader of placement.leader) {
      if (segmentIntersectsBox(leader, other.box)) record(`引线穿过标记 ${other.text} 的标号`);
    }
    if (polylinesConflict(placement.leader, placement.anchor, other.leader, other.anchor, context)) {
      record(`引线与标记 ${other.text} 的引线交叉`);
    }
  }
  return conflicts;
}

function findDuplicateIds(targets: readonly LeaderTarget[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const target of targets) {
    if (seen.has(target.id)) {
      if (!duplicates.includes(target.id)) duplicates.push(target.id);
    } else {
      seen.add(target.id);
    }
  }
  return duplicates;
}

function commit(context: SearchContext, placement: LeaderPlacement): void {
  context.placed.push(placement);
}

function uncommit(context: SearchContext): void {
  context.placed.pop();
}

type FreeSlot = { target: LeaderTarget; candidates: StaticCandidate[] };

/**
 * 有界回溯。成功时 `context.placed` 含钉死标号与本次放下的自由标号；失败时恢复到进入时的长度。
 * 每个标号先试当前最优；改用次优候选消耗 1 轮预算，整条路径最多 {@link LEADER_BACKTRACK_ROUNDS} 轮。
 */
function search(
  slots: readonly FreeSlot[],
  context: SearchContext,
  options: LeaderLineOptions,
): LeaderPlacement[] | undefined {
  const baseCount = context.placed.length;
  const chosen: LeaderPlacement[] = [];
  let nodes = 0;

  const place = (index: number, roundsLeft: number): boolean => {
    if (index >= slots.length) return true;
    nodes += 1;
    if (nodes > LEADER_BACKTRACK_NODE_CAP) return false;
    const slot = slots[index]!;
    const feasible = rankDynamic(slot.candidates, slot.target.anchor, context);
    if (feasible.length === 0) return false;
    const tries = Math.min(feasible.length, 1 + Math.max(0, roundsLeft));
    for (let attempt = 0; attempt < tries; attempt += 1) {
      const placement = placementFromGeometry(slot.target, feasible[attempt]!, options, false);
      chosen.push(placement);
      commit(context, placement);
      if (place(index + 1, roundsLeft - (attempt > 0 ? 1 : 0))) return true;
      chosen.pop();
      uncommit(context);
    }
    return false;
  };

  if (!place(0, LEADER_BACKTRACK_ROUNDS)) {
    context.placed.length = baseCount;
    return undefined;
  }
  return chosen;
}

/** 全局搜索失败后，从末尾逐个丢掉，得到「预算内放不下」的 id（目标顺序）。 */
function diagnoseFailedIds(slots: readonly FreeSlot[], context: SearchContext, options: LeaderLineOptions): string[] {
  const saved = context.placed.slice();
  const pending = [...slots];
  const failed: string[] = [];
  try {
    while (pending.length > 0) {
      context.placed.length = 0;
      context.placed.push(...saved);
      if (search(pending, context, options) !== undefined) break;
      const dropped = pending.pop();
      if (dropped !== undefined) failed.push(dropped.target.id);
    }
  } finally {
    context.placed.length = 0;
    context.placed.push(...saved);
  }
  const order = new Map(slots.map((slot, index) => [slot.target.id, index]));
  failed.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return failed.length > 0 ? failed : slots.map(slot => slot.target.id);
}

function degradeSequentially(
  slots: readonly FreeSlot[],
  context: SearchContext,
  options: LeaderLineOptions,
  rings: number,
): { placements: LeaderPlacement[]; warnings: string[] } {
  const placements: LeaderPlacement[] = [];
  const warnings: string[] = [];
  for (const slot of slots) {
    const feasible = rankDynamic(slot.candidates, slot.target.anchor, context);
    if (feasible.length > 0) {
      const placement = placementFromGeometry(slot.target, feasible[0]!, options, false);
      placements.push(placement);
      commit(context, placement);
      continue;
    }
    const placement = degradedPlacement(slot.target, options);
    placements.push(placement);
    commit(context, placement);
    warnings.push(degradeWarning(slot.target.text, rings));
  }
  return { placements, warnings };
}

function finish(
  targets: readonly LeaderTarget[],
  placements: readonly LeaderPlacement[],
  warnings: readonly string[],
  context: SearchContext,
): LeaderPlan {
  const byId = new Map(placements.map(placement => [placement.id, placement]));
  const ordered = targets.map(target => {
    const placement = byId.get(target.id);
    if (placement === undefined) {
      throw new TypeError(`引线择位内部错误：标记 ${target.id} 没有落位`);
    }
    return placement;
  });
  return {
    placements: ordered.map((placement, index) =>
      placement.pinned
        ? { ...placement, conflicts: auditPinnedPlacement(placement, index, ordered, context.obstacles, context) }
        : placement,
    ),
    warnings: [...warnings],
  };
}

/**
 * 规划一组图外引线标号。
 *
 * 顺序纪律：钉死标号先全部落位并登记为障碍，再对自由标号做评分 + 有界回溯。
 * 输出仍按目标顺序。重复 id 直接拒绝。
 */
export function planLeaderLines(
  targets: readonly LeaderTarget[],
  obstacles: LeaderObstacles = {},
  options: LeaderLineOptions,
): LeaderPlan {
  const duplicateIds = findDuplicateIds(targets);
  if (duplicateIds.length > 0) {
    throw new TypeError(
      `标记 id 须唯一，重复：${duplicateIds.join("、")}（重复 id 会让两个标号落在同一点、` +
        "先出现的锚点引线消失，而落位报告给不出任何异样）",
    );
  }

  const mode: LeaderPlacementMode = options.mode ?? "degrade";
  const context: SearchContext = {
    obstacles: { boxes: obstacles.boxes ?? [], segments: obstacles.segments ?? [] },
    placed: [],
    clearanceMm: options.clearanceMm ?? DEFAULT_CLEARANCE_MM,
    collinearAngleDeg: options.collinearAngleDeg ?? DEFAULT_COLLINEAR_ANGLE_DEG,
    collinearGapMm: options.collinearGapMm ?? DEFAULT_COLLINEAR_GAP_MM,
    gapMm: options.gapMm,
    canvas: options.canvas,
  };
  const rings = ringLengths(options.minLeaderMm, options.maxLeaderMm);

  for (const target of targets) {
    if (target.pinnedOffsetMm === undefined) continue;
    commit(context, pinnedPlacement(target, options));
  }

  const slots: FreeSlot[] = [];
  for (const target of targets) {
    if (target.pinnedOffsetMm !== undefined) continue;
    slots.push({ target, candidates: staticCandidates(target, options, context) });
  }

  const solved = search(slots, context, options);
  if (solved !== undefined) {
    return finish(targets, [...context.placed], [], context);
  }

  const failedIds = diagnoseFailedIds(slots, context, options);
  switch (mode) {
    case "strict":
      throw new LeaderPlacementError(failedIds);
    case "degrade": {
      const degraded = degradeSequentially(slots, context, options, rings.length);
      return finish(targets, context.placed, degraded.warnings, context);
    }
    default: {
      const neverMode: never = mode;
      throw new TypeError(`未知引线择位模式: ${String(neverMode)}`);
    }
  }
}
