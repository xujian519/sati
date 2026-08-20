import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { Button } from "../ui/button";
import { TEAM_ROLE_OPTIONS } from "./constants";
import { TERMINAL_TASK_STATUSES } from "./dag-model";
import { FeedbackBanner } from "./FeedbackBanner";
import { useActionFeedback } from "./hooks/useActionFeedback";
import type { PanelAction, PanelMember, PanelTask, PanelTeam, TeamWireEvent } from "./types";

type MemberTreeProps = {
  team: PanelTeam;
  onAction: PanelAction;
  /** 活动事件源（useTeamActivity 返回值）：成员行活动指示。 */
  activity: {
    events: TeamWireEvent[];
  };
};

/** 脉冲窗口：最近 N 条本团队事件中出现的成员视为"活跃"。 */
const RECENT_WINDOW = 5;

/** 成员状态圆点（与旧 MemberGrid 一致）。 */
const STATUS_DOT: Record<PanelMember["status"], string> = {
  idle: "bg-neutral-300 dark:bg-neutral-600",
  working: "bg-emerald-500",
};

/**
 * 折叠成员树（参照 dsh-agent-teams 成员树）：默认折叠；行 = 状态点（活跃脉冲环）
 * + 首字母圆头像 + memberId + 角色徽章 + 状态文本 + 当前任务（截断）+ done/total。
 * 底部保留添加成员表单（操作能力与旧 MemberGrid 等价）。
 */
export function MemberTree({ team, onAction, activity }: MemberTreeProps) {
  const { t } = useTranslation("teamPanel");
  const [open, setOpen] = useState(false);
  const [roleSlug, setRoleSlug] = useState("");
  const { busy, feedback, runAction } = useActionFeedback();

  // 最近 RECENT_WINDOW 条本团队事件涉及的 memberId（事件流顺序即新鲜度；
  // 按 teamId 过滤，避免他队事件误归属）
  const recentMemberIds = useMemo(() => {
    const recent = activity.events.filter(event => event.teamId === team.id).slice(-RECENT_WINDOW);
    const memberIds = new Set<string>();
    for (const event of recent) {
      if (event.memberId !== undefined) memberIds.add(event.memberId);
    }
    return memberIds;
  }, [activity.events, team.id]);

  const currentTaskOf = (member: PanelMember): PanelTask | undefined =>
    team.tasks.find(task => task.assigneeId === member.memberId && !TERMINAL_TASK_STATUSES.has(task.status));

  const statsOf = (member: PanelMember) => {
    const owned = team.tasks.filter(task => task.assigneeId === member.memberId);
    const done = owned.filter(task => task.status === "completed").length;
    return { done, total: owned.length };
  };

  const handleAdd = async () => {
    if (roleSlug === "") return;
    await runAction(
      () => onAction("team_add_member", { teamId: team.id, roleSlug }),
      () => setRoleSlug(""),
    );
  };

  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900"
      >
        <ChevronDown
          className={`h-3.5 w-3.5 text-neutral-400 transition-transform dark:text-neutral-500 ${open ? "rotate-0" : "-rotate-90"}`}
        />
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t("members.title")}</h3>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">{team.members.length}</span>
        <span className="ml-auto text-xs text-neutral-400 dark:text-neutral-500">
          {open ? t("members.collapse") : t("members.expand")}
        </span>
      </button>

      {open ? (
        <div className="space-y-1">
          {team.members.length === 0 ? (
            <div className="rounded-md border border-dashed border-neutral-300 p-4 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
              {t("members.empty")}
            </div>
          ) : (
            team.members.map(member => {
              const currentTask = currentTaskOf(member);
              const stats = statsOf(member);
              const recent = recentMemberIds.has(member.memberId);
              const modelRoute = member.modelRoute;
              const hasModelRoute = modelRoute.provider !== undefined && modelRoute.model !== undefined;
              return (
                <div
                  key={member.memberId}
                  className={`flex items-center gap-2.5 rounded-md border border-neutral-200 bg-white px-2.5 py-2 dark:border-neutral-800 dark:bg-neutral-950 ${
                    member.retired ? "opacity-60" : ""
                  }`}
                >
                  <span className="relative shrink-0">
                    <span
                      className={`block h-2.5 w-2.5 rounded-full ${member.retired ? "bg-neutral-200 dark:bg-neutral-700" : STATUS_DOT[member.status]}`}
                    />
                    {recent ? (
                      <span
                        className="absolute inset-0 animate-ping rounded-full bg-emerald-400/50"
                        aria-hidden="true"
                      />
                    ) : null}
                  </span>
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-medium text-brand-700 dark:bg-brand-900/40 dark:text-brand-300">
                    {member.memberId.charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-xs text-neutral-900 dark:text-neutral-100">
                        {member.memberId}
                      </span>
                      <span className="shrink-0 rounded-full bg-neutral-100 px-1.5 py-px font-mono text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                        {member.roleSlug}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-neutral-400 dark:text-neutral-500">
                      {member.retired
                        ? t("members.retired")
                        : currentTask !== undefined
                          ? t("members.currentTask", { subject: currentTask.subject })
                          : member.status === "working"
                            ? t("members.statusWorking")
                            : t("members.statusIdle")}
                      {hasModelRoute ? (
                        <span className="ml-1.5 font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
                          {t("members.modelRoute", {
                            provider: modelRoute.provider ?? "",
                            model: modelRoute.model ?? "",
                          })}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <span className="shrink-0 font-mono text-xs text-neutral-500 dark:text-neutral-400">
                    {stats.done}/{stats.total}
                  </span>
                </div>
              );
            })
          )}

          {/* 添加成员表单（自旧 MemberGrid 迁移；归档团队只读，不渲染） */}
          {team.archivedAt !== undefined ? (
            <p className="pt-1 text-xs text-neutral-400 dark:text-neutral-500">{t("members.archivedReadonly")}</p>
          ) : null}
          {team.archivedAt === undefined ? (
            <div className="flex items-center gap-2 pt-1">
              <select
                value={roleSlug}
                onChange={event => setRoleSlug(event.target.value)}
                aria-label={t("members.rolePlaceholder")}
                className="h-8 min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-2 text-xs text-neutral-700 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-hidden dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300"
              >
                <option value="" disabled>
                  {t("members.rolePlaceholder")}
                </option>
                {TEAM_ROLE_OPTIONS.map(role => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="outline" disabled={busy || roleSlug === ""} onClick={() => void handleAdd()}>
                {t("members.add")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <FeedbackBanner feedback={feedback} />
    </section>
  );
}
