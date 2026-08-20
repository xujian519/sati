import { useTranslation } from "react-i18next";
import type { PanelTeam } from "./types";

type TeamChipsProps = {
  teams: PanelTeam[];
  selectedTeamId?: string;
  onSelect: (teamId: string) => void;
};

/**
 * 团队切换 chips：活动团队（名称 + 任务数）+ 归档团队折叠区（dsh ?archived=1 思路
 * 前端化——归档团队可选中回看，但详情视图为只读：无归档/转派/加成员操作）。
 */
export function TeamChips({ teams, selectedTeamId, onSelect }: TeamChipsProps) {
  const { t } = useTranslation("teamPanel");
  const activeTeams = teams.filter(team => team.archivedAt === undefined);
  const archivedTeams = teams.filter(team => team.archivedAt !== undefined);

  const renderChip = (team: PanelTeam, dimmed: boolean) => (
    <button
      key={team.id}
      type="button"
      onClick={() => onSelect(team.id)}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${dimmed ? "opacity-70" : ""} ${
        team.id === selectedTeamId
          ? "border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-800 dark:bg-brand-950/40 dark:text-brand-300"
          : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-900"
      }`}
    >
      <span className="max-w-32 truncate">{team.name}</span>
      <span className="font-mono text-[10px] opacity-70">{team.tasks.length}</span>
    </button>
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {activeTeams.length === 0 ? (
          <span className="text-xs text-neutral-400 dark:text-neutral-500">{t("overview.noTeams")}</span>
        ) : (
          activeTeams.map(team => renderChip(team, false))
        )}
      </div>

      {archivedTeams.length > 0 ? (
        <details className="group">
          <summary className="cursor-pointer list-none text-xs text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300">
            {t("panel.archivedTeams", { count: archivedTeams.length })}
          </summary>
          <div className="mt-1.5 flex flex-wrap gap-1.5">{archivedTeams.map(team => renderChip(team, true))}</div>
        </details>
      ) : null}
    </div>
  );
}
