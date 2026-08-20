import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Minimize2, Radio, Users, X } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { CaptainSummary } from "./captain-summary";
import {
  TEAM_PANEL_COLLAPSED_KEY,
  TEAM_PANEL_DEFAULT_WIDTH,
  TEAM_PANEL_OVERLAY_MAX_WIDTH,
  TEAM_PANEL_SETTLE_MS,
} from "./constants";
import { FeedbackBanner } from "./FeedbackBanner";
import { useActionFeedback } from "./hooks/useActionFeedback";
import { describeEvent, EVENT_STYLE, FALLBACK_EVENT_STYLE, useTeamActivity } from "./hooks/use-team-activity";
import { useTeamPanel } from "./hooks/useTeamPanel";
import { MemberTree } from "./member-tree";
import { TaskDag } from "./task-dag";
import { TeamChips } from "./team-chips";
import type { PanelTeam } from "./types";

type FloatingTeamPanelProps = {
  /** 当前会话 id：会话跟随（captainSessionKey 匹配）与操作身份锚定。 */
  sessionId?: string | null;
  /** true = docked 常驻列（对话礼让）；false = 右上 overlay 覆盖。 */
  docked: boolean;
  isMobile: boolean;
  onClose: () => void;
};

function readStoredCollapsed(): boolean {
  try {
    return window.localStorage.getItem(TEAM_PANEL_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStoredCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(TEAM_PANEL_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // 隐私模式等场景忽略持久化失败
  }
}

/**
 * 团队活动浮层（重构自 M4 整页 tab，参照 dsh-agent-teams ActivityPanel）。
 *
 * 三态布局：docked（对话礼让常驻列）/ overlay（Files/窄屏/移动端覆盖）/ 浮标
 * （收起态小药丸）。数据层沿用 useTeamPanel 5s 轮询 + useTeamActivity 事件流
 * （事件驱动 DAG 节点/成员行脉冲与浮标活动点）。
 *
 * 自动展开状态机：挂载后 4s settle 窗口内事件不触发；窗口后首条事件自动展开
 * 一次；用户手动收起后不再自动展开（意图优先），点浮标展开可重新激活。
 */
export function FloatingTeamPanel({ sessionId, docked, isMobile, onClose }: FloatingTeamPanelProps) {
  const { t } = useTranslation("teamPanel");
  const { snapshot, loading, error, refresh, callAction } = useTeamPanel(sessionId);
  const { events, latestEvent, eventsForMember } = useTeamActivity();

  // 视图状态机：初始折叠态读持久化（仅决定初始视图，不抑制自动展开——
  // 4s settle 窗口已防挂载闪动；用户在本挂载内点击收起才视为意图，见下）
  const [view, setView] = useState<"expanded" | "collapsed">(() => (readStoredCollapsed() ? "collapsed" : "expanded"));
  const userCollapsedRef = useRef(false);
  const autoExpandedRef = useRef(false);
  const mountedAtRef = useRef(Date.now());
  const eventCountAtMountRef = useRef(0);

  // 事件到达 → 满足 settle 窗口后自动展开一次
  useEffect(() => {
    if (view === "expanded" || userCollapsedRef.current || autoExpandedRef.current) return;
    if (events.length <= eventCountAtMountRef.current) return;
    if (Date.now() - mountedAtRef.current < TEAM_PANEL_SETTLE_MS) return;
    autoExpandedRef.current = true;
    setView("expanded");
  }, [events.length, view]);

  // ESC 关闭展开态面板
  useEffect(() => {
    if (view !== "expanded") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [view, onClose]);

  // 会话跟随：当前会话为队长的团队自动选中（chips 手动切换可覆盖）
  const followTeamId = useMemo(
    () => snapshot?.teams.find(team => team.captainSessionKey === sessionId)?.id,
    [snapshot, sessionId],
  );
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  useEffect(() => {
    if (followTeamId !== undefined) setSelectedTeamId(followTeamId);
  }, [followTeamId]);

  const teams = snapshot?.teams ?? [];
  const activeTeams = teams.filter(team => team.archivedAt === undefined);
  const selectedTeam: PanelTeam | undefined = teams.find(team => team.id === selectedTeamId) ?? activeTeams[0];

  // 建队表单（空态，自旧 TeamOverview 迁移）
  const { busy, feedback, runAction } = useActionFeedback();
  const [teamName, setTeamName] = useState("");
  const handleCreate = async () => {
    const trimmed = teamName.trim();
    if (trimmed === "") return;
    await runAction(
      () => callAction("team_create", { name: trimmed }),
      () => {
        setTeamName("");
        void refresh({ silent: true });
      },
    );
  };

  // 收起态：右上角浮标（团队数 + 活动脉冲点）
  if (view === "collapsed") {
    const hasActivity = latestEvent !== null;
    return (
      <button
        type="button"
        onClick={() => {
          userCollapsedRef.current = false;
          setView("expanded");
        }}
        title={t("panel.pillExpand")}
        aria-label={t("panel.pillExpand")}
        className="absolute top-3 right-3 z-40 inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1.5 shadow-md transition-colors hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:bg-neutral-800"
      >
        <Users className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400" />
        <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
          {t("pill.teamCount", { count: activeTeams.length })}
        </span>
        {hasActivity ? (
          <span
            className="relative flex h-2 w-2"
            role="status"
            aria-label={t("pill.newActivity")}
            title={t("pill.newActivity")}
          >
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
        ) : null}
      </button>
    );
  }

  const body = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 错误横幅：hook error 是运行时数据（非静态文案），直接显示，不走 i18n */}
      {error !== null ? <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}

      {loading && snapshot === null ? (
        <div className="p-6 text-sm text-muted-foreground">{t("loading")}</div>
      ) : teams.length === 0 ? (
        <div className="space-y-3 p-4">
          <div className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            {t("overview.noTeams")}
          </div>
          <Input
            value={teamName}
            onChange={event => setTeamName(event.target.value)}
            placeholder={t("overview.createPlaceholder")}
            onKeyDown={event => {
              if (event.key === "Enter") void handleCreate();
            }}
            className="h-8 text-sm"
          />
          <Button
            size="sm"
            variant="secondary"
            className="w-full"
            disabled={busy || teamName.trim() === ""}
            onClick={() => void handleCreate()}
          >
            {t("overview.create")}
          </Button>
          <FeedbackBanner feedback={feedback} />
        </div>
      ) : (
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <TeamChips teams={teams} selectedTeamId={selectedTeam?.id} onSelect={setSelectedTeamId} />
          {selectedTeam !== undefined ? (
            <>
              <CaptainSummary team={selectedTeam} onAction={callAction} />
              <TaskDag team={selectedTeam} onAction={callAction} activity={{ events }} />
              <MemberTree team={selectedTeam} onAction={callAction} activity={{ events, eventsForMember }} />
            </>
          ) : null}

          {/* 最近动态：事件流并入面板（旧独立 EventStream section 删除） */}
          {events.length > 0 ? (
            <section className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Radio className="h-3.5 w-3.5 text-neutral-400 dark:text-neutral-500" />
                <h3 className="text-xs font-semibold text-neutral-900 dark:text-neutral-100">{t("events.recent")}</h3>
              </div>
              <ul className="space-y-1">
                {events.slice(-3).map(event => (
                  <li
                    key={event._eventId}
                    className="flex items-center gap-2 rounded-md border border-neutral-200 bg-white px-2 py-1 dark:border-neutral-800 dark:bg-neutral-950"
                  >
                    <span
                      className={`shrink-0 rounded-full px-2 py-px font-mono text-[10px] font-medium ${EVENT_STYLE[event.type] ?? FALLBACK_EVENT_STYLE}`}
                    >
                      {event.type}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">
                      {describeEvent(event)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );

  if (docked && !isMobile) {
    // Docked：对话礼让常驻列（复用 Files assistant 的 flex-shrink-0 兄弟列范式）
    return (
      <div
        className="flex h-full min-w-0 flex-shrink-0 flex-col border-l border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
        style={{ width: TEAM_PANEL_DEFAULT_WIDTH }}
      >
        <div className="flex items-center justify-between gap-2 border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
          <div className="flex min-w-0 items-center gap-2">
            <Users className="h-4 w-4 shrink-0 text-neutral-400 dark:text-neutral-500" />
            <h2 className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              {t("panel.title")}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => {
                userCollapsedRef.current = true;
                writeStoredCollapsed(true);
                setView("collapsed");
              }}
              title={t("panel.collapse")}
              aria-label={t("panel.collapse")}
              className="rounded-md p-1 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              <Minimize2 className="h-4 w-4" strokeWidth={1.8} />
            </button>
            <button
              type="button"
              onClick={onClose}
              title={t("panel.close")}
              aria-label={t("panel.close")}
              className="rounded-md p-1 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              <X className="h-4 w-4" strokeWidth={1.8} />
            </button>
          </div>
        </div>
        {body}
      </div>
    );
  }

  // Overlay：右上覆盖（Files/窄屏/移动端/dashboard 同屏），不挤压现有布局
  return (
    <div
      className="absolute inset-y-0 right-0 z-40 flex flex-col border-l border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-950"
      style={{ width: `min(${TEAM_PANEL_OVERLAY_MAX_WIDTH}px, 92vw)` }}
    >
      <div className="flex items-center justify-between gap-2 border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
        <div className="flex min-w-0 items-center gap-2">
          <Users className="h-4 w-4 shrink-0 text-neutral-400 dark:text-neutral-500" />
          <h2 className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t("panel.title")}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => {
              userCollapsedRef.current = true;
              writeStoredCollapsed(true);
              setView("collapsed");
            }}
            title={t("panel.collapse")}
            aria-label={t("panel.collapse")}
            className="rounded-md p-1 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <Minimize2 className="h-4 w-4" strokeWidth={1.8} />
          </button>
          <button
            type="button"
            onClick={onClose}
            title={t("panel.close")}
            aria-label={t("panel.close")}
            className="rounded-md p-1 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>
      </div>
      {body}
    </div>
  );
}
