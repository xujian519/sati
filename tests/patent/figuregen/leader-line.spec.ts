/**
 * src/patent/figuregen/leader-line — 图外引线标号择位的性质测试。
 *
 * 测的是**决策性质**而非具体坐标：标号向图外引、不压图内内容、引线不与主线条共线重叠、
 * 引线之间不交叉、越界时退化并告警、钉死落位照用且后果被审计。坐标只在需要固定口径时
 * 才写死（间隙、步进、最短引线），避免把实现细节焊进测试。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_COLLINEAR_ANGLE_DEG,
  LEADER_DIRECTIONS_DEG,
  labelBoxOf,
  planLeaderLines,
  segmentAngleDeg,
  segmentsIntersect,
  type LeaderBox,
  type LeaderLineOptions,
  type LeaderPoint,
  type LeaderPlan,
  type LeaderSegment,
  type LeaderTarget,
} from "../../../src/patent/figuregen/leader-line.js";

/** 与 CAD 通路同量：字号 3mm、间隙 1.5mm、最短引线 6mm。 */
const BASE_OPTIONS: LeaderLineOptions = {
  fontSizeMm: 3,
  gapMm: 1.5,
  minLeaderMm: 6,
  maxLeaderMm: 12,
};

const WIDE_CANVAS: LeaderBox = { left: -100, top: -100, right: 100, bottom: 100 };

function dirOf(from: LeaderPoint, to: LeaderPoint): [number, number] {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  return [(to.x - from.x) / length, (to.y - from.y) / length];
}

function angleBetween(a: readonly [number, number], b: readonly [number, number]): number {
  return (Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1]))) * 180) / Math.PI;
}

function overlaps(a: LeaderBox, b: LeaderBox): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function placementOf(plan: LeaderPlan, id: string) {
  const placement = plan.placements.find(entry => entry.id === id);
  assert.ok(placement !== undefined, `缺落位：${id}`);
  return placement;
}

/** 切掉锚点附近一小段：同一锚点引出的引线在此处共点是构造使然，不算交叉。 */
function beyondAnchor(segment: LeaderSegment, gapMm: number): LeaderSegment {
  const length = Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y);
  return {
    from: {
      x: segment.from.x + ((segment.to.x - segment.from.x) / length) * gapMm,
      y: segment.from.y + ((segment.to.y - segment.from.y) / length) * gapMm,
    },
    to: segment.to,
  };
}

test("labelBoxOf：宽度按字符类别（Latin 半角 0.5em、CJK 全角 1em），基线上下按字号比例", () => {
  const latin = labelBoxOf("10", 3, { x: 10, y: 20 });
  assert.equal(latin.left, 10 - 1.5);
  assert.equal(latin.right, 10 + 1.5);
  assert.equal(latin.top, 20 - 3);
  assert.equal(latin.bottom, 20 + 0.6);

  const mixed = labelBoxOf("10a", 3, { x: 0, y: 0 });
  assert.equal(mixed.right - mixed.left, 4.5);
});

test("无遮挡：标号落在基向（远离图心）上、取最短引线，引线止于标号外缘", () => {
  const plan = planLeaderLines(
    [{ id: "10", text: "10", anchor: { x: 50, y: 0 } }],
    {},
    { ...BASE_OPTIONS, figureCenter: { x: 0, y: 0 }, canvas: WIDE_CANVAS },
  );
  const placement = plan.placements[0]!;
  assert.equal(placement.degraded, false);
  assert.equal(placement.pinned, false);
  // 基向 = 锚点 − 图心 = +x ⇒ 标号在右侧、距离取最短档（引线由短到长枚举，取第一个可用者）
  assert.deepEqual(placement.offsetMm, [BASE_OPTIONS.minLeaderMm, 0]);
  assert.equal(placement.leader.length, 1);
  const leader = placement.leader[0]!;
  assert.deepEqual(leader.from, { x: 50, y: 0 });
  assert.deepEqual(leader.to, { x: 50 + BASE_OPTIONS.minLeaderMm - BASE_OPTIONS.gapMm, y: 0 });
  assert.deepEqual(plan.warnings, []);
});

test("图内实心区：锚点在轮廓里时把标号推到轮廓外（而不是画在图上）", () => {
  // 100×40 实心区、锚点在正中 ⇒ 最短引线根本出不了图，必须换更长的
  const geometry: LeaderBox = { left: 0, top: 0, right: 100, bottom: 40 };
  const plan = planLeaderLines(
    [{ id: "30", text: "30", anchor: { x: 50, y: 20 } }],
    { boxes: [geometry] },
    {
      ...BASE_OPTIONS,
      maxLeaderMm: 30,
      figureCenter: { x: 50, y: 20 },
      canvas: { left: -20, top: -20, right: 120, bottom: 60 },
    },
  );
  const placement = plan.placements[0]!;
  assert.equal(placement.degraded, false);
  const distance = Math.hypot(placement.offsetMm[0], placement.offsetMm[1]);
  assert.ok(distance > BASE_OPTIONS.minLeaderMm, `引线须长于最短档：${distance}`);
  assert.ok(!overlaps(placement.box, geometry), `标号框不得压盖实心区：${JSON.stringify(placement.box)}`);
});

test("共线规避：基向与一条主线条共线时改向，不画出与主线条分不清的引线", () => {
  const line: LeaderSegment = { from: { x: 0, y: 0 }, to: { x: 100, y: 0 } };
  const target: LeaderTarget = { id: "10", text: "10", anchor: { x: 50, y: 0 } };
  const base = { ...BASE_OPTIONS, figureCenter: { x: 0, y: 0 }, canvas: WIDE_CANVAS };

  // 画布上没有该线条：照基向（+x）走
  const free = planLeaderLines([target], {}, base);
  assert.deepEqual(free.placements[0]!.offsetMm, [BASE_OPTIONS.minLeaderMm, 0]);

  // 有该线条：引线远端贴线 ⇒ 该候选判"分不清"，必须换向（首候选为基向旋转 45°）
  const avoided = planLeaderLines([target], { segments: [line] }, base);
  const placement = avoided.placements[0]!;
  assert.equal(placement.degraded, false);
  const leader = placement.leader[0]!;
  assert.ok(Math.abs(segmentAngleDeg(leader, line) - 45) < 1e-6, `引线应与主线条成 45°：${JSON.stringify(leader)}`);
  assert.ok(angleBetween(dirOf(placement.anchor, placement.labelPoint), [1, 0]) > 1e-6, "不得沿用与主线条共线的基向");
});

test("共线判据看的是远端垂距：小角度离开不算共线，远端贴线才算", () => {
  // 线条从 (-50,0) 到 (0,0)；锚点在其右端点上，基向朝右、略高于线条
  const line: LeaderSegment = { from: { x: -50, y: 0 }, to: { x: 0, y: 0 } };
  const target: LeaderTarget = { id: "1", text: "1", anchor: { x: 0, y: 0 } };
  const withCenter = (center: LeaderPoint) => ({ ...BASE_OPTIONS, figureCenter: center, canvas: WIDE_CANVAS });

  // 基向与线条约 14°：远端垂距 ≈ 6·sin14° ≈ 1.4mm > 0.7mm ⇒ 不算共线，基向照用
  const shallow = planLeaderLines([target], { segments: [line] }, withCenter({ x: -97, y: 24 }));
  const shallowPlacement = shallow.placements[0]!;
  assert.equal(shallowPlacement.degraded, false);
  const shallowRatio = shallowPlacement.offsetMm[1] / shallowPlacement.offsetMm[0];
  assert.ok(Math.abs(shallowRatio - -24 / 97) < 1e-6, `应保留基向：${JSON.stringify(shallowPlacement.offsetMm)}`);

  // 基向与线条约 2°：远端垂距 ≈ 0.2mm < 0.7mm ⇒ 判共线，须换向（≥ 夹角阈值）
  const glued = planLeaderLines([target], { segments: [line] }, withCenter({ x: -99.939, y: 3.49 }));
  const gluedLeader = glued.placements[0]!.leader[0]!;
  assert.ok(
    segmentAngleDeg(gluedLeader, line) >= DEFAULT_COLLINEAR_ANGLE_DEG,
    `贴线候选应被否掉：${JSON.stringify(glued.placements[0]!.offsetMm)}`,
  );
});

test("多个标记（同一锚点）：全部落位、标号互不重叠、引线除共点外不相交", () => {
  const geometry: LeaderBox = { left: 45, top: 15, right: 55, bottom: 25 };
  const plan = planLeaderLines(
    [
      { id: "10", text: "10", anchor: { x: 50, y: 20 } },
      { id: "11", text: "11", anchor: { x: 50, y: 20 } },
      { id: "12", text: "12", anchor: { x: 50, y: 20 } },
    ],
    { boxes: [geometry] },
    {
      ...BASE_OPTIONS,
      maxLeaderMm: 30,
      figureCenter: { x: 50, y: 20 },
      canvas: { left: -40, top: -40, right: 140, bottom: 80 },
    },
  );
  assert.deepEqual(plan.warnings, []);
  for (const [index, placement] of plan.placements.entries()) {
    assert.equal(placement.degraded, false, `标记 ${placement.id} 不应退化`);
    assert.ok(!overlaps(placement.box, geometry), `标号 ${placement.id} 压盖实心区`);
    for (const other of plan.placements.slice(index + 1)) {
      assert.ok(!overlaps(placement.box, other.box), `标号 ${placement.id} 与 ${other.id} 重叠`);
      for (const leader of placement.leader) {
        for (const otherLeader of other.leader) {
          assert.ok(
            !segmentsIntersect(beyondAnchor(leader, BASE_OPTIONS.gapMm), beyondAnchor(otherLeader, BASE_OPTIONS.gapMm)),
            `引线 ${placement.id} 与 ${other.id} 相交`,
          );
        }
      }
    }
  }
  // 三根引线自同一锚点扇形展开（方向各不相同）
  const directions = plan.placements.map(placement => dirOf(placement.anchor, placement.labelPoint));
  for (const [index, direction] of directions.entries()) {
    for (const other of directions.slice(index + 1)) {
      assert.ok(angleBetween(direction, other) > DEFAULT_COLLINEAR_ANGLE_DEG, "同锚点引线应扇形展开而非叠在一起");
    }
  }
});

test("越界：画幅里放不下任何候选 ⇒ 退化为就地标号并告警（不静默改位、不画越界引线）", () => {
  const plan = planLeaderLines(
    [{ id: "10", text: "10", anchor: { x: 4, y: 4 } }],
    {},
    { ...BASE_OPTIONS, figureCenter: { x: 0, y: 0 }, canvas: { left: 0, top: 0, right: 8, bottom: 8 } },
  );
  const placement = plan.placements[0]!;
  assert.equal(placement.degraded, true);
  assert.deepEqual(placement.leader, []);
  assert.deepEqual(placement.labelPoint, { x: 4, y: 4 });
  assert.deepEqual(placement.offsetMm, [0, 0]);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0]!, /退化为就地标号/u);
  assert.ok(plan.warnings[0]!.includes(String(LEADER_DIRECTIONS_DEG.length)), "告警应报出枚举规模");
});

test("钉死落位：照用调用方给的偏移（不做择位），且不产生择位告警", () => {
  const plan = planLeaderLines(
    [{ id: "30", text: "30", anchor: { x: 10, y: 10 }, pinnedOffsetMm: [-20, -8] }],
    {},
    { ...BASE_OPTIONS, figureCenter: { x: 0, y: 0 } },
  );
  const placement = plan.placements[0]!;
  assert.equal(placement.pinned, true);
  assert.equal(placement.degraded, false);
  assert.deepEqual(placement.labelPoint, { x: -10, y: 2 });
  assert.deepEqual(placement.offsetMm, [-20, -8]);
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(placement.conflicts, []);
  // 引线止于标号外缘：端点 = 标号点 − 方向 × 间隙
  const direction = dirOf(placement.anchor, placement.labelPoint);
  const leader = placement.leader[0]!;
  assert.deepEqual(leader.from, { x: 10, y: 10 });
  assert.ok(Math.abs(leader.to.x - (-10 - direction[0] * BASE_OPTIONS.gapMm)) < 1e-9);
  assert.ok(Math.abs(leader.to.y - (2 - direction[1] * BASE_OPTIONS.gapMm)) < 1e-9);
});

test("钉死落位的审计：压盖图内内容 / 引线与主线条共线 / 引线穿过别的标号都被记下", () => {
  const geometry: LeaderBox = { left: 0, top: 0, right: 100, bottom: 40 };
  const line: LeaderSegment = { from: { x: 0, y: 0 }, to: { x: 100, y: 0 } };
  const options = { ...BASE_OPTIONS, figureCenter: { x: 50, y: 20 }, canvas: WIDE_CANVAS };

  // 压盖：标号钉到实心区里
  const covered = planLeaderLines(
    [{ id: "1", text: "1", anchor: { x: 50, y: 20 }, pinnedOffsetMm: [0, 0] }],
    { boxes: [geometry] },
    options,
  );
  assert.ok(covered.placements[0]!.conflicts.some(message => message.includes("压在图形上")));

  // 共线：引线顺着主线条延长出去（远端仍贴在该线条所在直线上）
  const collinear = planLeaderLines(
    [{ id: "2", text: "2", anchor: { x: 100, y: 0 }, pinnedOffsetMm: [20, 0] }],
    { segments: [line] },
    options,
  );
  assert.ok(collinear.placements[0]!.conflicts.some(message => message.includes("共线重叠")));

  // 穿标号：第二个标记的引线从第一个标记的标号框里穿过（两锚点不同，故交叉与共点无关）
  const crossed = planLeaderLines(
    [
      { id: "3", text: "3", anchor: { x: 50, y: 50 }, pinnedOffsetMm: [0, -30] },
      { id: "4", text: "4", anchor: { x: 0, y: 20 }, pinnedOffsetMm: [80, 0] },
    ],
    {},
    options,
  );
  assert.deepEqual(placementOf(crossed, "3").conflicts, []);
  assert.ok(
    placementOf(crossed, "4").conflicts.some(message => message.includes("引线穿过标记 3 的标号")),
    JSON.stringify(placementOf(crossed, "4").conflicts),
  );
});

test("钉死落位先落位并登记为障碍：目标顺序不影响择位结果", () => {
  // 钉死的标号正压在自由标记的基向候选上 ⇒ 自由标记必须换向（而不是与它重叠或直接退化）
  const pinned: LeaderTarget = { id: "9", text: "9", anchor: { x: 30, y: 30 }, pinnedOffsetMm: [4.24, 4.24] };
  const free: LeaderTarget = { id: "10", text: "10", anchor: { x: 30, y: 30 } };
  const options = { ...BASE_OPTIONS, figureCenter: { x: 0, y: 0 }, canvas: WIDE_CANVAS };
  const first = planLeaderLines([pinned, free], {}, options);
  const second = planLeaderLines([free, pinned], {}, options);

  const free10 = placementOf(first, "10");
  const pinned9 = placementOf(first, "9");
  assert.equal(free10.degraded, false);
  assert.ok(!overlaps(free10.box, pinned9.box), "自由标记不得与钉死的标号框重叠");
  assert.ok(
    angleBetween(dirOf(free.anchor, free10.labelPoint), [Math.SQRT1_2, Math.SQRT1_2]) > DEFAULT_COLLINEAR_ANGLE_DEG,
    `不得沿用被占的基向：${JSON.stringify(free10.offsetMm)}`,
  );
  assert.deepEqual(free10.labelPoint, placementOf(second, "10").labelPoint);
});

test("确定性：同一输入两次调用逐位一致；落位按目标顺序返回", () => {
  const targets: LeaderTarget[] = [
    { id: "10", text: "10", anchor: { x: 10, y: 10 } },
    { id: "20", text: "20", anchor: { x: 12, y: 11 }, pinnedOffsetMm: [4, 4] },
    { id: "30", text: "30", anchor: { x: 9, y: 12 } },
  ];
  const options = {
    ...BASE_OPTIONS,
    figureCenter: { x: 10, y: 10 },
    canvas: { left: -30, top: -30, right: 50, bottom: 50 },
  };
  const obstacles = { boxes: [{ left: 0, top: 0, right: 20, bottom: 20 }] };
  const first = planLeaderLines(targets, obstacles, options);
  const second = planLeaderLines(targets, obstacles, options);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.placements.map(placement => placement.id),
    ["10", "20", "30"],
  );
});

test("几何谓词：相交（含端点接触与共线重叠）与夹角归一到 0–90", () => {
  const horizontal: LeaderSegment = { from: { x: 0, y: 0 }, to: { x: 10, y: 0 } };
  assert.ok(segmentsIntersect(horizontal, { from: { x: 5, y: -5 }, to: { x: 5, y: 5 } }), "十字相交");
  assert.ok(segmentsIntersect(horizontal, { from: { x: 10, y: 0 }, to: { x: 20, y: 0 } }), "端点接触");
  assert.ok(segmentsIntersect(horizontal, { from: { x: 2, y: 0 }, to: { x: 8, y: 0 } }), "共线重叠");
  assert.ok(!segmentsIntersect(horizontal, { from: { x: 5, y: 1 }, to: { x: 5, y: 5 } }), "未接触");
  assert.equal(segmentAngleDeg(horizontal, { from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }), 0);
  assert.equal(segmentAngleDeg(horizontal, { from: { x: 0, y: 0 }, to: { x: 0, y: 10 } }), 90);
  assert.equal(segmentAngleDeg(horizontal, { from: { x: 10, y: 0 }, to: { x: 0, y: 0 } }), 0, "反向平行归一到 0");
});
