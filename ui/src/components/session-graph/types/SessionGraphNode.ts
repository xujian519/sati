export type SessionGraphNode = {
  sessionId: string;
  title: string;
  parentSessionId?: string;
  forkedFromTurnId?: string;
  forkPreview?: {
    turnId: string;
    questionSnippet: string;
    answerSnippet?: string;
  };
  lastActivity?: number;
  createdAt?: string;
  isReadOnly: boolean;
  status: "idle" | "processing" | "interrupted";
  color: string;
  position: { x: number; y: number };
  positionLocked?: boolean;
};
