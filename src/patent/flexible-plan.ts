/**
 * 灵活计划层（移植自 XiaoNuo legal-bus FlexiblePlan + LegalStateMachine 检查点语义）。
 *
 * 阶段级生命周期管理：运行中增删改阶段、逐阶段确认（confirmStage）、回退重做
 * （rollbackStage：目标阶段及其后已确认阶段置 rolled_back 保留审计）、法条判定挂接
 * （attachArticleJudgment：委托 FactBlackboard.setArticleJudgment）。
 *
 * 纯函数 + 守卫：所有方法接收当前 state 返回新 state（stateless，对齐 patent_plan_task
 * 工具契约）；非法操作直接抛 FlexiblePlanError（fail-closed，对齐 FactBlackboard 风格）。
 * toManifest() 生成 WorkflowManifest 交给 runWorkflow 执行——本层只管理计划不执行阶段，
 * 执行结果经 confirmStage / rollbackStage 回流。
 */

import type { ArticleJudgment, FactBlackboard } from "./reasoning/fact-blackboard.js";
import type { WorkflowManifest, WorkflowStage } from "./workflow.js";

/** 阶段状态：pending 未执行 / confirmed 已确认 / rolled_back 曾确认后作废（审计保留）。 */
export type FlexibleStageStatus = "pending" | "confirmed" | "rolled_back";

/** 阶段（对齐 WorkflowStage 的 strategy/atom/params，补阶段级状态）。 */
export type FlexibleStage = {
  id: string;
  name: string;
  goal: string;
  strategy: "chain" | "react" | "sub_agent";
  /** 可选：声明 atom 后 toManifest 生成的阶段交 runWorkflow 原子执行。 */
  atom?: string;
  /** 可选：传递给 StageHandler 的静态参数。 */
  params?: Record<string, unknown>;
  status: FlexibleStageStatus;
  /** 阶段产物清单（供审计/展示）。 */
  artifacts: string[];
  /** 引用 FactBlackboard 规则约束 id。 */
  constraintIds: string[];
  /** 引用 FactBlackboard 法条判定 id（attachArticleJudgment 写入）。 */
  articleJudgments: string[];
};

export type FlexiblePlanStatus = "active" | "completed" | "abandoned";

/** 灵活计划状态快照（纯数据，可 JSON 持久化）。 */
export type FlexiblePlanState = {
  caseId: string;
  /** 对齐 orchestrations id（invalidation / infringement / drafting …）。 */
  caseType: string;
  technicalField?: string;
  status: FlexiblePlanStatus;
  stages: FlexibleStage[];
  /** 当前执行阶段；缺省 = 首个未确认阶段；无待执行阶段时为 undefined。 */
  currentStageId?: string;
  /** abandon 时记录原因（审计）。 */
  abandonReason?: string;
  createdAt: string;
  updatedAt: string;
};

export class FlexiblePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlexiblePlanError";
  }
}

const now = (): string => new Date().toISOString();

export type CreateFlexiblePlanOptions = {
  technicalField?: string;
  /** 初始阶段（新计划全部置 pending）。 */
  stages?: FlexibleStage[];
  /** 可注入时钟（测试用）。 */
  now?: () => string;
};

/** 创建新计划：所有传入阶段强制 pending，currentStageId 指向首个阶段。 */
export function createFlexiblePlan(
  caseId: string,
  caseType: string,
  options: CreateFlexiblePlanOptions = {},
): FlexiblePlanState {
  if (caseId.trim() === "") throw new FlexiblePlanError("caseId 不能为空");
  if (caseType.trim() === "") throw new FlexiblePlanError("caseType 不能为空");

  const nowFn = options.now ?? now;
  const ts = nowFn();
  const stages = (options.stages ?? []).map(s => ({ ...s, status: "pending" as const }));

  const ids = new Set<string>();
  for (const s of stages) {
    if (s.id.trim() === "") throw new FlexiblePlanError("stage.id 不能为空");
    if (ids.has(s.id)) throw new FlexiblePlanError(`重复的阶段 id: ${s.id}`);
    ids.add(s.id);
  }

  return {
    caseId,
    caseType,
    ...(options.technicalField !== undefined ? { technicalField: options.technicalField } : {}),
    status: "active",
    stages,
    currentStageId: stages.length > 0 ? stages[0].id : undefined,
    createdAt: ts,
    updatedAt: ts,
  };
}

/** 追加阶段：新阶段置 pending；计划无当前阶段时指向新阶段。 */
export function addStage(state: FlexiblePlanState, stage: FlexibleStage): FlexiblePlanState {
  assertActive(state);
  if (stage.id.trim() === "") throw new FlexiblePlanError("stage.id 不能为空");
  if (state.stages.some(s => s.id === stage.id)) {
    throw new FlexiblePlanError(`重复的阶段 id: ${stage.id}`);
  }
  const stages = [...state.stages, { ...stage, status: "pending" as const }];
  return {
    ...state,
    stages,
    currentStageId: state.currentStageId ?? stage.id,
    updatedAt: now(),
  };
}

/** 删除阶段：currentStageId 若指向被删阶段则回落到首个未确认阶段。 */
export function removeStage(state: FlexiblePlanState, stageId: string): FlexiblePlanState {
  assertActive(state);
  const idx = findStageIndex(state, stageId);
  const stages = state.stages.filter((_, i) => i !== idx);
  const currentStageId = state.currentStageId === stageId ? firstUnconfirmed(stages) : state.currentStageId;
  return { ...state, stages, currentStageId, updatedAt: now() };
}

/** 重排阶段：stageIds 必须包含全部阶段且无重复（fail-closed）。 */
export function reorderStages(state: FlexiblePlanState, stageIds: string[]): FlexiblePlanState {
  assertActive(state);
  if (stageIds.length !== state.stages.length) {
    throw new FlexiblePlanError("reorderStages: 新顺序必须包含全部阶段");
  }
  const idSet = new Set(stageIds);
  if (idSet.size !== stageIds.length) {
    throw new FlexiblePlanError("reorderStages: 顺序列表不能包含重复 id");
  }
  const byId = new Map(state.stages.map(s => [s.id, s]));
  const stages: FlexibleStage[] = [];
  for (const id of stageIds) {
    const s = byId.get(id);
    if (s === undefined) throw new FlexiblePlanError(`reorderStages: 未知阶段 "${id}"`);
    stages.push(s);
  }
  const currentStageId =
    state.currentStageId !== undefined && idSet.has(state.currentStageId)
      ? state.currentStageId
      : firstUnconfirmed(stages);
  return { ...state, stages, currentStageId, updatedAt: now() };
}

/** 确认阶段：置 confirmed，currentStageId 推进到下一未确认阶段。 */
export function confirmStage(state: FlexiblePlanState, stageId: string): FlexiblePlanState {
  assertActive(state);
  const idx = findStageIndex(state, stageId);
  const stages = state.stages.map((s, i) => (i === idx ? { ...s, status: "confirmed" as const } : s));
  const currentStageId = nextPendingAfter(stages, idx);
  return { ...state, stages, currentStageId, updatedAt: now() };
}

/**
 * 回退重做：目标阶段及其后已确认阶段置 rolled_back（审计保留），目标之前已确认保留，
 * pending 保持；currentStageId 回到目标阶段。
 * 典型场景：发现阶段 N 产出依赖上游错误 → rollback 到 N 重做，N 之前的成果不丢。
 */
export function rollbackStage(state: FlexiblePlanState, stageId: string): FlexiblePlanState {
  assertActive(state);
  const idx = findStageIndex(state, stageId);
  // 目标阶段及其后所有 confirmed 阶段置 rolled_back（审计保留）；目标之前已确认保留，pending 保持。
  const stages = state.stages.map((s, i) =>
    i >= idx && s.status === "confirmed" ? { ...s, status: "rolled_back" as const } : s,
  );
  return { ...state, stages, currentStageId: stageId, updatedAt: now() };
}

/**
 * 挂接法条判定：写入 FactBlackboard（locked 时抛错，fail-closed），并在阶段上记录引用。
 * 法条判定本身由 checker / evidence / agent 产出，本层只负责接线与留痕。
 * 注意：本操作是唯一非纯函数——会写注入的 blackboard（副作用先行，
 * state 构造无失败路径，不会出现半应用）。
 */
export function attachArticleJudgment(
  state: FlexiblePlanState,
  stageId: string,
  judgment: ArticleJudgment,
  blackboard: FactBlackboard,
): FlexiblePlanState {
  assertActive(state);
  const idx = findStageIndex(state, stageId);
  blackboard.setArticleJudgment(judgment);
  const stages = state.stages.map((s, i) => {
    if (i !== idx) return s;
    const articleJudgments = s.articleJudgments.includes(judgment.articleId)
      ? s.articleJudgments
      : [...s.articleJudgments, judgment.articleId];
    return { ...s, articleJudgments };
  });
  return { ...state, stages, updatedAt: now() };
}

/**
 * 生成 WorkflowManifest 交 runWorkflow 执行：过滤 rolled_back 阶段，
 * goal → description，strategy/atom/params 透传。保持"一条声明式路径"原则。
 */
export function toManifest(state: FlexiblePlanState): WorkflowManifest {
  const stages: WorkflowStage[] = state.stages
    .filter(s => s.status !== "rolled_back")
    .map(s => ({
      id: s.id,
      strategy: s.strategy,
      description: s.goal,
      ...(s.atom !== undefined ? { atom: s.atom } : {}),
      ...(s.params !== undefined ? { params: s.params } : {}),
    }));
  return {
    id: `flexible_${state.caseId}`,
    name: `灵活计划 ${state.caseId}`,
    caseType: state.caseType,
    stages,
  };
}

/** 完成计划：全部 pending 置 confirmed（已确认/已回退保留），status → completed。 */
export function complete(state: FlexiblePlanState): FlexiblePlanState {
  assertActive(state);
  const stages = state.stages.map(s => (s.status === "pending" ? { ...s, status: "confirmed" as const } : s));
  return { ...state, status: "completed", stages, currentStageId: undefined, updatedAt: now() };
}

/** 放弃计划：pending 置 rolled_back（已确认保留审计），status → abandoned，记录原因。 */
export function abandon(state: FlexiblePlanState, reason: string): FlexiblePlanState {
  assertActive(state);
  const stages = state.stages.map(s => (s.status === "pending" ? { ...s, status: "rolled_back" as const } : s));
  return {
    ...state,
    status: "abandoned",
    stages,
    currentStageId: undefined,
    abandonReason: reason,
    updatedAt: now(),
  };
}

/** 序列化（检查点持久化）。 */
export function toJSON(state: FlexiblePlanState): string {
  return JSON.stringify(state, null, 2);
}

/** 反序列化（轻量守卫，对齐 validateWorkflowManifest 风格：非法快照抛错）。 */
export function fromJSON(text: string): FlexiblePlanState {
  const data = JSON.parse(text) as FlexiblePlanState;
  if (typeof data.caseId !== "string" || data.caseId.trim() === "") {
    throw new FlexiblePlanError("fromJSON: 非法计划快照（caseId 缺失）");
  }
  if (typeof data.caseType !== "string" || data.caseType.trim() === "") {
    throw new FlexiblePlanError("fromJSON: 非法计划快照（caseType 缺失）");
  }
  if (!Array.isArray(data.stages)) {
    throw new FlexiblePlanError("fromJSON: 非法计划快照（stages 缺失）");
  }
  if (data.status !== "active" && data.status !== "completed" && data.status !== "abandoned") {
    throw new FlexiblePlanError(`fromJSON: 未知计划状态 "${String(data.status)}"`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// 内部守卫
// ---------------------------------------------------------------------------

function assertActive(state: FlexiblePlanState): void {
  if (state.status !== "active") {
    throw new FlexiblePlanError(`计划 ${state.caseId} 状态为 "${state.status}"，仅 active 可变更`);
  }
}

function findStageIndex(state: FlexiblePlanState, stageId: string): number {
  const idx = state.stages.findIndex(s => s.id === stageId);
  if (idx === -1) {
    throw new FlexiblePlanError(`阶段 "${stageId}" 不存在（计划 ${state.caseId}）`);
  }
  return idx;
}

/** 从 fromIndex 之后找第一个未确认阶段。 */
function nextPendingAfter(stages: readonly FlexibleStage[], fromIndex: number): string | undefined {
  for (let i = fromIndex + 1; i < stages.length; i += 1) {
    const s = stages[i];
    if (s !== undefined && s.status !== "confirmed") return s.id;
  }
  return undefined;
}

/** 从头找第一个未确认阶段（无待执行阶段时为 undefined）。 */
function firstUnconfirmed(stages: readonly FlexibleStage[]): string | undefined {
  return stages.find(s => s.status !== "confirmed")?.id;
}
