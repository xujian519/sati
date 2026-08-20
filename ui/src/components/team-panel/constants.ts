/** 面板快照轮询间隔（ms）。 */
export const TEAM_PANEL_POLL_MS = 5_000;

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
