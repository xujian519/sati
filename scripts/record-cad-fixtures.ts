/**
 * scripts/record-cad-fixtures.ts — 重录 `tests/fixtures/patent/cad/` 的投影边表。
 *
 * 为什么要有这个脚本：投影边表是**真实 FreeCAD 输出**的快照，单测不真跑 FreeCAD
 * （2.6GB 应用 + 平台差异）。边表契约升版本或加字段后必须重录，重录要能复现
 * ——否则 fixture 就成了一堆来历不明的数字。故试件几何也写在本脚本里（确定性建模）：
 * 40×30×10 平板 + 沿 Z 的半圆槽（半径 2，圆心落在 (2, 0)），与入库 fixture 同源。
 *
 * 用法（需本机 FreeCAD；`SATI_FREECAD_CMD` 可指定路径）：
 *
 *   npx tsx scripts/record-cad-fixtures.ts          # 重录并对照既有 fixture 报告差异
 *
 * 重录后必须跑 `pnpm test`（几何断言以 fixture 为准），并目视确认差异只有
 * 版本号与新增字段——几何点列变了就说明试件或投影链路被改动过。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  defaultCadRunner,
  projectStep,
  resolveFreecadCmd,
  type CadEdgeTable,
  type CadView,
} from "../src/patent/figuregen/cad/index.js";

/** fixture 目录（相对仓库根）。 */
export const CAD_FIXTURE_DIR = "tests/fixtures/patent/cad";

/** 试件建模脚本（FreeCAD 无头；确定性：固定尺寸、无时钟/随机）。 */
export const PLATE_STEP_SCRIPT = (stepOut: string): string =>
  [
    "# 由 scripts/record-cad-fixtures.ts 生成——录制用试件，不随产品分发。",
    "import FreeCAD as App",
    "import Part",
    "",
    `STEP_OUT = ${JSON.stringify(stepOut)}`,
    "plate = Part.makeBox(40, 30, 10)",
    "# 半圆槽：圆柱轴过 (2, 0)、半径 2 ⇒ 与平板近侧面相切，正面视图得到两条切线（X=0 / X=4）",
    "groove = Part.makeCylinder(2, 10, App.Vector(2, 0, 0), App.Vector(0, 0, 1))",
    "part = plate.cut(groove)",
    "part.exportStep(STEP_OUT)",
  ].join("\n");

/** 待录制的视图（file 相对 `CAD_FIXTURE_DIR`）。 */
export const CAD_FIXTURES: readonly { file: string; view: CadView; sectionOffsetMm?: number }[] = [
  { file: "plate-front.json", view: "front" },
  { file: "plate-iso.json", view: "iso" },
  // 全剖视图：水平剖切面 Z=5（保留 Z ≤ 5），俯视 ⇒ 剖切面 = 平板轮廓减去半圆槽
  { file: "plate-section-top.json", view: "top", sectionOffsetMm: 5 },
];

/** 对照两份边表，返回差异描述（几何点列或结构不同即报出）。 */
export function diffEdgeTables(previous: CadEdgeTable, next: CadEdgeTable): string[] {
  const diffs: string[] = [];
  if (previous.version !== next.version) diffs.push(`version: ${previous.version} → ${next.version}`);
  if (previous.edges.length !== next.edges.length) {
    diffs.push(`边数: ${previous.edges.length} → ${next.edges.length}`);
  }
  const count = Math.min(previous.edges.length, next.edges.length);
  for (let index = 0; index < count; index += 1) {
    const before = previous.edges[index]!;
    const after = next.edges[index]!;
    if (before.kind !== after.kind || before.curve !== after.curve) {
      diffs.push(`edges[${index}] 类型变化: ${before.kind}/${before.curve} → ${after.kind}/${after.curve}`);
      continue;
    }
    if (JSON.stringify(before.points) !== JSON.stringify(after.points)) {
      diffs.push(`edges[${index}] 点列变化（${before.curve}，${before.points.length} → ${after.points.length} 点）`);
    }
  }
  if (JSON.stringify(previous.axes.x) !== JSON.stringify(next.axes.x)) {
    diffs.push(`axes.x: ${JSON.stringify(previous.axes.x)} → ${JSON.stringify(next.axes.x)}`);
  }
  if (JSON.stringify(previous.axes.y) !== JSON.stringify(next.axes.y)) {
    diffs.push(`axes.y: ${JSON.stringify(previous.axes.y)} → ${JSON.stringify(next.axes.y)}`);
  }
  if (JSON.stringify(previous.axes.z) !== JSON.stringify(next.axes.z)) {
    diffs.push(`axes.z: ${JSON.stringify(previous.axes.z)} → ${JSON.stringify(next.axes.z)}`);
  }
  const beforeFaces = JSON.stringify(previous.cutFaces ?? null);
  const afterFaces = JSON.stringify(next.cutFaces ?? null);
  if (beforeFaces !== afterFaces) {
    diffs.push(
      `剖切面：${previous.cutFaces?.length ?? 0} → ${next.cutFaces?.length ?? 0} 个` +
        (previous.cutFaces?.length === next.cutFaces?.length ? "（轮廓点列有变化）" : ""),
    );
  }
  return diffs;
}

export type RecordResult = { file: string; table: CadEdgeTable; diffs: string[] };

/** 重录全部 fixture（返回逐项结果，供 CLI 打印与单测断言）。 */
export async function recordCadFixtures(options: { fixtureDir?: string; cmd?: string } = {}): Promise<RecordResult[]> {
  const fixtureDir = options.fixtureDir ?? resolve(process.cwd(), CAD_FIXTURE_DIR);
  const probe = options.cmd ?? resolveFreecadCmd()?.cmd;
  if (probe === undefined || (options.cmd !== undefined && !existsSync(options.cmd))) {
    throw new Error("未找到 freecadcmd：请安装 FreeCAD 或设置 SATI_FREECAD_CMD（本脚本必须真跑 FreeCAD 重录）");
  }
  const dir = await mkdtemp(join(tmpdir(), "sati-cad-record-"));
  const results: RecordResult[] = [];
  try {
    const stepPath = join(dir, "plate.step");
    const scriptPath = join(dir, "build_plate.py");
    await writeFile(scriptPath, PLATE_STEP_SCRIPT(stepPath), "utf8");
    const built = await defaultCadRunner(probe, [scriptPath], { timeoutMs: 60_000 });
    if (built.code !== 0 || !existsSync(stepPath)) {
      const detail = (built.stderr.trim() || built.stdout.trim()).split("\n").slice(-6).join(" | ");
      throw new Error(`试件 STEP 生成失败（退出码 ${String(built.code)}）：${detail}`);
    }
    for (const fixture of CAD_FIXTURES) {
      const table = await projectStep({
        cmd: probe,
        stepPath,
        view: fixture.view,
        ...(fixture.sectionOffsetMm === undefined ? {} : { sectionOffsetMm: fixture.sectionOffsetMm }),
      });
      const path = join(fixtureDir, fixture.file);
      let previous: CadEdgeTable | undefined;
      try {
        previous = JSON.parse(await readFile(path, "utf8")) as CadEdgeTable;
      } catch {
        previous = undefined;
      }
      await writeFile(path, `${JSON.stringify(table, null, 2)}\n`, "utf8");
      results.push({
        file: fixture.file,
        table,
        diffs: previous === undefined ? ["（新 fixture）"] : diffEdgeTables(previous, table),
      });
    }
    return results;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const results = await recordCadFixtures();
  for (const result of results) {
    const { table } = result;
    const summary =
      `可见 ${table.edges.filter(edge => edge.kind === "visible").length} / ` +
      `隐藏 ${table.edges.filter(edge => edge.kind === "hidden").length} 边` +
      (table.cutFaces === undefined ? "" : `，剖切面 ${table.cutFaces.length} 个`);
    console.log(`\n${result.file}（${table.view}，${summary}）`);
    console.log(`  差异：${result.diffs.length === 0 ? "无（几何逐点一致）" : result.diffs.join("；")}`);
  }
  console.log("\n重录完成：请跑 `pnpm test` 校验几何断言。");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
