/**
 * src/patent/figuregen/cad — 结构图 **manifest**（视图 → 文件 → 几何事实 / 件号归属）。
 *
 * 用途：多视图一次产出后，落一份可查的清单，回答三个问题：
 * 1. 这次出了哪几个视图、每个视图的文件名是什么；
 * 2. 模型里有几个零件、每个零件的几何事实（包围盒 / 质心 / 面积 / 体积）是什么；
 * 3. **件号 ↔ 零件 ↔ 锚点**的对应是什么（件号落在哪个零件、锚点坐标是多少）。
 *
 * **与 DSH 的对应关系**：DSH 的 `freecad-structure-script.ts` 同样落一份
 * `manifest.json`（`StructureManifest`：`modelPaths` 顺序即件号归属口径、`views[].anchors`
 * 记件号锚点、`views[].parts` 记逐零件投影占位）。本模块与它同构，差异是：
 * - DSH 的 manifest 由 **FreeCAD 脚本**直接写出；本模块由 **Sati 侧**装配（零件事实与
 *   锚点归属都在 TS 侧判定，写在一起才不会与图面脱节）；
 * - DSH 的件号归属由调用方用 `model` 下标显式声明；本仓零入参变更 ⇒ 归属由几何判定，
 *   并把判定结果（`partIndex`）显式写进 manifest，下游不必猜。
 *
 * **为什么单独成模块**：manifest 的装配与落盘是**产物装配**（不是几何、不是渲染），
 * 放在 cad/ 下让工具层只留"env 解析与调用"；同时 manifest 是 JSON 契约，
 * 字段一改就是产物格式变更，必须有独立的版本号与集中定义。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CadCalloutBinding, CadCalloutSource } from "./anchors.js";
import type { CadPartFact, CadView } from "./types.js";

/** manifest 契约版本（字段变更须升版本）。 */
export const CAD_MANIFEST_VERSION = 1;

/** manifest 中的零件条目。 */
export type CadManifestPart = {
  /** 零件序号（件号归属口径：STEP 中 solid 的出现顺序）。 */
  index: number;
  /** 包围盒（模型坐标，毫米）。 */
  bbox: { min: [number, number, number]; max: [number, number, number] };
  /** 质心（模型坐标，毫米）。 */
  centroid: [number, number, number];
  /** 表面积（平方毫米）。 */
  area: number;
  /** 体积（立方毫米）。 */
  volume: number;
};

/** manifest 中的件号条目（件号 → 零件序号 → 锚点坐标）。 */
export type CadManifestCallout = {
  /** 件号（附图标记号）。 */
  ref: number;
  /** 归属零件下标；null = 不落在任何零件上（C14）。 */
  partIndex: number | null;
  /** 锚点（模型坐标，毫米）。 */
  anchorMm: [number, number, number];
  /** 锚点来源：调用方显式给出 / 按零件顺序自动选取。 */
  source: CadCalloutSource;
};

/** manifest 中的视图条目。 */
export type CadManifestView = {
  /** 视图名。 */
  name: CadView;
  /** 视图顺序（0 起；主视图为 0）。 */
  order: number;
  /** SVG 文件名（相对 manifest 所在目录）。 */
  file: string;
  /** 该视图的图面几何事实（纸面毫米）。 */
  geometry: {
    scale: number;
    width_mm: number;
    height_mm: number;
    visible_edges: number;
    hidden_edges: number;
    cut_faces: number;
    hatch_segments: number;
  };
  /** 该视图的件号 → 零件 → 锚点对应。 */
  callouts: CadManifestCallout[];
};

/** 结构图 manifest（产物契约）。 */
export type CadStructureManifest = {
  version: number;
  /** 图号。 */
  figureNo: number;
  /** 模型路径（顺序即零件口径的来源；本仓单模型，故只有一个）。 */
  stepPath: string;
  /** 零件事实（顺序即件号归属口径）。 */
  parts: CadManifestPart[];
  /** 逐视图条目（顺序即输出顺序）。 */
  views: CadManifestView[];
};

/** manifest 装配入参。 */
export type BuildCadManifestInput = {
  figureNo: number;
  stepPath: string;
  parts: readonly CadPartFact[];
  views: readonly {
    view: CadView;
    file: string;
    geometry: CadManifestView["geometry"];
    bindings: readonly CadCalloutBinding[];
  }[];
};

/** 装配 manifest（纯函数；不落盘）。 */
export function buildCadStructureManifest(input: BuildCadManifestInput): CadStructureManifest {
  return {
    version: CAD_MANIFEST_VERSION,
    figureNo: input.figureNo,
    stepPath: input.stepPath,
    parts: input.parts.map(part => ({
      index: part.index,
      bbox: { min: [...part.bbox.min], max: [...part.bbox.max] },
      centroid: [...part.centroid],
      area: part.area,
      volume: part.volume,
    })),
    views: input.views.map((view, order) => ({
      name: view.view,
      order,
      file: view.file,
      geometry: view.geometry,
      callouts: view.bindings.map(binding => ({
        ref: binding.ref,
        partIndex: binding.partIndex,
        anchorMm: [...binding.anchorMm],
        source: binding.source,
      })),
    })),
  };
}

/** manifest 文件名（与 SVG 同基名，便于人工对照）。 */
export function cadManifestFileName(outputName: string, figureNo: number): string {
  return `${outputName}-fig${figureNo}-manifest.json`;
}

/**
 * 落盘 manifest（返回绝对路径）。
 *
 * 单独成函数（而不是并进 sidecar）：manifest 是**多视图**的产物，而 sidecar 契约是
 * "一幅图一个文件条目"（`figures[].figure_no` 唯一）⇒ 多视图时 sidecar 记主视图、
 * manifest 记全部视图，两者互补而不冲突。
 */
export async function writeCadStructureManifest(args: {
  outputDir: string;
  outputName: string;
  figureNo: number;
  manifest: CadStructureManifest;
}): Promise<string> {
  await mkdir(args.outputDir, { recursive: true });
  const path = join(args.outputDir, cadManifestFileName(args.outputName, args.figureNo));
  await writeFile(path, `${JSON.stringify(args.manifest, null, 2)}\n`, "utf8");
  return path;
}
