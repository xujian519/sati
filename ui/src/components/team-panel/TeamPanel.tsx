import { useTranslation } from "react-i18next";
import { useTeamPanel } from "./hooks/useTeamPanel";
import { TeamOverview } from "./TeamOverview";
import { MemberGrid } from "./MemberGrid";
import { TaskBoard } from "./TaskBoard";
import { EventStream } from "./EventStream";

/**
 * 团队活动面板（M4 全操作）：概览（建队）+ 成员 + 任务 + 事件流。
 * 操作经 callAction 走 gateway 工具链（/api/teams/action → team_* 工具）。
 */
export function TeamPanel() {
  const { t } = useTranslation("teamPanel");
  const { snapshot, loading, error, refresh, callAction } = useTeamPanel();

  // 初始占位：snapshot 未就绪且 loading 中（T8 定案：以 snapshot === null 为初始分支，不依赖 loading 单独分支）
  if (loading && snapshot === null) {
    return <div className="p-6 text-sm text-muted-foreground">{t("loading")}</div>;
  }

  const teams = snapshot?.teams ?? [];

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      {/* hook 的 error 是运行时数据（非静态文案），直接显示 message，不走 i18n */}
      {error !== null ? <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
      <TeamOverview
        teams={teams}
        onCreated={() => void refresh()}
        onCreate={async name => {
          const r = await callAction("team_create", { name });
          return r.ok;
        }}
      />
      {teams
        .filter(team => team.archivedAt === undefined)
        .map(team => (
          <div key={team.id} className="space-y-4">
            <MemberGrid team={team} onAction={callAction} />
            <TaskBoard team={team} onAction={callAction} />
          </div>
        ))}
      <EventStream />
    </div>
  );
}
