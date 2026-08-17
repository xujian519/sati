// heartbeat 的模块级纯 helper（从 heartbeat.ts 拆出，函数体逐字搬移）。
// 消息增量合并 / token 化与打分 / 预览渲染 / trace 构造 / 类型常量。
// 全部无 IO、无外部状态（nowIso/hashText 为确定性工具），可独立单测。
import type {
  IndexTraceRecord,
  IndexTraceStep,
  IndexTraceStoredResult,
  L0SessionRecord,
  MemoryCandidate,
  MemoryFileRecord,
  MemoryMessage,
  ProjectShortlistCandidate,
  ReadableProjectCatalogEntry,
  RetrievalPromptDebug,
  TraceI18nText,
} from "../types.js";
import { hashText, nowIso } from "../utils/id.js";
import { decodeEscapedUnicodeText } from "../utils/text.js";
import type { HeartbeatStats } from "./heartbeat.js";

const GENERAL_INDEX_PROJECT_CANDIDATE_LIMIT = 30;

function sameMessage(left: MemoryMessage | undefined, right: MemoryMessage | undefined): boolean {
  if (!left || !right) return false;
  return left.role === right.role && left.content === right.content;
}

function hasNewContent(previous: MemoryMessage[], incoming: MemoryMessage[]): boolean {
  if (incoming.length === 0) return false;
  if (previous.length === 0) return true;
  if (incoming.length > previous.length) return true;
  for (let index = 0; index < incoming.length; index += 1) {
    if (!sameMessage(previous[index], incoming[index])) return true;
  }
  return false;
}

function emptyStats(): HeartbeatStats {
  return {
    capturedSessions: 0,
    writtenFiles: 0,
    writtenUserFiles: 0,
    writtenProjectFiles: 0,
    writtenFeedbackFiles: 0,
    userProfilesUpdated: 0,
    failedSessions: 0,
  };
}

function tokenizeSearchText(value: string): string[] {
  const stopwords = new Set([
    "项目",
    "当前",
    "这个",
    "那个",
    "现在",
    "一下",
    "关于",
    "里面",
    "这里",
    "那里",
    "怎么",
    "怎样",
    "如何",
    "什么",
    "哪些",
    "进展",
    "情况",
    "默认",
    "应该",
    "需要",
    "general",
  ]);
  const expandCjkToken = (token: string): string[] => {
    if (!/[\p{Script=Han}]/u.test(token)) return [token];
    const pieces = token.match(/[\p{Script=Han}]+|[^\p{Script=Han}]+/gu) ?? [token];
    const expanded: string[] = [];
    for (const piece of pieces) {
      if (!/[\p{Script=Han}]/u.test(piece)) {
        expanded.push(piece);
        continue;
      }
      if (piece.length <= 8) expanded.push(piece);
      for (const size of [2, 3]) {
        if (piece.length < size) continue;
        for (let index = 0; index <= piece.length - size; index += 1) {
          expanded.push(piece.slice(index, index + size));
        }
      }
    }
    return expanded;
  };
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .map(item => item.trim())
        .flatMap(item => expandCjkToken(item))
        .filter(item => item.length >= 2),
    ),
  ).filter(item => !stopwords.has(item));
}

function buildGeneralProjectShortlist(
  catalog: ReadableProjectCatalogEntry[],
  text: string,
): ProjectShortlistCandidate[] {
  const tokens = tokenizeSearchText(text);
  return catalog
    .map(project => {
      const haystack = `${project.projectName} ${project.description}`.toLowerCase();
      const exact = text.toLowerCase().includes(project.projectName.toLowerCase()) ? 2 : 0;
      const matchedTokens = tokens.filter(token => haystack.includes(token));
      const score = exact * 10 + matchedTokens.length;
      return {
        projectId: project.logicalProjectId,
        projectName: project.projectName,
        description: project.description,
        status: project.status,
        updatedAt: project.summary.latestMemoryAt || project.updatedAt,
        sourceType: project.sourceType === "workspace_external" ? "workspace_external" : "general_local",
        score,
        exact,
        source: exact > 0 || matchedTokens.length > 0 ? "query" : "recent",
        matchedText: matchedTokens.join(", "),
      } satisfies ProjectShortlistCandidate;
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, GENERAL_INDEX_PROJECT_CANDIDATE_LIMIT);
}

function buildCandidateRoutingQuery(candidate: MemoryCandidate, focusTurn: MemoryMessage): string {
  return [
    focusTurn.content,
    candidate.name,
    candidate.description,
    candidate.rule,
    candidate.summary,
    candidate.stage,
    ...(candidate.constraints ?? []),
    ...(candidate.decisions ?? []),
    ...(candidate.blockers ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

function buildCandidateMemoryPreview(candidate: MemoryCandidate): string {
  const lines: string[] = [
    `# ${candidate.name}`,
    "",
    `type: ${candidate.type}`,
    `description: ${candidate.description}`,
  ];
  if (candidate.type === "feedback") {
    lines.push("", "## Rule", candidate.rule || candidate.description || candidate.summary || candidate.name);
    if (candidate.why) lines.push("", "## Why", candidate.why);
    if (candidate.howToApply) lines.push("", "## How To Apply", candidate.howToApply);
  }
  if (candidate.type === "project") {
    if (candidate.stage) lines.push("", "## Current Stage", candidate.stage);
    const sections: Array<[string, string[] | undefined]> = [
      ["Decisions", candidate.decisions],
      ["Constraints", candidate.constraints],
      ["Next Steps", candidate.nextSteps],
      ["Blockers", candidate.blockers],
      ["Timeline", candidate.timeline],
      ["Notes", candidate.notes],
    ];
    for (const [title, values] of sections) {
      const normalized = (values ?? []).map(item => item.trim()).filter(Boolean);
      if (normalized.length === 0) continue;
      lines.push("", `## ${title}`, ...normalized.map(item => `- ${item}`));
    }
    if (candidate.summary) lines.push("", "## Summary", candidate.summary);
  }
  if (candidate.body) lines.push("", "## Body", candidate.body);
  const preview = lines.join("\n").trim();
  return preview.length <= 3000 ? preview : `${preview.slice(0, 3000)}...`;
}

function flattenBatchMessages(sessions: L0SessionRecord[], seedMessages: MemoryMessage[] = []): MemoryMessage[] {
  let previousMessages: MemoryMessage[] = seedMessages;
  for (const session of sessions) {
    previousMessages = mergeSessionMessages(previousMessages, session.messages).mergedMessages;
  }
  return previousMessages;
}

function commonPrefixLength(previous: MemoryMessage[], incoming: MemoryMessage[]): number {
  const limit = Math.min(previous.length, incoming.length);
  let index = 0;
  while (index < limit && sameMessage(previous[index], incoming[index])) {
    index += 1;
  }
  return index;
}

function mergeSessionMessages(
  previousMessages: MemoryMessage[],
  incomingMessages: MemoryMessage[],
): {
  mergedMessages: MemoryMessage[];
  newMessages: MemoryMessage[];
} {
  if (previousMessages.length === 0) {
    return {
      mergedMessages: incomingMessages,
      newMessages: incomingMessages,
    };
  }
  const prefixLength = commonPrefixLength(previousMessages, incomingMessages);
  if (prefixLength > 0) {
    return {
      mergedMessages: incomingMessages,
      newMessages: incomingMessages.slice(prefixLength),
    };
  }
  return {
    mergedMessages: [...previousMessages, ...incomingMessages],
    newMessages: incomingMessages,
  };
}

function deriveFocusTurns(
  previousMessages: MemoryMessage[],
  sessions: L0SessionRecord[],
): Map<string, MemoryMessage[]> {
  const focusTurns = new Map<string, MemoryMessage[]>();
  let cursorMessages = previousMessages;
  for (const session of sessions) {
    const merged = mergeSessionMessages(cursorMessages, session.messages);
    focusTurns.set(
      session.l0IndexId,
      merged.newMessages.filter(message => message.role === "user"),
    );
    cursorMessages = merged.mergedMessages;
  }
  return focusTurns;
}

function buildIndexTraceId(sessionKey: string, startedAt: string, l0Ids: string[]): string {
  return `index_trace_${hashText(`${sessionKey}:${startedAt}:${l0Ids.join(",")}`)}`;
}

function normalizeTrigger(reason: string | undefined): IndexTraceRecord["trigger"] {
  const normalized = (reason ?? "").trim().toLowerCase();
  if (normalized.includes("scheduled")) return "scheduled";
  return "manual_sync";
}

function previewText(text: string, maxChars = 220): string {
  const normalized = decodeEscapedUnicodeText(text, true).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function inferStorageKind(record: MemoryFileRecord): IndexTraceStoredResult["storageKind"] {
  if (record.type === "general_project_meta") {
    return "general_project_meta";
  }
  if (record.type === "user") {
    return /\/?(UserNotes|UserIdentityNotes)\//.test(record.relativePath) ? "global_user_note" : "global_user";
  }
  return record.type === "feedback" ? "feedback" : "project";
}

function exposeStoredRelativePath(record: MemoryFileRecord): string {
  return record.scope === "global" ? `global/${record.relativePath}` : record.relativePath;
}

function textDetail(
  key: string,
  label: string,
  text: string,
  labelI18n?: TraceI18nText,
): NonNullable<IndexTraceStep["details"]>[number] {
  return {
    key,
    label,
    ...(labelI18n ? { labelI18n } : {}),
    kind: "text",
    text: decodeEscapedUnicodeText(text, true),
  };
}

function noteDetail(
  key: string,
  label: string,
  text: string,
  labelI18n?: TraceI18nText,
): NonNullable<IndexTraceStep["details"]>[number] {
  return {
    key,
    label,
    ...(labelI18n ? { labelI18n } : {}),
    kind: "note",
    text: decodeEscapedUnicodeText(text, true),
  };
}

function createStep(
  trace: IndexTraceRecord,
  kind: IndexTraceStep["kind"],
  title: string,
  status: IndexTraceStep["status"],
  inputSummary: string,
  outputSummary: string,
  options: {
    refs?: Record<string, unknown>;
    metrics?: Record<string, unknown>;
    details?: IndexTraceStep["details"];
    promptDebug?: RetrievalPromptDebug;
    titleI18n?: TraceI18nText;
    inputSummaryI18n?: TraceI18nText;
    outputSummaryI18n?: TraceI18nText;
  } = {},
): void {
  trace.steps.push({
    stepId: `${trace.indexTraceId}:step:${trace.steps.length + 1}`,
    kind,
    title,
    status,
    inputSummary,
    outputSummary,
    ...(options.refs ? { refs: options.refs } : {}),
    ...(options.metrics ? { metrics: options.metrics } : {}),
    ...(options.details ? { details: options.details } : {}),
    ...(options.promptDebug ? { promptDebug: options.promptDebug } : {}),
    ...(options.titleI18n ? { titleI18n: options.titleI18n } : {}),
    ...(options.inputSummaryI18n ? { inputSummaryI18n: options.inputSummaryI18n } : {}),
    ...(options.outputSummaryI18n ? { outputSummaryI18n: options.outputSummaryI18n } : {}),
  });
}

function createBatchTrace(
  sessionKey: string,
  sessions: L0SessionRecord[],
  trigger: IndexTraceRecord["trigger"],
  focusUserTurnCount: number,
): IndexTraceRecord {
  const startedAt = nowIso();
  const timestamps = sessions
    .map(session => session.timestamp)
    .filter(Boolean)
    .sort();
  return {
    indexTraceId: buildIndexTraceId(
      sessionKey,
      startedAt,
      sessions.map(session => session.l0IndexId),
    ),
    sessionKey,
    trigger,
    startedAt,
    status: "running",
    isNoOp: false,
    displayStatus: "Running",
    batchSummary: {
      l0Ids: sessions.map(session => session.l0IndexId),
      segmentCount: sessions.length,
      focusUserTurnCount,
      fromTimestamp: timestamps[0] ?? "",
      toTimestamp: timestamps[timestamps.length - 1] ?? "",
    },
    steps: [],
    storedResults: [],
  };
}

export {
  buildCandidateMemoryPreview,
  buildCandidateRoutingQuery,
  buildGeneralProjectShortlist,
  buildIndexTraceId,
  commonPrefixLength,
  createBatchTrace,
  createStep,
  deriveFocusTurns,
  emptyStats,
  exposeStoredRelativePath,
  flattenBatchMessages,
  hasNewContent,
  inferStorageKind,
  mergeSessionMessages,
  normalizeTrigger,
  noteDetail,
  previewText,
  sameMessage,
  textDetail,
  tokenizeSearchText,
};
