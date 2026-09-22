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
 * 妨碍」——标记线自身清楚可辨是条文要求，故引线"贴着某条主线条走"（共线）或"从别的标号上
 * 穿过"都不合规，必须换向或换长度。注意判据只否"共线重叠"，不否"正交穿越"：锚点在零件内部
 * 时，引线要出图就**必然**穿过零件轮廓，那是常规制图形态。
 *
 * **为什么不做成 SVG 后处理**（deepseek-harness 的 `leader-line.ts` 是后处理）：Sati 的两条
 * 渲染通路都自己知道几何（内置通路来自 `layoutFigure` 的节点盒，CAD 通路来自投影边表），
 * 锚点是结构化输入而不是从 SVG 文本里认出来的。后处理必须重建坐标系（组变换、viewBox 单位
 * 换算），解析不出来的形态只能退化——多一层解析就多一类"认不出⇒标不了"。故本模块吃**抽象
 * 几何**（点/矩形/线段），与渲染器解耦：谁有几何谁来调。
 *
 * **画幅策略的差异**（同为 4.3 服务的两种实现）：deepseek-harness 在放置后把画布往外扩边，
 * Sati 的 CAD 通路**不能**这样做——图幅必须落在受理局可印区内（超了会被裁），故改为渲染前
 * 预留标注带（构造期保证有位置），引擎在此带内择位；确实无位可放时**退化**为就地标号并告警，
 * 绝不画出一条与主线条分不清的引线（"画不出来"必须比"画出错的"更响亮）。
 *
 * 决策可复算：候选按「引线由短到长（步进固定）→ 方向绕"远离图心"的基向按固定角度序旋转」
 * 枚举，取第一个全部判据通过的落位——无随机、无评分阈值、无迭代收敛，同一输入永远同一结果。
 */

import { measureTextWidth } from "./metrics.js";

export type LeaderBox = { left: number; top: number; right: number; bottom: number };
export type LeaderPoint = { x: number; y: number };
export type LeaderSegment = { from: LeaderPoint; to: LeaderPoint };

/** 标注目标：一个必须被标出的锚点（纸面坐标）。 */
export type LeaderTarget = {
  /** 稳定 id（落位报告与告警用；**须唯一**，重复 id 只保留先出现者的落位）。 */
  id: string;
  /** 标号文本（数字，或 `10a` 这类带后缀的标记）。 */
  text: string;
  /** 引线起点（纸面坐标）：图上那个被标记的位置。 */
  anchor: LeaderPoint;
  /**
   * 调用方钉死的标号偏移（纸面毫米，相对锚点）。给了就**照用**：不做择位、不做规避（钉死是
   * 调用方的显式指令），由此产生的压盖/共线/越界不在此静默改写，而是记进
   * {@link LeaderPlacement.conflicts} 交检查器判。
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
  /** 最短引线（毫米，锚点到标号落点）。 */
  minLeaderMm: number;
  /** 最长引线（毫米）：超过此长度说明标号已远离图面，不如就地标号。 */
  maxLeaderMm: number;
  /** 引线长度步进（毫米）；缺省 {@link DEFAULT_LEADER_STEP_MM}。 */
  stepMm?: number;
  /** 标号必须完整落在此框内（纸面毫米；通常为图幅）。缺省不限制。 */
  canvas?: LeaderBox;
  /** 择位基向的参照点（通常是图形中心）：标号优先摆在"远离它"的方向。 */
  figureCenter?: LeaderPoint;
  /** 标号框与障碍矩形的最小净距（毫米）；缺省 {@link DEFAULT_CLEARANCE_MM}。 */
  clearanceMm?: number;
  /** 引线与主线条夹角小于此值（度）且相距很近 ⇒ 判共线不可分；缺省 15°。 */
  collinearAngleDeg?: number;
  /** 共线判定的最大间距（毫米）；缺省 {@link DEFAULT_COLLINEAR_GAP_MM}。 */
  collinearGapMm?: number;
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
  /** 引线折线（锚点 → 标号外缘）；退化时为空。 */
  leader: readonly LeaderSegment[];
  /** 是否由调用方钉死。 */
  pinned: boolean;
  /** 是否退化（无可用落位：就地标号、无引线）。 */
  degraded: boolean;
  /**
   * 钉死落位的后果（引线面 + 标号压盖图内内容；标号与标号的压盖、标号越界分别由调用方既有
   * 规则判，不在此重复）。引擎择位的落位恒为空数组——择位判据已把它们排除。
   */
  conflicts: readonly string[];
};

export type LeaderPlan = {
  placements: LeaderPlacement[];
  /** 退化告警（顺序 = 目标顺序；无退化则为空）。 */
  warnings: string[];
};

/** 共线/交叉判定的容差（择位与审计共用，保证两处口径一致）。 */
type LeaderTolerance = { collinearAngleDeg: number; collinearGapMm: number; gapMm: number };

/** 引线长度步进（毫米）：优先短引线，故步进取细。 */
export const DEFAULT_LEADER_STEP_MM = 1.5;
/** 标号框与障碍的最小净距（毫米）。 */
export const DEFAULT_CLEARANCE_MM = 0.5;
/** 共线判定的夹角阈值（度）：小于它且相距很近的引线与线条打印后分不清。 */
export const DEFAULT_COLLINEAR_ANGLE_DEG = 15;
/** 共线判定的最大间距（毫米）：约等于附图线宽（0.35mm）的两倍。 */
export const DEFAULT_COLLINEAR_GAP_MM = 0.7;
/**
 * 方向候选（相对基向的角度，度；顺序固定）：基向（远离图心）→ 两侧斜向 → 正交 → 反向。
 * 反向排最后是因为它把标号摆回图形一侧，多半被"标号不得压盖图内内容"否掉。
 */
export const LEADER_DIRECTIONS_DEG: readonly number[] = [0, 45, -45, 90, -90, 135, -135, 180];
/** 标号框在基线上方/下方的比例（合计 1.2 倍字号）。 */
const LABEL_ASCENT_RATIO = 1;
const LABEL_DESCENT_RATIO = 0.2;
const EPS = 1e-9;

/** 标号文本框（纸面毫米）：宽按字符类别估算（与布局器同一度量），高按字号比例。 */
export function labelBoxOf(text: string, fontSizeMm: number, labelPoint: LeaderPoint): LeaderBox {
  const halfWidth = measureTextWidth(text, fontSizeMm) / 2;
  return {
    left: labelPoint.x - halfWidth,
    right: labelPoint.x + halfWidth,
    top: labelPoint.y - fontSizeMm * LABEL_ASCENT_RATIO,
    bottom: labelPoint.y + fontSizeMm * LABEL_DESCENT_RATIO,
  };
}

function expandBox(box: LeaderBox, by: number): LeaderBox {
  return { left: box.left - by, top: box.top - by, right: box.right + by, bottom: box.bottom + by };
}

/** 两框是否相交（边界相切不算：标号贴着放不算压盖）。 */
function boxesOverlap(a: LeaderBox, b: LeaderBox): boolean {
  return a.left < b.right - EPS && b.left < a.right - EPS && a.top < b.bottom - EPS && b.top < a.bottom - EPS;
}

/** a 是否完全落在 b 内（边界含等号：正好贴边不算越界）。 */
function boxWithin(a: LeaderBox, b: LeaderBox): boolean {
  return a.left >= b.left - EPS && a.right <= b.right + EPS && a.top >= b.top - EPS && a.bottom <= b.bottom + EPS;
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

/** 点到线段所在**直线**的垂距；线段退化为一点时返回 undefined。 */
function pointLineDistance(point: LeaderPoint, line: LeaderSegment): number | undefined {
  const dx = line.to.x - line.from.x;
  const dy = line.to.y - line.from.y;
  const length = Math.hypot(dx, dy);
  if (length < EPS) return undefined;
  return Math.abs((point.x - line.from.x) * dy - (point.y - line.from.y) * dx) / length;
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
 * 引线是否"顺着某条已有线条走"（夹角小 **且**引线远端仍贴在该线条所在直线上）。
 *
 * 三种要捉的形态（沿线重叠、顺线条延长出去、平行贴着走）都由这一条覆盖：重合即远端垂距为 0。
 * **只用引线的远端**做判据，不用整条线段的最小距离——引线常从主线条上（或其端点）出发，逐段
 * 最小距离必然为 0，那样判会把"从线条上以小角度离开"的合法引线全否掉。障碍线条也没有"远端"
 * 可言（折线的每个顶点都是端点），故不对它做反测。
 */
function leaderGluesToLine(leader: LeaderSegment, line: LeaderSegment, tolerance: LeaderTolerance): boolean {
  if (segmentAngleDeg(leader, line) >= tolerance.collinearAngleDeg) return false;
  const far = pointLineDistance(leader.to, line);
  return far !== undefined && far < tolerance.collinearGapMm;
}

/**
 * 去掉引线靠近锚点的一小段（长度 = 标号间隙）：同一锚点引出的多根引线在锚点处相交是**构造
 * 使然**（扇形展开），不是"互相妨碍"，故交叉判定前先切掉这一小段。
 */
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

/** 两条引线是否互相妨碍（相交，或共线贴着走）。两条都是引线，故两个远端都作判据。 */
function leadersConflict(a: LeaderSegment, b: LeaderSegment, tolerance: LeaderTolerance): boolean {
  const trimmedA = trimAtAnchor(a, tolerance.gapMm);
  const trimmedB = trimAtAnchor(b, tolerance.gapMm);
  if (segmentsIntersect(trimmedA, trimmedB)) return true;
  return leaderGluesToLine(trimmedA, trimmedB, tolerance) || leaderGluesToLine(trimmedB, trimmedA, tolerance);
}

type CandidateContext = LeaderTolerance & {
  obstacles: Required<LeaderObstacles>;
  placedBoxes: LeaderBox[];
  placedLeaders: LeaderSegment[];
  clearanceMm: number;
  canvas: LeaderBox | undefined;
};

/**
 * 判定一个候选落位是否可用（全判据通过才接受）。
 *
 * 标号框与**障碍矩形**的判定用"扩了净距的障碍框"：标号要离开图内内容一小段，否则打印后
 * 文字与轮廓线糊在一起。
 */
function candidateAccepted(box: LeaderBox, leader: LeaderSegment | undefined, context: CandidateContext): boolean {
  if (context.canvas !== undefined && !boxWithin(box, context.canvas)) return false;
  for (const obstacle of context.obstacles.boxes) {
    if (boxesOverlap(box, expandBox(obstacle, context.clearanceMm))) return false;
  }
  for (const placed of context.placedBoxes) {
    if (boxesOverlap(box, expandBox(placed, context.clearanceMm))) return false;
  }
  if (leader === undefined) return true;
  for (const placed of context.placedBoxes) {
    if (segmentIntersectsBox(leader, placed)) return false;
  }
  for (const line of context.obstacles.segments) {
    if (leaderGluesToLine(leader, line, context)) return false;
  }
  for (const placed of context.placedLeaders) {
    if (leadersConflict(leader, placed, context)) return false;
  }
  return true;
}

/** 归一化方向；零向量返回 undefined。 */
function normalizeDirection(vector: readonly [number, number]): [number, number] | undefined {
  const length = Math.hypot(vector[0], vector[1]);
  if (length < EPS) return undefined;
  return [vector[0] / length, vector[1] / length];
}

function rotateDeg(direction: readonly [number, number], degrees: number): [number, number] {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [direction[0] * cos - direction[1] * sin, direction[0] * sin + direction[1] * cos];
}

/** 由锚点与方向/长度得到引线（长度不超间隙时无引线：标号就贴在锚点上）。 */
function leaderOf(
  anchor: LeaderPoint,
  direction: readonly [number, number],
  length: number,
  gapMm: number,
): LeaderSegment[] {
  if (length <= gapMm + EPS) return [];
  return [
    {
      from: anchor,
      to: { x: anchor.x + direction[0] * (length - gapMm), y: anchor.y + direction[1] * (length - gapMm) },
    },
  ];
}

function placementOf(
  target: LeaderTarget,
  labelPoint: LeaderPoint,
  leader: readonly LeaderSegment[],
  options: LeaderLineOptions,
  pinned: boolean,
): LeaderPlacement {
  return {
    id: target.id,
    text: target.text,
    anchor: target.anchor,
    labelPoint,
    offsetMm: [labelPoint.x - target.anchor.x, labelPoint.y - target.anchor.y],
    box: labelBoxOf(target.text, options.fontSizeMm, labelPoint),
    leader,
    pinned,
    degraded: false,
    conflicts: [],
  };
}

/**
 * 钉死落位的后果审计（不做规避：钉死是调用方的显式指令）。
 *
 * 与择位判据**分列**而不复用返回值：择位是"接受/拒绝"（内部口径），审计是"报告为什么不行"
 * （对外口径），两者都调用同一组几何谓词与同一组容差，故口径不会漂移。
 */
function auditPinnedPlacement(
  placement: LeaderPlacement,
  selfIndex: number,
  others: readonly LeaderPlacement[],
  obstacles: Required<LeaderObstacles>,
  context: CandidateContext,
): string[] {
  const conflicts: string[] = [];
  const record = (message: string): void => {
    if (!conflicts.includes(message)) conflicts.push(message);
  };
  for (const obstacle of obstacles.boxes) {
    if (boxesOverlap(placement.box, expandBox(obstacle, context.clearanceMm))) {
      record("标号压在图形上（与图内实心区重叠），标号读不出来");
      break;
    }
  }
  for (const leader of placement.leader) {
    for (const line of obstacles.segments) {
      if (leaderGluesToLine(leader, line, context)) {
        record("引线与主线条共线重叠（夹角过小且贴得很近），打印后分不清哪条是标记线");
        break;
      }
    }
    for (const [otherIndex, other] of others.entries()) {
      if (otherIndex === selfIndex) continue;
      if (segmentIntersectsBox(leader, other.box)) record(`引线穿过标记 ${other.text} 的标号`);
      for (const otherLeader of other.leader) {
        if (leadersConflict(leader, otherLeader, context)) record(`引线与标记 ${other.text} 的引线交叉`);
      }
    }
  }
  return conflicts;
}

/**
 * 规划一组图外引线标号。
 *
 * 顺序纪律（确定性的一部分）：**钉死的标号先全部落位并登记为障碍**，再做择位——否则同一组
 * 输入会因"钉死的排在后面"而得到不同结果。择位本身按目标顺序贪心，先放下的标号成为后放者的
 * 障碍（一次落位、不回退：回退需要全局搜索，收益不抵确定性代价）。
 */
export function planLeaderLines(
  targets: readonly LeaderTarget[],
  obstacles: LeaderObstacles = {},
  options: LeaderLineOptions,
): LeaderPlan {
  const context: CandidateContext = {
    obstacles: { boxes: obstacles.boxes ?? [], segments: obstacles.segments ?? [] },
    placedBoxes: [],
    placedLeaders: [],
    clearanceMm: options.clearanceMm ?? DEFAULT_CLEARANCE_MM,
    collinearAngleDeg: options.collinearAngleDeg ?? DEFAULT_COLLINEAR_ANGLE_DEG,
    collinearGapMm: options.collinearGapMm ?? DEFAULT_COLLINEAR_GAP_MM,
    gapMm: options.gapMm,
    canvas: options.canvas,
  };
  const placements: LeaderPlacement[] = [];
  const warnings: string[] = [];
  for (const target of targets) {
    if (target.pinnedOffsetMm === undefined) continue;
    const offset = target.pinnedOffsetMm;
    const direction = normalizeDirection(offset);
    const length = Math.hypot(offset[0], offset[1]);
    const labelPoint: LeaderPoint = { x: target.anchor.x + offset[0], y: target.anchor.y + offset[1] };
    const placement = placementOf(
      target,
      labelPoint,
      direction === undefined ? [] : leaderOf(target.anchor, direction, length, options.gapMm),
      options,
      true,
    );
    placements.push(placement);
    context.placedBoxes.push(placement.box);
    context.placedLeaders.push(...placement.leader);
  }

  const stepMm = options.stepMm ?? DEFAULT_LEADER_STEP_MM;
  const steps = Math.max(1, Math.floor((options.maxLeaderMm - options.minLeaderMm) / stepMm) + 1);
  for (const target of targets) {
    if (target.pinnedOffsetMm !== undefined) continue;
    const center = options.figureCenter;
    const base =
      center === undefined
        ? ([0, -1] as [number, number])
        : (normalizeDirection([target.anchor.x - center.x, target.anchor.y - center.y]) ?? [0, -1]);
    let placed: LeaderPlacement | undefined;
    for (let index = 0; index < steps && placed === undefined; index += 1) {
      const length = options.minLeaderMm + index * stepMm;
      for (const degrees of LEADER_DIRECTIONS_DEG) {
        const direction = rotateDeg(base, degrees);
        const labelPoint: LeaderPoint = {
          x: target.anchor.x + direction[0] * length,
          y: target.anchor.y + direction[1] * length,
        };
        const leader = leaderOf(target.anchor, direction, length, options.gapMm);
        const box = labelBoxOf(target.text, options.fontSizeMm, labelPoint);
        if (!candidateAccepted(box, leader[0], context)) continue;
        placed = placementOf(target, labelPoint, leader, options, false);
        break;
      }
    }
    if (placed === undefined) {
      placed = {
        ...placementOf(target, target.anchor, [], options, false),
        degraded: true,
      };
      warnings.push(
        `标记 ${target.text} 无可用引线落位（${LEADER_DIRECTIONS_DEG.length} 个方向 × ${steps} 档引线长度均被占：` +
          "标号会压盖图内内容/其它标号，或引线与主线条共线、与其它引线相交）" +
          "⇒ 退化为就地标号（无引线）：请显式指定该标记的落位，或减少同时标注的标记",
      );
    }
    placements.push(placed);
    context.placedBoxes.push(placed.box);
    context.placedLeaders.push(...placed.leader);
  }

  // 落位按**目标顺序**返回（钉死的前置只是放置顺序，不该改变调用方的输出顺序）；审计放在
  // 最后：审计口径是"与全部其它落位的关系"，与放置顺序无关。
  const byId = new Map(placements.map(placement => [placement.id, placement]));
  const ordered = targets.map(target => byId.get(target.id)!);
  return {
    placements: ordered.map((placement, index) =>
      placement.pinned
        ? { ...placement, conflicts: auditPinnedPlacement(placement, index, ordered, context.obstacles, context) }
        : placement,
    ),
    warnings,
  };
}
