export type Position = {
  x: number;
  y: number;
};

export type SessionRow = {
  id: string;
  title: string;
  cwd: string;
  parentId?: string;
  blank?: boolean;
};

export type ProjectedMessage = {
  id: string;
  text: string;
  kind: "user" | "assistant" | "note";
  at: string;
  turn?: number;
  step?: number;
};

export type Thread = {
  id: string;
  workspaceId: string;
  title: string;
  parentId: string | null;
  sessionId: string | null;
  sessionTitle: string | null;
  color: string;
  position: Position;
  messages: ProjectedMessage[];
  createdAt: string;
  updatedAt: string;
};

export type Workspace = {
  id: string;
  kind: "project" | "manual";
  cwd: string | null;
  title: string;
  threads: Thread[];
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceSummary = {
  id: string;
  kind: "project" | "manual";
  cwd: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  threadCount: number;
};

export type WorkspaceState = {
  version: 4;
  hiddenSessionIds: string[];
  workspaces: Workspace[];
};
