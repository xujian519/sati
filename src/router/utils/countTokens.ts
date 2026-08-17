import { flattenToolResultBlockText, type CanonicalMessage, type CanonicalModelEvent } from "../../model/index.js";
import { countTokens } from "../../context/budget/tokenizer.js";

export { countTokens };

/**
 * 估算消息序列 token 总数。
 *
 * 增量语义：逐消息拼接后分别计数再求和（而非全量 join 一次计数）——配合
 * tokenizer 的内容级 sha1 缓存，历史消息文本未变时仅 O(n) hash 命中，只有
 * 新增/变更的消息触发实际编码。全量 join 会在追加一条新消息时令整个上下文的
 * 缓存键变化，退化为每轮全量重编码（CJK 高重复文本下分钟级阻塞，见
 * docs/workbuddy-sati-performance-analysis-review.md P2-20）。
 */
export function countMessagesTokens(messages: CanonicalMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    const chunks: string[] = [];
    for (const block of msg.content) {
      switch (block.type) {
        case "text":
        case "thinking":
          chunks.push(block.text);
          break;
        case "tool_call":
          if (block.input !== undefined) {
            chunks.push(typeof block.input === "string" ? block.input : JSON.stringify(block.input));
          }
          break;
        case "tool_result":
          chunks.push(flattenToolResultBlockText(block));
          break;
      }
    }
    if (chunks.length === 0) continue;
    total += countTokens(chunks.join("\n"));
  }
  return total;
}

export function countResponseTokens(events: CanonicalModelEvent[]): number {
  const chunks: string[] = [];
  for (const event of events) {
    if (event.type === "text_delta") {
      chunks.push(event.text);
    } else if (event.type === "thinking_delta") {
      chunks.push(event.text);
    } else if (event.type === "tool_call_delta") {
      chunks.push(event.delta);
    }
  }
  if (chunks.length === 0) return 0;
  return countTokens(chunks.join(""));
}

/** No-op retained for API compatibility (js-tiktoken needs no manual free). */
export function dispose(): void {}
