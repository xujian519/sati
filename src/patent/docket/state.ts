/**
 * 案卷轮次状态机（docket，P0-1：案卷级迭代循环）。
 *
 * 与 flexible-plan 分层：flexible-plan 管理**阶段**生命周期（确认/回退），
 * docket 管理**案卷轮次**——缺口问题清单 → 修订派工 → 轮次上限 → 定稿门控。
 * 竞品调研（patent-docket 类纯文本技能）验证了"缺口最多改 N 轮，超轮升级人工"
 * 是专利代理实务的真实节奏；纯文本方案无强制力，这里落成状态机。
 *
 * 纯函数 + 守卫（对齐 flexible-plan.ts 风格）：所有方法接收当前 state 返回新
 * state（stateless）；非法操作抛 DocketError（fail-closed）。执行归 flexible_plan
 * 工具（run/confirm/rollback 回流），本层只管理案卷状态。
 */

import { SAFE_ID_PATTERN } from "../persist-utils.js";

/** 案卷阶段：open 在办 / finalized 已定稿 / abandoned 已放弃。 */
export type DocketPhase = "open" | "finalized" | "abandoned";

/** 缺口问题（修订轮次的驱动单元；resolved 后保留审计）。 */
export type GapQuestion = {
  /** 案卷内唯一标识（setGapQuestions 按 id 或原文匹配置位）。 */
  id: string;
  question: string;
  /** 问题来源（检索缺证据 / 交底缺参数 / 审查意见质疑……）。 */
  source?: string;
  resolved: boolean;
  /** 解决该问题的修订轮次号（recordRevision 写入）。 */
  resolvedRound?: number;
};

/** 单轮修订记录（答案摘要 + 阶段产物归档路径）。 */
export type RevisionRecord = {
  round: number;
  at: string;
  /** 本轮回答的缺口问题 id 列表。 */
  answered: string[];
  /** 答案摘要（自由文本，供代理人回看）。 */
  notes?: string;
  /** 归档目录（revisions/round-N/，相对/绝对由工具层解析）。 */
  archiveDir?: string;
  /** 本轮纳入归档的产物名列表。 */
  artifacts: string[];
};

export type DocketState = {
  caseId: string;
  caseType: string;
  /** 已完成的修订轮次数。 */
  round: number;
  /** 修订轮次上限（默认 3；create 可覆盖）。 */
  maxRounds: number;
  phase: DocketPhase;
  /** 关联 flexible-plan 的 caseId（缺省与 caseId 相同）。 */
  linkedPlanCaseId?: string;
  gaps: GapQuestion[];
  revisions: RevisionRecord[];
  /** 创建时记录案件摘要（可选，展示用）。 */
  notes?: string;
  /** abandon 时记录原因（审计）。 */
  abandonReason?: string;
  /** finalize 时间（审计）。 */
  finalizedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export class DocketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocketError";
  }
}

const now = (): string => new Date().toISOString();

/** 默认修订轮次上限（竞品同款经验值；create 可覆盖）。 */
export const DEFAULT_MAX_ROUNDS = 3;

export type CreateDocketOptions = {
  maxRounds?: number;
  linkedPlanCaseId?: string;
  notes?: string;
  /** 初始缺口问题（resolved 字段由状态机强制置 false）。 */
  gaps?: Array<{ id: string; question: string; source?: string }>;
  /** 可注入时钟（测试用）。 */
  now?: () => string;
};

/** 创建案卷：phase=open、round=0；缺口全部置未解决。 */
export function createDocket(caseId: string, caseType: string, options: CreateDocketOptions = {}): DocketState {
  if (caseId.trim() === "") throw new DocketError("caseId 不能为空");
  if (caseType.trim() === "") throw new DocketError("caseType 不能为空");
  // 与 flexible-plan 同款字符集校验：caseId 直接拼入文件路径，fail-closed 前移。
  if (!SAFE_ID_PATTERN.test(caseId)) {
    throw new DocketError(`caseId ${JSON.stringify(caseId)} 含非法字符（仅允许 [A-Za-z0-9._-] 且不以点开头）`);
  }
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new DocketError(`maxRounds 必须为正整数（收到 ${String(options.maxRounds)}）`);
  }
  const ts = (options.now ?? now)();
  const gaps = (options.gaps ?? []).map(g => gapOrThrow({ ...g, resolved: false }));
  assertUniqueGapIds(gaps);
  return {
    caseId,
    caseType,
    round: 0,
    maxRounds,
    phase: "open",
    ...(options.linkedPlanCaseId !== undefined ? { linkedPlanCaseId: options.linkedPlanCaseId } : {}),
    gaps,
    revisions: [],
    ...(options.notes !== undefined && options.notes.trim() !== "" ? { notes: options.notes } : {}),
    createdAt: ts,
    updatedAt: ts,
  };
}

/**
 * 设置/合并缺口问题清单（intake 与每轮修订后刷新）。
 * 合并语义：同 id 视为重开/更新问题文本（resolved 重置为 false——已确认的缺口
 * 再次出现就是新缺口）；未提到的既有问题保持原状态；新 id 追加为未解决。
 */
export function setGapQuestions(
  state: DocketState,
  gaps: Array<{ id: string; question: string; source?: string }>,
): DocketState {
  assertOpen(state);
  // 输入内部重复 id：两条不同问题撞同一键会静默后者覆盖前者（丢数据），fail-closed。
  assertUniqueGapIds(gaps.map(g => gapOrThrow(g)));
  const next = [...state.gaps];
  for (const incoming of gaps) {
    const g = gapOrThrow(incoming);
    const idx = next.findIndex(s => s.id === g.id);
    if (idx === -1) {
      next.push(g);
    } else {
      // 重开：文本更新 + resolved 置回（保留历史轮次号无意义，清掉）。
      next[idx] = { ...next[idx]!, question: g.question, source: g.source ?? next[idx]!.source, resolved: false };
      delete next[idx]!.resolvedRound;
    }
  }
  assertUniqueGapIds(next);
  return { ...state, gaps: next, updatedAt: now() };
}

/** 修订派工单（triageDocket 产物：下一轮该做什么）。 */
export type TriageNext =
  | { kind: "draft"; note?: string }
  | { kind: "revise"; round: number; openGaps: GapQuestion[] }
  | { kind: "finalize_ready" }
  | { kind: "escalate_human"; openGaps: GapQuestion[] };

/**
 * 分诊：只读推导下一步动作，不改状态。
 * 规则：无缺口且已建立计划语境→finalize_ready 由调用方自行决定，本函数给事实：
 * - openGaps 为空：返回 finalize_ready；
 * - 有缺口且 round < maxRounds：返回 revise(round+1, 未决清单)；
 * - 有缺口且 round >= maxRounds：返回 escalate_human（**不静默继续**）。
 * 缺口清零前禁止 finalize 的强制点在 finalizeDocket() 里，不在这里。
 */
export function triageDocket(state: DocketState): { docket: DocketState; next: TriageNext } {
  assertOpen(state);
  const openGaps = state.gaps.filter(g => !g.resolved);
  if (openGaps.length === 0) {
    // 尚未跑过任何一轮且从未登记缺口：先起草（draft），起草后经 setGapQuestions 补缺口。
    if (state.round === 0 && state.gaps.length === 0) {
      return { docket: state, next: { kind: "draft" } };
    }
    return { docket: state, next: { kind: "finalize_ready" } };
  }
  if (state.round >= state.maxRounds) {
    return { docket: state, next: { kind: "escalate_human", openGaps } };
  }
  return { docket: state, next: { kind: "revise", round: state.round + 1, openGaps } };
}

export type RecordRevisionInput = {
  /** 本轮回答的缺口问题（id 或问题原文均可匹配）。 */
  answered: string[];
  notes?: string;
  /** 本轮阶段产物（内容由归档层处理；本层只记录名称）。 */
  artifacts?: string[];
};

/**
 * 记录一轮修订：round+1，被回答的缺口置 resolved（记录轮次号），未回答缺口保留。
 * 轮次已达上限时抛 DocketError（fail-closed，由 triageDocket 的 escalate_human 兜住话术）。
 */
export function recordRevision(state: DocketState, input: RecordRevisionInput): DocketState {
  assertOpen(state);
  if (state.round >= state.maxRounds) {
    throw new DocketError(
      `案卷 ${state.caseId} 修订轮次已达上限 ${state.maxRounds}，请升级人工处理（triageDocket → escalate_human）`,
    );
  }
  if (input.answered.length === 0) {
    throw new DocketError("recordRevision: answered 不能为空（本轮没有回答任何缺口？）");
  }
  const round = state.round + 1;
  const answerKeys = new Set(input.answered.map(a => a.trim()).filter(a => a !== ""));
  if (answerKeys.size === 0) throw new DocketError("recordRevision: answered 全部为空白项");
  const gaps = state.gaps.map(g => {
    if (g.resolved) return g;
    if (answerKeys.has(g.id) || answerKeys.has(g.question.trim())) {
      return { ...g, resolved: true, resolvedRound: round };
    }
    return g;
  });
  const answeredIds = gaps.filter(g => g.resolved && g.resolvedRound === round).map(g => g.id);
  if (answeredIds.length === 0) {
    throw new DocketError(`recordRevision: answered 与案卷 ${state.caseId} 的未决缺口均不匹配`);
  }
  const revisions: RevisionRecord[] = [
    ...state.revisions,
    {
      round,
      at: now(),
      answered: answeredIds,
      ...(input.notes !== undefined && input.notes.trim() !== "" ? { notes: input.notes } : {}),
      artifacts: [...new Set(input.artifacts ?? [])],
    },
  ];
  return { ...state, round, gaps, revisions, updatedAt: now() };
}

/**
 * 定稿门控：缺口未清零禁止定稿（fail-closed）。定稿保留 revisions/gaps 快照审计。
 */
export function finalizeDocket(state: DocketState, notes?: string): DocketState {
  assertOpen(state);
  const openGaps = state.gaps.filter(g => !g.resolved);
  if (openGaps.length > 0) {
    throw new DocketError(
      `finalize: 案卷 ${state.caseId} 仍有 ${openGaps.length} 个未决缺口（${openGaps
        .slice(0, 3)
        .map(g => g.id)
        .join(", ")}${openGaps.length > 3 ? " …" : ""}），缺口清零后方可定稿`,
    );
  }
  if (state.round === 0 && state.revisions.length === 0) {
    // 一轮修订都没有：直接"定稿"通常是绕过流程，fail-closed 提示走 confirm 计划收尾。
    throw new DocketError(`finalize: 案卷 ${state.caseId} 尚未记录任何修订轮次（round=0）`);
  }
  return {
    ...state,
    phase: "finalized",
    finalizedAt: now(),
    ...(notes !== undefined && notes.trim() !== "" ? { notes: notes.trim() } : {}),
    updatedAt: now(),
  };
}

/** 放弃案卷：记录原因（审计），终态不可再变更。 */
export function abandonDocket(state: DocketState, reason: string): DocketState {
  assertOpen(state);
  if (reason.trim() === "") {
    throw new DocketError("abandonDocket: reason 不能为空");
  }
  return { ...state, phase: "abandoned", abandonReason: reason.trim(), updatedAt: now() };
}

/** 序列化（检查点持久化）。 */
export function docketToJSON(state: DocketState): string {
  return JSON.stringify(state, null, 2);
}

/** 反序列化（轻量守卫，对齐 flexible-plan fromJSON 风格：非法快照抛 DocketError）。 */
export function docketFromJSON(text: string): DocketState {
  const data = JSON.parse(text) as DocketState;
  if (typeof data.caseId !== "string" || data.caseId.trim() === "") {
    throw new DocketError("docketFromJSON: 非法案卷快照（caseId 缺失）");
  }
  if (!SAFE_ID_PATTERN.test(data.caseId)) {
    throw new DocketError(
      `docketFromJSON: caseId ${JSON.stringify(data.caseId)} 含非法字符（仅允许 [A-Za-z0-9._-] 且不以点开头）`,
    );
  }
  if (typeof data.caseType !== "string" || data.caseType.trim() === "") {
    throw new DocketError("docketFromJSON: 非法案卷快照（caseType 缺失）");
  }
  if (data.phase !== "open" && data.phase !== "finalized" && data.phase !== "abandoned") {
    throw new DocketError(`docketFromJSON: 未知案卷阶段 "${String(data.phase)}"`);
  }
  if (!Number.isInteger(data.round) || data.round < 0) {
    throw new DocketError(`docketFromJSON: round 非法（${String(data.round)}）`);
  }
  if (!Number.isInteger(data.maxRounds) || (data.maxRounds as number) < 1) {
    throw new DocketError(`docketFromJSON: maxRounds 非法（${String(data.maxRounds)}）`);
  }
  if (data.round > data.maxRounds) {
    throw new DocketError(`docketFromJSON: round(${data.round}) 超过 maxRounds(${data.maxRounds})`);
  }
  if (!Array.isArray(data.gaps)) throw new DocketError("docketFromJSON: 非法案卷快照（gaps 缺失）");
  for (const g of data.gaps) {
    if (typeof g?.id !== "string" || g.id.trim() === "") throw new DocketError("docketFromJSON: gap.id 非法");
    if (typeof g.question !== "string" || g.question.trim() === "") {
      throw new DocketError(`docketFromJSON: 缺口 ${g.id} 缺少 question`);
    }
    if (typeof g.resolved !== "boolean") throw new DocketError(`docketFromJSON: 缺口 ${g.id} 的 resolved 非法`);
  }
  assertUniqueGapIds(data.gaps);
  if (!Array.isArray(data.revisions)) throw new DocketError("docketFromJSON: 非法案卷快照（revisions 缺失）");
  for (const r of data.revisions) {
    if (!Number.isInteger(r?.round) || (r.round as number) < 1) {
      throw new DocketError(`docketFromJSON: 修订记录 round 非法（${String(r.round)}）`);
    }
    if (!Array.isArray(r.answered)) throw new DocketError(`docketFromJSON: 修订轮 ${r.round} 的 answered 非法`);
    if (!Array.isArray(r.artifacts)) throw new DocketError(`docketFromJSON: 修订轮 ${r.round} 的 artifacts 非法`);
  }
  if (data.phase === "finalized" && data.gaps.some(g => !g.resolved)) {
    throw new DocketError("docketFromJSON: finalized 快照仍有未决缺口（违反定稿门控）");
  }
  return data;
}

// ---------------------------------------------------------------------------
// 内部守卫
// ---------------------------------------------------------------------------

function gapOrThrow(g: { id: string; question: string; source?: string; resolved?: boolean }): GapQuestion {
  if (g.id.trim() === "") throw new DocketError("gap.id 不能为空");
  if (g.question.trim() === "") throw new DocketError(`缺口 ${g.id} 的 question 不能为空`);
  return {
    id: g.id.trim(),
    question: g.question.trim(),
    ...(g.source !== undefined && g.source.trim() !== "" ? { source: g.source.trim() } : {}),
    resolved: g.resolved ?? false,
  };
}

function assertUniqueGapIds(gaps: readonly GapQuestion[]): void {
  const seen = new Set<string>();
  for (const g of gaps) {
    if (seen.has(g.id)) throw new DocketError(`重复的缺口 id: ${g.id}`);
    seen.add(g.id);
  }
}

function assertOpen(state: DocketState): void {
  if (state.phase !== "open") {
    throw new DocketError(`案卷 ${state.caseId} 状态为 "${state.phase}"，仅 open 可变更`);
  }
}
