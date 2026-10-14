/** 知识草稿（WS2）——gateway `/api/web/knowledge-drafts` 载荷的手工类型镜像。 */
export type KnowledgeDraftStatus = "pending" | "confirmed" | "rejected";

export type KnowledgeDraft = {
  id: string;
  sessionId: string;
  title: string;
  content: string;
  project?: string;
  status: KnowledgeDraftStatus;
  rejectReason?: string;
  documentId?: string;
  createdAt: string;
  updatedAt: string;
};
