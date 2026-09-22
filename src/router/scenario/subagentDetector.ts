import { isTailInjection } from "../../context/prompt/tailInjection.js";
import type { CanonicalMessage, CanonicalToolSchema } from "../../model/index.js";

const SUBAGENT_TAG_PATTERN = /<(?:sati|ccr)-subagent-model>([\s\S]+?)<\/(?:sati|ccr)-subagent-model>/i;

export type SubagentDetection = {
  isSubagent: boolean;
  modelHint?: string;
  /** True when the request was launched without an Agent / Task tool, suggesting subagent context. */
  missingAgentTool: boolean;
  /** True when the message body contained a subagent tag we should strip in mutations. */
  taggedInUserMessage: boolean;
};

const AGENT_TOOL_NAME_PATTERN = /^(?:agent|task|launch[_-]?agent|spawn[_-]?agent)$/i;

export function detectSubagent(
  messages: CanonicalMessage[],
  tools: CanonicalToolSchema[] | undefined,
  isMainAgent: boolean,
): SubagentDetection {
  let modelHint: string | undefined;
  let taggedInUserMessage = false;

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    // 尾部注入是运行时拼进来的上下文（账本/记忆/方法论），其中的 `[subagent: …]` 字样
    // 不是用户写的调度标记，不得据此判定子代理场景。
    if (isTailInjection(message)) {
      continue;
    }
    for (const block of message.content) {
      if (block.type !== "text") {
        continue;
      }
      const match = SUBAGENT_TAG_PATTERN.exec(block.text);
      if (match) {
        modelHint = match[1].trim();
        taggedInUserMessage = true;
      }
    }
  }

  const missingAgentTool = !!tools && !tools.some(tool => AGENT_TOOL_NAME_PATTERN.test(tool.name));

  return {
    isSubagent: !isMainAgent || taggedInUserMessage || missingAgentTool,
    modelHint,
    missingAgentTool,
    taggedInUserMessage,
  };
}

export function stripSubagentTagFromMessages(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.map(message => {
    if (message.role !== "user") {
      return message;
    }
    let mutated = false;
    const content = message.content.map(block => {
      if (block.type !== "text") {
        return block;
      }
      const replaced = block.text.replace(SUBAGENT_TAG_PATTERN, "").trimEnd();
      if (replaced === block.text) {
        return block;
      }
      mutated = true;
      return { ...block, text: replaced };
    });
    return mutated ? { ...message, content } : message;
  });
}
