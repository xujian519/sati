/**
 * 声明式工作流执行器（移植自 Mady workflows/patent_novelty.yaml + manifest.go）。
 *
 * 设计原则（吸取 Mady 教训：5 条执行路径并存导致"看起来实现但从未运行"）：
 * 只保留一条声明式路径 —— WorkflowManifest（JSON/YAML 可序列化）+ 单一执行器 runWorkflow。
 * 内置 patent_novelty_v1 manifest（五阶段 + novelty_chain 模板镜像）。
 *
 * 原子执行（v2，移植自 Mady agentcore/atom.go + pipeline_handler.go）：
 * - WorkflowStage 可声明 atom（Pipeline 原子操作名）；runWorkflow 优先按 atom 分发到
 *   StageHandler（经注入的 handlers 注册表或全局注册表），handler 内部调用 LLM/检索器。
 * - 未声明 atom 的阶段回退到调用方 executor（向后兼容；patent_workflow 工具走此路径）。
 * - 审批门（approval-gate）等 handler 抛 InterruptStageError 时，runWorkflow 暂停
 *   并返回 interrupted 信息（暂停 ≠ 失败），不执行后续阶段。
 */

import {
  type AtomRegistry,
  type PipelineState,
  type StageHandlerRegistry,
  type StageProvider,
  globalAtomRegistry,
  globalStageHandlerRegistry,
  isInterruptStageError,
} from "./atoms/index.js";

export type WorkflowStrategy = "chain" | "react" | "sub_agent";

export type WorkflowStage = {
  id: string;
  strategy: WorkflowStrategy;
  description: string;
  /**
   * 可选：Pipeline 原子操作名（如 "extract"/"search"/"compare"/"reasoning"/"approval-gate"）。
   * 声明后 runWorkflow 按 atom 分发到 StageHandler；缺省回退 executor。
   */
  atom?: string;
};

export type WorkflowManifest = {
  id: string;
  name: string;
  caseType: string;
  stages: WorkflowStage[];
  validation?: {
    /** 是否要求所有步骤都产生输出（缺省 true） */
    requireAllSteps?: boolean;
    maxRetries?: number;
  };
};

export type WorkflowContext = {
  /** 案例目录或案例 ID，用于输入输出路径（可含 {caseId} 占位） */
  caseId?: string;
  /** 用户输入/初始事实 */
  input?: string;
  [key: string]: unknown;
};

export type StageExecutor = (stage: WorkflowStage, ctx: WorkflowContext) => Promise<string>;

export type WorkflowRunOptions = {
  /** 阶段处理器注册表（缺省全局注册表）。传空注册表可禁用原子执行（收口语义）。 */
  handlers?: StageHandlerRegistry;
  /** Atom 声明注册表（缺省全局注册表），用于解析 atom.outputSchema[0] 主输出键。 */
  atoms?: AtomRegistry;
  /** 原子执行所需的外部能力（LLM/检索器），由宿主注入。 */
  provider?: StageProvider;
};

export type WorkflowStageResult = {
  stageId: string;
  strategy: WorkflowStrategy;
  output: string;
  /** 该步骤是否降级（无输出时标记，不中断流程） */
  degraded: boolean;
  retries: number;
  /** 该阶段声明的原子名（如有） */
  atom?: string;
};

export type WorkflowInterrupt = {
  stageId: string;
  message: string;
  data: Record<string, unknown>;
};

export type WorkflowRunResult = {
  manifestId: string;
  caseType: string;
  completed: boolean;
  stages: WorkflowStageResult[];
  /** 未产生输出的步骤 id */
  degradedSteps: string[];
  summary: string;
  /** 审批门等中断信息：存在表示执行被人工介入暂停（暂停 ≠ 失败） */
  interrupted?: WorkflowInterrupt;
};

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

/**
 * Manifest 校验（轻量守卫，替代 zod）：非法即抛错。
 * options.atomNames 提供时，额外校验已声明 atom 均存在（fail-fast）。
 */
export function validateWorkflowManifest(
  manifest: WorkflowManifest,
  options?: { atomNames?: ReadonlySet<string> },
): void {
  if (!manifest.id.trim()) throw new WorkflowError("manifest.id 不能为空");
  if (!manifest.name.trim()) throw new WorkflowError("manifest.name 不能为空");
  if (!manifest.caseType.trim()) throw new WorkflowError("manifest.caseType 不能为空");
  if (!Array.isArray(manifest.stages) || manifest.stages.length === 0) {
    throw new WorkflowError("manifest.stages 必须至少包含一个阶段");
  }
  const ids = new Set<string>();
  for (const stage of manifest.stages) {
    if (!stage.id.trim()) throw new WorkflowError("stage.id 不能为空");
    if (ids.has(stage.id)) throw new WorkflowError(`重复的阶段 id: ${stage.id}`);
    ids.add(stage.id);
    if (!["chain", "react", "sub_agent"].includes(stage.strategy)) {
      throw new WorkflowError(`未知策略: ${stage.strategy}（阶段 ${stage.id}）`);
    }
    if (!stage.description.trim()) throw new WorkflowError(`阶段 ${stage.id} 缺少描述`);
    if (stage.atom !== undefined && !stage.atom.trim()) {
      throw new WorkflowError(`阶段 ${stage.id} 的 atom 不能为空字符串`);
    }
    if (options?.atomNames && stage.atom !== undefined && !options.atomNames.has(stage.atom)) {
      throw new WorkflowError(`阶段 ${stage.id} 声明了未知 atom: ${stage.atom}`);
    }
  }
}

/**
 * 单一执行器：按顺序执行各阶段。
 * - 声明 atom 的阶段经 StageHandler 执行（handler 内部调 LLM/检索器），输出合并进 PipelineState
 * - 未声明 atom 的阶段回退调用方 executor（输出为空时标记 degraded 而非中断）
 * - 审批门等中断（InterruptStageError）：暂停执行并返回 interrupted（不执行后续阶段）
 */
export async function runWorkflow(
  manifest: WorkflowManifest,
  ctx: WorkflowContext,
  executor?: StageExecutor,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult> {
  validateWorkflowManifest(manifest);
  const requireAll = manifest.validation?.requireAllSteps ?? true;
  const maxRetries = manifest.validation?.maxRetries ?? 2;
  const handlers = options.handlers ?? globalStageHandlerRegistry;
  const atoms = options.atoms ?? globalAtomRegistry;

  // 原子契约存在性 fail-fast：声明了未知 atom（连契约都没有）直接抛错；
  // 已知 atom 但 handler 未注册时回退 executor（atom 是契约，handler 是实现，可延迟注册）。
  for (const stage of manifest.stages) {
    if (stage.atom !== undefined && !atoms.lookup(stage.atom)) {
      throw new WorkflowError(`阶段 ${stage.id} 声明了未知 atom "${stage.atom}"（请先 RegisterAtom）`);
    }
  }

  const state: PipelineState = { ...ctx };
  const results: WorkflowStageResult[] = [];
  let interrupted: WorkflowInterrupt | undefined;

  for (const stage of manifest.stages) {
    const handler = stage.atom !== undefined ? handlers.lookup(stage.atom) : undefined;
    let output = "";
    let retries = 0;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        if (handler) {
          const segment = await handler.execute({ state, provider: options.provider });
          Object.assign(state, segment);
          // 主输出键 = atom.outputSchema[0]（对齐 Mady 约定，文本/JSON 均可）；兜底按 stage.id 引用。
          const mainKey = stage.atom !== undefined ? atoms.lookup(stage.atom)?.outputSchema?.[0] : undefined;
          const raw = mainKey !== undefined ? segment[mainKey] : undefined;
          output = typeof raw === "string" ? raw : raw === undefined ? "" : JSON.stringify(raw, null, 2);
          if (output.trim().length === 0) output = String(state[stage.id] ?? "");
          state[stage.id] = output;
        } else if (executor) {
          output = (await executor(stage, ctx)) ?? "";
        }
        if (output.trim().length > 0) break;
        lastError = new Error("阶段执行未产生输出");
      } catch (err) {
        if (isInterruptStageError(err)) {
          interrupted = { stageId: stage.id, message: err.message, data: err.data };
          break;
        }
        lastError = err;
        retries += 1;
        if (attempt >= maxRetries) {
          output = "";
          break;
        }
      }
      retries = attempt + 1;
    }

    if (interrupted) break; // 审批门等中断：暂停，不执行后续阶段

    if (
      output.trim().length === 0 &&
      lastError !== undefined &&
      !(lastError instanceof Error && lastError.message === "阶段执行未产生输出")
    ) {
      // 保留错误信息到输出，便于诊断；仍标记 degraded。
      // 用结构化标记前缀（而非中文字面量），避免与 executor 正常输出冲突。
      output = `[WORKFLOW_DEGRADED] ${stage.id}: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
    }
    results.push({
      stageId: stage.id,
      strategy: stage.strategy,
      output,
      degraded: output.trim().length === 0 || output.startsWith("[WORKFLOW_DEGRADED]"),
      retries,
      ...(stage.atom !== undefined ? { atom: stage.atom } : {}),
    });
  }

  const degradedSteps = results.filter(r => r.degraded).map(r => r.stageId);
  const completed = !requireAll || (degradedSteps.length === 0 && interrupted === undefined);
  const okCount = results.filter(r => !r.degraded).length;

  let summary: string;
  if (interrupted) {
    summary = `工作流 ${manifest.id}（${manifest.name}）: 已执行 ${results.length}/${manifest.stages.length} 阶段，在 "${interrupted.stageId}" 暂停等待人工确认`;
  } else {
    summary = `工作流 ${manifest.id}（${manifest.name}）: ${okCount}/${results.length} 阶段完成${degradedSteps.length > 0 ? `，降级阶段: ${degradedSteps.join("、")}` : ""}`;
  }

  return {
    manifestId: manifest.id,
    caseType: manifest.caseType,
    completed,
    stages: results,
    degradedSteps,
    summary,
    ...(interrupted ? { interrupted } : {}),
  };
}

/**
 * 内置：专利新颖性分析五阶段 manifest（镜像 Mady patent_novelty.yaml 与 novelty_chain 模板）。
 *
 * 注意：本 manifest **不声明 atom** —— 其消费方 patent_workflow 工具采用"主代理产出
 * 文本 → 工具收口校验"语义（确定性、无 LLM）。需要原子自动执行时，调用方应定义
 * 带 atom 的自定义 manifest，并注入已注册内置原子的注册表与 provider（见 src/patent/atoms）。
 */
export const patentNoveltyManifest: WorkflowManifest = {
  id: "patent_novelty_v1",
  name: "专利新颖性分析",
  caseType: "novelty_search",
  stages: [
    { id: "parse", strategy: "chain", description: "解析技术交底书，提取技术特征" },
    { id: "search", strategy: "react", description: "检索现有技术文献" },
    { id: "compare", strategy: "chain", description: "逐项对比技术特征与现有技术（单独对比原则）" },
    { id: "conclude", strategy: "chain", description: "生成新颖性分析结论（附置信度）" },
    { id: "approval", strategy: "chain", description: "人工确认分析结论" },
  ],
  validation: { requireAllSteps: true, maxRetries: 2 },
};
