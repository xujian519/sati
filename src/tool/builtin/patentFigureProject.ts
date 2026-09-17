/**
 * patent_figure_project — 由已有 3D 源（STEP）无头投影出专利附图（黑白 SVG）。
 *
 * 定位（方案 P2 阶段一）：**已有 STEP/3D 源 → 直接投影**。价值最高、风险最低（实测
 * 导入 + 投影各数毫秒），且交付契约与本模块其它附图完全一致（黑白线条 + 图号标注 +
 * A4 可印区适配 + sidecar 留痕）。阶段二（由模型产几何 DSL）不做——模型直接产三维
 * 几何的可靠性不足。
 *
 * 边界（诚实声明）：
 * - **不产几何**：只投影已有 STEP，不做建模；
 * - **不标注附图标记**：标记的图面位置需要坐标系统，属后续能力；本工具只保证投影图
 *   本身合规（黑白、可印、线条可辨），`spec.nodes` 为空骨架；
 * - **不做剖面线**：剖视图需切平面 + 确定性剖面线绘制（指南 4.3 要求不妨碍标记线）；
 * - 依赖本机 FreeCAD（`SATI_FREECAD_CMD` 或探测安装路径）：缺失即 fail-closed，
 * 不静默回退内置渲染器。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  CAD_VIEWS,
  buildFigureSidecar,
  checkCadProjection,
  figureSidecarFileName,
  isCadView,
  projectStep,
  renderCadSvg,
  resolveFreecadCmd,
  type CadRunner,
  type CadView,
  type DocumentKind,
  type FigureSpec,
  type Jurisdiction,
} from "../../patent/figuregen/index.js";
import { caseOutputsDir } from "../../patent/paths.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../protocol/types.js";

export type PatentFigureProjectInput = {
  step_path: string;
  output_name: string;
  view: string;
  figure_no?: number;
  hidden_lines?: boolean;
  case_id?: string;
  output_dir?: string;
  jurisdiction?: string;
  document_kind?: string;
  tolerance_mm?: number;
};

export type CreatePatentFigureProjectToolOptions = {
  /** 注入的进程运行器（单测不真跑 FreeCAD）。 */
  runner?: CadRunner;
  /** 注入的 freecadcmd 路径（缺省走能力探测）。 */
  freecadCmd?: string;
};

export function createPatentFigureProjectTool(
  options: CreatePatentFigureProjectToolOptions = {},
): SatiToolDefinition<PatentFigureProjectInput> {
  return {
    name: "patent_figure_project",
    outputSchema: { type: "object", properties: {} },
    aliases: ["PatentFigureProject", "figure_project"],
    title: "Project 3D Model to Patent Figure",
    description:
      "Project an existing STEP/3D model into a patent-style figure (deterministic black-and-white SVG, " +
      "hidden-line removal, millimetre-accurate orthographic projection) using a headless FreeCAD on this " +
      "machine. Views: front/back/left/right/top/bottom/iso. The SVG is produced by this project's own " +
      "drawing contract (fits the A4 printable area, carries the 图N caption) and a sidecar records the " +
      "projection parameters. Boundaries: it does not create geometry, does not place reference numerals " +
      "(the figure is an unannotated projection) and does not draw section hatching. Requires a local " +
      "FreeCAD install (SATI_FREECAD_CMD or the standard app path); missing install fails closed.",
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["step_path", "output_name", "view"],
      properties: {
        step_path: { type: "string", description: "STEP 文件路径（工作区相对或绝对）" },
        output_name: { type: "string", description: "输出文件名主干（生成 <name>-fig<N>.svg 与 <name>-figures.json）" },
        view: { type: "string", enum: [...CAD_VIEWS], description: "投影方向（正投影；iso 为轴测图）" },
        figure_no: { type: "number", description: "图号（默认 1，用于图号标注与 sidecar）" },
        hidden_lines: {
          type: "boolean",
          description: "是否绘制隐藏线（默认 false：CNIPA 实务以剖视图表达内部结构，虚线易与标记线混淆）",
        },
        case_id: { type: "string", description: "案卷 id；提供时落盘 data/cases/<caseId>/outputs/" },
        output_dir: { type: "string", description: "显式输出目录（覆盖默认 .sati/figures/ 与 case_id）" },
        jurisdiction: { type: "string", enum: ["cn", "us"], description: "辖区（默认 cn）：us 图号标注为 FIG. N" },
        document_kind: {
          type: "string",
          enum: ["invention", "utility"],
          description: "发明/实用新型（写入 sidecar，供附图门判定 V9）",
        },
        tolerance_mm: { type: "number", description: "投影离散化容差（毫米，默认 0.5；越小越平滑、边表越大）" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    async execute(input, context: SatiToolRuntimeContext) {
      if (!isCadView(input.view)) {
        throw new SatiToolRuntimeError(
          "invalid_tool_input",
          `非法 view "${input.view}"（可用: ${CAD_VIEWS.join(", ")}）`,
          { tool: "patent_figure_project" },
        );
      }
      const view: CadView = input.view;
      if (!/^[A-Za-z0-9._\-\u4e00-\u9fa5]{1,100}$/u.test(input.output_name)) {
        throw new SatiToolRuntimeError("invalid_tool_input", `非法 output_name: ${JSON.stringify(input.output_name)}`, {
          tool: "patent_figure_project",
        });
      }
      const figureNo =
        Number.isInteger(input.figure_no) && (input.figure_no ?? 0) > 0 ? (input.figure_no as number) : 1;
      const jurisdiction: Jurisdiction = input.jurisdiction === "us" ? "us" : "cn";
      const documentKind: DocumentKind | undefined =
        input.document_kind === "utility" ? "utility" : input.document_kind === "invention" ? "invention" : undefined;
      const hiddenLines = input.hidden_lines === true;

      const stepPath = isAbsolute(input.step_path) ? input.step_path : resolve(context.cwd, input.step_path);
      const outputDir =
        input.output_dir !== undefined
          ? isAbsolute(input.output_dir)
            ? input.output_dir
            : resolve(context.cwd, input.output_dir)
          : input.case_id !== undefined
            ? resolve(context.cwd, caseOutputsDir(input.case_id))
            : resolve(context.cwd, ".sati", "figures");

      // 能力探测 fail-closed：无 FreeCAD 不静默回退（CAD 图只能由几何投影得到）。
      let cmd = options.freecadCmd;
      let cmdSource = options.freecadCmd === undefined ? "" : "注入路径";
      if (cmd === undefined) {
        const probe = resolveFreecadCmd();
        if (probe === undefined) {
          throw new SatiToolRuntimeError(
            "tool_execution_failed",
            "未找到 FreeCAD 无头命令 freecadcmd：请安装 FreeCAD，或用 SATI_FREECAD_CMD 指定其路径" +
              "（本工具不静默回退其它渲染器——CAD 图只能由几何投影得到）",
            { tool: "patent_figure_project" },
          );
        }
        cmd = probe.cmd;
        cmdSource = probe.source;
      }

      try {
        const table = await projectStep({
          cmd,
          stepPath,
          view,
          ...(input.tolerance_mm === undefined ? {} : { toleranceMm: input.tolerance_mm }),
          ...(options.runner === undefined ? {} : { runner: options.runner }),
        });
        // 几何级检查分两步：C1（边数）先于出图 → fail-closed；C2/C3 依赖适配缩放 → 渲染后。
        const edgeFindings = checkCadProjection({ table, hiddenLines });
        const blocker = edgeFindings.find(finding => finding.severity === "fail");
        if (blocker !== undefined) {
          throw new SatiToolRuntimeError("tool_execution_failed", `投影结果不可交付：${blocker.message}`, {
            tool: "patent_figure_project",
            view,
          });
        }
        const render = renderCadSvg(table, {
          figureNo,
          jurisdiction,
          hiddenLines,
        });
        const findings = [
          ...edgeFindings,
          ...checkCadProjection({ table, render, hiddenLines }).filter(finding => finding.rule !== "C1"),
        ];

        await mkdir(outputDir, { recursive: true });
        const svgPath = resolve(outputDir, `${input.output_name}-fig${figureNo}.svg`);
        await writeFile(svgPath, render.svg, "utf8");

        // 图号 + 空骨架 spec（CAD 图的画幅由投影几何决定，不由本模块布局决定）
        const skeleton: FigureSpec = { figure_no: figureNo, kind: "block", nodes: [], edges: [] };
        const sidecarPath = resolve(outputDir, figureSidecarFileName(input.output_name));
        await writeFile(
          sidecarPath,
          `${JSON.stringify(
            buildFigureSidecar({
              outputName: input.output_name,
              renderer: "cad",
              jurisdiction,
              documentKind,
              files: [
                {
                  figure_no: figureNo,
                  path: svgPath,
                  geometry: {
                    source: "cad",
                    view,
                    scale: render.scale,
                    width_mm: render.widthMm,
                    height_mm: render.heightMm,
                    hidden_lines: hiddenLines,
                    findings,
                  },
                },
              ],
              figures: [skeleton],
              check: { ok: true, findings: [], refsInFigures: [], refsInText: [] },
              // 文本侧规则在投影期不适用（无说明书文本），核验由附图门在定稿期跑
              skipTextRules: true,
            }),
            null,
            2,
          )}\n`,
          "utf8",
        );

        const lines: string[] = [
          `已投影 ${view} 视图（FreeCAD 无头，命令来源: ${cmdSource}）：`,
          `- 图${figureNo}: ${svgPath}`,
          `- 几何范围 ${table.edges.length} 条投影边（可见 ${render.visibleEdges} / 隐藏 ${render.hiddenEdges}）`,
          `- 纸面尺寸 ${render.widthMm.toFixed(1)}×${render.heightMm.toFixed(1)}mm（适配缩放 ${(render.scale * 100).toFixed(0)}%，A4 可印区 170×257mm 内）`,
          `- 附图 sidecar: ${sidecarPath}`,
          "",
          "几何级检查：",
          ...findings.map(
            finding =>
              `- [${finding.severity.toUpperCase()}] ${finding.rule}: ${finding.message}` +
              (finding.evidence ? `\n  ${finding.evidence.join("\n  ")}` : ""),
          ),
          "",
          "说明：本图为**未标注**的投影图（附图标记需人工/后续能力标注）；不产几何、不绘剖视图剖面线。",
        ];

        return {
          content: [
            { type: "text", text: lines.join("\n") },
            {
              type: "file" as const,
              path: svgPath,
              mimeType: "image/svg+xml",
              description: `CAD 投影图 图${figureNo}`,
            },
            {
              type: "file" as const,
              path: sidecarPath,
              mimeType: "application/json",
              description: "CAD figure sidecar",
            },
          ],
        };
      } catch (err) {
        if (err instanceof SatiToolRuntimeError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new SatiToolRuntimeError("tool_execution_failed", `patent_figure_project 执行失败: ${message}`, {
          tool: "patent_figure_project",
          view,
        });
      }
    },
  };
}
