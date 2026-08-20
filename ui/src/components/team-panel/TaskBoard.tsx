import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { FeedbackBanner } from "./FeedbackBanner";
import { useActionFeedback } from "./hooks/useActionFeedback";
import type { PanelAction, PanelTask, PanelTeam } from "./types";

type TaskBoardProps = {
  team: PanelTeam;
  onAction: PanelAction;
};

/** 任务状态徽章配色（与后端 TeamTaskStatus 集合一致；未知状态兜底灰）。 */
const TASK_STATUS_STYLE: Record<string, string> = {
  pending: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  claimed: "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-400",
  in_progress: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400",
  completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400",
  failed: "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-400",
  cancelled: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
};

const TASK_STATUS_KEY: Record<string, string> = {
  pending: "tasks.statusPending",
  claimed: "tasks.statusClaimed",
  in_progress: "tasks.statusInProgress",
  completed: "tasks.statusCompleted",
  failed: "tasks.statusFailed",
  cancelled: "tasks.statusCancelled",
};

/** 终态任务（与后端 TERMINAL_TASK_STATUSES 一致）：不可转派。 */
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * 任务看板：任务行（subject/status 徽章/attempt/阻塞依赖/assignee）+ 非终态任务转派下拉 +
 * 归档团队按钮（window.confirm 二次确认）。操作经 onAction 直调 team_* 工具链。
 */
export function TaskBoard({ team, onAction }: TaskBoardProps) {
  const { t } = useTranslation("teamPanel");
  const [reassignFor, setReassignFor] = useState<Record<string, string>>({});
  // 转派/归档共享 busy（C2 提取）：低频面板操作互斥，任一进行中两按钮同禁
  const { busy, feedback, runAction } = useActionFeedback();

  // 可转派目标：非退休的 idle 成员（working 成员已有任务在身）
  const idleMembers = team.members.filter(member => !member.retired && member.status === "idle");

  const handleReassign = async (task: PanelTask) => {
    const memberId = reassignFor[task.taskId];
    if (memberId === undefined || memberId === "") return;
    await runAction(
      () => onAction("team_reassign_task", { teamId: team.id, taskId: task.taskId, memberId }),
      () => setReassignFor(prev => ({ ...prev, [task.taskId]: "" })),
    );
  };

  const handleArchive = async () => {
    // 归档不可逆，二次确认
    if (!window.confirm(t("archive.confirmBody", { name: team.name }))) return;
    await runAction(() => onAction("team_archive", { teamId: team.id }));
  };

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t("tasks.title")}</h3>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">{team.tasks.length}</span>
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void handleArchive()}>
          {t("archive.button")}
        </Button>
      </div>

      {team.tasks.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 p-4 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          {t("tasks.empty")}
        </div>
      ) : (
        <div className="space-y-2">
          {team.tasks.map(task => {
            const statusKey = TASK_STATUS_KEY[task.status] ?? task.status;
            const statusStyle = TASK_STATUS_STYLE[task.status] ?? TASK_STATUS_STYLE.pending;
            const terminal = TERMINAL_TASK_STATUSES.has(task.status);
            return (
              <div
                key={task.taskId}
                className="flex flex-wrap items-center gap-3 rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950"
              >
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusStyle}`}>
                  {t(statusKey)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-neutral-900 dark:text-neutral-100">{task.subject}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-xs text-neutral-400 dark:text-neutral-500">
                    <span>{task.taskId}</span>
                    <span>{t("tasks.attempt", { count: task.attempt })}</span>
                    {task.blockedByCount > 0 ? (
                      <span>{t("tasks.blockedBy", { count: task.blockedByCount })}</span>
                    ) : null}
                    <span>{task.assigneeId !== undefined ? task.assigneeId : t("tasks.unassigned")}</span>
                  </div>
                </div>
                {!terminal ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <select
                      value={reassignFor[task.taskId] ?? ""}
                      onChange={event => setReassignFor(prev => ({ ...prev, [task.taskId]: event.target.value }))}
                      aria-label={`${t("tasks.reassign")} ${task.taskId}`}
                      className="h-8 rounded-md border border-neutral-200 bg-white px-2 text-xs text-neutral-700 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-hidden dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300"
                    >
                      <option value="" disabled>
                        {t("tasks.reassignPlaceholder")}
                      </option>
                      {idleMembers.map(member => (
                        <option key={member.memberId} value={member.memberId}>
                          {t("tasks.optionFormat", { memberId: member.memberId, roleSlug: member.roleSlug })}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || (reassignFor[task.taskId] ?? "") === ""}
                      onClick={() => void handleReassign(task)}
                    >
                      {t("tasks.reassign")}
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <FeedbackBanner feedback={feedback} />
    </section>
  );
}
