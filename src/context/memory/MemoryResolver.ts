import type { CanonicalMessage } from "../../model/index.js";

export type ContextMemoryMessage = {
  msgId?: string;
  role: string;
  content: string;
};

/**
 * 任务意图（知识注入优化信号，粗粒度）。
 *
 * 由调用方/注入链按 query 启发式推导；knowledge provider（如
 * PatentMemoryProvider）据此调整注入限额——OA/无效类任务知识需求密集，
 * 提升 wiki 卡片注入上限；普通对话保持默认，避免上下文膨胀。
 */
export type TaskIntent = "oa" | "invalidity" | "draft" | "general";

/**
 * 专利分析语义词：判例/知识注入的精确触发词（共享常量）。
 *
 * 覆盖非任务意图的分析类 query（区别特征/技术启示/证据认定等措辞）；
 * 任务意图（oa/invalidity/draft）由 buildRetrieveTaskIntent 另行分类。
 * 单一来源，供 CaseLawMemoryProvider 与未来知识增强复用，避免多份词表漂移。
 */
export const PATENT_ANALYSIS_KEYWORDS: readonly string[] = [
  "创造性",
  "新颖性",
  "无效",
  "答复",
  "审查意见",
  "区别特征",
  "技术启示",
  "证据认定",
  "预料不到",
  "充分公开",
  "修改超范围",
  "单独对比",
  "三步法",
  "A22",
  "A26",
  "A33",
];

/**
 * 项目知识偏好（per-project knowledge profile，可选）。
 *
 * 由配置（memory.knowledgeProfile）解析后经注入链透传到 knowledge provider：
 * 不同客户/技术领域项目可声明自己的知识侧重，弥补"全局知识 × 当前 query"
 * 驱动的盲区。未配置时行为与现状完全一致。
 */
export type KnowledgeProfile = {
  /** IPC 部（A-H），query 命中该部候选时强制注入对应审查标准卡片。 */
  ipcSections?: string[];
};

export type MemoryRetrieveInput = {
  query: string;
  sessionId: string;
  projectRoot: string;
  recentMessages: CanonicalMessage[];
  signal?: AbortSignal;
  /** 任务意图（缺省 general；知识 provider 据此调整注入限额）。 */
  taskIntent?: TaskIntent;
  /** 项目知识偏好（可选；缺省无偏好，行为与现状一致）。 */
  knowledgeProfile?: KnowledgeProfile;
};

export type MemoryRetrieveResult = {
  systemContext?: string;
  diagnostics: MemoryDiagnostic[];
  metadata?: Record<string, unknown>;
};

export type MemoryCaptureTurnInput = {
  sessionId: string;
  projectRoot: string;
  messages: CanonicalMessage[];
  errored: boolean;
};

export type MemoryDiagnostic = {
  code:
    | "memory_disabled"
    | "memory_provider_error"
    | "memory_context_empty"
    | "memory_cache_hit"
    | "memory_ipc_classified"
    | "memory_case_law_injected";
  message: string;
  severity: "info" | "warning" | "error";
};

export type MemoryResolver = {
  retrieve(input: MemoryRetrieveInput): Promise<MemoryRetrieveResult>;
  captureTurn(input: MemoryCaptureTurnInput): Promise<void>;
};

export type CanonicalMessagesToMemoryMessagesOptions = {
  includeForkCarryover?: boolean;
};

export function canonicalMessagesToMemoryMessages(
  messages: CanonicalMessage[],
  options: CanonicalMessagesToMemoryMessagesOptions = {},
): ContextMemoryMessage[] {
  return messages.flatMap((message, index) => {
    if (options.includeForkCarryover === false && message.metadata?.forkCarryover) {
      return [];
    }

    const entries: Array<Omit<ContextMemoryMessage, "msgId">> = [];
    const pushEntry = (role: string, text: string) => {
      const content = text.trim();
      if (!content) return;
      const previous = entries.at(-1);
      if (previous?.role === role) {
        previous.content = `${previous.content}\n${content}`;
        return;
      }
      entries.push({ role, content });
    };

    for (const block of message.content) {
      if (block.type === "text") {
        pushEntry(message.role, block.text);
      } else if (block.type === "tool_result") {
        pushEntry("tool", block.content.map(item => (item.type === "text" ? item.text : `[${item.type}]`)).join("\n"));
      } else if (block.type === "tool_result_reference") {
        pushEntry("tool", block.preview);
      } else if (block.type === "media_reference") {
        pushEntry("tool", block.preview);
      }
    }

    return entries.map((entry, entryIndex) => ({
      msgId: entries.length === 1 ? `message-${index}` : `message-${index}:${entryIndex}`,
      role: entry.role,
      content: entry.content,
    }));
  });
}
