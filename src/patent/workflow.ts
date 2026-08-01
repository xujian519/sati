/**
 * 声明式工作流执行器（移植自 Mady workflows/patent_novelty.yaml + manifest.go）。
 *
 * 设计原则（吸取 Mady 教训：5 条执行路径并存导致"看起来实现但从未运行"）：
 * 只保留一条声明式路径 —— WorkflowManifest（JSON/YAML 可序列化）+ 单一执行器 runWorkflow。
 * 内置 patent_novelty_v1 manifest（五阶段 + novelty_chain 模板镜像）。
 */

export type WorkflowStrategy = "chain" | "react" | "sub_agent";

export type WorkflowStage = {
  id: string;
  strategy: WorkflowStrategy;
  description: string;
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
  /** 案例目录或案例 ID，用于输入输出路径（可含 {caseId}） */
  caseId?: string;
  /** 用户输入/初始事实 */
  input?: string;
  [key: string]: unknown;
};

export type StageExecutor = (stage: WorkflowStage, ctx: WorkflowContext) => Promise<string>;

export type WorkflowStageResult = {
  stageId: string;
  strategy: WorkflowStrategy;
  output: string;
  /** 该步骤是否降级（无输出时标记，不中断流程） */
  degraded: boolean;
  retries: number;
};

export type WorkflowRunResult = {
  manifestId: string;
  caseType: string;
  completed: boolean;
  stages: WorkflowStageResult[];
  /** 未产生输出的步骤 id */
  degradedSteps: string[];
  summary: string;
};

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

/** Manifest 校验（轻量守卫，替代 zod）：非法即抛错。 */
export function validateWorkflowManifest(manifest: WorkflowManifest): void {
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
  }
}

/**
 * 单一执行器：按顺序执行各阶段，输出为空时标记 degraded 而非中断。
 * executor 由调用方注入（chain 阶段走确定性逻辑，react/sub_agent 阶段走 LLM/子代理）。
 */
export async function runWorkflow(
  manifest: WorkflowManifest,
  ctx: WorkflowContext,
  executor: StageExecutor,
): Promise<WorkflowRunResult> {
  validateWorkflowManifest(manifest);
  const requireAll = manifest.validation?.requireAllSteps ?? true;
  const maxRetries = manifest.validation?.maxRetries ?? 2;

  const results: WorkflowStageResult[] = [];
  for (const stage of manifest.stages) {
    let output = "";
    let retries = 0;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        output = (await executor(stage, ctx)) ?? "";
        if (output.trim().length > 0) break;
        lastError = new Error("阶段执行未产生输出");
      } catch (err) {
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
      // 保留错误信息到输出，便于诊断；仍标记 degraded
      output = `[阶段 ${stage.id} 执行失败] ${lastError instanceof Error ? lastError.message : String(lastError)}`;
    }
    results.push({
      stageId: stage.id,
      strategy: stage.strategy,
      output,
      degraded: output.trim().length === 0 || output.startsWith("[阶段"),
      retries,
    });
  }

  const degradedSteps = results.filter(r => r.degraded).map(r => r.stageId);
  const completed = !requireAll || degradedSteps.length === 0;
  const okCount = results.filter(r => !r.degraded).length;

  return {
    manifestId: manifest.id,
    caseType: manifest.caseType,
    completed,
    stages: results,
    degradedSteps,
    summary: `工作流 ${manifest.id}（${manifest.name}）: ${okCount}/${results.length} 阶段完成${degradedSteps.length > 0 ? `，降级阶段: ${degradedSteps.join("、")}` : ""}`,
  };
}

/** 内置：专利新颖性分析五阶段 manifest（镜像 Mady patent_novelty.yaml 与 novelty_chain 模板）。 */
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
