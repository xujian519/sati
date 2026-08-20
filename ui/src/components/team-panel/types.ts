/** 面板快照（与 gateway team_panel_snapshot 契约对应；ui 侧类型本地声明，不导入 src/）。 */
export type PanelMember = {
  memberId: string;
  roleSlug: string;
  status: "idle" | "working";
  modelRoute: { provider?: string; model?: string };
  retired: boolean;
};

export type PanelTask = {
  taskId: string;
  subject: string;
  status: string;
  attempt: number;
  attemptId?: string;
  assigneeId?: string;
  dependencies: string[];
  blockedByCount: number;
  handoffId?: string;
  output?: string;
};

export type PanelTeam = {
  id: string;
  name: string;
  captainSessionKey: string;
  createdAt: string;
  archivedAt?: string;
  captainOnline: boolean;
  members: PanelMember[];
  tasks: PanelTask[];
  unreadForCaptain: number;
};

export type TeamPanelSnapshot = { teams: PanelTeam[] };

export type PanelActionResult = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
