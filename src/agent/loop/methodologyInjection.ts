import { messageContent, type CanonicalMessage } from "../../model/index.js";

/**
 * Append an optional methodology prompt (from the injected hook) to the system
 * prompt, keyed off the FIRST user text message of the request. No-op when the
 * hook is absent or returns nothing.
 *
 * Keying off the first user message (rather than the last) keeps the
 * methodology stable across the turn: tool results and supplemental
 * messages are projected as later role:"user" messages and would otherwise
 * flip the matched methodology (or drop it) mid-turn, and it keeps the
 * system-prompt prefix stable for prompt caching.
 *
 * Pure function — no class/instance state. Extracted from AgentLoop so the
 * methodology feature can be unit-tested and evolved independently.
 */
/**
 * 取请求消息中的第一条 user 文本消息（methodology keying 依据）。
 * 导出供「注入内容落库」记录 methodology 注入段落时复用同一 keying 逻辑。
 */
export function findFirstUserText(messages: CanonicalMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const parts: string[] = [];
    for (const block of messageContent(message)) {
      if (block.type === "text") parts.push(block.text);
    }
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  return undefined;
}

/**
 * 单次计算方法论 addendum（keying 于第一条 user 文本）。与拼 system prompt
 * 分离：调用方可复用同一 addendum 既落库审计又拼 prompt，避免同一 inject
 * 回调执行两次导致「记录文本 ≠ 模型实际所见」。
 */
export function computeMethodologyAddendum(
  messages: CanonicalMessage[],
  inject?: (firstUserMessage: string) => string | null,
): string | undefined {
  if (!inject) return undefined;
  const firstUserText = findFirstUserText(messages);
  if (firstUserText === undefined) return undefined;
  return inject(firstUserText) || undefined;
}

/** 把已计算的方法论 addendum 追加到 system prompt（空值原样返回）。 */
export function applyMethodologyAddendum(systemPrompt: string, addendum: string | undefined): string {
  if (!addendum) return systemPrompt;
  return `${systemPrompt}\n\n${addendum}`;
}
