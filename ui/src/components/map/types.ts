export type Position = {
  x: number;
  y: number;
};

export type MapWorkspace = {
  id: string;
  name: string;
  cwd: string;
  color: string;
  position: Position;
};

export type MapThreadStatus = "idle" | "processing" | "interrupted";

export type MapThread = {
  id: string;
  title: string;
  workspaceId: string;
  parentId?: string;
  sessionId?: string;
  status: MapThreadStatus;
  color: string;
  position: Position;
};

export type MapEdge = {
  from: string;
  to: string;
};

export type MapSessionSyncItem = {
  id: string;
  title: string;
  cwd: string;
  parentId?: string;
  blank: boolean;
};
