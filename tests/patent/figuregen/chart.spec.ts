/**
 * src/patent/figuregen — 曲线图/坐标图（矢量通路）测试。
 *
 * 覆盖：自动范围与刻度取整、显式范围优先、标记/线型默认分配与冲突检测、
 * 轴标目与图例的图面落点、黑白不变式、画幅与 V7 同源、图面词语进入 V12/V13。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  CHART_MARKER_CYCLE,
  chartOutOfRange,
  chartStyleConflicts,
  chartWordingLabels,
  layoutChart,
  renderChartBody,
  resolveChartSeries,
} from "../../../src/patent/figuregen/chart.js";
import { checkFigures } from "../../../src/patent/figuregen/check.js";
import { buildFigureDot } from "../../../src/patent/figuregen/dot.js";
import { renderFigureSvg } from "../../../src/patent/figuregen/render-svg.js";
import type { FigureChart, FigureSpec } from "../../../src/patent/figuregen/types.js";

function chartSpec(chart: FigureChart, extra: Partial<FigureSpec> = {}): FigureSpec {
  return { figure_no: 1, kind: "chart", nodes: [], edges: [], chart, ...extra };
}

const ONE_SERIES: FigureChart = {
  x: { title: "时间(h)" },
  y: { title: "转化率(%)" },
  series: [
    {
      name: "实施例1",
      points: [
        [0, 0],
        [1, 32],
        [2, 61],
        [3, 88],
        [4, 96],
      ],
    },
  ],
};

test("横轴刻度按数据范围外扩并取整（读数是整档，不是数据极值）", () => {
  const layout = layoutChart(ONE_SERIES);
  assert.deepEqual(
    layout.xTicks.map(tick => tick.text),
    ["0", "1", "2", "3", "4"],
  );
  // 纵轴数据 0..96 ⇒ 按 25 步长取到 0..100
  assert.deepEqual(
    layout.yTicks.map(tick => tick.text),
    ["0", "25", "50", "75", "100"],
  );
  for (const tick of layout.xTicks) assert.ok(tick.position >= layout.plot.left && tick.position <= layout.plot.right);
  for (const tick of layout.yTicks) assert.ok(tick.position >= layout.plot.top && tick.position <= layout.plot.bottom);
});

test("显式 min 固定，缺省端仍取整（min:0 + 数据 0..97 ⇒ 0/25/50/75/100）", () => {
  const layout = layoutChart({
    x: { title: "t(s)", min: 0, max: 10 },
    y: { title: "y" },
    series: [
      {
        points: [
          [0, 0],
          [10, 97],
        ],
      },
    ],
  });
  assert.deepEqual(
    layout.yTicks.map(tick => tick.text),
    ["0", "25", "50", "75", "100"],
  );
  assert.deepEqual(
    layout.xTicks.map(tick => tick.text),
    ["0", "2.5", "5", "7.5", "10"],
  );
});

test("刻度数决定步长密度（目标是密度而非硬性条数）；越界值回落缺省", () => {
  const count = (ticks: number | undefined): number =>
    layoutChart({ ...ONE_SERIES, x: { title: "t(s)", ticks } }).xTicks.length;
  // 数据 x 0..4：目标 3 ⇒ 步长 2（0/2/4）；目标 11 ⇒ 步长 0.5（0/0.5/…/4）
  assert.equal(count(3), 3);
  assert.ok(count(11) > count(5), `目标 11 的刻度数 ${count(11)} 未比缺省更密`);
  assert.equal(count(1), 5);
  assert.equal(count(99), 5);
});

test("刻度落在整档上（范围为取整结果时不得出现 1.75/3.25 这类标签）", () => {
  const layout = layoutChart({
    x: { title: "t(s)" },
    y: { title: "R(kΩ)" },
    series: [
      {
        points: [
          [0, 1.2],
          [10, 3.9],
        ],
      },
    ],
  });
  assert.deepEqual(
    layout.yTicks.map(tick => tick.text),
    ["1", "2", "3", "4"],
  );
});

test("单序列无标记即为纯曲线；多序列缺省标记自动分配不同形状", () => {
  const single = resolveChartSeries(ONE_SERIES);
  assert.equal(single[0]!.marker, CHART_MARKER_CYCLE[0]);
  assert.equal(single[0]!.line, "solid");

  const multi = resolveChartSeries({
    ...ONE_SERIES,
    series: [
      {
        points: [
          [0, 0],
          [1, 1],
        ],
      },
      {
        points: [
          [0, 1],
          [1, 0],
        ],
      },
      {
        points: [
          [0, 0],
          [1, 0.5],
        ],
      },
    ],
  });
  assert.deepEqual(
    multi.map(entry => entry.marker),
    [CHART_MARKER_CYCLE[0], CHART_MARKER_CYCLE[1], CHART_MARKER_CYCLE[2]],
  );
  assert.deepEqual(chartStyleConflicts({ ...ONE_SERIES, series: multi.map(entry => entry.series) }), []);
});

test("线型与标记都相同的两条曲线报出冲突（黑白图面无从分辨）", () => {
  const chart: FigureChart = {
    ...ONE_SERIES,
    series: [
      {
        name: "对比例1",
        points: [
          [0, 0],
          [1, 1],
        ],
        marker: "square",
      },
      {
        name: "对比例2",
        points: [
          [0, 1],
          [1, 0],
        ],
        marker: "square",
      },
      {
        name: "实施例1",
        points: [
          [0, 0.5],
          [1, 0.5],
        ],
        marker: "circle",
      },
    ],
  };
  const conflicts = chartStyleConflicts(chart);
  assert.equal(conflicts.length, 1);
  assert.ok(conflicts[0]!.includes("对比例1") && conflicts[0]!.includes("对比例2"), conflicts[0]);
  assert.ok(conflicts[0]!.includes("solid/square"));

  // 换个线型即成为可区分组合
  assert.deepEqual(
    chartStyleConflicts({
      ...chart,
      series: chart.series.map((series, index) => (index === 1 ? { ...series, line: "dashed" } : series)),
    }),
    [],
  );
});

test("轴外数据点报出（渲染器有意不裁剪）", () => {
  const inside = { x: { title: "t(s)", min: 0, max: 10 }, y: { title: "y", min: 0, max: 100 }, series: [] };
  assert.deepEqual(
    chartOutOfRange({
      ...inside,
      series: [
        {
          points: [
            [0, 0],
            [10, 100],
          ],
        },
      ],
    }),
    [],
  );

  const outside = chartOutOfRange({
    ...inside,
    series: [
      {
        name: "实施例1",
        points: [
          [0, 0],
          [12, 120],
        ],
      },
    ],
  });
  assert.equal(outside.length, 1);
  assert.ok(outside[0]!.includes("实施例1"), outside[0]);
  assert.ok(outside[0]!.includes("(12, 120)"), outside[0]);
  assert.ok(outside[0]!.includes("横轴 0..10"), outside[0]);
});

test("布局：画幅覆盖全部图元；caption=false 时不留图号带", () => {
  const layout = layoutChart(ONE_SERIES);
  for (const tick of layout.yTicks) assert.ok(tick.position >= layout.plot.top);
  assert.ok(layout.plot.right <= layout.width);
  assert.ok(layout.plot.bottom + 40 <= layout.height);
  assert.equal(layout.height - layoutChart(ONE_SERIES, { caption: false }).height, 40);
  // 纵轴标目写在刻度值左侧，不越出画布
  assert.ok(layout.yTitleX > 0, `纵轴标目落点 ${layout.yTitleX} 越出画布`);
});

test("图例：有 name 的序列列在横轴标目下方，legend:false 时不画", () => {
  const withLegend = layoutChart({
    ...ONE_SERIES,
    series: [
      {
        name: "实施例1",
        points: [
          [0, 0],
          [1, 1],
        ],
      },
      {
        name: "对比例1",
        points: [
          [0, 1],
          [1, 0],
        ],
      },
    ],
  });
  assert.equal(withLegend.legend.length, 1);
  assert.ok(withLegend.legend[0]!.baseline > withLegend.xTitleBaseline);
  const body = renderChartBody(withLegend);
  assert.ok(body.includes(">实施例1</text>") && body.includes(">对比例1</text>"), body);

  const hidden = layoutChart({ ...ONE_SERIES, legend: false });
  assert.equal(hidden.legend.length, 0);
  assert.ok(!renderChartBody(hidden).includes("实施例1"));
});

test("单点序列只画标记不画折线；图例超出绘图区宽度时折行", () => {
  const single = layoutChart({
    x: { title: "t(s)" },
    y: { title: "y" },
    series: [{ name: "样点", points: [[1, 1]] }],
  });
  const body = renderChartBody(single);
  assert.equal(body.includes("<polyline"), false);
  // 1 个数据点标记 + 图例里 1 个标记示例
  assert.equal((body.match(/<circle/gu) ?? []).length, 2);

  const many = layoutChart({
    x: { title: "t(s)" },
    y: { title: "y" },
    series: Array.from({ length: 8 }, (_, index) => ({
      name: `试样${index + 1}的测量结果`,
      points: [
        [0, index],
        [1, index + 1],
      ],
    })),
  });
  assert.ok(many.legend.length > 1, `图例未折行：${many.legend.length} 行`);
  const rows = many.legend.flatMap(row => row.entries);
  assert.equal(rows.length, 8);
  // 行基线自上而下递增，且末行不越出画幅
  assert.ok(many.legend[1]!.baseline > many.legend[0]!.baseline);
  assert.ok(many.legend.at(-1)!.baseline <= many.height);
});

test("极窄显式范围内无整档刻度时退化为两端点（不可零刻度）", () => {
  const layout = layoutChart({
    x: { title: "t(s)", min: 1.01, max: 1.09, ticks: 2 },
    y: { title: "y", min: 0, max: 1 },
    series: [
      {
        points: [
          [1.01, 0],
          [1.09, 1],
        ],
      },
    ],
  });
  assert.deepEqual(
    layout.xTicks.map(tick => tick.text),
    ["1.01", "1.09"],
  );
  assert.equal(layout.xTicks[0]!.position, layout.plot.left);
  assert.equal(layout.xTicks[1]!.position, layout.plot.right);
});

test("网格线：默认不画，grid:true 时按刻度落点画细实线", () => {
  const off = renderChartBody(layoutChart(ONE_SERIES));
  const on = renderChartBody(layoutChart({ ...ONE_SERIES, grid: true }));
  const count = (body: string): number => (body.match(/stroke-width="0.8"/gu) ?? []).length;
  assert.equal(count(off), 0);
  assert.equal(count(on), layoutChart(ONE_SERIES).xTicks.length + layoutChart(ONE_SERIES).yTicks.length);
});

test("图面词语：轴标目与图例进用语检查面（V12/V13 的证据来源）", () => {
  assert.deepEqual(chartWordingLabels(ONE_SERIES), [
    { where: "横轴标目", text: "时间(h)" },
    { where: "纵轴标目", text: "转化率(%)" },
    { where: "图例", text: "实施例1" },
  ]);
  assert.deepEqual(chartWordingLabels({ ...ONE_SERIES, legend: false }), [
    { where: "横轴标目", text: "时间(h)" },
    { where: "纵轴标目", text: "转化率(%)" },
  ]);
});

test("渲染：黑白不变式 + 轴/刻度/曲线/标记齐备，无渐变无彩色函数", () => {
  const spec = chartSpec({
    ...ONE_SERIES,
    series: [
      {
        name: "实施例1",
        points: [
          [0, 0],
          [1, 32],
          [2, 61],
        ],
        marker: "filled-circle",
        line: "dashed",
      },
      {
        name: "对比例1",
        points: [
          [0, 5],
          [1, 10],
          [2, 15],
        ],
        marker: "triangle",
      },
    ],
  });
  const { svg, width, height } = renderFigureSvg(spec);
  assert.ok(svg.includes(`data-figure-no="1"`));
  assert.equal(svg.includes("url(#arrow)"), false); // 曲线图不用箭头 marker
  assert.ok(svg.includes(`width="${width}"`));
  assert.ok(svg.includes('text-anchor="middle" fill="#000000">图1</text>'), svg); // 图号居中在图下
  assert.ok(svg.includes('stroke-dasharray="7 4"'));
  assert.ok(svg.includes("<polyline"));
  assert.ok(svg.includes('fill="#000000"') && svg.includes('fill="#FFFFFF"'));
  assert.equal(/<linearGradient|<radialGradient|rgb\(|#[0-9a-fA-F]{3}(?![0-9a-fA-F])/u.test(svg), false);
  assert.equal(height % 1, 0);
});

test("渲染：符号形状与越界数据不抛错（布局期过滤非有限点/畸形点）", () => {
  const { svg } = renderFigureSvg(
    chartSpec({
      x: { title: "t(s)" },
      y: { title: "y" },
      series: [
        {
          name: "含脏数据",
          // 非有限数与长度不足的点在布局期被跳过，不参与范围推导与连线
          points: [
            [0, 0],
            [Number.NaN, 5],
            [1, 2],
            [Number.POSITIVE_INFINITY, 3],
          ],
        },
      ],
    }),
  );
  assert.ok(svg.includes("含脏数据"));
});

test("V7：曲线图画幅与渲染器同源（核验量的是同一张图）", () => {
  const spec = chartSpec(ONE_SERIES);
  const rendered = renderFigureSvg(spec);
  const result = checkFigures([spec], "", { skipTextRules: true, figureCount: 1 });
  const v7 = result.findings.filter(finding => finding.rule === "V7");
  // A4 可印区内不出 fail（固定画幅 500×400 量级，远小于可印区）
  assert.deepEqual(
    v7.filter(finding => finding.metric === "page_fit"),
    [],
  );
  const layout = layoutChart(ONE_SERIES, { caption: true });
  assert.equal(rendered.width, layout.width);
  assert.equal(rendered.height, layout.height);
});

test("V20/V21：曲线不可区分与轴外数据进核验报告", () => {
  const spec = chartSpec({
    x: { title: "t(s)", min: 0, max: 10 },
    y: { title: "y", min: 0, max: 100 },
    series: [
      {
        name: "对比例1",
        points: [
          [0, 0],
          [12, 120],
        ],
        marker: "square",
      },
      {
        name: "对比例2",
        points: [
          [0, 10],
          [5, 50],
        ],
        marker: "square",
      },
    ],
  });
  const result = checkFigures([spec], "", { skipTextRules: true });
  const rules = result.findings.map(finding => finding.rule);
  assert.ok(rules.includes("V20"), JSON.stringify(result.findings));
  assert.ok(rules.includes("V21"), JSON.stringify(result.findings));
  const v21 = result.findings.find(finding => finding.rule === "V21")!;
  assert.ok(v21.evidence!.join("\n").includes("(12, 120)"), v21.evidence!.join("\n"));
});

test("V19：实用新型附图全为曲线图时提示（只在看全本案且 cn 时判）", () => {
  const spec = chartSpec(ONE_SERIES);
  const utility = checkFigures([spec], "", { skipTextRules: true, documentKind: "utility" });
  assert.ok(utility.findings.some(finding => finding.rule === "V19" && finding.severity === "warn"));

  // 发明不判（细则第二十条第五款只约束实用新型）
  const invention = checkFigures([spec], "", { skipTextRules: true, documentKind: "invention" });
  assert.equal(
    invention.findings.some(finding => finding.rule === "V19"),
    false,
  );

  // 分次核验（本图只是全案的一幅）时不判：无从知道是否另有结构视图
  const partial = checkFigures([spec], "", { skipTextRules: true, documentKind: "utility", figureCount: 3 });
  assert.equal(
    partial.findings.some(finding => finding.rule === "V19"),
    false,
  );

  // 另有非曲线图时不判
  const mixed = checkFigures(
    [spec, { figure_no: 2, kind: "flowchart", nodes: [{ id: "a", label: "步骤" }], edges: [] }],
    "",
    { skipTextRules: true, documentKind: "utility" },
  );
  assert.equal(
    mixed.findings.some(finding => finding.rule === "V19"),
    false,
  );

  // 非 cn 辖区不判（该款是 CN 细则）
  const us = checkFigures([spec], "", { skipTextRules: true, documentKind: "utility", jurisdiction: "us" });
  assert.equal(
    us.findings.some(finding => finding.rule === "V19"),
    false,
  );
});

test("V13：曲线图的非中文轴标目与图例进图面用语检查（仅 cn）", () => {
  const spec = chartSpec({
    x: { title: "Time (h)" },
    y: { title: "转化率(%)" },
    series: [
      {
        name: "Example 1",
        points: [
          [0, 0],
          [1, 1],
        ],
      },
    ],
  });
  const cn = checkFigures([spec], "", { skipTextRules: true });
  const v13 = cn.findings.find(finding => finding.rule === "V13");
  assert.ok(v13, JSON.stringify(cn.findings));
  assert.ok(v13.evidence!.join("\n").includes("横轴标目"), v13.evidence!.join("\n"));
  assert.ok(v13.evidence!.join("\n").includes("图例"), v13.evidence!.join("\n"));

  const us = checkFigures([spec], "", { skipTextRules: true, jurisdiction: "us" });
  assert.equal(
    us.findings.some(finding => finding.rule === "V13"),
    false,
  );
});

test("DOT 通路对曲线图 fail-loud（graphviz 画不出坐标轴）", () => {
  assert.throws(() => buildFigureDot(chartSpec(ONE_SERIES)), /曲线图.*只能由内置渲染器绘制/u);
});

test("确定性：同输入两次布局/渲染逐字节一致", () => {
  const a = renderFigureSvg(chartSpec(ONE_SERIES));
  const b = renderFigureSvg(chartSpec(ONE_SERIES));
  assert.equal(a.svg, b.svg);
});
