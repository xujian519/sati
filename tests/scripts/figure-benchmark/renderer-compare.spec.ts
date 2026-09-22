/**
 * tests/scripts/figure-benchmark/renderer-compare.spec.ts — 渲染器对比脚本的度量口径护栏。
 *
 * 对比脚本的结论会被用来决定「默认渲染器是否切换」，所以度量本身必须钉死：
 * ① 解析口径（画幅/文本框/连线几何）在两种 SVG 方言上都成立；
 * ② 两个容差是**有意**的，且方向正确——边框擦边不算压线/穿线（否则会把两个后端正常的
 *    紧凑布局一律标成缺陷），真贯穿、真重叠必须算出来。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  canvasMmOf,
  charMmOf,
  countEdgeNodeCrossings,
  countLabelStrikes,
  countTextOverlaps,
  edgeSegmentsOf,
  median,
  parseContentBBox,
  parseGraphvizEdgeSegments,
  parseNodeBoxes,
  parsePathData,
  parsePolylineSegments,
  parseSvgCanvas,
  parseTextBoxes,
  utilization,
} from "../../../scripts/figure-benchmark/renderer-compare.js";

/** 内置渲染器方言：`<polyline>` 连线 + `n-` 前缀节点分组 + 整幅白底 rect + defs 内箭头。 */
const BUILTIN_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" data-figure-no="1" width="200" height="100" viewBox="0 0 200 100">',
  '<rect x="0" y="0" width="200" height="100" fill="#FFFFFF"/>',
  '<defs><marker id="arrow"><path d="M0,1 L9,5 L0,9 Z" fill="#000000"/></marker></defs>',
  '<polyline fill="none" stroke="#000000" points="10,20 40,20 60,50"/>',
  '<g id="n-a" data-ref="10"><rect x="0" y="10" width="40" height="20" rx="2" fill="#FFFFFF" stroke="#000000"/>',
  '<text x="20" y="24" font-size="14" text-anchor="middle" fill="#000000">模块(10)</text></g>',
  '<text x="100" y="94" font-size="14" text-anchor="middle" fill="#000000">图1</text>',
  "</svg>",
].join("\n");

/** graphviz 方言：graph0 整幅白底 polygon + edge 分组内 `<path d>` + 转义 title。 */
const GRAPHVIZ_SVG = [
  '<svg width="247pt" height="72pt" viewBox="0.00 0.00 247.00 72.00" xmlns="http://www.w3.org/2000/svg">',
  '<g id="graph0" class="graph" transform="scale(1 1) rotate(0) translate(4 68)">',
  "<title>图1</title>",
  '<polygon fill="white" stroke="none" points="-4,4 -4,-68 243,-68 243,4 -4,4"/>',
  '<text text-anchor="middle" x="123" y="-10" font-size="14.00">图1</text>',
  '<g id="node1" class="node" data-ref="10">',
  "<title>f1&#45;b1</title>",
  '<polygon fill="#FFFFFF" stroke="#000000" points="27,-18 27,-54 141,-54 141,-18 27,-18"/>',
  '<text text-anchor="middle" x="84" y="-32" font-size="14.00" fill="#000000">输入接口单元</text>',
  "</g>",
  '<g id="edge1" class="edge">',
  "<title>f1&#45;b1&#45;&gt;f1&#45;b2</title>",
  '<path fill="none" stroke="#000000" d="M141,-36C149,-36 149,-36 157,-36"/>',
  '<polygon fill="#000000" stroke="#000000" points="157,-36 150,-39.5 150,-32.5 157,-36"/>',
  "</g>",
  "</g>",
  "</svg>",
].join("\n");

test("画幅：viewBox 解析；缺失或非法即抛错", () => {
  assert.deepEqual(parseSvgCanvas(GRAPHVIZ_SVG), { width: 247, height: 72 });
  assert.throws(() => parseSvgCanvas("<svg></svg>"), /viewBox/u);
  assert.throws(() => parseSvgCanvas('<svg viewBox="0 0 a b"></svg>'), /viewBox 非法/u);
});

test("文本框：按 anchor 展开左右边界，剥掉内层标签，识别压线标签", () => {
  const boxes = parseTextBoxes(GRAPHVIZ_SVG);
  assert.deepEqual(
    boxes.map(box => box.text),
    ["图1", "输入接口单元"],
  );
  const label = boxes[1]!;
  // CJK 6 字 × 14 单位 = 84；anchor=middle ⇒ 以 x=84 居中
  assert.equal(label.right - label.left, 84);
  assert.equal(label.left, 42);
  assert.equal(label.top, -32 - 14 * 0.8);
  assert.equal(label.bottom, -32 + 14 * 0.2);
  assert.equal(label.onLine, false);

  const mixed = parseTextBoxes(
    '<svg><text x="10" y="20" font-size="10">开始</text>' +
      '<text x="10" y="40" font-size="10" text-anchor="end">结束</text>' +
      '<text x="10" y="60" font-size="10" paint-order="stroke">是<tspan></tspan></text>' +
      '<text x="10" y="80" font-size="10"></text></svg>',
  );
  assert.deepEqual(
    mixed.map(box => [box.text, box.left, box.right]),
    [
      ["开始", 10, 30],
      ["结束", -10, 10],
      ["是", 10, 20],
    ],
  );
  assert.equal(mixed[2]!.onLine, true, "paint-order=stroke 的边标签压在连线上");
});

test("文本框：graphviz 的边标签（在 edge 分组内、无 paint-order）同样按压线标记", () => {
  const svg = [
    '<svg viewBox="0 0 100 100">',
    '<g class="node"><title>a</title><text x="20" y="20" font-size="10">节点</text></g>',
    '<g class="edge"><title>a&#45;&gt;b</title><path d="M0,0"/>',
    '<text x="50" y="50" font-size="10" text-anchor="middle">是</text></g>',
    "</svg>",
  ].join("");
  const boxes = parseTextBoxes(svg);
  assert.deepEqual(
    boxes.map(box => [box.text, box.onLine]),
    [
      ["节点", false],
      ["是", true],
    ],
  );
  // 边标签不作穿线靶，节点标签仍是
  assert.equal(countLabelStrikes([{ x1: 30, y1: 50, x2: 70, y2: 50 }], boxes), 0);
  assert.equal(countLabelStrikes([{ x1: 0, y1: 20, x2: 40, y2: 20 }], boxes), 1);
});

test("连线：内置取 polyline，graphviz 只取 edge 分组内的 path（节点形状不算连线）", () => {
  const builtin = parsePolylineSegments(BUILTIN_SVG);
  assert.deepEqual(builtin, [
    { x1: 10, y1: 20, x2: 40, y2: 20 },
    { x1: 40, y1: 20, x2: 60, y2: 50 },
  ]);

  const graphviz = parseGraphvizEdgeSegments(GRAPHVIZ_SVG);
  assert.equal(graphviz.unsupported, 0);
  assert.equal(graphviz.segments.length, 4, "M + C 三次曲线按 1/4 采样成 4 段");
  const round = (segment: { x1: number; y1: number; x2: number; y2: number }): number[] =>
    [segment.x1, segment.y1, segment.x2, segment.y2].map(value => Math.round(value * 100) / 100);
  assert.deepEqual(round(graphviz.segments[0]!), [141, -36, 145.75, -36]);
  assert.deepEqual(round(graphviz.segments.at(-1)!), [152.25, -36, 157, -36]);

  assert.deepEqual(edgeSegmentsOf(GRAPHVIZ_SVG, "builtin"), { segments: [], unsupported: 0 });
});

test("path 解析：直线/曲线/圆弧与未支持指令的计数", () => {
  assert.deepEqual(parsePathData("M0,0 L10,0 L10,10"), {
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    unsupported: 0,
  });
  const arc = parsePathData("M0,0 A5,5 0 0 1 10,10");
  assert.deepEqual(arc.points, [
    { x: 0, y: 0 },
    { x: 10, y: 10 },
  ]);
  assert.equal(arc.unsupported, 1, "圆弧按端点直线近似并计数");
  assert.equal(parsePathData("m0,0 l5,5").unsupported, 1, "相对指令未支持，计数后停");
});

test("文字压线：真重叠算，边框擦边不算（graphviz 字体度量与本模块近似有系统偏差）", () => {
  const box = { left: 0, top: 0, right: 100, bottom: 20, text: "a", fontSize: 10, onLine: false };
  const kiss = { left: 95, top: 0, right: 195, bottom: 20, text: "b", fontSize: 10, onLine: false };
  assert.equal(countTextOverlaps([box, kiss]), 0, "5% 擦边视为测量噪声");
  const heavy = { left: 50, top: 0, right: 150, bottom: 20, text: "c", fontSize: 10, onLine: false };
  assert.equal(countTextOverlaps([box, heavy]), 1, "50% 重叠必须判出");
  assert.equal(countTextOverlaps([box]), 0);
});

test("标签穿线：端点落在框内（连线到节点边框为止）不算，贯穿才算；边标签不作靶", () => {
  const targets = [{ left: 0, top: 0, right: 100, bottom: 20, text: "标签", fontSize: 10, onLine: false }];
  // 起点在框内 → 不算
  assert.equal(countLabelStrikes([{ x1: 95, y1: 10, x2: 150, y2: 10 }], targets), 0);
  // 完整贯穿 → 算
  assert.equal(countLabelStrikes([{ x1: -10, y1: 10, x2: 110, y2: 10 }], targets), 1);
  // 只擦到一个角（未贯穿）→ 不算
  assert.equal(countLabelStrikes([{ x1: -10, y1: -10, x2: 5, y2: 5 }], targets), 0);
  // 边标签（onLine）不是穿线靶
  const onLine = [{ ...targets[0]!, onLine: true }];
  assert.equal(countLabelStrikes([{ x1: -10, y1: 10, x2: 110, y2: 10 }], onLine), 0);
});

test("利用率：整幅白底（内置 rect / graphviz polygon）不计入内容并集", () => {
  const builtinCanvas = parseSvgCanvas(BUILTIN_SVG);
  const builtinBox = parseContentBBox(BUILTIN_SVG, builtinCanvas)!;
  // 合成长标注（模块(10) 宽 56 > 合成节点框 40）左溢出，正是"内容并集"应有的行为；
  // 关键是右沿不得等于画幅右沿——等于就说明整幅白底 rect 被算进来了。
  assert.equal(builtinBox.left, -8);
  assert.ok(builtinBox.right < 200, `白底不应参与并集，实际右沿 ${builtinBox.right}`);
  assert.ok(utilization(BUILTIN_SVG, builtinCanvas) < 1);

  const graphvizCanvas = parseSvgCanvas(GRAPHVIZ_SVG);
  const graphvizBox = parseContentBBox(GRAPHVIZ_SVG, graphvizCanvas)!;
  assert.equal(graphvizBox.left, 27, "graph0 白底 polygon（从 -4 起）不参与并集，左沿取节点框");
  const graphvizUtilization = utilization(GRAPHVIZ_SVG, graphvizCanvas);
  assert.ok(graphvizUtilization > 0 && graphvizUtilization < 1, `graphviz 利用率应可区分，实际 ${graphvizUtilization}`);
});

test("单位换算：内置坐标是 px、graphviz 是 pt（14 号字换算差 4/3）", () => {
  const inMm = (value: number): number => Math.round(value * 1000) / 1000;
  for (const backend of ["builtin", "graphviz"] as const) {
    const size = backend === "builtin" ? { width: 96, height: 96 } : { width: 72, height: 72 };
    const mm = canvasMmOf(size, backend);
    assert.equal(inMm(mm.widthMm), 25.4, `${backend} 一英寸 = 25.4mm`);
    assert.equal(inMm(mm.heightMm), 25.4);
  }
  assert.equal(inMm(charMmOf("builtin")), 3.704, "14px = 14/96 英寸");
  assert.equal(inMm(charMmOf("graphviz")), 4.939, "14pt = 14/72 英寸");
});

test("节点盒：只认白底填充的图形（整幅白底与黑色实心箭头都不算）", () => {
  const graphviz = parseNodeBoxes(GRAPHVIZ_SVG);
  assert.equal(graphviz.length, 1, "节点 polygon 计入；graph0 白底与黑色箭头不计");
  assert.deepEqual(graphviz[0], { left: 27, top: -54, right: 141, bottom: -18 });
  assert.equal(parseNodeBoxes(BUILTIN_SVG).length, 1, "整幅白底 rect 不计，节点 rect 计入");

  assert.equal(countEdgeNodeCrossings([{ x1: 0, y1: -36, x2: 200, y2: -36 }], graphviz), 1, "贯穿节点盒");
  assert.equal(countEdgeNodeCrossings([{ x1: 141, y1: -36, x2: 200, y2: -36 }], graphviz), 0, "止于节点边框");
});

test("median：奇数取中位、偶数取两中均值、空集为 0", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), 0);
});
