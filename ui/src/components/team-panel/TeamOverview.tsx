import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { FeedbackBanner } from "./FeedbackBanner";
import { useActionFeedback } from "./hooks/useActionFeedback";
import type { PanelActionResult, PanelTeam } from "./types";

type TeamOverviewProps = {
  teams: PanelTeam[];
  /** 建队回调：返回完整 ActionResult，失败时展示具体后端 message（与成员/任务反馈链路一致）。 */
  onCreate: (name: string) => Promise<PanelActionResult>;
  onCreated: () => void;
};

/**
 * 团队概览：团队卡列表（id/name/队长在线徽章/归档态/成员与任务数）+ 新建团队表单。
 * 归档团队只在此展示卡片，成员/任务视图由容器按 archivedAt 过滤。
 */
export function TeamOverview({ teams, onCreate, onCreated }: TeamOverviewProps) {
  const { t } = useTranslation("teamPanel");
  const [name, setName] = useState("");
  const { busy, feedback, runAction } = useActionFeedback();

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    await runAction(
      () => onCreate(trimmed),
      () => {
        setName("");
        onCreated();
      },
    );
  };

  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t("overview.title")}</h2>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">{teams.length}</span>
      </div>

      {teams.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          {t("overview.noTeams")}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {teams.map(team => (
          <div
            key={team.id}
            className="rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">{team.name}</div>
                <div className="mt-0.5 truncate font-mono text-xs text-neutral-400 dark:text-neutral-500">
                  {team.id}
                </div>
              </div>
              {team.archivedAt !== undefined ? (
                <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950/60 dark:text-amber-400">
                  {t("overview.archived")}
                </span>
              ) : null}
            </div>
            <div className="mt-3 flex items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400">
              <span className="inline-flex items-center gap-1.5">
                <span
                  className={`h-2 w-2 rounded-full ${team.captainOnline ? "bg-emerald-500" : "bg-neutral-300 dark:bg-neutral-600"}`}
                />
                {team.captainOnline ? t("overview.captainOnline") : t("overview.captainOffline")}
              </span>
              <span>{t("overview.memberCount", { count: team.members.length })}</span>
              <span>{t("overview.taskCount", { count: team.tasks.length })}</span>
            </div>
          </div>
        ))}

        {/* 新建团队表单 */}
        <div className="rounded-md border border-dashed border-neutral-300 p-4 dark:border-neutral-700">
          <Input
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder={t("overview.createPlaceholder")}
            onKeyDown={event => {
              if (event.key === "Enter") void handleCreate();
            }}
            className="h-8 text-sm"
          />
          <Button
            size="sm"
            variant="secondary"
            className="mt-2 w-full"
            disabled={busy || name.trim() === ""}
            onClick={() => void handleCreate()}
          >
            {t("overview.create")}
          </Button>
        </div>
      </div>

      <FeedbackBanner feedback={feedback} />
    </section>
  );
}
