/**
 * src/patent/figuregen — 附图 sidecar 契约测试（组装 / 解析 fail-loud / 目录定位）。
 *
 * sidecar 是"生成期"与"定稿期"之间的 FigureSpec 载体：结构不合法必须报错，
 * 不能被下游当作"空附图集"静默通过。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkFigures } from "../../../src/patent/figuregen/check.js";
import {
  FIGURE_SIDECAR_VERSION,
  buildFigureSidecar,
  figureSidecarFileName,
  findFigureSidecar,
  parseFigureSidecar,
  readFigureSidecar,
} from "../../../src/patent/figuregen/sidecar.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";

const SPEC: FigureSpec = {
  figure_no: 1,
  kind: "flowchart",
  nodes: [
    { id: "a", label: "开始", shape: "ellipse" },
    { id: "b", label: "处理模块(20)", ref: 20 },
  ],
  edges: [{ from: "a", to: "b" }],
};

function build(overrides: Partial<Parameters<typeof buildFigureSidecar>[0]> = {}) {
  return buildFigureSidecar({
    outputName: "case-x",
    renderer: "builtin",
    jurisdiction: "cn",
    files: [{ figure_no: 1, path: "/tmp/out/case-x-fig1.svg" }],
    figures: [SPEC],
    check: checkFigures([SPEC], "", { skipTextRules: true }),
    skipTextRules: true,
    generatedAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  });
}

test("sidecar：文件名契约与字段形状", () => {
  assert.equal(figureSidecarFileName("case-x"), "case-x-figures.json");
  const sidecar = build();
  assert.equal(sidecar.version, FIGURE_SIDECAR_VERSION);
  assert.equal(sidecar.generated_at, "2026-09-17T00:00:00.000Z");
  // 存文件名而非绝对路径：案卷整目录搬迁后仍可用，且不把家目录写进产物
  assert.equal(sidecar.figures[0].file, "case-x-fig1.svg");
  assert.equal(sidecar.check.stage, "generation");
  assert.equal(sidecar.check.skip_text_rules, true);
  assert.deepEqual(sidecar.figures[0].spec, SPEC);
});

test("sidecar：多图按 figure_no 升序、document_kind 缺省时省略字段", () => {
  const sidecar = build({
    figures: [{ ...SPEC, figure_no: 2 }, SPEC],
    files: [
      { figure_no: 1, path: "/tmp/out/case-x-fig1.svg" },
      { figure_no: 2, path: "/tmp/out/case-x-fig2.svg" },
    ],
  });
  assert.deepEqual(
    sidecar.figures.map(f => f.figure_no),
    [1, 2],
  );
  assert.equal(sidecar.figures[1].file, "case-x-fig2.svg");
  assert.ok(!("document_kind" in sidecar), "未指定 document_kind 时不写该字段");
});

test("sidecar：解析 fail-loud——非法 JSON / 版本不符 / 缺 file / spec 无 nodes", () => {
  assert.throws(() => parseFigureSidecar("{"), /不是合法 JSON/u);
  assert.throws(() => parseFigureSidecar("[]"), /顶层应为对象/u);
  assert.throws(() => parseFigureSidecar('{"version":99,"figures":[]}'), /版本不支持/u);
  assert.throws(() => parseFigureSidecar('{"version":1}'), /缺少 figures 数组/u);
  assert.throws(() => parseFigureSidecar('{"version":1,"figures":[{"figure_no":1}]}'), /file 应为非空字符串/u);
  assert.throws(
    () => parseFigureSidecar('{"version":1,"figures":[{"figure_no":1,"file":"a.svg","spec":{}}]}'),
    /spec 应为含 nodes 数组/u,
  );
});

test("sidecar：解析回读与组装等价（无损往返）", () => {
  const sidecar = build();
  assert.deepEqual(parseFigureSidecar(JSON.stringify(sidecar)), sidecar);

  // 用回读的 spec 重跑规则与用原 spec 一致
  const specText = "处理模块(20)执行处理；另有风扇(40)。";
  assert.deepEqual(
    checkFigures(
      parseFigureSidecar(JSON.stringify(sidecar)).figures.map(f => f.spec),
      specText,
    ),
    checkFigures([SPEC], specText),
  );
});

test("sidecar：目录定位取文件名升序首个；目录/文件缺失返回 undefined", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-sidecar-"));
  try {
    assert.equal(await findFigureSidecar(dir), undefined, "空目录无 sidecar");
    assert.equal(await findFigureSidecar(join(dir, "missing")), undefined, "目录不存在不抛错");

    writeFileSync(join(dir, "b-figures.json"), JSON.stringify(build({ outputName: "b" })));
    writeFileSync(join(dir, "a-figures.json"), JSON.stringify(build({ outputName: "a" })));
    const found = await findFigureSidecar(dir);
    assert.equal(found, join(dir, "a-figures.json"), "按文件名升序取首个（确定性）");
    assert.equal((await readFigureSidecar(found!))?.output_name, "a");
    assert.equal(await readFigureSidecar(join(dir, "none.json")), undefined);

    // 子目录不参与定位（只扫一层）
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "c-figures.json"), JSON.stringify(build()));
    assert.equal(await findFigureSidecar(dir), join(dir, "a-figures.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
