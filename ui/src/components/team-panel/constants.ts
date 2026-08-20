/** 面板快照轮询间隔（ms）。 */
export const TEAM_PANEL_POLL_MS = 5_000;

/** Docked 态面板宽度（px）。 */
export const TEAM_PANEL_DEFAULT_WIDTH = 380;

/** Overlay 态面板最大宽度（px）。 */
export const TEAM_PANEL_OVERLAY_MAX_WIDTH = 420;

/** 收起态自动展开的挂载稳定窗口（ms）：防首屏加载期事件闪动展开。 */
export const TEAM_PANEL_SETTLE_MS = 4_000;

/** 折叠态持久化键（裸键，与 MainContent 的 sati:* 惯例一致）。 */
export const TEAM_PANEL_COLLAPSED_KEY = "sati:team-panel-collapsed";

/**
 * 团队角色可选清单（12 岗）——以 `skills/patent-teams/` 目录实际角色为准：
 * case-manager / researcher / drafter / technical-expert / adversarial-reviewer /
 * applicant-counsel / formal-examiner / invalidity-petitioner / patentee-defender /
 * adjudicator / defendant-counsel / tech-investigator。
 */
export const TEAM_ROLE_OPTIONS = [
  "case-manager",
  "researcher",
  "drafter",
  "technical-expert",
  "adversarial-reviewer",
  "applicant-counsel",
  "formal-examiner",
  "invalidity-petitioner",
  "patentee-defender",
  "adjudicator",
  "defendant-counsel",
  "tech-investigator",
] as const;
