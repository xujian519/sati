/**
 * 网关装配的辅助函数族（2026-09-11 由 createLocalGateway.ts 抽出，architecture-fix-plan P4a 第一刀）。
 *
 * 逐字迁移，行为不变；组合根（createLocalGateway）仅保留编排与装配调用。
 */

import { existsSync } from "node:fs";
import { dirname, join as joinPath, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_KEY, brandEnv } from "../env.js";
import { type AgentRuntimeDependencies, type CreateAgentSessionOptions } from "../agent/index.js";
import {
  TeamDb,
  TeamScheduler,
  attemptsExhausted,
  ownedOpenTask,
  validateAttemptUpdate,
  type TeamEvent,
} from "../agent/team/index.js";
import {
  listRegisteredRoleIds,
  registerRoleDefinition,
  unregisterRoleDefinition,
} from "../agent/sub/builtinSubagentTypes.js";
import { roleFromContribution } from "../agent/sub/roleFromSkill.js";
import { PluginRuntime } from "../extension/index.js";
import { SqliteApprovalStore } from "../patent/provenance/approval-store.js";
import { type SatiElicitationChannel } from "../tool/index.js";
import { createLogger } from "../telemetry/index.js";
import { type ExtensionWatchEvent } from "./ExtensionWatchManager.js";
import { registerNestedTeamRoleDefinitions } from "./teamRoleAssembly.js";

export function handleMemberTurnCompleted(
  db: TeamDb,
  teamSchedulerRef: TeamScheduler,
  teamId: string,
  memberId: string,
  emitTeamEvent: (captainSessionKey: string, event: TeamEvent) => boolean,
): void {
  const open = ownedOpenTask(db.listTasks(teamId), memberId);
  if (open !== undefined) {
    const fresh = db.getTask(teamId, open.id);
    if (fresh !== undefined && attemptsExhausted(fresh)) {
      const guard = validateAttemptUpdate(fresh, fresh.attemptId);
      if (guard === undefined) {
        db.updateTask({ ...fresh, status: "failed", updatedAt: new Date().toISOString() });
        // I2（code review）：置 failed 同步补发 task_failed（对齐 teamTasks 工具路径的事件形状；
        // 队长会话扇出，团队行缺失时跳过——任务归属团队必存在，此处仅防御）。
        const team = db.getTeam(teamId);
        if (team !== undefined) {
          emitTeamEvent(team.captainSessionKey, {
            type: "task_failed",
            teamId,
            taskId: fresh.id,
            memberId: open.assigneeId ?? "",
            attempt: fresh.attempt,
            reason: "attempts_exhausted",
          });
        }
      }
    }
  }
  void teamSchedulerRef.onMemberIdle(teamId, memberId).catch(() => undefined);
}

export function resolveBuiltinSkillsRoot(
  configuredRoot: string | undefined,
  env: Record<string, string | undefined>,
): string {
  const explicit = configuredRoot ?? brandEnv(env, ENV_KEY.BUNDLED_SKILLS_DIR);
  if (explicit) return resolve(explicit);

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    joinPath(moduleDir, "..", "..", "skills"),
    joinPath(moduleDir, "..", "..", "..", "skills"),
    joinPath(process.cwd(), "skills"),
  ];
  return resolve(candidates.find(candidate => existsSync(candidate)) ?? candidates[2]);
}

export function mergeSessionDependencies(
  base: CreateAgentSessionOptions["dependencies"],
  extension: Partial<
    Pick<
      AgentRuntimeDependencies,
      | "context"
      | "fileHistory"
      | "subagentTranscript"
      | "elicitation"
      | "eventEmitter"
      | "drainEvents"
      | "planFileManager"
      | "planTodoManager"
    >
  >,
): CreateAgentSessionOptions["dependencies"] {
  return {
    ...base,
    ...(extension.context ? { context: extension.context } : {}),
    ...(extension.fileHistory ? { fileHistory: extension.fileHistory } : {}),
    ...(extension.subagentTranscript ? { subagentTranscript: extension.subagentTranscript } : {}),
    ...(extension.elicitation ? { elicitation: extension.elicitation } : {}),
    ...(extension.eventEmitter ? { eventEmitter: extension.eventEmitter } : {}),
    ...(extension.drainEvents ? { drainEvents: extension.drainEvents } : {}),
    ...(extension.planFileManager ? { planFileManager: extension.planFileManager } : {}),
    ...(extension.planTodoManager ? { planTodoManager: extension.planTodoManager } : {}),
  };
}

export function describeExtensionScope(scope: ExtensionWatchEvent["scope"]): string {
  return scope.kind === "global" ? "global extensions" : `project extensions (${scope.projectRoot})`;
}

export function createAutoElicitationChannel(): SatiElicitationChannel {
  return {
    async askUser(request) {
      const answers: Record<string, string | string[]> = {};
      for (const q of request.questions) {
        if (q.options.length > 0) {
          answers[q.question] = q.multiSelect ? [q.options[0].label] : q.options[0].label;
        } else {
          answers[q.question] = "yes";
        }
      }
      return { type: "answered", answers };
    },
  };
}

export function syncRoleDefinitions(pluginRuntime: PluginRuntime, builtinSkillsRoot?: string): void {
  for (const id of listRegisteredRoleIds()) {
    unregisterRoleDefinition(id);
  }
  for (const skill of pluginRuntime.getAllSkills()) {
    const definition = roleFromContribution(skill);
    if (definition !== null) {
      registerRoleDefinition(definition);
    }
  }
  // M3 T15：skills/patent-teams/ 嵌套目录（自身无 SKILL.md，一级扫描跳过），
  // 经同一 roleFromContribution → registerRoleDefinition 路径补注册。
  registerNestedTeamRoleDefinitions(builtinSkillsRoot);
}

/**
 * 安全构造审批审计库（评审 I3）：库打不开（目录只读/损坏/魔数不符）时降级为
 * 不注入 approvalStore（审批留痕不落盘），绝不抛错拖垮 gateway；saveRecord 侧
 * 已内建 fail-open。返回 undefined = 不落盘。
 */

export function createApprovalStoreSafely(): SqliteApprovalStore | undefined {
  try {
    return new SqliteApprovalStore();
  } catch (err) {
    sqliteApprovalStoreLogger.error("审批审计库打开失败，审批留痕降级为不落盘:", err);
    return undefined;
  }
}

const sqliteApprovalStoreLogger = createLogger("SqliteApprovalStore");
