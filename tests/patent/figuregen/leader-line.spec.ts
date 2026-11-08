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
  LEADER_DIRECTION_PHASE_DEG,
  LEADER_DIRECTIONS_DEG,
  LEADER_PLACEMENT_GUIDANCE,
  LEADER_STUB_MM,
  LeaderPlacementError,
  buildLeaderGeometry,
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
import { glyphBox } from "../../../src/patent/figuregen/glyph-box.js";

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

function closeTo(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}：${actual} ≠ ${expected}`);
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

test("labelBoxOf：与复核侧共用 glyphBox 的字符宽度（数字/小写 0.6em、CJK 1em）与升降比例", () => {
  const latin = labelBoxOf("10", 3, { x: 10, y: 20 });
  closeTo(latin.left, 10 - 1.8, "left");
  closeTo(latin.right, 10 + 1.8, "right");
  closeTo(latin.top, 20 - 2.25, "top");
  closeTo(latin.bottom, 20 + 0.36, "bottom");

  const mixed = labelBoxOf("10a", 3, { x: 0, y: 0 });
  closeTo(mixed.right - mixed.left, 5.4, "width");

  // 与复核侧的 `glyphBox` 逐值一致（两侧各算一份会让"择位躲开了、复核说贯穿"）
  for (const text of ["1", "10", "100", "处理模块"]) {
    const box = labelBoxOf(text, 3, { x: 7, y: 9 });
    const glyph = glyphBox(text, [7, 9], 3, "middle");
    assert.deepEqual(box, { left: glyph.minX, top: glyph.minY, right: glyph.maxX, bottom: glyph.maxY }, text);
  }
});

test("无遮挡：标号落在最接近基向的相位方向、取最短环，折线以水平短划止于字框外", () => {
  const anchor = { x: 50, y: 0 };
  const plan = planLeaderLines(
    [{ id: "10", text: "10", anchor }],
    {},
    { ...BASE_OPTIONS, figureCenter: { x: 0, y: 0 }, canvas: WIDE_CANVAS },
  );
  const placement = plan.placements[0]!;
  assert.equal(placement.degraded, false);
  assert.equal(placement.pinned, false);
  // 基向 = +x。相位把 0° 错开到 15°（与 345° 角距相同，下标更小者胜），环距取最短档。
  const expected = buildLeaderGeometry({
    anchor,
    directionDeg: LEADER_DIRECTION_PHASE_DEG,
    ringMm: BASE_OPTIONS.minLeaderMm,
    text: "10",
    fontSizeMm: BASE_OPTIONS.fontSizeMm,
    gapMm: BASE_OPTIONS.gapMm,
  });
  assert.ok(expected !== undefined);
  assert.deepEqual(placement.labelPoint, expected.labelPoint);
  assert.deepEqual(placement.box, expected.box);
  assert.equal(placement.leader.length, 2, "自由落位应是斜段 + 水平短划");
  const [inclined, stub] = placement.leader;
  assert.deepEqual(inclined!.from, anchor);
  assert.equal(stub!.from.y, stub!.to.y, "末段应水平");
  assert.ok(Math.abs(stub!.to.x - stub!.from.x - LEADER_STUB_MM) < 1e-9, "短划长度应等于命名常量");
  assert.ok(
    Math.abs(
      segmentAngleDeg(inclined!, { from: anchor, to: { x: anchor.x + 1, y: anchor.y } }) - LEADER_DIRECTION_PHASE_DEG,
    ) < 1e-6,
  );
  const glyph = glyphBox("10", [placement.labelPoint.x, placement.labelPoint.y], BASE_OPTIONS.fontSizeMm, "middle");
  assert.deepEqual(placement.box, { left: glyph.minX, top: glyph.minY, right: glyph.maxX, bottom: glyph.maxY });
  assert.ok(Math.abs(placement.box.left - stub!.to.x - BASE_OPTIONS.gapMm) < 1e-9, "短划应停在字框左缘再退间隙");
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

test("共线规避：最佳斜段贴着主线条时改向，不画出与主线条分不清的引线", () => {
  const anchor = { x: 50, y: 0 };
  const target: LeaderTarget = { id: "10", text: "10", anchor };
  const base = { ...BASE_OPTIONS, figureCenter: { x: 0, y: 0 }, canvas: WIDE_CANVAS };
  const radians = (LEADER_DIRECTION_PHASE_DEG * Math.PI) / 180;
  // 主线条沿着首选相位（15°）伸出：该斜段的远端落在线上，必须换向
  const line: LeaderSegment = {
    from: anchor,
    to: { x: anchor.x + Math.cos(radians) * 40, y: anchor.y + Math.sin(radians) * 40 },
  };

  const free = planLeaderLines([target], {}, base);
  const freeInclined = free.placements[0]!.leader[0]!;
  assert.ok(
    Math.abs(
      segmentAngleDeg(freeInclined, { from: anchor, to: { x: anchor.x + 1, y: anchor.y } }) -
        LEADER_DIRECTION_PHASE_DEG,
    ) < 1e-6,
    "无障碍时斜段应取相位方向",
  );

  const avoided = planLeaderLines([target], { segments: [line] }, base);
  const placement = avoided.placements[0]!;
  assert.equal(placement.degraded, false);
  const leader = placement.leader[0]!;
  assert.ok(
    segmentAngleDeg(leader, line) >= DEFAULT_COLLINEAR_ANGLE_DEG,
    `贴线斜段应被否掉：${JSON.stringify(leader)}`,
  );
});

test("共线判据看的是远端垂距：小角度离开不算共线，斜段本身贴线才算", () => {
  // 线条停在锚点左侧。15° 斜段的远端垂距 ≈ 6·sin15° ≈ 1.55mm > 0.7mm，不算共线。
  const line: LeaderSegment = { from: { x: -50, y: 0 }, to: { x: 0, y: 0 } };
  const target: LeaderTarget = { id: "1", text: "1", anchor: { x: 0, y: 0 } };
  const options = { ...BASE_OPTIONS, figureCenter: { x: -10, y: 0 }, canvas: WIDE_CANVAS };

  const shallow = planLeaderLines([target], { segments: [line] }, options);
  const shallowLeader = shallow.placements[0]!.leader[0]!;
  assert.equal(shallow.placements[0]!.degraded, false);
  assert.ok(
    Math.abs(segmentAngleDeg(shallowLeader, line) - LEADER_DIRECTION_PHASE_DEG) < 1e-6,
    `小角度离开应保留相位方向：${JSON.stringify(shallow.placements[0]!.offsetMm)}`,
  );

  const radians = (LEADER_DIRECTION_PHASE_DEG * Math.PI) / 180;
  const gluedLine: LeaderSegment = {
    from: { x: 0, y: 0 },
    to: { x: Math.cos(radians) * 30, y: Math.sin(radians) * 30 },
  };
  const glued = planLeaderLines([target], { segments: [gluedLine] }, options);
  const gluedLeader = glued.placements[0]!.leader[0]!;
  assert.ok(
    segmentAngleDeg(gluedLeader, gluedLine) >= DEFAULT_COLLINEAR_ANGLE_DEG,
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

test("引线止点按字框求解：水平短划停在字框外，斜段不取正水平或正垂直", () => {
  const centers: readonly [string, LeaderPoint][] = [
    ["向右", { x: 0, y: 50 }],
    ["向下", { x: 50, y: 0 }],
    ["斜向", { x: 0, y: 0 }],
  ];
  for (const text of ["1", "10", "100"]) {
    for (const [label, center] of centers) {
      const anchor = { x: 50, y: 50 };
      const plan = planLeaderLines(
        [{ id: text, text, anchor }],
        {},
        { ...BASE_OPTIONS, figureCenter: center, canvas: WIDE_CANVAS },
      );
      const placement = plan.placements[0]!;
      assert.equal(placement.degraded, false, `${text} ${label} 不应退化`);
      const stub = placement.leader[placement.leader.length - 1]!;
      assert.equal(stub.from.y, stub.to.y, `${text} ${label}：末段应水平`);
      const sign = stub.to.x >= stub.from.x ? 1 : -1;
      const edge = sign > 0 ? placement.box.left : placement.box.right;
      assert.ok(
        Math.abs(Math.abs(edge - stub.to.x) - BASE_OPTIONS.gapMm) < 1e-9,
        `${text} ${label}：短划应停在字框外 ${BASE_OPTIONS.gapMm}mm`,
      );
      const glyph = glyphBox(text, [placement.labelPoint.x, placement.labelPoint.y], BASE_OPTIONS.fontSizeMm, "middle");
      assert.deepEqual(
        placement.box,
        { left: glyph.minX, top: glyph.minY, right: glyph.maxX, bottom: glyph.maxY },
        `${text} ${label}：标号框必须与 glyphBox 一致`,
      );
      const inclined = placement.leader[0]!;
      const toHorizontal = segmentAngleDeg(inclined, { from: { x: 0, y: 0 }, to: { x: 1, y: 0 } });
      const toVertical = segmentAngleDeg(inclined, { from: { x: 0, y: 0 }, to: { x: 0, y: 1 } });
      assert.ok(
        Math.min(toHorizontal, toVertical) >= LEADER_DIRECTION_PHASE_DEG - 1e-6,
        `${text} ${label}：斜段不应是正水平或正垂直`,
      );
    }
  }
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
  // 引线止于标号外缘再退间隙（斜向：沿射线退 gap，故到框的垂距 ≤ gap）
  const leader = placement.leader[0]!;
  assert.deepEqual(leader.from, { x: 10, y: 10 });
  const dx = Math.max(placement.box.left - leader.to.x, 0, leader.to.x - placement.box.right);
  const dy = Math.max(placement.box.top - leader.to.y, 0, leader.to.y - placement.box.bottom);
  const boxDistance = Math.hypot(dx, dy);
  assert.ok(boxDistance > 0, `引线止点不得进入标号框：${JSON.stringify(leader.to)}`);
  assert.ok(boxDistance <= BASE_OPTIONS.gapMm + 1e-9, `引线止点应退开间隙：${boxDistance}`);
  const cross = (leader.to.x - 10) * (2 - 10) - (leader.to.y - 10) * (-10 - 10);
  assert.ok(Math.abs(cross) < 1e-6, "引线应沿锚点→标号的方向");
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
  assert.ok(covered.placements[0]!.conflicts.some(message => message.includes("压在图形或图号注记上")));

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

test("重复 id 被拒绝：不静默丢弃落位、不让两个标号落在同一点", () => {
  // 落位与调用方**按下标对齐**（render-cad 即如此读回）。若重复 id 被静默容忍，两个目标会
  // 取到同一个落位：图面上一个标号消失、另一个精确重叠，而落位报告零告警。
  const targets: LeaderTarget[] = [
    { id: "10", text: "10", anchor: { x: 20, y: 20 } },
    { id: "10", text: "10", anchor: { x: 80, y: 60 } },
  ];
  assert.throws(
    () => planLeaderLines(targets, {}, BASE_OPTIONS),
    /id 须唯一/u,
    "重复 id 必须响亮失败——挑其中一个顶替不是修复，是把错图做得更难发现",
  );
});

test("重复 id 的拒绝覆盖钉死落位（pinned 不绕过唯一性检查）", () => {
  const targets: LeaderTarget[] = [
    { id: "10", text: "10", anchor: { x: 20, y: 20 }, pinnedOffsetMm: [10, 10] },
    { id: "10", text: "10", anchor: { x: 80, y: 60 } },
  ];
  assert.throws(() => planLeaderLines(targets, {}, BASE_OPTIONS), /id 须唯一/u);
});

test("唯一 id 的正常输入不受影响（回归：唯一性检查不得误伤）", () => {
  const plan = planLeaderLines(
    [
      { id: "10", text: "10", anchor: { x: 20, y: 20 } },
      { id: "20", text: "20", anchor: { x: 80, y: 60 } },
    ],
    {},
    { ...BASE_OPTIONS, canvas: WIDE_CANVAS },
  );
  assert.deepEqual(
    plan.placements.map(placement => placement.id),
    ["10", "20"],
  );
});

test("strict：放不下就抛 LeaderPlacementError，并点名放不下的标记", () => {
  const options = {
    ...BASE_OPTIONS,
    mode: "strict" as const,
    figureCenter: { x: 0, y: 0 },
    canvas: { left: 0, top: 0, right: 8, bottom: 8 },
  };
  assert.throws(
    () => planLeaderLines([{ id: "10", text: "10", anchor: { x: 4, y: 4 } }], {}, options),
    (error: unknown) => {
      assert.ok(error instanceof LeaderPlacementError);
      assert.deepEqual([...error.unplaceableIds], ["10"]);
      assert.match(error.message, /减少同时标注/);
      assert.match(error.message, /拆成多幅/);
      assert.match(error.message, /label_offset_mm/);
      assert.ok(error.message.includes(LEADER_PLACEMENT_GUIDANCE));
      return true;
    },
  );
});

test("strict：同一输入在可放置时与 degrade 得到同一落位；钉死偏移不因 strict 被改写", () => {
  const placeable = {
    ...BASE_OPTIONS,
    figureCenter: { x: 0, y: 0 },
    canvas: WIDE_CANVAS,
  };
  const targets: LeaderTarget[] = [
    { id: "10", text: "10", anchor: { x: 20, y: 0 } },
    { id: "20", text: "20", anchor: { x: 0, y: 0 }, pinnedOffsetMm: [-20, -8] },
  ];
  const loose = planLeaderLines(targets, {}, { ...placeable, mode: "degrade" });
  const tight = planLeaderLines(targets, {}, { ...placeable, mode: "strict" });
  assert.deepEqual(loose, tight);
  assert.deepEqual(placementOf(tight, "20").offsetMm, [-20, -8]);
  assert.equal(placementOf(tight, "20").pinned, true);
});

test("拥挤需要回溯：先放者的最优解堵死后放者的唯一口袋时，改走次优", () => {
  const ringMm = 12;
  const optionsBase: LeaderLineOptions = {
    ...BASE_OPTIONS,
    minLeaderMm: ringMm,
    maxLeaderMm: ringMm,
    figureCenter: { x: -20, y: 0 },
    clearanceMm: 0.5,
  };
  const anchor = { x: 0, y: 0 };
  const geometryOf = (text: string, directionDeg: number) => {
    const geometry = buildLeaderGeometry({
      anchor,
      directionDeg,
      ringMm,
      text,
      fontSizeMm: optionsBase.fontSizeMm,
      gapMm: optionsBase.gapMm,
    });
    assert.ok(geometry !== undefined, `${text} @ ${directionDeg}°`);
    return geometry;
  };
  const narrow = geometryOf("1", 15);
  const narrowNext = geometryOf("1", 45);
  const wide = geometryOf("100", 15);
  const wideNext = geometryOf("100", 45);
  // 画布只包住 15° 与 45° 两只口袋，把更陡的方向关在外面。
  const canvas: LeaderBox = {
    left: Math.min(narrow.box.left, narrowNext.box.left, wide.box.left) - 1,
    top: Math.min(narrow.box.top, narrowNext.box.top, wide.box.top) - 1,
    right: Math.max(narrow.box.right, narrowNext.box.right, wide.box.right) + 1,
    bottom: narrowNext.box.bottom + 0.05,
  };
  const blocked = geometryOf("1", 75);
  assert.equal(blocked.box.top > canvas.bottom || blocked.box.bottom > canvas.bottom, true, "75° 应被画布排除");
  // 薄障碍只压住宽标号在 45° 的外伸，窄标号的 45° 框仍可用。
  const sliver: LeaderBox = {
    left: narrowNext.box.right + (optionsBase.clearanceMm ?? 0) + 0.3,
    right: wideNext.box.right + 0.5,
    top: wideNext.box.top - 0.2,
    bottom: wideNext.box.bottom + 0.2,
  };
  const options = { ...optionsBase, canvas };
  const alone = planLeaderLines([{ id: "A", text: "1", anchor }], { boxes: [sliver] }, options);
  assert.deepEqual(alone.placements[0]!.labelPoint, narrow.labelPoint, "A 单独时应占 15° 最优口袋");

  const plan = planLeaderLines(
    [
      { id: "A", text: "1", anchor },
      { id: "B", text: "100", anchor },
    ],
    { boxes: [sliver] },
    { ...options, mode: "strict" },
  );
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(placementOf(plan, "A").labelPoint, narrowNext.labelPoint, "回溯后 A 应让出 15°");
  assert.deepEqual(placementOf(plan, "B").labelPoint, wide.labelPoint, "B 应占回唯一可用的 15°");
  assert.equal(placementOf(plan, "A").degraded, false);
  assert.equal(placementOf(plan, "B").degraded, false);
});

test("reverse：把锚点挪出可放置区域后，strict 必须失败（fail-closed）", () => {
  const canvas: LeaderBox = { left: -40, top: -40, right: 40, bottom: 40 };
  const options = { ...BASE_OPTIONS, mode: "strict" as const, figureCenter: { x: 0, y: 0 }, canvas };
  const placed = planLeaderLines([{ id: "10", text: "10", anchor: { x: 0, y: 0 } }], {}, options);
  assert.equal(placed.placements[0]!.degraded, false, "对照：锚点在画幅内时应能放下");

  assert.throws(
    () => planLeaderLines([{ id: "10", text: "10", anchor: { x: 10_000, y: 10_000 } }], {}, options),
    (error: unknown) => {
      assert.ok(error instanceof LeaderPlacementError);
      assert.deepEqual([...error.unplaceableIds], ["10"]);
      assert.match(error.message, /strict/);
      return true;
    },
  );

  // 钉死的不在失败名单里；被挪走的自由标记才是。
  assert.throws(
    () =>
      planLeaderLines(
        [
          { id: "pin", text: "1", anchor: { x: 0, y: 0 }, pinnedOffsetMm: [12, -6] },
          { id: "gone", text: "2", anchor: { x: 10_000, y: -10_000 } },
        ],
        {},
        options,
      ),
    (error: unknown) => {
      assert.ok(error instanceof LeaderPlacementError);
      assert.deepEqual([...error.unplaceableIds], ["gone"]);
      return true;
    },
  );
});

test("方向相位：12 个绝对角都不落在正水平或正垂直上", () => {
  assert.equal(LEADER_DIRECTIONS_DEG.length, 12);
  for (const degrees of LEADER_DIRECTIONS_DEG) {
    const remainder = ((degrees % 90) + 90) % 90;
    assert.ok(Math.min(remainder, 90 - remainder) >= LEADER_DIRECTION_PHASE_DEG - 1e-9, `${degrees}° 贴着轴线`);
  }
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
