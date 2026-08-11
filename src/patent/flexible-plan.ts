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
 *
 * ⚠️ 接线状态（2026-08）：本层自身**未接入独立工具**——`patent_plan_task` 工具
 * 走的是 plantask.ts 状态机，与本层无关。但**原子执行消费路径已打通**：
 * toManifest() 产出的 manifest 可被 runWorkflow 以全局原子注册表 + provider
 * 自动执行（集成测试见 tests/patent/flexible-plan-atomic.spec.ts），
 * 执行结果经 confirmStage / rollbackStage 回流。接入 `flexible_plan` 工具
 * （创建计划 → 原子执行 → 逐阶段确认）时，可复用 patent_workflow_run 的
 * provider 装配（LLM + nuo-patent 检索）。
 */

import {
  HIGH_CONFIDENCE_THRESHOLD,
  classifyIpcTop,
  getIpcDomain,
  type IpcClassification,
} from "../knowledge/patent/ipc-classifier.js";
import { SAFE_ID_PATTERN } from "./persist-utils.js";
import type { ArticleJudgment, FactBlackboard } from "./reasoning/fact-blackboard.js";
import type { WorkflowManifest, WorkflowStage } from "./workflow.js";
import { manifestToGraph, type CompiledGraph, type ManifestToGraphDeps } from "./graph/index.js";

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
  /**
   * 案件原始输入文本（如技术交底书摘要、权利要求主题）。
   * 当 technicalField 未显式指定时，用于自动推断 IPC 技术领域。
   */
  inputText?: string;
  /** 可注入的 IPC 分类器（测试用）。 */
  classifier?: (text: string) => IpcClassification;
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
  // 与存储层同款字符集校验（fail-closed 前移）：savePlan 之前就把路径注入
  // 类 caseId 拒之门外，避免"创建成功、持久化时 RangeError"的接受-拒绝分裂。
  if (!SAFE_ID_PATTERN.test(caseId)) {
    throw new FlexiblePlanError(`caseId ${JSON.stringify(caseId)} 含非法字符（仅允许 [A-Za-z0-9._-] 且不以点开头）`);
  }

  const nowFn = options.now ?? now;
  const ts = nowFn();
  const stages = (options.stages ?? []).map(s => ({ ...s, status: "pending" as const }));

  const ids = new Set<string>();
  for (const s of stages) {
    if (s.id.trim() === "") throw new FlexiblePlanError("stage.id 不能为空");
    if (ids.has(s.id)) throw new FlexiblePlanError(`重复的阶段 id: ${s.id}`);
    ids.add(s.id);
  }

  const technicalField =
    options.technicalField !== undefined
      ? options.technicalField
      : inferTechnicalField(options.inputText ?? "", options.classifier);

  return {
    caseId,
    caseType,
    ...(technicalField !== undefined ? { technicalField } : {}),
    status: "active",
    stages,
    currentStageId: stages.length > 0 ? stages[0].id : undefined,
    createdAt: ts,
    updatedAt: ts,
  };
}

/** 把 IPC 分类结果格式化为 technicalField（例：H:电学 / H01:基本电气元件）。 */
export function formatTechnicalField(classification: IpcClassification): string {
  const sectionName = getIpcDomain(classification.section)?.name ?? classification.section;
  const detail = classification.detail;
  const code = detail ? `${classification.section} ${detail}` : classification.section;
  const label = detail ? `${sectionName}-${classification.detail}` : sectionName;
  return `${code}:${label}`;
}

/**
 * 根据案件输入文本推断技术领域。
 * 置信度低于高置信阈值时返回 undefined（避免低质量注入）。
 */
export function inferTechnicalField(
  inputText: string,
  classifier: (text: string) => IpcClassification = classifyIpcTop,
): string | undefined {
  if (!inputText.trim()) return undefined;
  const top = classifier(inputText);
  if (top.confidence < HIGH_CONFIDENCE_THRESHOLD) return undefined;
  return formatTechnicalField(top);
}

/** 判断 IPC 分类是否属于电学（H 部）。 */
export function isElectricalIpc(classification: IpcClassification): boolean {
  return classification.section.toUpperCase() === "H";
}

/** 判断案件输入是否被识别为电学领域（H 部）。 */
export function isElectricalCase(inputText: string): boolean {
  if (!inputText.trim()) return false;
  return isElectricalIpc(classifyIpcTop(inputText));
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

/** 确认阶段：置 confirmed，currentStageId 指向首个未确认阶段。 */
export function confirmStage(state: FlexiblePlanState, stageId: string): FlexiblePlanState {
  assertActive(state);
  const idx = findStageIndex(state, stageId);
  const stages = state.stages.map((s, i) => (i === idx ? { ...s, status: "confirmed" as const } : s));
  // 从头扫描而非从被确认阶段之后扫描：乱序确认（提前确认 s3）时，
  // 更早的 pending 阶段仍须保留在待执行窗口，不能把指针推到 undefined。
  const currentStageId = firstUnconfirmed(stages);
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
  const target = state.stages[idx];
  if (target === undefined) {
    throw new FlexiblePlanError(`阶段 "${stageId}" 不存在（计划 ${state.caseId}）`);
  }
  // 黑板必须属于同一案件：不同 case 的法条事实混入会把判定写进错误的
  // 案件事实库，且本案件的执行永远看不到它（按 articleId 键控，零校验）。
  if (blackboard.caseId !== state.caseId || blackboard.caseType !== state.caseType) {
    throw new FlexiblePlanError(
      `attachArticleJudgment: 黑板属于 ${blackboard.caseId}/${blackboard.caseType}，` +
        `与计划 ${state.caseId}/${state.caseType} 不一致`,
    );
  }
  // 作废（rolled_back）阶段不再接收新判定：回滚后判定随阶段一并失效。
  if (target.status === "rolled_back") {
    throw new FlexiblePlanError(`阶段 "${stageId}" 已回退作废，不接受新法条判定`);
  }
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
 * 生成 WorkflowManifest 交 runWorkflow 执行：只发射未完成阶段
 * （pending 待执行 + rolled_back 回退后待重做），confirmed 已确认不重复执行；
 * goal → description，strategy/atom/params 透传。保持"一条声明式路径"原则。
 */
export function toManifest(state: FlexiblePlanState): WorkflowManifest {
  assertActive(state);
  const stages: WorkflowStage[] = state.stages
    .filter(s => s.status !== "confirmed")
    .map(s => ({
      id: s.id,
      strategy: s.strategy,
      description: s.goal,
      ...(s.atom !== undefined ? { atom: s.atom } : {}),
      ...(s.params !== undefined ? { params: s.params } : {}),
    }));
  // 无待执行阶段：空 manifest 会让 runWorkflow 抛 WorkflowError（执行层错误），
  // 在计划层提前以 FlexiblePlanError 拒绝，语义更准确（fail-closed）。
  if (stages.length === 0) {
    throw new FlexiblePlanError(`计划 ${state.caseId} 没有待执行阶段（全部已确认）`);
  }
  return {
    id: `flexible_${state.caseId}`,
    name: `灵活计划 ${state.caseId}`,
    caseType: state.caseType,
    stages,
  };
}

/**
 * 灵活计划 → 可执行图（toManifest + manifestToGraph 一步到位）。
 * 图执行（runGraph / runGraphWithCheckpoints）后经 confirmStage / rollbackStage
 * 回流，语义与 toManifest → runWorkflow 一致；声明 atom 的阶段由图引擎自动执行。
 */
export function toCompiledGraph(state: FlexiblePlanState, deps: ManifestToGraphDeps = {}): CompiledGraph {
  return manifestToGraph(toManifest(state), deps);
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
  // 原因用于审计，空值会让 abandonReason 缺失/不可追溯——fail-closed。
  if (reason.trim() === "") {
    throw new FlexiblePlanError("abandon: reason 不能为空");
  }
  const stages = state.stages.map(s => (s.status === "pending" ? { ...s, status: "rolled_back" as const } : s));
  return {
    ...state,
    status: "abandoned",
    stages,
    currentStageId: undefined,
    abandonReason: reason.trim(),
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
  // caseId 字符集与存储层一致：含路径分隔符的快照在 savePlan 必然 RangeError，
  // 解析时提前拒绝，错误类型统一为 FlexiblePlanError。
  if (!SAFE_ID_PATTERN.test(data.caseId)) {
    throw new FlexiblePlanError(
      `fromJSON: caseId ${JSON.stringify(data.caseId)} 含非法字符（仅允许 [A-Za-z0-9._-] 且不以点开头）`,
    );
  }
  if (typeof data.caseType !== "string" || data.caseType.trim() === "") {
    throw new FlexiblePlanError("fromJSON: 非法计划快照（caseType 缺失）");
  }
  if (data.status !== "active" && data.status !== "completed" && data.status !== "abandoned") {
    throw new FlexiblePlanError(`fromJSON: 未知计划状态 "${String(data.status)}"`);
  }
  if (!Array.isArray(data.stages)) {
    throw new FlexiblePlanError("fromJSON: 非法计划快照（stages 缺失）");
  }
  const ids = new Set<string>();
  for (const stage of data.stages) {
    if (typeof stage !== "object" || stage === null) {
      throw new FlexiblePlanError("fromJSON: 非法计划快照（stages 含非对象元素）");
    }
    if (typeof stage.id !== "string" || stage.id.trim() === "") {
      throw new FlexiblePlanError("fromJSON: 非法计划快照（stage.id 缺失）");
    }
    if (ids.has(stage.id)) {
      throw new FlexiblePlanError(`fromJSON: 重复的阶段 id: ${stage.id}`);
    }
    ids.add(stage.id);
    if (typeof stage.name !== "string") {
      throw new FlexiblePlanError(`fromJSON: 阶段 ${stage.id} 的 name 非法`);
    }
    if (typeof stage.goal !== "string" || stage.goal.trim() === "") {
      throw new FlexiblePlanError(`fromJSON: 阶段 ${stage.id} 缺少 goal`);
    }
    if (stage.strategy !== "chain" && stage.strategy !== "react" && stage.strategy !== "sub_agent") {
      throw new FlexiblePlanError(`fromJSON: 阶段 ${stage.id} 的 strategy 非法`);
    }
    if (stage.status !== "pending" && stage.status !== "confirmed" && stage.status !== "rolled_back") {
      throw new FlexiblePlanError(`fromJSON: 阶段 ${stage.id} 的 status 非法`);
    }
    if (!Array.isArray(stage.artifacts)) {
      throw new FlexiblePlanError(`fromJSON: 阶段 ${stage.id} 的 artifacts 非法`);
    }
    if (!Array.isArray(stage.constraintIds)) {
      throw new FlexiblePlanError(`fromJSON: 阶段 ${stage.id} 的 constraintIds 非法`);
    }
    if (!Array.isArray(stage.articleJudgments)) {
      throw new FlexiblePlanError(`fromJSON: 阶段 ${stage.id} 的 articleJudgments 非法`);
    }
  }
  if (data.currentStageId !== undefined && !ids.has(data.currentStageId)) {
    throw new FlexiblePlanError(`fromJSON: currentStageId "${String(data.currentStageId)}" 不属于任何阶段`);
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

/** 从头找第一个未确认阶段（无待执行阶段时为 undefined）。 */
function firstUnconfirmed(stages: readonly FlexibleStage[]): string | undefined {
  return stages.find(s => s.status !== "confirmed")?.id;
}
