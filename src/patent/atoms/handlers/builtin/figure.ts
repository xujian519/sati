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
import { readFile, writeFile } from "node:fs/promises";
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
  checkFigures,
  findFigureSidecar,
  parseFigureSvg,
  readFigureSidecar,
  type DocumentKind,
  type FigureCheckResult,
  type FigureSidecar,
  type FigureSidecarGeometry,
  type FigureSpec,
  type Jurisdiction,
} from "../../../figuregen/index.js";
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

/** 回读自检：sidecar 声明的图必须与其 SVG 的图号 / data-ref 集合一致（漂移 fail-loud）。 */
export async function detectFigureDrift(inputs: LocatedInputs): Promise<string[]> {
  const drifts: string[] = [];
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
  return drifts;
}

/** 输入内容哈希：spec 集合 + 说明书文本 + 辖区/文种（结论与输入的对应关系可审计）。 */
export function figureInputsHash(input: {
  specs: readonly FigureSpec[];
  specText: string;
  documentKind?: DocumentKind;
  jurisdiction: Jurisdiction;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        specs: input.specs,
        spec_text: input.specText,
        document_kind: input.documentKind ?? null,
        jurisdiction: input.jurisdiction,
      }),
    )
    .digest("hex");
}

function renderReport(input: {
  source: string;
  dir: string;
  sidecar: FigureSidecar;
  result: FigureCheckResult;
  textFaces: string;
  skippedTextRules: boolean;
  forced: boolean;
}): string {
  const fails = input.result.findings.filter(f => f.severity === "fail");
  const warns = input.result.findings.filter(f => f.severity === "warn");
  const lines = [
    `附图门: ${input.result.ok ? "✅ 通过" : "⚠️ 未通过"}（fail=${fails.length}, warn=${warns.length}）${input.forced ? "【人工强制放行】" : ""}`,
    `- 附图来源: ${input.source}（${input.dir}）`,
    `- 附图: ${input.sidecar.figures.map(f => `图${f.figure_no} ${f.file}`).join("；")}（渲染器 ${input.sidecar.renderer}）`,
    `- 生成期核验: ${input.sidecar.check.ok ? "通过" : "有发现"}（文本侧规则未参与）`,
    `- 文本面: ${input.textFaces}${input.skippedTextRules ? "——无说明书文本，V2/V3 未生效" : ""}`,
    ...(input.result.specFaces === undefined
      ? []
      : [
          `- 文字面分节: ${input.result.specFaces.sectioned ? "已分节" : "未分节"}（${input.result.specFaces.reason}）`,
        ]),
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
    input.result.ok
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

    const result = checkFigures(specs, specText, {
      skipTextRules: skippedTextRules,
      documentKind: documentKind,
      jurisdiction: jurisdiction,
    });

    const report = renderReport({
      source,
      dir,
      sidecar,
      result,
      textFaces: textFaces.length > 0 ? textFaces : "（无）",
      skippedTextRules,
      forced: Boolean(state[APPROVAL_GRANTED_KEY]),
    });

    // 留痕（无论通过与否）：结论与输入的对应关系可审计（含 renderer 与 CAD 投影参数）。
    const inputsHash = figureInputsHash({ specs, specText, documentKind, jurisdiction });
    const reportPath = join(dir, "figure-check.json");
    await writeReport(reportPath, {
      inputsHash,
      result,
      renderer: sidecar.renderer,
      figures: sidecar.figures,
    });

    const drifts = await detectFigureDrift(located);
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
    if (fails.length > 0 && !state[APPROVAL_GRANTED_KEY]) {
      throw new InterruptStageError("figure-gate", "附图未通过确定性核验，请决策放行/重做或退回", {
        guardrail_level: "medium",
        review_context:
          `附图存在 ${fails.length} 项 fail 级发现（图号连续性/图文标记一致/画幅可印性）。` +
          "编号选择：1=确认放行（强制） / 2=重新生成附图 / 3=退回",
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
  renderer?: string;
  geometry?: readonly (FigureSidecarGeometry & { figure_no: number })[];
};

export type FigureCheckReportInput = {
  inputsHash: string;
  result: FigureCheckResult;
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
    ...(input.renderer === undefined ? {} : { renderer: input.renderer }),
    ...(geometry.length === 0 ? {} : { geometry }),
  };
}

async function writeReport(path: string, input: FigureCheckReportInput): Promise<void> {
  await writeFile(path, `${JSON.stringify(buildFigureCheckReport(input), null, 2)}\n`, "utf8");
}
