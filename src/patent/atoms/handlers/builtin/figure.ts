/**
 * 附图域门原子：figure-gate —— 把"附图是否合规"从"主代理是否记得核验"接成工作流门禁。
 *
 * 动机：核验能力（checkFigures，V1/V2/V3/V4/V5/V7/V8/V9）此前只被两个工具按需调用，
 * 而工作流阶段是透传的 ⇒ 核验实际从未被自动执行。本门把同一套确定性规则接到
 * `figure_generate` 阶段上。
 *
 * 输入契约：生成期落盘的 sidecar（`<name>-figures.json`，含**完整 FigureSpec**，见
 * `figuregen/sidecar.ts`）+ 说明书文本（`state.claims_draft` / `state.spec_draft`）。
 * 目录三级回退：`state.figure_dir` → 案卷 outputs → `.sati/figures`（各带原因串；
 * 三级皆无 sidecar → degraded 并说明已探查的位置，不假装"已核验"）。
 *
 * 判定：
 * - **fail 级** → `InterruptStageError` 挂 HITL（编号选择：1=确认放行 / 2=重新生成附图 /
 *   3=退回）；已批准时经 `APPROVAL_GRANTED_KEY` 强制放行并在报告标注"人工强制放行"
 *   （语义与 clarity-gate 同构，放行标记只存在于 handler 局部执行态，见 gate.ts）。
 * - **warn 级** → 报告透传，不阻断撰写。
 * - **sidecar 与 SVG 漂移**（图被手工改写/移动，或 sidecar 被改坏）→ fail-loud 挂 HITL：
 *   漂移下"核验通过"不成立，宁可中断也不给出假保证。
 *
 * 留痕：同目录 `figure-check.json`（v1：`version` / `checked_at` / `inputs_hash` / `result`），
 * `inputs_hash` 为 spec 与文本的内容哈希，供审计"这份结论是否仍对应当前输入"。
 *
 * 说明：
 * - 不声明 retry：本阶段的"修复"发生在主代理的附图生成（工具）侧，回退一个透传阶段
 *   不会改变产出——有界重试只对能被重跑的阶段有意义。
 * - 目录解析用 `process.cwd()`（StageHandler 契约无 cwd 注入），与
 *   `patent_figure_generate` 的 `context.cwd` 在服务进程内同源。
 */

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { type Atom } from "../../atom.js";
import {
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  InterruptStageError,
  getStateString,
} from "../../handler.js";
import {
  assertSafeSvg,
  checkFigures,
  findFigureSidecar,
  officeForJurisdiction,
  parseFigureSvg,
  readFigureSidecar,
  type DocumentKind,
  type FigureCheckResult,
  type FigureSidecar,
  type FigureSidecarGeometry,
  type FigureSpec,
  type Jurisdiction,
  type TargetOffice,
} from "../../../figuregen/index.js";
import { analyzeImageBuffer, type PixelFinding, type PixelMetrics } from "../../../figuregen/pixel-gate.js";
import { caseOutputsDir } from "../../../paths.js";
import { APPROVAL_GRANTED_KEY } from "./gate.js";
import { degraded } from "./llm.js";

/** `figure-check.json` 契约版本。 */
export const FIGURE_CHECK_REPORT_VERSION = 1;

export const figureGateAtom: Atom = {
  name: "figure-gate",
  // 描述语义契约：只声明"审什么"，不出现阈值数字（判据是核验器内部实现，
  // HITL 报告面保留——对齐隐藏清单纪律，防止为凑阈值而非改善附图）。
  description: "附图确定性门槛：图号连续性、图文附图标记双向一致、画幅可印性（含打印字高可辨性），fail 级挂 HITL 决策",
  category: "gate",
  inputSchema: ["figure_dir", "claims_draft", "spec_draft"],
  outputSchema: ["figure_report"],
};

/** 附图目录候选（带原因串，供报告与降级说明）。 */
export type FigureDirCandidate = { dir: string; reason: string };

/** 目录三级回退（顺序即优先级）。 */
export function figureDirCandidates(state: PipelineState, cwd: string = process.cwd()): FigureDirCandidate[] {
  const candidates: FigureDirCandidate[] = [];
  const explicit = getStateString(state, "figure_dir");
  if (explicit.trim().length > 0) {
    candidates.push({
      dir: isAbsolute(explicit) ? explicit : resolve(cwd, explicit),
      reason: "state.figure_dir",
    });
  }
  const caseId = getStateString(state, "caseId");
  if (caseId.trim().length > 0) {
    candidates.push({ dir: resolve(cwd, caseOutputsDir(caseId)), reason: `案卷 outputs（caseId=${caseId}）` });
  }
  candidates.push({ dir: resolve(cwd, ".sati", "figures"), reason: ".sati/figures（工具默认输出目录）" });
  return candidates;
}

type LocatedInputs = {
  dir: string;
  source: string;
  sidecar: FigureSidecar;
  sidecarPath: string;
};

/** 定位 sidecar：按候选顺序取首个命中（各候选无 sidecar 则继续）。 */
async function locateInputs(
  state: PipelineState,
  cwd: string,
): Promise<LocatedInputs | { missing: FigureDirCandidate[] }> {
  const candidates = figureDirCandidates(state, cwd);
  const missing: FigureDirCandidate[] = [];
  for (const candidate of candidates) {
    const sidecarPath = await findFigureSidecar(candidate.dir);
    if (sidecarPath === undefined) {
      missing.push(candidate);
      continue;
    }
    const sidecar = await readFigureSidecar(sidecarPath);
    if (sidecar === undefined) {
      missing.push(candidate);
      continue;
    }
    return { dir: candidate.dir, source: candidate.reason, sidecar, sidecarPath };
  }
  return { missing };
}

/**
 * 回读自检：sidecar 声明的图必须与其 SVG 的图号 / data-ref 集合一致（漂移 fail-loud）。
 *
 * 顺带产出**图号观测**（哪些图带可见图号）：V15/V16 的判据是交付文件的可见形态，而图号
 * 条件化后"应当有"与"实际有"是两件事——回读同一批文件得到观测，避免再读一遍盘。
 */
export async function detectFigureDrift(inputs: LocatedInputs): Promise<{
  drifts: string[];
  numberedFigureNos: number[];
}> {
  const drifts: string[] = [];
  const numberedFigureNos: number[] = [];
  for (const figure of inputs.sidecar.figures) {
    const path = join(inputs.dir, figure.file);
    let svg: string;
    try {
      svg = await readFile(path, "utf8");
    } catch {
      // sidecar 声明的附图文件读不到（已被删除/移动或不可读）→ 记一条 drift 并跳到下一张；汇总之 drifts 非空会让调用方抛 InterruptStageError（high guardrail，人工决策放行/重生成/退回）。
      drifts.push(`图${figure.figure_no}: sidecar 声明的附图文件不存在（${figure.file}）`);
      continue;
    }
    // 跨信任边界读盘：sidecar 声明的 SVG 可能已被人工改写（漂移检测本就是为这一场景存在），
    // 故先过安全门；被拒时记一条 drift（核验结论在"文件不可信"时不成立）。
    try {
      assertSafeSvg(svg);
    } catch (err) {
      drifts.push(
        `图${figure.figure_no}: 附图 SVG 未通过安全检查（${err instanceof Error ? err.message : String(err)}）` +
          "——跨信任边界读取已拒绝",
      );
      continue;
    }
    let parsed;
    try {
      parsed = parseFigureSvg(svg);
    } catch (err) {
      drifts.push(
        `图${figure.figure_no}: 附图无法回读（${err instanceof Error ? err.message : String(err)}）——` +
          "非本工具产出或被改写",
      );
      continue;
    }
    if (parsed.figureNo !== figure.spec.figure_no) {
      drifts.push(`图${figure.figure_no}: 图内图号标注为 ${parsed.figureNo}，与 sidecar 不一致`);
    }
    // 图号的**可见形态**优先以回读为准（V15/V16 判的就是可见形态）；但产物若已做文本
    // 转路径（文字变轮廓），回读不到 `<text>图N</text>` 不等于图号不存在——那时以生成期
    // sidecar 记录的 caption 为准。**未转路径时绝不回落**：那种情况下"回读不到"正是图号
    // 被删的漂移信号，回落会把它蒙掉。
    if (parsed.numbered || (inputs.sidecar.text_to_path === true && figure.caption !== undefined)) {
      numberedFigureNos.push(figure.spec.figure_no);
    }
    const expected = figure.spec.nodes
      .filter(node => node.ref !== undefined)
      .map(node => `${node.id}:${node.ref}`)
      .sort();
    const actual = parsed.nodes
      .filter(node => node.ref !== undefined)
      .map(node => `${node.id}:${node.ref}`)
      .sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      drifts.push(
        `图${figure.figure_no}: 文件内标记与 sidecar 的 FigureSpec 不一致（sidecar [${expected.join(", ")}]` +
          `，文件 [${actual.join(", ")}]）`,
      );
    }
  }
  return { drifts, numberedFigureNos };
}

/** 栅格附图扩展名（`pixel-gate` 经 sharp 解码的格式）。 */
const RASTER_FIGURE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "webp", "gif", "tif", "tiff"];

/**
 * 本案的栅格附图附件：与 SVG 同目录、同命名体例 `<output_name>-fig<N>.<ext>`。
 *
 * 按命名体例发现而非"目录下全部图片"：案卷目录里常有与本案无关的图片（客户对比材料、
 * 其他案卷的扫描件），卷进本门禁会制造误报与错误的阻断。
 */
export function rasterAttachmentNames(entries: readonly string[], outputName: string): string[] {
  const escaped = outputName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`^${escaped}-fig\\d+\\.(?:${RASTER_FIGURE_EXTENSIONS.join("|")})$`, "iu");
  return entries.filter(name => pattern.test(name)).sort((a, b) => a.localeCompare(b));
}

/** 单张栅格附图的像素门禁结果；解码失败时**不静默**，记下该图少了哪类核验。 */
export type RasterGateEntry =
  | { name: string; digest: string; measured: true; metrics: PixelMetrics; findings: PixelFinding[] }
  | { name: string; digest: string; measured: false; error: string };

/** 栅格附件整体观测：`none` = 本案无栅格附件（PX 不适用），不是"跳过了核验"。 */
export type RasterGateObservation = { status: "none" } | { status: "ran"; entries: readonly RasterGateEntry[] };

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * 对目录内的栅格附图附件跑像素门禁（黑白性 / 线宽 / DPI / 图号声明）。
 *
 * 为什么接进门禁而不是只留给 `patent_figure_check`：本门是交付前最后一道自动门，而 PX1
 * 这类 fail 级缺陷（大面积中间灰 = 灰度/着色渲染）此前只在按需调用的核验报告里出现、
 * 从不参与阻断 —— 与"核验接成门禁"的设计意图相悖。
 *
 * 解码不可用（sharp 未安装 / 格式不支持）时**逐图记录失败原因**而不抛错：本地缺解码器
 * 不是申请人的过错，不该阻断交付；但必须说清"这几张图因此少了哪类核验"。
 */
export async function runRasterGate(input: {
  dir: string;
  outputName: string;
  office: TargetOffice;
}): Promise<RasterGateObservation> {
  let entries: string[];
  try {
    entries = await readdir(input.dir);
  } catch {
    return { status: "none" };
  }
  const names = rasterAttachmentNames(entries, input.outputName);
  if (names.length === 0) return { status: "none" };

  const results: RasterGateEntry[] = [];
  for (const name of names) {
    try {
      const buffer = await readFile(join(input.dir, name));
      const digest = sha256Hex(buffer);
      const { metrics, findings } = await analyzeImageBuffer(buffer, { name, office: input.office });
      results.push({ name, digest, measured: true, metrics, findings });
    } catch (err) {
      results.push({
        name,
        digest: "",
        measured: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { status: "ran", entries: results };
}

/** 栅格附件的 fail 级发现数（参与本门的 fail 判定）。 */
export function rasterFailCount(observation: RasterGateObservation): number {
  if (observation.status === "none") return 0;
  return observation.entries.reduce(
    (total, entry) => total + (entry.measured ? entry.findings.filter(f => f.severity === "fail").length : 0),
    0,
  );
}

/**
 * 输入内容哈希：spec 集合 + 说明书文本 + 辖区/文种（结论与输入的对应关系可审计）。
 *
 * `raster` 为本案栅格附图附件的内容哈希：**无栅格附件时不并入载荷**，使纯矢量案件的
 * 哈希值与既有契约逐字节一致；有附件时并入，因为此时 PX 级结论也由这些字节决定。
 */
export function figureInputsHash(input: {
  specs: readonly FigureSpec[];
  specText: string;
  documentKind?: DocumentKind;
  jurisdiction: Jurisdiction;
  raster?: readonly { name: string; digest: string }[];
}): string {
  const raster = (input.raster ?? []).filter(entry => entry.digest.length > 0);
  return createHash("sha256")
    .update(
      JSON.stringify({
        specs: input.specs,
        spec_text: input.specText,
        document_kind: input.documentKind ?? null,
        jurisdiction: input.jurisdiction,
        ...(raster.length === 0 ? {} : { raster }),
      }),
    )
    .digest("hex");
}

/** 栅格附件的报告段（无附件时一行说明；有附件时逐张列指标与发现）。 */
function rasterSection(raster: RasterGateObservation): string[] {
  if (raster.status === "none") {
    return ["", "- 栅格附件: 无（未附栅格图，PX 黑白性/线宽/DPI 判据不适用）"];
  }
  const lines = ["", "栅格附图像素级核验（不做 OCR：图号须由文件名声明）："];
  for (const entry of raster.entries) {
    if (!entry.measured) {
      lines.push(
        `- ${entry.name}: 未执行像素核验 —— ${entry.error}` +
          "（该图因此缺少黑白性/线宽/DPI 核验；请确认 sharp 解码依赖是否就绪）",
      );
      continue;
    }
    const { metrics } = entry;
    lines.push(
      `- ${entry.name}: ${metrics.width}×${metrics.height}px，${metrics.dpi}DPI${
        metrics.dpiEstimated ? "（估算）" : ""
      }，非白占比 ${(metrics.inkRatio * 100).toFixed(2)}%，中间灰占比 ${(metrics.midGrayRatio * 100).toFixed(1)}%` +
        (metrics.linePx === undefined ? "" : `，最细线宽约 ${metrics.linePx}px`) +
        ` —— ${entry.findings.length === 0 ? "无发现" : `${entry.findings.length} 项发现`}`,
    );
    for (const finding of entry.findings) {
      lines.push(
        `  [${finding.severity.toUpperCase()}] ${finding.rule}: ${finding.message}` +
          (finding.evidence ? `\n  ${finding.evidence.join("\n  ")}` : ""),
      );
    }
  }
  return lines;
}

function renderReport(input: {
  source: string;
  dir: string;
  sidecar: FigureSidecar;
  result: FigureCheckResult;
  raster: RasterGateObservation;
  textFaces: string;
  skippedTextRules: boolean;
  numberedFigureNos: readonly number[];
  forced: boolean;
}): string {
  const fails = input.result.findings.filter(f => f.severity === "fail");
  const warns = input.result.findings.filter(f => f.severity === "warn");
  // 栅格附件的发现与结构规则的发现同权：PX1 这类 fail 级缺陷此前只在按需核验的报告里
  // 出现，本门把它一并计入判定（本仓的规则号分列 PX*/V*，报告里也分列）。
  const rasterEntries = input.raster.status === "ran" ? input.raster.entries : [];
  const rasterFails = rasterEntries.flatMap(entry =>
    entry.measured ? entry.findings.filter(f => f.severity === "fail") : [],
  );
  const rasterWarns = rasterEntries.flatMap(entry =>
    entry.measured ? entry.findings.filter(f => f.severity === "warn") : [],
  );
  const degradedRaster = rasterEntries.filter(entry => !entry.measured).length;
  const passed = input.result.ok && rasterFails.length === 0;
  const lines = [
    `附图门: ${passed ? "✅ 通过" : "⚠️ 未通过"}（fail=${fails.length + rasterFails.length}, warn=${
      warns.length + rasterWarns.length
    }${degradedRaster === 0 ? "" : `, 未核验栅格=${degradedRaster}`}）${input.forced ? "【人工强制放行】" : ""}`,
    `- 附图来源: ${input.source}（${input.dir}）`,
    `- 附图: ${input.sidecar.figures.map(f => `图${f.figure_no} ${f.file}`).join("；")}（渲染器 ${input.sidecar.renderer}）`,
    `- 生成期核验: ${input.sidecar.check.ok ? "通过" : "有发现"}（文本侧规则未参与）`,
    `- 文本面: ${input.textFaces}${input.skippedTextRules ? "——无说明书文本，V2/V3 未生效" : ""}`,
    `- 图号观测: ${
      input.numberedFigureNos.length === 0
        ? `均无图号标注（本案 ${input.sidecar.figures.length} 幅）`
        : `图${input.numberedFigureNos.join("、图")} 带图号`
    }`,
    ...(input.result.specFaces === undefined
      ? []
      : [
          `- 文字面分节: ${input.result.specFaces.sectioned ? "已分节" : "未分节"}（${input.result.specFaces.reason}）`,
        ]),
    ...(input.result.bracketRules === undefined ? [] : [`- 括号规则: ${input.result.bracketRules.reason}`]),
    ...rasterSection(input.raster),
  ];
  if (input.result.findings.length > 0) {
    lines.push("", "发现：");
    for (const finding of input.result.findings) {
      lines.push(
        `- [${finding.severity.toUpperCase()}] ${finding.rule}: ${finding.message}` +
          (finding.evidence ? `\n  ${finding.evidence.join("\n  ")}` : ""),
      );
    }
  }
  lines.push(
    "",
    passed
      ? "- 结论: 附图通过确定性核验，可随说明书定稿。"
      : "- 结论: 存在 fail 级发现，附图不得定稿——请修正后重新生成，或在 HITL 确认放行。",
  );
  return lines.join("\n");
}

export class FigureGateHandler implements StageHandler {
  readonly name = "figure-gate";
  readonly category = "gate" as const;

  async execute({ state }: StageExecuteInput): Promise<PipelineState> {
    const located = await locateInputs(state, process.cwd());
    if ("missing" in located) {
      const probed = located.missing.map(candidate => `${candidate.reason}（${candidate.dir}）`).join("；");
      return degraded("figure-gate", `未找到附图 sidecar（已探查：${probed}）——附图核验未执行`);
    }

    const { dir, source, sidecar } = located;
    const specs = sidecar.figures.map(figure => figure.spec);
    const stateKind = getStateString(state, "document_kind");
    const documentKind: DocumentKind | undefined =
      sidecar.document_kind ?? (stateKind === "invention" || stateKind === "utility" ? stateKind : undefined);
    const jurisdiction: Jurisdiction = sidecar.jurisdiction;

    const claims = getStateString(state, "claims_draft");
    const spec = getStateString(state, "spec_draft");
    const textFaces = [claims.trim().length > 0 ? "claims_draft" : "", spec.trim().length > 0 ? "spec_draft" : ""]
      .filter(Boolean)
      .join(" + ");
    const specText = [claims, spec].filter(part => part.trim().length > 0).join("\n\n");
    // 无文本层（如门被放在定稿前）：V2/V3 无法判定，如实跳过而非把全部标记判为"未提及"。
    const skippedTextRules = specText.trim().length === 0;

    // 先回读交付文件（漂移检测与图号观测同源），再跑确定性规则——图号义务（V15/V16）只有
    // 在交付形态可观测时才能判，缺了观测就退化成"猜渲染器应该怎么写"。
    const { drifts, numberedFigureNos } = await detectFigureDrift(located);

    const result = checkFigures(specs, specText, {
      skipTextRules: skippedTextRules,
      documentKind: documentKind,
      jurisdiction: jurisdiction,
      figureCount: sidecar.figures.length,
      numberedFigureNos,
    });

    // 栅格附图附件（同目录、同命名体例 `<output_name>-fig<N>.<ext>`）：本门是交付前最后
    // 一道自动门，PX 级 fail（灰度/着色渲染、线宽不可辨）与结构规则同权参与阻断。
    const raster = await runRasterGate({
      dir,
      outputName: sidecar.output_name,
      office: sidecar.office ?? officeForJurisdiction(jurisdiction),
    });

    const report = renderReport({
      source,
      dir,
      sidecar,
      result,
      raster,
      textFaces: textFaces.length > 0 ? textFaces : "（无）",
      skippedTextRules,
      numberedFigureNos,
      forced: Boolean(state[APPROVAL_GRANTED_KEY]),
    });

    // 留痕（无论通过与否）：结论与输入的对应关系可审计（含 renderer 与 CAD 投影参数）。
    const inputsHash = figureInputsHash({
      specs,
      specText,
      documentKind,
      jurisdiction,
      ...(raster.status === "ran"
        ? { raster: raster.entries.map(entry => ({ name: entry.name, digest: entry.digest })) }
        : {}),
    });
    const reportPath = join(dir, "figure-check.json");
    await writeReport(reportPath, {
      inputsHash,
      result,
      raster,
      renderer: sidecar.renderer,
      figures: sidecar.figures,
    });

    if (drifts.length > 0) {
      throw new InterruptStageError("figure-gate", "附图文件与 sidecar 不一致（核验结论不可信）", {
        guardrail_level: "high",
        review_context:
          "附图文件与生成期 sidecar 的 FigureSpec 不一致（文件被改写/移动或 sidecar 被改坏）。" +
          "编号选择：1=确认放行（按 sidecar 结论继续） / 2=重新生成附图 / 3=退回",
        figure_report: report,
        figure_check_report: reportPath,
        figure_drift: drifts,
      });
    }

    const fails = result.findings.filter(f => f.severity === "fail");
    const rasterFails = rasterFailCount(raster);
    if ((fails.length > 0 || rasterFails > 0) && !state[APPROVAL_GRANTED_KEY]) {
      throw new InterruptStageError("figure-gate", "附图未通过确定性核验，请决策放行/重做或退回", {
        guardrail_level: "medium",
        review_context: `附图存在 ${fails.length + rasterFails} 项 fail 级发现（图号连续性/图文标记一致/画幅可印性${
          rasterFails === 0 ? "" : "/栅格附件黑白性与线宽"
        }）。编号选择：1=确认放行（强制） / 2=重新生成附图 / 3=退回`,
        figure_report: report,
        figure_check_report: reportPath,
      });
    }

    return { figure_report: report };
  }
}

/**
 * `figure-check.json` v1 契约（inputs_hash 使"结论 ↔ 输入"可核）。
 *
 * `renderer` 与 `geometry` 直接取自 sidecar：CAD 投影图的画幅由**投影几何**决定（不由
 * 本模块布局决定），故把投影参数与投影期几何检查结论一并留痕，使"这张图怎么来的"可审计。
 */
export type FigureCheckReport = {
  version: number;
  checked_at: string;
  inputs_hash: string;
  result: FigureCheckResult;
  /** 栅格附图附件的像素门禁观测（`none` 表示本案无栅格附件，非"未核验"）。 */
  raster?: RasterGateObservation;
  renderer?: string;
  geometry?: readonly (FigureSidecarGeometry & { figure_no: number })[];
};

export type FigureCheckReportInput = {
  inputsHash: string;
  result: FigureCheckResult;
  /** 栅格附图附件的像素门禁观测（未附栅格图时可缺省）。 */
  raster?: RasterGateObservation;
  /** sidecar.renderer（builtin / graphviz / cad）。 */
  renderer?: string;
  /** sidecar 各图的几何来源（仅 CAD 图有）。 */
  figures?: readonly { figure_no: number; geometry?: FigureSidecarGeometry }[];
  checkedAt?: string;
};

export function buildFigureCheckReport(input: FigureCheckReportInput): FigureCheckReport {
  const geometry = (input.figures ?? []).flatMap(figure =>
    figure.geometry === undefined ? [] : [{ figure_no: figure.figure_no, ...figure.geometry }],
  );
  return {
    version: FIGURE_CHECK_REPORT_VERSION,
    checked_at: input.checkedAt ?? new Date().toISOString(),
    inputs_hash: input.inputsHash,
    result: input.result,
    ...(input.raster === undefined ? {} : { raster: input.raster }),
    ...(input.renderer === undefined ? {} : { renderer: input.renderer }),
    ...(geometry.length === 0 ? {} : { geometry }),
  };
}

async function writeReport(path: string, input: FigureCheckReportInput): Promise<void> {
  await writeFile(path, `${JSON.stringify(buildFigureCheckReport(input), null, 2)}\n`, "utf8");
}
