import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { TEAM_ROLE_OPTIONS } from "./constants";
import { FeedbackBanner } from "./FeedbackBanner";
import { useActionFeedback } from "./hooks/useActionFeedback";
import type { PanelAction, PanelMember, PanelTeam } from "./types";

type MemberGridProps = {
  team: PanelTeam;
  onAction: PanelAction;
};

const STATUS_DOT: Record<PanelMember["status"], string> = {
  idle: "bg-neutral-300 dark:bg-neutral-600",
  working: "bg-emerald-500",
};

/**
 * 成员网格：成员状态卡（memberId/roleSlug 徽章/status 圆点 + 文案/退休置灰）+ 添加成员表单。
 * 添加成员经 onAction → team_add_member（后端校验队长权限与角色注册）。
 */
export function MemberGrid({ team, onAction }: MemberGridProps) {
  const { t } = useTranslation("teamPanel");
  const [roleSlug, setRoleSlug] = useState<string>("");
  const { busy, feedback, runAction } = useActionFeedback();

  const handleAdd = async () => {
    if (roleSlug === "") return;
    await runAction(
      () => onAction("team_add_member", { teamId: team.id, roleSlug }),
      () => setRoleSlug(""),
    );
  };

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t("members.title")}</h3>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">{team.members.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={roleSlug}
            onChange={event => setRoleSlug(event.target.value)}
            aria-label={t("members.rolePlaceholder")}
            className="h-8 rounded-md border border-neutral-200 bg-white px-2 text-xs text-neutral-700 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-hidden dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300"
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
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {team.members.map(member => (
          <div
            key={member.memberId}
            className={`flex items-center gap-3 rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950 ${
              member.retired ? "opacity-60" : ""
            }`}
          >
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${member.retired ? "bg-neutral-200 dark:bg-neutral-700" : STATUS_DOT[member.status]}`}
              title={
                member.retired
                  ? t("members.retired")
                  : member.status === "working"
                    ? t("members.statusWorking")
                    : t("members.statusIdle")
              }
            />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-xs text-neutral-900 dark:text-neutral-100">{member.memberId}</div>
              {member.modelRoute?.provider ? (
                <div className="mt-0.5 truncate text-xs text-neutral-400 dark:text-neutral-500">
                  {t("members.modelRoute", {
                    provider: member.modelRoute.provider,
                    model: member.modelRoute.model ?? "default",
                  })}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 font-mono text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                {member.roleSlug}
              </span>
              {member.retired ? (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950/60 dark:text-amber-400">
                  {t("members.retired")}
                </span>
              ) : (
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  {member.status === "working" ? t("members.statusWorking") : t("members.statusIdle")}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      <FeedbackBanner feedback={feedback} />
    </section>
  );
}
