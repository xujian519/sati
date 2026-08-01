/**
 * patent 知识库类型定义。
 * 数据结构对齐 Mady（Go）的 ipc-standards.yaml / patent_kg.db（nodes/edges 表）。
 */

/** IPC 审查标准卡片（对应 Mady IPCStandard / ipc-standards.yaml）。 */
export type IpcStandardCard = {
  /** 卡片唯一标识，如 "创造性-三步法-A61医药-A61" */
  id: string;
  /** 关联法条，如 "patent-law-a22.3" */
  article: string;
  /** IPC 部（A-H） */
  ipcSection: string;
  /** IPC 大组/小组，如 "A61"、"G06" */
  ipcDetail?: string;
  /** 卡片名称，如 "创造性-审查标准-体育娱乐" */
  name: string;
  /** 审查要点列表 */
  keyPoints: string[];
  /** 撰写/答辩提示列表 */
  tips: string[];
  /** 来源文件路径 */
  source: string;
};

/** IPC 分类结果。 */
export type IpcClassification = {
  /** IPC 部（A-H） */
  section: string;
  /** 置信度 0..1（公式：0.5 + 匹配率 * 0.5，与 Mady 一致） */
  confidence: number;
  /** 命中的关键词 */
  matchedKeywords: string[];
};

/** 知识图谱节点类型（对应 Mady GraphNode.NodeType 常量子集）。 */
export type KgNodeType =
  | "Concept"
  | "LawArticle"
  | "GuidelineRule"
  | "Case"
  | "Judgment"
  | "WikiCard"
  | "PersonalNote"
  | "BookReference"
  | "Rule"
  | "DomainGuide"
  | "IPC"
  | "Evidence"
  | "WritingPattern";

/** 知识图谱节点（对应 patent_kg.db nodes 表列）。 */
export type KgNode = {
  id: string;
  nodeType: string;
  name?: string;
  title?: string;
  content?: string;
  lawRefsCount?: number;
  source?: string;
  fullRef?: string;
  chapter?: string;
  articleNumber?: string;
  version?: string;
};

/** 知识图谱边（对应 patent_kg.db edges 表列）。 */
export type KgEdge = {
  source: string;
  target: string;
  relation: string;
};
