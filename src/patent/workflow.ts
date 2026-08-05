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
  /**
   * 可选：传递给 StageHandler 的静态参数（执行前合并进 PipelineState，handler 经 state 读取）。
   * 用于同一原子在不同阶段的差异化配置（如 extract 三路的 output_key / extraction_type）。
   */
  params?: Record<string, unknown>;
  /**
   * 可选：一致性重试循环（对齐 Mady disclosure 管线的 check_consistency 条件回退边）。
   * 本阶段输出匹配 whenOutputMatches（信号：需要重做）时，回退到 rewindTo 阶段
   * 重新执行（含中间阶段），最多 maxRetries 次。
   */
  retry?: {
    /** 触发回退的输出信号（正则源文本；如 "不一致|矛盾|缺少"）。 */
    whenOutputMatches: string;
    /** 回退目标阶段 id；缺省重试当前阶段。 */
    rewindTo?: string;
    /** 最大回退次数（缺省 1）。 */
    maxRetries?: number;
  };
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
  /**
   * 结果持久化存储：执行结束时调用 saveRun（可选）。
   * 设计对齐 src/workflow WorkflowPlanStore（save/load/list 三接口），
   * 实现见 ./workflow-store.js。
   */
  persist?: WorkflowRunStore;
  /** 持久化键（runId），用于区分同一 manifest 的多次执行；缺省 manifestId。 */
  runId?: string;
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
  /** 可选：结果持久化失败时的告警（执行本身不受影响） */
  persistWarning?: string;
};

/**
 * WorkflowRun 持久化契约（对齐 src/workflow/persistence/WorkflowPlanStore 的
 * save/load/list 三接口；此处持久化对象为 patent 域的 WorkflowRunResult）。
 * 实现见 ./workflow-store.js（InMemory / JsonFile 两种后端）。
 */
export interface WorkflowRunStore {
  saveRun(result: WorkflowRunResult, runId?: string): Promise<void>;
  loadRun(runId: string): Promise<WorkflowRunResult | undefined>;
  listRuns(): Promise<string[]>;
}

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
    if (stage.retry !== undefined) {
      if (stage.retry.whenOutputMatches.trim() === "") {
        throw new WorkflowError(`阶段 ${stage.id} 的 retry.whenOutputMatches 不能为空`);
      }
      try {
        new RegExp(stage.retry.whenOutputMatches, "i");
      } catch {
        throw new WorkflowError(`阶段 ${stage.id} 的 retry.whenOutputMatches 非法正则`);
      }
      if (stage.retry.rewindTo !== undefined && !ids.has(stage.retry.rewindTo)) {
        // ids 按 manifest 顺序逐个收集：此检查隐含约束 rewindTo 只能指向更早阶段
        // （后续阶段尚未入 ids）——因此“纯回退边图”天然无环；而“顺序边 + 回退边”
        // 的混合环（如 disclosure 的 consistency → extract_problem）是合法的受控
        // 回退，由 runWorkflow 的 rewindCounts 有界执行，不属配置错误。
        throw new WorkflowError(`阶段 ${stage.id} 的 retry.rewindTo 指向不存在的阶段: ${stage.retry.rewindTo}`);
      }
      if (stage.retry.rewindTo === stage.id) {
        throw new WorkflowError(`阶段 ${stage.id} 的 retry.rewindTo 不能指向自身（无回退意义）`);
      }
      const maxRetries = stage.retry.maxRetries ?? 1;
      if (maxRetries < 0) throw new WorkflowError(`阶段 ${stage.id} 的 retry.maxRetries 不能为负`);
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

  const stageIds = new Map(manifest.stages.map((s, i) => [s.id, i]));
  // 回退计数（局部 Map，不污染 PipelineState；跨阶段重入持久，防无限回退）。
  const rewindCounts = new Map<string, number>();
  // 信号正则预编译（manifest 常量，避免每次执行/回退重新编译）。
  const signalCache = new Map<string, RegExp>();
  const signalFor = (stage: WorkflowStage): RegExp | undefined => {
    if (stage.retry === undefined) return undefined;
    const cached = signalCache.get(stage.id);
    if (cached !== undefined) return cached;
    // g 标志必需：signalMatches 用 exec 遍历全部匹配位置（无 g 时 exec 每次从头匹配 → 死循环）
    const compiled = new RegExp(stage.retry.whenOutputMatches, "gi");
    signalCache.set(stage.id, compiled);
    return compiled;
  };

  /**
   * 信号触发判定：匹配位置前窗口内出现否定词（不/未/无/没，无句界分隔）
   * 时视为否定性表述（"未发现不一致""不缺少任何特征"），不触发回退。
   */
  const signalMatches = (text: string, signal: RegExp): boolean => {
    let match: RegExpExecArray | null;
    const RE = /[不未无没]/;
    signal.lastIndex = 0; // 带 g 标志的正则跨调用保留 lastIndex：回退重入前必须重置，否则 exec 直接返回 null
    while ((match = signal.exec(text)) !== null) {
      const start = Math.max(0, match.index - 12);
      const before = text.slice(start, match.index);
      if (!before.includes("。") && !before.includes("；") && !before.includes(";") && !RE.test(before)) {
        return true;
      }
      if (match[0].length === 0) signal.lastIndex += 1;
    }
    return false;
  };

  /**
   * 执行单个 stage（含重试循环与 degraded 输出构造），不处理信号回退。
   * 供串行路径与并行组共用。
   */
  const runStageOnce = async (
    stage: WorkflowStage,
  ): Promise<{ output: string; retries: number; interrupted?: WorkflowInterrupt }> => {
    const handler = stage.atom !== undefined ? handlers.lookup(stage.atom) : undefined;
    let output = "";
    let retries = 0;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        if (handler) {
          // 阶段静态参数合并进执行态（不污染共享 state，仅本次 handler 可见）。
          const execState = stage.params !== undefined ? { ...state, ...stage.params } : state;
          const segment = await handler.execute({ state: execState, provider: options.provider });
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
          return { output: "", retries, interrupted: { stageId: stage.id, message: err.message, data: err.data } };
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

    if (
      output.trim().length === 0 &&
      lastError !== undefined &&
      !(lastError instanceof Error && lastError.message === "阶段执行未产生输出")
    ) {
      // 保留错误信息到输出，便于诊断；仍标记 degraded。
      // 用结构化标记前缀（而非中文字面量），避免与 executor 正常输出冲突。
      output = `[WORKFLOW_DEGRADED] ${stage.id}: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
    }
    return { output, retries };
  };

  const pushResult = (stage: WorkflowStage, outcome: { output: string; retries: number }): void => {
    results.push({
      stageId: stage.id,
      strategy: stage.strategy,
      output: outcome.output,
      degraded: outcome.output.trim().length === 0 || outcome.output.startsWith("[WORKFLOW_DEGRADED]"),
      retries: outcome.retries,
      ...(stage.atom !== undefined ? { atom: stage.atom } : {}),
    });
  };

  // 并行窗口上限：无 retry（无信号回退风险）且**同 atom** 的连续阶段才可并行
  // （如 extract 三路分键提取）。非同 atom 阶段（approval-gate 审批门等可能抛
  // 中断的 handler）保持串行——并行组内前序中断时后续阶段已并发执行过，
  // 与"审批门后不再执行"语义不符，故中断型阶段一律不进并行组。
  const MAX_PARALLEL_STAGES = 4;

  for (let index = 0; index < manifest.stages.length; ) {
    // 计算可并行窗口（从当前 stage 起，连续且无 retry、同 atom 的阶段）。
    let window = 1;
    const groupAtom = manifest.stages[index]!.atom;
    while (index + window < manifest.stages.length && window < MAX_PARALLEL_STAGES) {
      const candidate = manifest.stages[index + window]!;
      if (candidate.retry !== undefined || candidate.atom !== groupAtom || groupAtom === undefined) break;
      window += 1;
    }

    if (window > 1) {
      // 并行组：各 stage 独立执行（无 retry → 组内不可能触发信号回退；
      // interrupted 在组内全部完成后按顺序处理，与串行 break 语义一致）。
      const group = manifest.stages.slice(index, index + window);
      const outcomes = await Promise.all(group.map(stage => runStageOnce(stage)));
      let groupInterrupted: WorkflowInterrupt | undefined;
      for (let gi = 0; gi < outcomes.length; gi += 1) {
        const outcome = outcomes[gi]!;
        if (outcome.interrupted) {
          groupInterrupted = outcome.interrupted;
          break;
        }
        pushResult(group[gi]!, outcome);
      }
      if (groupInterrupted) {
        interrupted = groupInterrupted;
        break;
      }
      index += window;
      continue;
    }

    const stage = manifest.stages[index]!;
    const outcome = await runStageOnce(stage);
    if (outcome.interrupted) {
      interrupted = outcome.interrupted;
      break;
    }
    const { output, retries } = outcome;

    // 一致性重试循环（对齐 Mady check_consistency 条件回退边）：输出触发信号时
    // 回退到 rewindTo 阶段重新执行（含中间阶段），覆盖被回退阶段的旧结果与 state。
    if (output.trim().length > 0 && stage.retry !== undefined) {
      const signal = signalFor(stage);
      if (signal !== undefined && signalMatches(output, signal)) {
        const rewindTo = stage.retry.rewindTo ?? stage.id;
        const rewindIndex = stageIds.get(rewindTo)!;
        const rewindCount = (rewindCounts.get(stage.id) ?? 0) + 1;
        const maxRewind = stage.retry.maxRetries ?? 1;
        if (rewindCount > maxRewind) {
          // 超过最大回退次数：保留当前（不一致）输出并继续，标记 degraded。
          results.push({
            stageId: stage.id,
            strategy: stage.strategy,
            output: `[WORKFLOW_RETRY_EXHAUSTED] ${stage.id}: ${output}`,
            degraded: true,
            retries,
            ...(stage.atom !== undefined ? { atom: stage.atom } : {}),
          });
          index += 1;
          continue;
        }
        // 覆盖从 rewindTo 起的结果与 state 键（防陈旧输出被兜底复用），回退重执行。
        rewindCounts.set(stage.id, rewindCount);
        results.splice(rewindIndex);
        for (const rewinded of manifest.stages.slice(rewindIndex)) {
          delete state[rewinded.id];
        }
        index = rewindIndex;
        continue;
      }
    }

    pushResult(stage, { output, retries });
    index += 1;
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

  const result: WorkflowRunResult = {
    manifestId: manifest.id,
    caseType: manifest.caseType,
    completed,
    stages: results,
    degradedSteps,
    summary,
    ...(interrupted ? { interrupted } : {}),
  };
  // 持久化失败不阻断执行结果（对齐工具层“持久化失败仅提示”的语义），
  // 仅把告警带回结果供调用方展示。
  try {
    await options.persist?.saveRun(result, options.runId);
  } catch (error) {
    result.persistWarning = `持久化失败（不影响执行结果）: ${error instanceof Error ? error.message : String(error)}`;
  }
  return result;
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

/**
 * 内置：技术交底书披露分析 manifest（移植 Mady disclosure/graph.go 的 PFE 管线）。
 *
 * PFE（Problem/Feature/Effect）三元组提取：problem/features/effects 三路提取
 * （经 stage.params 分键，互不覆盖）→ merge 融合 → groundedness 原文依据过滤
 * （低分特征反馈）→ 一致性检查（输出含"不一致/矛盾/缺少"信号时回退到提取阶段
 * 重做，最多 1 次）→ 检索关键词生成 → 现有技术检索（prior_art 证据注入）→
 * 逐特征新颖性初判（单独对比原则 + 证据引用）→ 报告 → review_gate 人工复核
 * （中断等待确认）→ draft_claims 直出权利要求草稿。
 *
 * 注意：本 manifest 声明了内置原子（extract / merge / groundedness / keywords /
 * search / novelty / approval-gate / draft-claims），消费方需注入 provider
 * （LLM/检索器）与内置原子注册表（registerBuiltinAtoms）执行。prior-art 注入链
 * （generate_keywords → search → novelty）在 provider.search 缺失时降级
 * （evidence_coverage=none），不中断管线（对齐 Mady fail-open 语义）。
 */
export const patentDisclosureManifest: WorkflowManifest = {
  id: "patent_disclosure_v1",
  name: "技术交底书披露分析",
  caseType: "disclosure_analysis",
  stages: [
    { id: "preprocess", strategy: "chain", description: "预处理技术交底书，分段与去噪" },
    {
      id: "extract_problem",
      strategy: "sub_agent",
      description: "提取待解决的技术问题",
      atom: "extract",
      params: { extraction_type: "提取待解决的技术问题（严格输出 problems 数组）", output_key: "problems" },
    },
    {
      id: "extract_features",
      strategy: "sub_agent",
      description: "提取技术特征",
      atom: "extract",
      params: { extraction_type: "提取技术特征（严格输出 features 数组）", output_key: "features" },
    },
    {
      id: "extract_effects",
      strategy: "sub_agent",
      description: "提取技术效果",
      atom: "extract",
      params: { extraction_type: "提取技术效果（严格输出 effects 数组）", output_key: "effects" },
    },
    { id: "merge", strategy: "chain", description: "融合 PFE 三元组（问题↔特征↔效果交叉引用）", atom: "merge" },
    {
      id: "groundedness",
      strategy: "chain",
      description: "评估提取特征在原文中的依据（低分特征反馈）",
      atom: "groundedness",
    },
    {
      id: "consistency",
      strategy: "chain",
      description: "PFE 一致性检查（特征-效果因果链闭合、无孤立特征）",
      retry: {
        whenOutputMatches: "不一致|矛盾|缺少|孤立",
        rewindTo: "extract_problem",
        maxRetries: 1,
      },
    },
    { id: "generate_keywords", strategy: "chain", description: "生成检索关键词（上位/下位/同义词）", atom: "keywords" },
    { id: "search", strategy: "react", description: "检索现有技术文献（证据片段注入新颖性评估）", atom: "search" },
    {
      id: "novelty",
      strategy: "chain",
      description: "逐特征新颖性初判（单独对比原则 + 证据引用）",
      atom: "novelty",
    },
    { id: "report", strategy: "chain", description: "生成披露分析报告（创新点/保护建议）" },
    {
      id: "review_gate",
      strategy: "chain",
      description: "人工复核披露分析报告（中断等待确认）",
      atom: "approval-gate",
      params: { review_context: "披露分析报告需人工复核后方可继续" },
    },
    {
      id: "draft_claims",
      strategy: "chain",
      description: "基于 PFE 与新颖性结果直出权利要求草稿（独立+从属）",
      atom: "draft-claims",
    },
  ],
  validation: { requireAllSteps: true, maxRetries: 2 },
};

/**
 * 内置：专利创造性分析八阶段 manifest（专利法 A22.3，三步法）。
 *
 * 阶段设计对齐知识资产（src/knowledge/patent/wiki/专利实务/创造性/）与
 * 复审无效实务的模板化论证结构：解析与画像 → 检索与候选筛选 → 三步法
 * 展开为三阶段（最接近现有技术 → 区别特征与实际解决的技术问题 → 技术启示）
 * → 辅助判断因素复核 → 结论与反事后诸葛亮自检 → 人工确认（HITL）。
 *
 * 注意：本 manifest **不声明 atom**（与 patent_novelty_v1 一致）——消费方
 * patent_workflow 工具采用"主代理产出文本 → 工具收口校验"语义（确定性、无
 * LLM）；收口时按 caseType inventiveness_analysis 映射 patent_inventiveness 域
 * 规则门（9 条：三步法/实际解决技术问题/公知常识路径/多文件结合/技术启示/
 * 惯用手段/用途限定/预料不到效果）。需要原子自动执行时，调用方应定义带 atom
 * 的自定义 manifest，并注入已注册内置原子的注册表与 provider（见 src/patent/atoms）。
 */
export const patentInventivenessManifest: WorkflowManifest = {
  id: "patent_inventiveness_v1",
  name: "专利创造性分析",
  caseType: "inventiveness_analysis",
  stages: [
    {
      id: "parse",
      strategy: "chain",
      description: "解析权利要求/技术方案，构建所属领域技术人员画像，确定申请日/优先权日时间基准",
    },
    {
      id: "search",
      strategy: "react",
      description: "检索现有技术文献，筛选最接近现有技术候选（技术领域→技术问题→发明构思）",
    },
    { id: "closest", strategy: "chain", description: "三步法 Step1：确定最接近的现有技术（候选多时逐个试判）" },
    {
      id: "diff",
      strategy: "chain",
      description: "三步法 Step2：实质对比确定区别技术特征，客观确定实际解决的技术问题（不得包含解决手段）",
    },
    {
      id: "hint",
      strategy: "chain",
      description: "三步法 Step3：技术启示判断（改进动机/结合启示/公知常识/发明构思/逻辑推理与有限试验）",
    },
    {
      id: "secondary",
      strategy: "chain",
      description: "辅助判断因素复核（预料不到的技术效果/长期渴望难题/克服技术偏见/商业成功）",
    },
    { id: "conclude", strategy: "chain", description: "生成创造性结论（高/中/低/无，附置信度）+ 反事后诸葛亮自检" },
    { id: "approval", strategy: "chain", description: "人工确认分析结论（HITL）" },
  ],
  validation: { requireAllSteps: true, maxRetries: 2 },
};

/**
 * 内置 manifest 目录（单一数据源）。
 *
 * 消费方（patent_workflow 工具）经此遍历注册 manifest，并按条目读取确定性
 * 规则门检查域（caseType 推导的默认值）——新增内置 manifest 只需在此追加
 * 一项，工具层零改动；检查域与 manifest 同源声明，消除"漏配 → 规则门静默
 * 跳过"的故障模式。自定义 manifest 不在目录内，未显式传 checkDomain 时不
 * 跑规则门（fail-open，文档已声明）。
 */
export type BuiltinPatentManifest = {
  manifest: WorkflowManifest;
  /** 收口时确定性规则门检查域（caseType 推导的默认值）。 */
  checkDomains: readonly string[];
};

export const builtinPatentManifests: readonly BuiltinPatentManifest[] = [
  { manifest: patentNoveltyManifest, checkDomains: ["patent_novelty"] },
  { manifest: patentDisclosureManifest, checkDomains: ["patent_disclosure", "patent_claims"] },
  { manifest: patentInventivenessManifest, checkDomains: ["patent_inventiveness"] },
];
