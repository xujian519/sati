import { rename, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import {
  aggregate,
  builtinPatentManifests,
  defaultPatentRules,
  formatRuleResults,
  runWorkflow,
  validateWorkflowManifest,
  workflowManifestToMermaid,
  JsonFileWorkflowRunStore,
  RuleEngine,
  type RuleCheckResult,
  type Verdict,
  type WorkflowContext,
  type WorkflowManifest,
  type WorkflowRunResult,
} from "../../patent/index.js";
import { StageHandlerRegistry, type StageProvider } from "../../patent/atoms/index.js";
import { createNuoSearchProvider } from "../../patent/data/nuo/searchProvider.js";
import { caseWorkflowRunsDir } from "../../patent/paths.js";
import { DEFAULT_MODEL_ID, DEFAULT_MODEL_PROVIDER, type CanonicalModelRequest } from "../../model/index.js";
import type { SatiToolDefinition, SatiToolModelClient } from "../protocol/types.js";

export type PatentWorkflowStageOutput = {
  /** 与 manifest.stages[].id 对应的阶段 id。 */
  stageId: string;
  /** 该阶段的分析输出文本（由主代理按阶段完成分析后提供）。 */
  text: string;
};

export type PatentWorkflowInput = {
  /** 工作流 manifest id（缺省 "patent_novelty_v1" = 内置专利新颖性分析五阶段）。 */
  manifestId?: string;
  /** 各阶段输出（缺省按顺序对应 manifest 全部阶段）。 */
  outputs?: PatentWorkflowStageOutput[];
  /** 案例标识（用于结果记录，可含 {caseId} 占位）。 */
  caseId?: string;
  /**
   * 确定性规则检查域（覆盖 manifest 默认映射）。逗号分隔多域，如 "patent_novelty,patent_disclosure"；
   * 传空串禁用检查。缺省按内置 manifest 目录条目读取（patent_novelty_v1 → patent_novelty；
   * patent_disclosure_v1 → patent_disclosure,patent_claims；patent_inventiveness_v1 → patent_inventiveness）。
   */
  checkDomain?: string;
};

/** 解析本次调用的检查域；返回空数组 = 跳过确定性门。 */
function resolveCheckDomains(manifest: WorkflowManifest, checkDomain?: string): readonly string[] {
  if (checkDomain === "") return [];
  if (checkDomain !== undefined) {
    return checkDomain
      .split(",")
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }
  // 内置 manifest 的检查域与 manifest 同源声明（builtinPatentManifests 目录）；
  // 自定义 manifest 不在目录内，未显式传 checkDomain 时不跑规则门（fail-open）。
  return builtinPatentManifests.find(e => e.manifest.id === manifest.id)?.checkDomains ?? [];
}

/** 规则检查结果摘要（一行）：verdict + 失败数。 */
function summarizeCheck(verdict: Verdict, failures: readonly RuleCheckResult[]): string {
  const label = verdict === "pass" ? "✅ 通过" : verdict === "needs_revision" ? "⚠️ 需修改" : "⛔ 阻断";
  return failures.length === 0 ? `确定性门: ${label}` : `确定性门: ${label}（${failures.length} 项规则失败）`;
}

/**
 * 解析案例持久化目录：绝对路径 → `<caseId>/workflow-runs`；相对路径（含分隔符）→
 * `<cwd>/<caseId>/workflow-runs`；纯 id → `<cwd>/data/cases/<caseId>/workflow-runs`
 * （路径约定来自 src/patent/paths.ts 的 caseWorkflowRunsDir，与 worker-contract 的
 * outputs 目录同源）。patent_workflow_run（原子执行工具）复用本函数。
 */
export function resolveWorkflowRunsDir(caseId: string, cwd: string): string {
  if (isAbsolute(caseId)) return join(caseId, "workflow-runs");
  if (caseId.includes("/") || caseId.includes("\\")) return join(cwd, caseId, "workflow-runs");
  return join(cwd, caseWorkflowRunsDir(caseId));
}

/** 持久化 runId 键：路径形式取 basename，避免文件路径含分隔符破坏 JSON 文件名。 */
export function caseKeyOf(caseId: string): string {
  if (isAbsolute(caseId) || caseId.includes("/") || caseId.includes("\\")) {
    return basename(caseId);
  }
  return caseId;
}

/** 原子写：先写同目录临时文件再 rename，避免并发/中断产生半写文件。 */
export async function atomicWriteFile(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, file);
}

// ---------------------------------------------------------------------------
// 工作流运行结果共享装配（收口工具 patent_workflow 与原子工具
// patent_workflow_run 共用：持久化目标解析、Mermaid 落盘、尾部文本拼装）
// ---------------------------------------------------------------------------

export type WorkflowRunPersistTarget = { runsDir: string; runId: string };

/** 解析本次运行的持久化目标（runsDir/runId）；无 caseId 时返回 undefined。 */
export function resolveRunPersistTarget(
  caseId: string | undefined,
  manifestId: string,
  cwd: string,
): WorkflowRunPersistTarget | undefined {
  if (caseId === undefined) return undefined;
  return {
    runsDir: resolveWorkflowRunsDir(caseId, cwd),
    runId: `${caseKeyOf(caseId)}__${manifestId}`,
  };
}

/**
 * 执行后写 Mermaid 计划图并返回持久化提示。
 * JSON 由 runWorkflow 内部经 persist 选项保存；本函数只补 .mmd 与提示，
 * 并把 JSON 持久化失败（result.persistWarning）透出到提示文本。
 */
export async function writeRunArtifacts(
  target: WorkflowRunPersistTarget,
  manifest: WorkflowManifest,
  result: WorkflowRunResult,
): Promise<string> {
  try {
    await atomicWriteFile(join(target.runsDir, `${target.runId}.mmd`), workflowManifestToMermaid(manifest));
    const note = `持久化: ${join(target.runsDir, `${target.runId}.json`)} + ${join(target.runsDir, `${target.runId}.mmd`)}`;
    return result.persistWarning ? `${note}\n${result.persistWarning}` : note;
  } catch (err) {
    return `持久化失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** 工作流运行结果尾部文本拼装（阶段行/规则门/持久化提示已由调用方备好）。 */
export function renderWorkflowResultText(opts: {
  toolName: string;
  result: WorkflowRunResult;
  stageLines: string[];
  persistNote: string;
  checkSection: string;
  interruptNote?: string;
}): string {
  const completion = opts.result.completed ? "completed" : "incomplete";
  return [
    `${opts.toolName}(${opts.result.manifestId}): ${opts.result.summary}`,
    ...opts.stageLines,
    ...(opts.interruptNote !== undefined ? [opts.interruptNote] : []),
    `完成状态: ${completion}`,
    opts.persistNote,
    ...(opts.checkSection !== "" ? [opts.checkSection] : []),
  ].join("\n");
}

/**
 * `patent_workflow` — 声明式专利工作流执行工具。
 *
 * 按内置/自定义 WorkflowManifest 的声明式阶段顺序执行：
 * 主代理按 manifest 各阶段（解析→检索→对比→结论→人工确认）逐步完成分析，
 * 将各阶段文本传入本工具做结果组装、完整性校验（degraded 标记）与摘要生成。
 * 确定性执行，无 LLM 调用；用于专利新颖性分析等结构化流程的产物收口。
 *
 * 自 v0.1.0 起接入 **dual-track 确定性规则门**（src/patent/checker）：对全部非降级
 * 阶段产出拼接文本运行 defaultPatentRules 判定（按内置 manifest 目录条目读取检查域，
 * 可用 checkDomain 覆盖），将 pass / needs_revision / blocked 判级与失败明细
 * 拼入工具输出——撰写/答复产出在收口时过一遍确定性审查，供主代理据此修订或放行。
 *
 * 注意：本工具传**空 StageHandlerRegistry**（禁用原子执行）——阶段输出由主代理
 * 提供、工具只做收口校验；真正需要原子自动执行（handler 内部调 LLM/检索）时，
 * 使用 `patent_workflow_run` 工具（src/tool/builtin/patentWorkflowRunTool.ts）：
 * 它注入全局原子注册表 + provider（LLM + nuo-patent 检索）自动执行声明 atom 的
 * 阶段（见 src/patent/atoms）。两条路径分工明确：收口（本工具）消费主代理文本，
 * 原子（patent_workflow_run）自动产出。
 */
export function createPatentWorkflowTool(): SatiToolDefinition<PatentWorkflowInput> {
  const manifests = new Map(builtinPatentManifests.map(({ manifest }) => [manifest.id, manifest]));

  return {
    name: "patent_workflow",
    outputSchema: {
      type: "object",
      properties: {},
    },
    aliases: ["PatentWorkflow", "run_patent_workflow"],
    description:
      "Run a declarative patent workflow: validates the manifest, assembles per-stage outputs into a " +
      "structured WorkflowRunResult with degraded-step marking and a summary, then runs the deterministic " +
      "rule gate (dual-track checker) over the outputs and appends the pass/needs_revision/blocked verdict. " +
      "Built-in manifests: patent_novelty_v1 (parse → search → compare → conclude → approval), " +
      "patent_disclosure_v1 (preprocess → extract → merge → consistency → report → approval) and " +
      "patent_inventiveness_v1 (parse → search → closest → diff → hint → secondary → conclude → approval). " +
      "Use to finalize " +
      "multi-stage patent analyses (novelty / disclosure / inventiveness) with a single verifiable result record. " +
      "When caseId is provided, the run result is persisted to <caseDir>/workflow-runs/<caseId>__<manifestId>.json " +
      "plus a Mermaid plan diagram <caseId>__<manifestId>.mmd " +
      "(caseId as path → <caseId>/workflow-runs/; as plain id → data/cases/<caseId>/workflow-runs/ under cwd).",
    kind: "session",
    inputSchema: {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: {
        manifestId: {
          type: "string",
          description: "Workflow manifest id. Defaults to 'patent_novelty_v1'.",
        },
        caseId: {
          type: "string",
          description:
            "Optional case id for result records. When provided, the run is persisted to " +
            "<caseDir>/workflow-runs/<caseId>__<manifestId>.json for audit.",
        },
        checkDomain: {
          type: "string",
          description:
            "Deterministic rule-check domains (comma-separated, e.g. 'patent_novelty,patent_disclosure'). " +
            "Overrides the manifest default mapping; empty string disables the rule gate.",
        },
        outputs: {
          type: "array",
          description: "Per-stage outputs keyed by stage id. Missing stages are marked degraded.",
          items: {
            type: "object",
            required: ["stageId", "text"],
            additionalProperties: false,
            properties: {
              stageId: { type: "string" },
              text: { type: "string" },
            },
          },
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input, context) {
      // 缺省取内置目录首个 manifest（patent_novelty_v1）。
      const manifest = manifests.get(input.manifestId ?? builtinPatentManifests[0]?.manifest.id);
      if (!manifest) {
        const available = [...manifests.keys()].join(", ");
        return {
          content: [
            {
              type: "text",
              text: `patent_workflow: 未知 manifest "${input.manifestId}"（可用: ${available}）`,
            },
          ],
        };
      }
      try {
        validateWorkflowManifest(manifest);
      } catch (err) {
        return { content: [{ type: "text", text: `patent_workflow: manifest 校验失败: ${(err as Error).message}` }] };
      }

      const byId = new Map((input.outputs ?? []).map(o => [o.stageId, o.text]));
      // 空注册表：禁用原子执行，保持"主代理产出 → 工具收口"语义（无 LLM 调用）。
      const persistTarget = resolveRunPersistTarget(input.caseId, manifest.id, context?.cwd ?? process.cwd());
      const result = await runWorkflow(manifest, { caseId: input.caseId }, async stage => byId.get(stage.id) ?? "", {
        handlers: new StageHandlerRegistry(),
        persist: persistTarget ? new JsonFileWorkflowRunStore(persistTarget.runsDir) : undefined,
        runId: persistTarget?.runId,
      });

      // 提供 caseId 时自动持久化（JSON 由 runWorkflow 保存，.mmd 补写；失败仅提示）。
      const persistNote = persistTarget
        ? await writeRunArtifacts(persistTarget, manifest, result)
        : "持久化: 未启用（未提供 caseId）";

      const lines = result.stages.map(s => {
        const flag = s.degraded ? "⚠️ 降级" : "✅";
        return `- ${flag} ${s.stageId} (${s.strategy}): ${s.output.length > 0 ? `${s.output.slice(0, 80)}${s.output.length > 80 ? "…" : ""}` : "(无输出)"}`;
      });

      // 确定性规则门：对全部非降级阶段产出拼接文本评估（dual-track 的确定性轨）。
      const checkDomains = resolveCheckDomains(manifest, input.checkDomain);
      const checkSection = checkDomains.length > 0 ? runRuleGate(result, checkDomains) : "";

      return {
        content: [
          {
            type: "text",
            text: renderWorkflowResultText({
              toolName: "patent_workflow",
              result,
              stageLines: lines,
              persistNote,
              checkSection,
            }),
          },
        ],
      };
    },
  };
}

/**
 * 执行确定性规则门：拼接非降级阶段产出 → defaultPatentRules 按域评估 → 聚合判级，
 * 返回 Markdown 报告片段（含判级结论行 + 失败明细表；全部通过时仅结论行）。
 */
export function runRuleGate(
  result: { stages: { degraded: boolean; output: string }[] },
  domains: readonly string[],
): string {
  const text = result.stages
    .filter(s => !s.degraded && s.output.trim().length > 0 && !s.output.startsWith("[WORKFLOW_DEGRADED]"))
    .map(s => s.output)
    .join("\n");
  const engine = new RuleEngine();
  engine.registerMany(defaultPatentRules());
  const failures = engine.evaluate(text, { domain: domains });
  const verdict = aggregate(failures);
  const summary = summarizeCheck(verdict, failures);
  return `${summary}\n${formatRuleResults(failures, verdict)}`;
}

// ---------------------------------------------------------------------------
// 原子执行共享装配（patent_workflow_run 与 flexible_plan 共用：
// LLM 客户端 + 检索器 → StageProvider，避免两处各自维护装配逻辑漂移）
// ---------------------------------------------------------------------------

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export type WorkflowProviderDeps = {
  /** 模型客户端（缺省取 context.model；二者皆无时 buildWorkflowProvider 返回 undefined）。 */
  model?: SatiToolModelClient;
  /** 模型 provider id（缺省 "openrouter"，对齐 web_fetch 默认）。 */
  provider?: string;
  /** 模型 id（缺省 "moonshotai/kimi-k2.6"，对齐 web_fetch 默认）。 */
  modelId?: string;
  /** 检索器（缺省 nuo-patent 的 searchPatents，经 createNuoSearchProvider 适配）。 */
  search?: StageProvider["search"];
  /**
   * per-node 模型覆盖映射（P2-1 模型分层）：callLLM 的 modelHint 标识（如 "cheap"/"strong"）
   * → { provider?, model }。缺省空 = 忽略 modelHint，全部节点用默认模型（行为不变）。
   */
  modelHints?: Record<string, { provider?: string; model: string }>;
};

export type WorkflowProviderContext = {
  model?: SatiToolModelClient;
  /** 案例标识：透出到 StageProvider.caseId，供 claim-chart 等原子落盘/核验合并。 */
  caseId?: string;
};

/** 收集 stream 事件为完整文本（对齐 web_fetch 二次模型调用模式）。 */
async function collectModelText(model: SatiToolModelClient, request: CanonicalModelRequest): Promise<string> {
  let text = "";
  for await (const event of model.stream(request)) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;
      case "error":
        throw new Error(`模型调用失败: ${event.error.message}`);
      default:
        break;
    }
  }
  return text;
}

/**
 * 统一 ctx 映射：各原子输入键（text/source_text/extraction_input/claim）指向同一份
 * 输入文本。patent_workflow_run（manifest + graph 路径）与 flexible_plan（run）共用，
 * 避免三处各自维护映射漂移。
 */
export function buildWorkflowRunContext(opts: {
  caseId?: string;
  input: string;
  maxResults?: number;
  /** claim-chart 阶段的目标对象 JSON（[{id,kind,title?,source_path?}]）；缺省为空。 */
  chartTargets?: string;
}): WorkflowContext {
  return {
    caseId: opts.caseId,
    input: opts.input,
    text: opts.input,
    source_text: opts.input,
    extraction_input: opts.input,
    claim: opts.input,
    chart_targets: opts.chartTargets ?? "",
    max_results: String(opts.maxResults ?? 5),
  };
}

/**
 * 装配 StageProvider：callLLM 走 deps.model ?? context.model（皆无时返回
 * undefined，由调用方给出明确错误而非静默降级）；search 走 deps.search 或
 * nuo-patent。jsonSchema 提供时要求结构化输出（handler 尝试解析 JSON）。
 */
export function buildWorkflowProvider(
  deps: WorkflowProviderDeps,
  context: WorkflowProviderContext = {},
): StageProvider | undefined {
  const model = deps.model ?? context.model;
  if (!model) return undefined;
  return {
    callLLM: async (prompt, opts) => {
      const jsonSchema = opts?.jsonSchema;
      const outputSchema =
        jsonSchema !== undefined && typeof jsonSchema === "object" && jsonSchema !== null
          ? { name: "structured_output", schema: jsonSchema as Record<string, unknown>, strict: true }
          : undefined;
      // 模型分层（P2-1）：modelHint 命中映射时覆盖 provider/model，未命中用默认。
      const hint = opts?.modelHint !== undefined ? deps.modelHints?.[opts.modelHint] : undefined;
      const request: CanonicalModelRequest = {
        provider: hint?.provider ?? deps.provider ?? DEFAULT_MODEL_PROVIDER,
        model: hint?.model ?? deps.modelId ?? DEFAULT_MODEL_ID,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        temperature: opts?.temperature ?? 0,
        stream: true,
        ...(outputSchema !== undefined ? { outputSchema } : {}),
      };
      return collectModelText(model, request);
    },
    search: deps.search ?? createNuoSearchProvider().search,
    caseId: context.caseId ?? "",
  };
}
