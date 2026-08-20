import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { TASK_STATUS_FILL } from "./dag-model";
import { FeedbackBanner } from "./FeedbackBanner";
import { useActionFeedback } from "./hooks/useActionFeedback";
import type { PanelAction, PanelTeam } from "./types";

type CaptainSummaryProps = {
  team: PanelTeam;
  onAction: PanelAction;
};

const activeStatuses = new Set(["claimed", "in_progress"]);

/** 图例：进行中 / 已完成 / 失败 三态（claimed+in_progress 收敛为"进行中"）。 */
const LEGEND: Array<{ statuses: string[]; fill: string; labelKey: string }> = [
  { statuses: ["claimed", "in_progress"], fill: TASK_STATUS_FILL.in_progress, labelKey: "tasks.statusInProgress" },
  { statuses: ["completed"], fill: TASK_STATUS_FILL.completed, labelKey: "tasks.statusCompleted" },
  { statuses: ["failed"], fill: TASK_STATUS_FILL.failed, labelKey: "tasks.statusFailed" },
];

/**
 * 队长摘要（参照 dsh-agent-teams CaptainNode）：在线态 + 派发摘要 + 分段进度条 +
 * 图例 + 一句话状态摘要 + 归档按钮。分段条每任务一段按状态着色（inline style 直用
 * TASK_STATUS_FILL，与 DAG 节点色单点维护）。
 */
export function CaptainSummary({ team, onAction }: CaptainSummaryProps) {
  const { t } = useTranslation("teamPanel");
  const { busy, feedback, runAction } = useActionFeedback();

  const done = team.tasks.filter(task => task.status === "completed").length;
  const active = team.tasks.filter(task => activeStatuses.has(task.status)).length;
  const activeMembers = team.members.filter(member => !member.retired).length;

  const handleArchive = async () => {
    // 归档不可逆，二次确认
    if (!window.confirm(t("archive.confirmBody", { name: team.name }))) return;
    await runAction(() => onAction("team_archive", { teamId: team.id }));
  };

  return (
    <section className="space-y-2.5 rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${team.captainOnline ? "bg-emerald-500" : "bg-neutral-300 dark:bg-neutral-600"}`}
            title={team.captainOnline ? t("overview.captainOnline") : t("overview.captainOffline")}
          />
          <span className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">{team.name}</span>
          {team.archivedAt !== undefined ? (
            <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950/60 dark:text-amber-400">
              {t("overview.archived")}
            </span>
          ) : null}
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void handleArchive()}>
          {t("archive.button")}
        </Button>
      </div>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {t("captain.dispatched", { tasks: team.tasks.length, members: activeMembers })}
      </p>

      {team.tasks.length > 0 ? (
        <>
          {/* 分段进度条：每任务一段，宽度等分 */}
          <div
            className="flex h-1.5 w-full gap-px overflow-hidden rounded-full"
            role="img"
            aria-label={t("progress.legend")}
          >
            {team.tasks.map(task => (
              <span
                key={task.taskId}
                className="h-full min-w-[2px] flex-1 rounded-full"
                style={{ backgroundColor: TASK_STATUS_FILL[task.status] ?? TASK_STATUS_FILL.pending }}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {LEGEND.map(legend => (
              <span
                key={legend.labelKey}
                className="inline-flex items-center gap-1 text-[11px] text-neutral-500 dark:text-neutral-400"
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: legend.fill }} />
                {t(legend.labelKey)}
              </span>
            ))}
            <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
              {t("captain.summaryDone", { total: team.tasks.length, done, active })}
            </span>
          </div>
        </>
      ) : null}

      <FeedbackBanner feedback={feedback} />
    </section>
  );
}
