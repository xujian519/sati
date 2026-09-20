import type { CanonicalMessage } from "../../model/index.js";

/**
 * 压缩替换上下文的整份快照（上游 #599 引入的形态）。
 *
 * 压缩原本「先写边界记录、再逐条写替换消息」，两条记录之间存在崩溃窗口：
 * 边界已落盘而替换消息未落盘时，重放会丢弃边界前历史、只剩残缺替换内容。
 * 把整份替换上下文内联进边界记录后，「授权丢弃历史」与「替换内容完整」变成
 * 同一份记录的同一件事——记录不完整即不授权。
 */
export type CompactSnapshotPayload = {
  version: 1;
  messages: CanonicalMessage[];
};

/**
 * 快照读取的最小结构面：只需判别式与 boundary 字段，便于同时接受落盘条目
 * （`AgentTranscriptEntry`）与内存写入口的轻量形状。
 */
export type CompactSnapshotCarrier = { type: string; boundary?: unknown };

/**
 * 读取并校验压缩快照；不通过返回 undefined。
 *
 * 磁盘上的 JSON 即便能解析成完整记录也不可信（截断、旧版本、异构写入），
 * 故逐层校验形状后才返回消息——返回值即是「可否丢弃边界前历史」的唯一授权。
 */
export function readCompactSnapshot(entry: CompactSnapshotCarrier): CanonicalMessage[] | undefined {
  if (entry.type !== "control_boundary") {
    return undefined;
  }
  const boundary: unknown = entry.boundary;
  if (!isRecord(boundary) || boundary.kind !== "compact" || boundary.subtype !== "compact_boundary") {
    return undefined;
  }
  const snapshot: unknown = boundary.snapshot;
  if (!isRecord(snapshot)) {
    return undefined;
  }
  if (snapshot.version !== 1 || !Array.isArray(snapshot.messages) || snapshot.messages.length === 0) {
    return undefined;
  }
  const messages: CanonicalMessage[] = [];
  for (const candidate of snapshot.messages) {
    if (!isMessage(candidate)) {
      return undefined;
    }
    messages.push(candidate);
  }
  return messages;
}

function isMessage(value: unknown): value is CanonicalMessage {
  return (
    isRecord(value) &&
    (value.role === "user" || value.role === "assistant") &&
    (value.metadata === undefined || isRecord(value.metadata)) &&
    Array.isArray(value.content) &&
    value.content.every(isContentBlock)
  );
}

function isContentBlock(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.type) {
    case "text":
    case "thinking":
      return typeof value.text === "string";
    case "image":
    case "audio":
      return (
        (value.source === "base64" || value.source === "url") &&
        typeof value.data === "string" &&
        typeof value.mimeType === "string"
      );
    case "pdf":
      return (
        value.source === "base64" &&
        typeof value.data === "string" &&
        value.mimeType === "application/pdf" &&
        typeof value.bytes === "number"
      );
    case "tool_call":
      return typeof value.id === "string" && typeof value.name === "string";
    case "tool_result":
      return (
        typeof value.toolCallId === "string" &&
        Array.isArray(value.content) &&
        value.content.every(
          block => isRecord(block) && ["text", "image", "pdf"].includes(String(block.type)) && isContentBlock(block),
        )
      );
    case "tool_result_reference":
      return (
        typeof value.toolCallId === "string" &&
        typeof value.path === "string" &&
        typeof value.originalBytes === "number" &&
        typeof value.preview === "string" &&
        typeof value.hasMore === "boolean"
      );
    case "media_reference":
      return (
        typeof value.path === "string" &&
        typeof value.originalBytes === "number" &&
        typeof value.preview === "string" &&
        typeof value.hasMore === "boolean" &&
        typeof value.mimeType === "string" &&
        ["image", "pdf", "audio"].includes(String(value.mediaType))
      );
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
