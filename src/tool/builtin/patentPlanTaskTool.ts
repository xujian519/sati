import {
  PlanTaskSemanticError,
  PlanTaskStateMachine,
  replanTasks,
  syncPlanToTasks,
  TRANSITIONS,
  type PlanTask,
  type PlanTaskState,
} from "../../patent/index.js";
import type { SatiToolDefinition } from "../protocol/types.js";

export type PatentPlanTaskInput = {
  /** 操作类型。 */
  action: "transition" | "sync" | "replan";
  /** 当前状态（transition 必需；首次可用 planning）。 */
  currentState?: string;
  /** 目标状态（transition 必需）。 */
  to?: string;
  /** 计划步骤列表（sync/replan 必需）。 */
  planSteps?: string[];
  /** 之前已同步的任务（replan 可选：哈希比对已完成步骤）。 */
  previousTasks?: PlanTask[];
  /** 当前任务列表（transition 到 executing 必需：强制先 sync 计划步骤）。 */
  tasks?: PlanTask[];
  /** 重规划反馈（transition 到 replanning 必需：反馈驱动重规划）。 */
  feedback?: string;
};

/**
 * `patent_plan_task` — 人机协作计划状态机工具（HITL 闭环）。
 *
 * 维护专利任务的白名单状态迁移（planning → awaiting_approval → executing →
 * awaiting_feedback → replanning → finished），非法迁移抛错（fail-closed）；
 * 支持计划步骤 → 任务同步与重规划增量续跑（哈希比对已完成步骤）。
 * 状态机带语义强制：进入 executing 必须先 sync 出任务（tasks 非空）、
 * 进入 replanning 必须有反馈（feedback 非空）——无任务不执行、无反馈不重规划。
 * 工具无会话状态：每次调用传入当前状态，由调用方（agent）持久化。
 */
export function createPatentPlanTaskTool(): SatiToolDefinition<PatentPlanTaskInput> {
  return {
    name: "patent_plan_task",
    aliases: ["PatentPlanTask", "plan_task_state"],
    description:
      "Human-in-the-loop plan state machine for patent tasks: transition (whitelist-checked " +
      "state changes), sync (plan steps → ordered tasks with blockedBy deps), replan (hash-compare " +
      "completed steps for incremental resume). Fail-closed on illegal transitions. Stateless: pass " +
      "the current state on every call.",
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["action"],
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["transition", "sync", "replan"],
          description: "Operation: transition | sync | replan.",
        },
        currentState: { type: "string", description: "Current state (required for transition)." },
        to: { type: "string", description: "Target state (required for transition)." },
        planSteps: { type: "array", items: { type: "string" }, description: "Plan steps (sync/replan)." },
        previousTasks: {
          type: "array",
          description: "Previous task list (replan, optional: preserve completed steps).",
          items: { type: "object", additionalProperties: true },
        },
        tasks: {
          type: "array",
          description: "Current task list (transition to executing, required: sync first).",
          items: { type: "object", additionalProperties: true },
        },
        feedback: {
          type: "string",
          description: "Feedback driving replanning (transition to replanning, required).",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      switch (input.action) {
        case "transition": {
          const from = (input.currentState ?? "planning") as PlanTaskState;
          const to = input.to as PlanTaskState;
          // 运行时输入校验（inputSchema enum 仅代理侧提示，不强制）：非法状态 fail-closed 返回文本而非抛 TypeError
          const validStates = new Set(Object.keys(TRANSITIONS));
          if (!validStates.has(from) || !validStates.has(to)) {
            return {
              content: [
                {
                  type: "text",
                  text: `patent_plan_task: 非法状态 "${from}" 或 "${to}"（合法: ${[...validStates].join(" / ")}）`,
                },
              ],
            };
          }
          const machine = new PlanTaskStateMachine(from);
          if (!machine.canTransition(to)) {
            return {
              content: [
                {
                  type: "text",
                  text: `patent_plan_task: 非法状态迁移 ${from} → ${to}（请检查 TRANSITIONS 白名单）`,
                },
              ],
            };
          }
          // 语义强制（fail-closed）：executing 需 tasks、replanning 需 feedback——
          // 与状态机 PlanTaskSemanticError 一致，工具层转为文本返回。
          try {
            const next = machine.transition(to, { tasks: input.tasks, feedback: input.feedback });
            return { content: [{ type: "text", text: `patent_plan_task: ${from} → ${next} ✅` }] };
          } catch (err) {
            if (err instanceof PlanTaskSemanticError) {
              return { content: [{ type: "text", text: `patent_plan_task: ${err.message}` }] };
            }
            throw err;
          }
        }
        case "sync": {
          const steps = input.planSteps ?? [];
          if (steps.length === 0) {
            return { content: [{ type: "text", text: "patent_plan_task: sync 需要 planSteps 非空" }] };
          }
          const result = syncPlanToTasks(steps);
          const lines = result.tasks.map(
            t => `- ${t.id} ${t.status}${t.blockedBy ? `（依赖 ${t.blockedBy.join(",")}）` : ""}: ${t.description}`,
          );
          return {
            content: [
              {
                type: "text",
                text: `patent_plan_task: 同步 ${result.tasks.length} 个任务\n${lines.join("\n")}\n待执行: ${result.toRun.join(", ")}`,
              },
            ],
          };
        }
        case "replan": {
          const steps = input.planSteps ?? [];
          if (steps.length === 0) {
            return { content: [{ type: "text", text: "patent_plan_task: replan 需要 planSteps 非空" }] };
          }
          const result = replanTasks(input.previousTasks ?? [], steps);
          const preserved = result.preserved.length > 0 ? `保留已完成: ${result.preserved.join(", ")}` : "无保留步骤";
          return {
            content: [
              {
                type: "text",
                text: `patent_plan_task: 重规划 → ${result.tasks.length} 个任务\n${preserved}\n需执行: ${result.toRun.join(", ") || "（全部已完成）"}`,
              },
            ],
          };
        }
        default: {
          // inputSchema enum 仅代理侧提示，运行时不强制：未知 action fail-closed
          return {
            content: [
              {
                type: "text",
                text: `patent_plan_task: 未知操作 "${String(input.action)}"（可选: transition / sync / replan）`,
              },
            ],
          };
        }
      }
    },
  };
}
