/**
 * tests/patent/figuregen/render-baseline.spec.ts — 附图渲染产物不变式护栏的回归测试。
 *
 * 护栏要抓的是**跨版本/跨平台的布局漂移**：既有断言全是「同一进程内两次调用」比较，
 * 抓不到 dot 版本差异引起的漂移。本测试锁住护栏自身的三条性质：
 * ① 不变式抽取对固定输入**稳定**（同输入 ⇒ 同不变式，基线才可复算）；
 * ② **容差内不算漂移**、**超容差算漂移**（纸面尺寸 ±0.5mm 的口径不被悄悄放宽）；
 * ③ **基线缺失时报错**（不是静默通过）。
 *
 * 另有一条"语义锚点"：结构量（图号/`data-ref`/文字内容集合/图元类别分布）在**引擎版本不同**
 * 时也必须比对——坐标派生量可以不判定，结构量不可以（结构漂了就是缺陷）。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  GEOMETRY_FIELDS,
  PAPER_SIZE_TOLERANCE_MM,
  RENDER_BACKENDS,
  STRUCTURAL_FIELDS,
  collectBackendBaseline,
  compareBackendBaseline,
  extractFigureInvariant,
  loadRenderBaseline,
  parseRenderBaseline,
  renderBaselinePath,
  type BackendBaseline,
  type FigureRenderInvariant,
} from "../../../scripts/figure-benchmark/gen-render-baseline.js";
import { GENERATION_BENCHMARK_CASES } from "../../../scripts/figure-benchmark/gen-cases.js";
import { renderFigureSvg } from "../../../src/patent/figuregen/index.js";

const BASELINE = renderBaselinePath(process.cwd());

/** 构造一份最小的基线段（用于容差口径的单测）。 */
function syntheticBackend(figure: FigureRenderInvariant, engineVersion = "builtin"): BackendBaseline {
  return {
    backend: "builtin",
    engine_version: engineVersion,
    cases: [{ id: "synthetic", figures: [figure] }],
  };
}

/** 基准不变式（各字段取值固定，便于逐项构造漂移）。 */
function syntheticFigure(): FigureRenderInvariant {
  return {
    figure_no: 1,
    visible_figure_no: "图1",
    refs: [10, 20],
    width_mm: 100,
    height_mm: 200,
    text_count: 2,
    text_contents: ["甲(10)", "图1"],
    shape_kinds: { rect: 2, text: 2 },
    shape_count: 2,
    endpoint_count: 8,
    segment_count: 8,
    content_sha256: "0".repeat(64),
  };
}

test("基线入库且覆盖三个后端与全部用例", async () => {
  const baseline = parseRenderBaseline(await readFile(BASELINE, "utf8"));
  assert.equal(baseline.generator, "scripts/figure-benchmark/gen-render-baseline.ts");
  assert.equal(baseline.input_cases, "scripts/figure-benchmark/gen-cases.ts");
  assert.equal(baseline.policy.paper_size_tolerance_mm, PAPER_SIZE_TOLERANCE_MM);
  for (const backend of RENDER_BACKENDS) {
    const section = baseline.backends[backend];
    assert.ok(section, `基线缺少后端 ${backend}`);
    assert.deepEqual(
      section.cases.map(item => item.id),
      GENERATION_BENCHMARK_CASES.map(item => item.id),
      `后端 ${backend} 的基线未覆盖全部用例`,
    );
  }
});

test("不变式抽取对固定输入稳定（同一 SVG 两次抽取逐项相同）", () => {
  const benchmarkCase = GENERATION_BENCHMARK_CASES[0];
  assert.ok(benchmarkCase);
  const spec = benchmarkCase.figures[0];
  assert.ok(spec);
  const svg = renderFigureSvg(spec, { figureCount: benchmarkCase.figures.length }).svg;
  const first = extractFigureInvariant(svg, { backend: "builtin" });
  const second = extractFigureInvariant(svg, { backend: "builtin" });
  assert.deepEqual(first, second);
  // 抽取内容必须落在不变式契约内（不含坐标字段）。
  assert.equal(first.figure_no, spec.figure_no);
  assert.deepEqual(
    Object.keys(first).sort(),
    [...STRUCTURAL_FIELDS, ...GEOMETRY_FIELDS, "content_sha256"].sort(),
    "不变式的字段集合必须与契约一致（新增字段要显式登记）",
  );
});

test("内置渲染器逐字节确定 ⇒ sha256 相同；graphviz 后端不记 sha256（坐标会漂）", () => {
  const benchmarkCase = GENERATION_BENCHMARK_CASES[0];
  assert.ok(benchmarkCase);
  const spec = benchmarkCase.figures[0];
  assert.ok(spec);
  const svg = renderFigureSvg(spec, { figureCount: benchmarkCase.figures.length }).svg;
  const builtin = extractFigureInvariant(svg, { backend: "builtin" });
  const graphviz = extractFigureInvariant(svg, { backend: "graphviz" });
  assert.match(builtin.content_sha256 ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(graphviz.content_sha256, null, "graphviz 产物不逐字节确定，不记 sha256");
  // 同一份产物，两个后端的不变式除 sha256 外应一致（抽取与后端无关，只与产物有关）。
  assert.deepEqual({ ...builtin, content_sha256: null }, { ...graphviz, content_sha256: null });
});

test("容差内不算漂移（纸面尺寸差 ≤ 0.5mm 判一致）", () => {
  const expected = syntheticBackend(syntheticFigure());
  const actual = syntheticBackend({ ...syntheticFigure(), width_mm: 100 + PAPER_SIZE_TOLERANCE_MM / 2 });
  const comparison = compareBackendBaseline(expected, actual);
  assert.deepEqual(comparison.drifts, []);
  assert.equal(comparison.engine_matched, true);
});

test("超容差算漂移（纸面尺寸差 > 0.5mm 判漂移，并指出哪一幅哪个量）", () => {
  const expected = syntheticBackend(syntheticFigure());
  const actual = syntheticBackend({ ...syntheticFigure(), width_mm: 100 + PAPER_SIZE_TOLERANCE_MM + 0.001 });
  const comparison = compareBackendBaseline(expected, actual);
  assert.equal(comparison.drifts.length, 1);
  const drift = comparison.drifts[0];
  assert.ok(drift);
  assert.equal(drift.path, "builtin/synthetic/图1.width_mm");
  assert.equal(drift.kind, "tolerance");
});

test("结构量漂移即变红（与坐标无关的量必须比对）", () => {
  const expected = syntheticBackend(syntheticFigure());
  const tampered = syntheticFigure();
  tampered.text_contents = ["乙(10)", "图1"];
  const comparison = compareBackendBaseline(expected, syntheticBackend(tampered));
  assert.equal(comparison.drifts.length, 1);
  assert.equal(comparison.drifts[0]?.path, "builtin/synthetic/图1.text_contents[0]");
});

test("图元类别分布漂移即变红（少画一个矩形也要看见）", () => {
  const expected = syntheticBackend(syntheticFigure());
  const tampered = syntheticFigure();
  tampered.shape_kinds = { rect: 1, text: 2 };
  const comparison = compareBackendBaseline(expected, syntheticBackend(tampered));
  assert.equal(comparison.drifts.length, 1);
  assert.equal(comparison.drifts[0]?.path, "builtin/synthetic/图1.shape_kinds.rect");
});

test("引擎版本不同时：坐标派生量不判定（未核验），结构量仍判定", () => {
  const expected = syntheticBackend(syntheticFigure(), "16.1.0");
  const actual = syntheticBackend(
    { ...syntheticFigure(), width_mm: 999, endpoint_count: 999, segment_count: 999 },
    "17.0.0",
  );
  const comparison = compareBackendBaseline(expected, actual);
  assert.equal(comparison.engine_matched, false);
  assert.deepEqual(comparison.drifts, [], "坐标派生量在引擎版本不同时不得判漂移");
  assert.equal(comparison.unverified.length, GEOMETRY_FIELDS.length);
  assert.match(comparison.note, /未核验/u);

  // 结构量漂移仍然要红（坐标可以不判，结构必须判）。
  const drifted = syntheticBackend({ ...syntheticFigure(), refs: [10] }, "17.0.0");
  const second = compareBackendBaseline(expected, drifted);
  assert.equal(second.drifts.length, 1);
  assert.equal(second.drifts[0]?.path, "builtin/synthetic/图1.refs.length");
});

test("基线缺失时报错（不是静默通过）", async () => {
  await assert.rejects(
    () =>
      loadRenderBaseline(path.join(process.cwd(), "tests/fixtures/patent/figuregen-bench/__no-such-baseline__.json")),
    /基线缺失/u,
  );
});

test("基线不可解析时报错（结构不合法即 fail-loud）", () => {
  assert.throws(() => parseRenderBaseline("[]"), /backends\/policy/u);
  assert.throws(() => parseRenderBaseline('{"backends":{}}'), /backends\/policy/u);
  assert.throws(() => parseRenderBaseline("not json"), SyntaxError);
});

test("入库基线与当前代码一致（内置渲染器逐项相同）", async () => {
  const baseline = await loadRenderBaseline(BASELINE);
  const expected = baseline.backends.builtin;
  assert.ok(expected, "基线缺少 builtin 段");
  const actual = await collectBackendBaseline("builtin");
  const comparison = compareBackendBaseline(expected, actual);
  assert.deepEqual(
    comparison.drifts,
    [],
    `渲染不变式漂移：\n${comparison.drifts.map(line => `  - ${line.path}: ${line.expected} → ${line.actual}`).join("\n")}\n` +
      "确认变更符合预期后运行 `pnpm tsx scripts/figure-benchmark/gen-render-baseline.ts --update`，并在 PR 中说明理由。",
  );
});

test("可复算：同一输入集 + 同一代码 ⇒ 同一基线", async () => {
  const first = await collectBackendBaseline("builtin");
  const second = await collectBackendBaseline("builtin");
  assert.deepEqual(first, second);
});
