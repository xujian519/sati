import { join } from "node:path";
import {
  abandon,
  addStage,
  complete,
  confirmStage,
  createFlexiblePlan,
  FlexiblePlanError,
  removeStage,
  reorderStages,
  rollbackStage,
  toManifest,
  JsonFileFlexiblePlanStore,
  JsonFileWorkflowRunStore,
  runWorkflow,
  type FlexiblePlanState,
  type FlexiblePlanStore,
  type FlexibleStage,
} from "../../patent/index.js";
import { globalAtomRegistry, globalStageHandlerRegistry } from "../../patent/atoms/index.js";
import type { SatiJsonSchema } from "../protocol/schema.js";
import type { SatiToolDefinition } from "../protocol/types.js";
import {
  buildWorkflowProvider,
  buildWorkflowRunContext,
  renderWorkflowResultText,
  resolveRunPersistTarget,
  resolveWorkflowRunsDir,
  writeRunArtifacts,
  type WorkflowProviderDeps,
} from "./patentWorkflowTool.js";

/**
 * `flexible_plan` — 灵活计划工具（阶段级 HITL：创建计划 → 原子执行 → 逐阶段确认/回退）。
 *
 * 接线 flexible-plan.ts 状态机：create 建计划（可选 IPC 技术领域推断），run 把未确认
 * 阶段经 toManifest 交 runWorkflow 原子执行（provider 装配与 patent_workflow_run 共享
 * buildWorkflowProvider：LLM + nuo-patent 检索），confirm/rollback 逐阶段确认或回退重做，
 * add/remove/reorder 运行时增删改阶段，complete/abandon 收尾。计划按 caseId 持久化
 * （JsonFileFlexiblePlanStore，<caseDir>/workflow-runs/flexible-plans/），跨调用状态由
 * 工具自身管理（区别于 patent_plan_task 的无状态透传）。
 *
 * 语义：run 只执行未确认阶段（pending 待执行 + rolled_back 待重做）；确认才固化产物，
 * 未确认阶段下次 run 会重新执行。autoConfirm=true 时 run 结束自动确认全部成功阶段。
 */

export type FlexiblePlanAction =
  | "create"
  | "get"
  | "run"
  | "confirm"
  | "rollback"
  | "add"
  | "remove"
  | "reorder"
  | "complete"
  | "abandon";

/** 阶段定义（工具侧输入；status/artifacts 等由状态机补齐）。 */
export type FlexiblePlanStageInput = {
  id: string;
  name: string;
  goal: string;
  strategy: "chain" | "react" | "sub_agent";
  /** 可选：声明 atom 后 run 时交原子执行。 */
  atom?: string;
  /** 可选：传递给 StageHandler 的静态参数。 */
  params?: Record<string, unknown>;
  artifacts?: string[];
  constraintIds?: string[];
  articleJudgments?: string[];
};

export type FlexiblePlanToolInput = {
  action: FlexiblePlanAction;
  /** 计划主键（全部操作必需；持久化按此键控）。 */
  caseId?: string;
  /** 对齐 orchestrations id（create 必需）。 */
  caseType?: string;
  /** 案件原始输入文本（create 时持久化供 run 复用；run 可覆盖）。 */
  inputText?: string;
  /** 显式技术领域（create 可选；缺省由 inputText 推断 IPC 领域）。 */
  technicalField?: string;
  /** 阶段定义（create / add）。 */
  stages?: FlexiblePlanStageInput[];
  /** 单个阶段定义（add）。 */
  stage?: FlexiblePlanStageInput;
  /** 目标阶段 id（confirm / rollback / remove）。 */
  stageId?: string;
  /** 新顺序（reorder，须含全部阶段 id）。 */
  stageIds?: string[];
  /** 放弃原因（abandon 必需，审计留痕）。 */
  reason?: string;
  /** run 检索结果上限（缺省 5）。 */
  maxResults?: number;
  /** run 结束后自动确认全部成功（非降级）阶段。 */
  autoConfirm?: boolean;
};

/** provider 装配字段（model/provider/modelId/search）单一来源见 patentWorkflowTool 的 WorkflowProviderDeps。 */
export type FlexiblePlanToolDeps = WorkflowProviderDeps & {
  /** 阶段处理器注册表（缺省全局注册表——registerBuiltinAtoms 已装配内置原子）。 */
  handlers?: typeof globalStageHandlerRegistry;
  /** 计划存储（缺省 JsonFileFlexiblePlanStore：<caseDir>/workflow-runs/flexible-plans/）。 */
  store?: FlexiblePlanStore;
  /** 可注入时钟（测试用）。 */
  now?: () => string;
};

/** 工具输入 → 状态机阶段（补齐 status/artifacts/constraintIds/articleJudgments）。 */
function toFlexibleStage(s: FlexiblePlanStageInput): FlexibleStage {
  return {
    id: s.id,
    name: s.name,
    goal: s.goal,
    strategy: s.strategy,
    ...(s.atom !== undefined ? { atom: s.atom } : {}),
    ...(s.params !== undefined ? { params: s.params } : {}),
    status: "pending",
    artifacts: s.artifacts ?? [],
    constraintIds: s.constraintIds ?? [],
    articleJudgments: s.articleJudgments ?? [],
  };
}

/** 渲染计划摘要（状态/技术领域/当前阶段 + 阶段列表）。 */
function renderPlan(plan: FlexiblePlanState): string {
  const lines = plan.stages.map(s => {
    const flag = s.status === "confirmed" ? "✅" : s.status === "rolled_back" ? "↩️" : "⏳";
    const atomNote = s.atom !== undefined ? ` [atom:${s.atom}]` : "";
    const artifactNote = s.artifacts.length > 0 ? `（产物: ${s.artifacts.length} 项）` : "";
    return `- ${flag} ${s.id}${atomNote}（${s.strategy}）: ${s.goal}${artifactNote}`;
  });
  const parts = [`flexible_plan(caseId=${plan.caseId}, caseType=${plan.caseType}, status=${plan.status})`];
  if (plan.technicalField !== undefined) parts.push(`技术领域: ${plan.technicalField}`);
  parts.push(`当前阶段: ${plan.currentStageId ?? "（无待执行阶段）"}`, ...lines);
  return parts.join("\n");
}

/** 加载计划（不存在时抛 FlexiblePlanError，由 execute 统一转文本）。 */
async function loadPlan(store: FlexiblePlanStore, caseId: string): Promise<FlexiblePlanState> {
  const plan = await store.loadPlan(caseId);
  if (plan === undefined) throw new FlexiblePlanError(`计划 "${caseId}" 不存在（先用 action=create 创建）`);
  return plan;
}

/** 缺省存储：<caseDir>/workflow-runs/flexible-plans/（与 workflow-runs 同域约定）。 */
function defaultPlanStore(caseId: string, cwd: string): FlexiblePlanStore {
  const runsDir = resolveWorkflowRunsDir(caseId, cwd);
  return new JsonFileFlexiblePlanStore(join(runsDir, "flexible-plans"));
}

/** 工具文本结果（错误与成功共用；前缀由调用方写全）。 */
function toolText(message: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: message }] };
}

/**
 * 阶段 JSON Schema（inputSchema 中 create 的 stages 与 add 的 stage 共享，
 * 避免 9 个字段两处复制漂移）。
 */
const STAGE_SCHEMA: SatiJsonSchema = {
  type: "object",
  required: ["id", "name", "goal", "strategy"],
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    goal: { type: "string" },
    strategy: { type: "string", enum: ["chain", "react", "sub_agent"] },
    atom: { type: "string", description: "Atom name to auto-execute this stage (e.g. extract)." },
    params: { type: "object", description: "Static params passed to the stage handler." },
    artifacts: { type: "array", items: { type: "string" } },
    constraintIds: { type: "array", items: { type: "string" } },
    articleJudgments: { type: "array", items: { type: "string" } },
  },
};

/**
 * 计划变更操作表：confirm/rollback/add/remove/reorder/complete/abandon 七个变更
 * 共用同一条执行流（require → loadPlan → apply → savePlan → 渲染），差异只有
 * 前置校验、状态机函数与后缀消息。数据表驱动，避免 7 个同构 switch 分支。
 */
type MutationSpec = {
  /** 前置校验：缺失参数时返回错误消息；通过返回 undefined。 */
  require?: (input: FlexiblePlanToolInput) => string | undefined;
  /** 状态机变更（apply 前已 loadPlan）。 */
  apply: (state: FlexiblePlanState, input: FlexiblePlanToolInput) => FlexiblePlanState;
  /** 变更后的附加消息（追加在 renderPlan 之后）。 */
  message: (state: FlexiblePlanState, input: FlexiblePlanToolInput) => string;
};

const MUTATIONS: Partial<Record<Exclude<FlexiblePlanAction, "create" | "get" | "run">, MutationSpec>> = {
  confirm: {
    require: i => (i.stageId === undefined ? "confirm 需要 stageId" : undefined),
    apply: (s, i) => confirmStage(s, i.stageId!),
    message: (_s, i) => `已确认阶段 "${i.stageId}"。`,
  },
  rollback: {
    require: i => (i.stageId === undefined ? "rollback 需要 stageId" : undefined),
    apply: (s, i) => rollbackStage(s, i.stageId!),
    message: (_s, i) => `已回退到阶段 "${i.stageId}"（其及后续已确认阶段置 rolled_back 保留审计）。`,
  },
  add: {
    require: i => (i.stage === undefined ? "add 需要 stage" : undefined),
    apply: (s, i) => addStage(s, toFlexibleStage(i.stage!)),
    message: (_s, i) => `已追加阶段 "${i.stage!.id}"。`,
  },
  remove: {
    require: i => (i.stageId === undefined ? "remove 需要 stageId" : undefined),
    apply: (s, i) => removeStage(s, i.stageId!),
    message: (_s, i) => `已删除阶段 "${i.stageId}"。`,
  },
  reorder: {
    require: i => (i.stageIds === undefined ? "reorder 需要 stageIds（含全部阶段 id）" : undefined),
    apply: (s, i) => reorderStages(s, i.stageIds!),
    message: () => "已重排阶段顺序。",
  },
  complete: {
    apply: s => complete(s),
    message: () => "计划已完成（status=completed）。",
  },
  abandon: {
    require: i => (i.reason !== undefined && i.reason.trim() !== "" ? undefined : "abandon 需要 reason（审计留痕）"),
    apply: (s, i) => abandon(s, i.reason!),
    message: () => "计划已放弃（status=abandoned）。",
  },
};

const ACTIONS_LABEL = "create / get / run / confirm / rollback / add / remove / reorder / complete / abandon";

export function createFlexiblePlanTool(deps: FlexiblePlanToolDeps = {}): SatiToolDefinition<FlexiblePlanToolInput> {
  return {
    name: "flexible_plan",
    outputSchema: {
      type: "object",
      properties: {},
    },
    aliases: ["FlexiblePlan", "flexible_plan_task"],
    description:
      "Flexible plan for patent cases (stage-level HITL): create a plan (optional IPC technical-field " +
      "inference from the disclosure text), run it (pending stages executed via the atom registry with " +
      "LLM + prior-art search, exactly like patent_workflow_run), then confirm / rollback stages one by one. " +
      "Also add / remove / reorder stages at runtime and complete or abandon the plan. Plans are persisted by " +
      "caseId across calls (unlike patent_plan_task, which is stateless). run executes only unconfirmed stages " +
      "(pending + rolled_back); confirmed stages are frozen, so confirm fixes the output — autoConfirm=true " +
      "confirms all successful stages at the end of a run.",
    kind: "session",
    domain: "patent",
    inputSchema: {
      type: "object",
      required: ["action", "caseId"],
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["create", "get", "run", "confirm", "rollback", "add", "remove", "reorder", "complete", "abandon"],
          description:
            "Operation: create | get | run | confirm | rollback | add | remove | reorder | complete | abandon.",
        },
        caseId: { type: "string", description: "Plan key (required for every operation; persists by this id)." },
        caseType: {
          type: "string",
          description: "Orchestration type, e.g. invalidation / infringement / drafting (create).",
        },
        inputText: {
          type: "string",
          description:
            "Case input text (e.g. technical disclosure). create persists it for later runs; run can override it.",
        },
        technicalField: {
          type: "string",
          description: "Explicit technical field (create; else inferred from inputText).",
        },
        stages: {
          type: "array",
          description: "Stage definitions (create / add).",
          items: STAGE_SCHEMA,
        },
        stage: {
          description: "Single stage definition (add).",
          ...STAGE_SCHEMA,
        },
        stageId: { type: "string", description: "Target stage id (confirm / rollback / remove)." },
        stageIds: {
          type: "array",
          items: { type: "string" },
          description: "New stage order (reorder, must include all ids).",
        },
        reason: { type: "string", description: "Abandon reason, kept for audit (abandon)." },
        maxResults: { type: "number", description: "Max prior-art search results for run (default 5)." },
        autoConfirm: {
          type: "boolean",
          description: "When true, run confirms all successful (non-degraded) stages at the end.",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async execute(input, context) {
      if (input.caseId === undefined || input.caseId.trim() === "") {
        return toolText("flexible_plan: caseId 不能为空（计划按 caseId 持久化，跨调用状态）");
      }
      const store = deps.store ?? defaultPlanStore(input.caseId, context?.cwd ?? process.cwd());
      try {
        // 计划变更：七个 mutation 共用同一条执行流（操作表驱动）。
        const mutation = MUTATIONS[input.action as keyof typeof MUTATIONS];
        if (mutation !== undefined) {
          const missing = mutation.require?.(input);
          if (missing !== undefined) return toolText(`flexible_plan: ${missing}`);
          const plan = await loadPlan(store, input.caseId);
          const updated = mutation.apply(plan, input);
          await store.savePlan(updated);
          return toolText(`${renderPlan(updated)}\n${mutation.message(updated, input)}`);
        }

        switch (input.action) {
          case "create": {
            if (input.caseType === undefined || input.caseType.trim() === "") {
              return toolText("flexible_plan: create 需要 caseType");
            }
            // inputText 由状态机 createFlexiblePlan 持久化（字段所有权在状态机）。
            const plan = createFlexiblePlan(input.caseId, input.caseType, {
              inputText: input.inputText,
              technicalField: input.technicalField,
              stages: (input.stages ?? []).map(toFlexibleStage),
              now: deps.now,
            });
            await store.savePlan(plan);
            return toolText(`${renderPlan(plan)}\n已创建并持久化（action=run 执行未确认阶段）。`);
          }
          case "get": {
            const plan = await loadPlan(store, input.caseId);
            return toolText(renderPlan(plan));
          }
          case "run": {
            const plan = await loadPlan(store, input.caseId);
            // toManifest 内部 assertActive + 拒绝"全部已确认"（无待执行阶段）。
            const manifest = toManifest(plan);
            const provider = buildWorkflowProvider(deps, context);
            if (!provider) {
              return toolText(
                "flexible_plan: 未提供模型客户端（context.model 缺失），无法执行原子阶段。请在有模型会话中调用。",
              );
            }
            const sourceText = input.inputText ?? plan.inputText ?? "";
            const workflowCtx = buildWorkflowRunContext({
              caseId: input.caseId,
              input: sourceText,
              maxResults: input.maxResults,
            });
            // 无 atom 阶段（报告/透传）：透传输入文本，不降级。
            const executor = async (): Promise<string> => sourceText;
            const persistTarget = resolveRunPersistTarget(input.caseId, manifest.id, context?.cwd ?? process.cwd());
            const result = await runWorkflow(manifest, workflowCtx, executor, {
              handlers: deps.handlers ?? globalStageHandlerRegistry,
              atoms: globalAtomRegistry,
              provider,
              ...(persistTarget !== undefined
                ? { persist: new JsonFileWorkflowRunStore(persistTarget.runsDir), runId: persistTarget.runId }
                : {}),
            });
            // autoConfirm：成功（非降级）阶段自动确认并回流计划（固化产物）。
            let updated = plan;
            if (input.autoConfirm === true) {
              for (const stage of result.stages) {
                if (!stage.degraded) updated = confirmStage(updated, stage.stageId);
              }
              await store.savePlan(updated);
            }
            const lines = result.stages.map(s => {
              const flag = s.degraded ? "⚠️ 降级" : "✅";
              const preview =
                s.output.length > 0 ? `${s.output.slice(0, 80)}${s.output.length > 80 ? "…" : ""}` : "(无输出)";
              return `- ${flag} ${s.stageId}${s.atom !== undefined ? ` [atom:${s.atom}]` : ""}: ${preview}`;
            });
            const persistNote =
              persistTarget !== undefined ? await writeRunArtifacts(persistTarget, manifest, result) : "持久化: 未启用";
            const interruptNote = result.interrupted
              ? `⏸ 审批门暂停: "${result.interrupted.stageId}"（${result.interrupted.message}）——等待人工确认，后续阶段未执行`
              : undefined;
            return {
              content: [
                {
                  type: "text",
                  text: renderWorkflowResultText({
                    toolName: "flexible_plan(run)",
                    result,
                    stageLines: lines,
                    persistNote,
                    checkSection: "",
                    interruptNote,
                  }),
                },
              ],
            };
          }
          default: {
            // inputSchema enum 仅代理侧提示，运行时不强制：未知 action fail-closed。
            return toolText(`flexible_plan: 未知操作 "${String(input.action)}"（可选: ${ACTIONS_LABEL}）`);
          }
        }
      } catch (err) {
        // FlexiblePlanError / WorkflowError / 存储错误统一转文本（fail-closed，对齐专利工具风格）。
        return toolText(`flexible_plan: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
