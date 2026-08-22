import type { ProjectedMessage } from "../protocol/types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractText(message: unknown): string | undefined {
  if (!isObject(message)) return undefined;

  const role = message.role;
  if (role !== "user" && role !== "assistant") return undefined;

  const content = message.content;
  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const block of content) {
    if (isObject(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }

  const joined = parts.join("\n").trim();
  return joined.length > 0 ? joined : undefined;
}

function baseId(entry: Record<string, unknown>): string {
  if (typeof entry.entryId === "string" && entry.entryId.length > 0) {
    return entry.entryId;
  }
  const sequence = typeof entry.sequence === "number" ? entry.sequence : 0;
  return `seq-${sequence}`;
}

function entryAt(entry: Record<string, unknown>): string {
  return typeof entry.createdAt === "string" && entry.createdAt.length > 0 ? entry.createdAt : new Date().toISOString();
}

function projectAcceptedInput(entry: Record<string, unknown>): ProjectedMessage[] {
  const messages = entry.messages;
  if (!Array.isArray(messages)) return [];

  const id = baseId(entry);
  const at = entryAt(entry);
  const out: ProjectedMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const raw = messages[index];
    const text = extractText(raw);
    if (text === undefined) continue;

    const role = isObject(raw) ? raw.role : undefined;
    out.push({
      id: `${id}-m${index}`,
      text,
      kind: role === "assistant" ? "assistant" : "user",
      at,
    });
  }

  return out;
}

function projectAssistantLike(entry: Record<string, unknown>): ProjectedMessage[] {
  const text = extractText(entry.message);
  if (text === undefined) return [];

  return [
    {
      id: baseId(entry),
      text,
      kind: "assistant",
      at: entryAt(entry),
    },
  ];
}

/**
 * 把 Sati transcript 事件投影为 canvas 消息。
 * MVP 仅抽取 user/assistant 文本块；tool_result、status、thinking 等保持沉默。
 */
export function projectSessionEvents(events: unknown[]): ProjectedMessage[] {
  const out: ProjectedMessage[] = [];

  for (const raw of events) {
    if (!isObject(raw)) continue;

    const type = raw.type;
    if (type === "accepted_input") {
      out.push(...projectAcceptedInput(raw));
    } else if (type === "assistant_message" || type === "durable_message") {
      out.push(...projectAssistantLike(raw));
    }
  }

  return out;
}
