/** TeamEvent 变体的 wire 形态（浏览器侧局部收窄，不导入 src/）。 */
export type TeamWireEvent = {
  type: string;
  teamId?: string;
  taskId?: string;
  memberId?: string;
  attempt?: number;
  /** 本地自增 React key（非后端字段）。 */
  _eventId?: number;
  [key: string]: unknown;
};

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
};

export type TeamPanelSnapshot = { teams: PanelTeam[] };

export type PanelActionResult = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

/** 面板操作签名（容器向子视图透传的 callAction，直调 gateway team_* 工具链）。 */
export type PanelAction = (tool: string, input: Record<string, unknown>) => Promise<PanelActionResult>;
