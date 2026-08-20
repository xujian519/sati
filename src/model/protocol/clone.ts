import type { CanonicalContentBlock, CanonicalMessage } from "./canonical.js";

export function messageContent(message: Pick<CanonicalMessage, "content">): CanonicalContentBlock[] {
  return Array.isArray(message.content) ? message.content : [];
}

/**
 * Deep-clone a single content block. Handles nested structures that a plain
 * spread would share by reference:
 *
 *  - `tool_result` → deep-clones the inner `content` array and each element.
 *  - `tool_call`   → `structuredClone`s the opaque `input` payload.
 *  - All other block types have only primitive-valued properties; a spread
 *    is sufficient.
 *
 * The `raw` field is intentionally left as a shared reference — it is a
 * read-only provider echo used only for debugging and never mutated.
 */
export function cloneContentBlock(block: CanonicalContentBlock): CanonicalContentBlock {
  if (block.type === "tool_result") {
    return {
      ...block,
      content: block.content.map(item => ({ ...item })),
    };
  }
  if (block.type === "tool_call") {
    return {
      ...block,
      input: block.input !== undefined ? structuredClone(block.input) : block.input,
    };
  }
  return { ...block };
}

export function cloneMessage(message: CanonicalMessage): CanonicalMessage {
  return {
    ...message,
    content: messageContent(message).map(cloneContentBlock),
  };
}

export function cloneMessages(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.map(cloneMessage);
}
