/**
 * AgentLoop 消息工具纯函数（从 AgentLoop.ts 拆出）。
 *
 * 全部为确定性消息变换，无运行期状态；可独立测试。
 */

import { truncateHeadPreservingCheckpoint } from "../../context/compaction/CompactionEngine.js";
import {
  messageContent,
  textFromMessage,
  type CanonicalMessage,
  type CanonicalToolCall,
  type PartialTextToolCallInfo,
} from "../../model/index.js";
import type { StreamInterruption } from "../../model/protocol/errors.js";
import type { SatiToolErrorResult } from "../../tool/index.js";

export const PLAN_MODE_REMINDER_MESSAGE = [
  "Plan mode is active.",
  "Read first using read-only tools, then write or refine plan markdown only under `.sati/plans/`.",
  "Do not make implementation changes while planning.",
  "When the plan is ready for user review, call `exit_plan_mode` with the plan file path.",
].join("\n");

export function hasToolCallBlock(message: CanonicalMessage): boolean {
  return messageContent(message).some(block => block.type === "tool_call");
}

export function isMissingReasoningContentError(error: { message: string }): boolean {
  return (
    /\breasoning_content\b/i.test(error.message) &&
    /thinking\s+mode/i.test(error.message) &&
    /pass(?:ed)?\s+back/i.test(error.message)
  );
}

export function hasReplayableReasoningContent(message: CanonicalMessage): boolean {
  return messageContent(message).some(
    block =>
      block.type === "thinking" && ((block.reasoningContent ?? block.text).length > 0 || block.reasoningContent === ""),
  );
}

export function addEmptyReasoningContentMarkers(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.map((message, index) => {
    if (index === messages.length - 1 && message.role === "assistant" && messageContent(message).length === 0) {
      return message;
    }
    if (message.role !== "assistant" || hasReplayableReasoningContent(message)) {
      return message;
    }
    return {
      ...message,
      content: [{ type: "thinking", text: "", reasoningContent: "" }, ...messageContent(message)],
    };
  });
}

export function appendPlanModeReminder(messages: CanonicalMessage[]): CanonicalMessage[] {
  return [
    ...messages,
    {
      role: "user",
      content: [{ type: "text", text: PLAN_MODE_REMINDER_MESSAGE }],
      metadata: { synthetic: true, purpose: "plan_mode_reminder" },
    },
  ];
}

/** Keep a bounded tail without dropping the user request that initiated it. */
export function truncateHeadKeepRatio(messages: CanonicalMessage[], keepRatio: number): CanonicalMessage[] {
  return truncateHeadPreservingCheckpoint(messages, keepRatio);
}

/**
 * Drop the trailing `[assistant_message_with_partial_tool_call,
 * synthetic_tool_result]` pair the loop just appended on a model error so a
 * retry doesn't replay an unfinished tool call. Safe no-op if the trailing
 * shape doesn't match.
 */
export function stripTrailingErrorPair(messages: CanonicalMessage[]): CanonicalMessage[] {
  const out = [...messages];
  const last = out[out.length - 1];
  if (last && last.role === "user" && last.content.every(block => block.type === "tool_result")) {
    out.pop();
  }
  const newLast = out[out.length - 1];
  if (newLast && newLast.role === "assistant") {
    out.pop();
  }
  return out;
}

/**
 * Strip all image blocks from messages, replacing them with a text placeholder.
 * Used as a recovery strategy when a multimodal processor fails on corrupted images.
 */
export function stripImagesFromMessages(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.map(msg => {
    const newContent = msg.content.map(block => {
      if (block.type === "image") {
        return { type: "text" as const, text: "[Image removed: multimodal processor error recovery]" };
      }
      if (block.type === "tool_result" && block.content.some(c => c.type === "image")) {
        return {
          ...block,
          content: block.content.map(c =>
            c.type === "image"
              ? { type: "text" as const, text: "[Image removed: multimodal processor error recovery]" }
              : c,
          ),
        };
      }
      return block;
    });
    return { ...msg, content: newContent };
  });
}

export function removeTransientPromptsById(
  messages: CanonicalMessage[],
  transientIds: Set<string>,
): CanonicalMessage[] {
  return messages.filter(message => {
    const transientId = message.metadata?.transientId;
    return !(
      message.role === "user" &&
      message.metadata?.transient === true &&
      typeof transientId === "string" &&
      transientIds.has(transientId)
    );
  });
}

/**
 * 把 transient synthetic prompts（恢复提示，从未落库）从消息序列中分离。
 * 压缩输入必须用 persistent 部分——transient 若参与压缩，遮蔽重建序列
 * （transcript 投影）会缺这些消息导致 shadowedRanges 索引错位。
 */
export function splitTransientPrompts(messages: CanonicalMessage[]): {
  persistent: CanonicalMessage[];
  transient: CanonicalMessage[];
} {
  const persistent: CanonicalMessage[] = [];
  const transient: CanonicalMessage[] = [];
  for (const message of messages) {
    if (message.metadata?.transient === true) {
      transient.push(message);
    } else {
      persistent.push(message);
    }
  }
  return { persistent, transient };
}

export function normalizeMessagesForModelRequest(messages: CanonicalMessage[]): CanonicalMessage[] {
  const out: CanonicalMessage[] = [];
  for (const rawMessage of messages) {
    const message: CanonicalMessage = {
      ...rawMessage,
      content: messageContent(rawMessage),
    };
    const last = out[out.length - 1];
    if (last?.role === "assistant" && message.role === "assistant" && canMergeAssistantMessages(last, message)) {
      out[out.length - 1] = {
        role: "assistant",
        content: [...messageContent(last), ...messageContent(message)],
        metadata: mergeMessageMetadata(last.metadata, message.metadata),
      };
      continue;
    }
    if (message.role === "assistant" && message.content.length === 0) {
      continue;
    }
    out.push(message);
  }
  return out;
}

function canMergeAssistantMessages(first: CanonicalMessage, second: CanonicalMessage): boolean {
  return !hasToolCallBlock(first) && !hasToolCallBlock(second);
}

function mergeMessageMetadata(
  first: CanonicalMessage["metadata"],
  second: CanonicalMessage["metadata"],
): CanonicalMessage["metadata"] {
  if (!first && !second) {
    return undefined;
  }
  return {
    ...(first ?? {}),
    ...(second ?? {}),
  };
}

export function buildPartialTextToolCallRecoveryPrompt(partial: PartialTextToolCallInfo | undefined): string {
  const evidence = partial
    ? `Detected partial text tool-call syntax (${partial.format}/${partial.reason}).`
    : "Detected partial text tool-call syntax.";
  return [
    "The previous response contained partial tool-call XML/text and could not be safely executed.",
    evidence,
    "Resend the complete intended tool call with all required parameters, or continue in visible text if no tool is needed.",
    "Do not repeat dangling XML/tool-call fragments.",
  ].join("\n");
}

/** 去掉 thinking 块后的消息副本（thinking 不回显给用户，也不参与续接判定）。 */
export function withoutThinkingBlocks(message: CanonicalMessage): CanonicalMessage {
  return {
    ...message,
    content: messageContent(message).filter(block => block.type !== "thinking"),
  };
}

/**
 * 流中断/未知 finish 恢复出口的安全最终文本消息：
 * - 存在任何 tool call（含文本编码的半截调用）→ 不产出最终消息（绝不把
 *   半截工具调用持久化给用户/转录）；
 * - 否则去掉 thinking 块后，无实质文本 → undefined，有实质文本 → 文本消息。
 */
export function safeFinalTextMessage(
  message: CanonicalMessage,
  hasPartialTextToolCall: boolean | undefined,
  toolCalls: CanonicalToolCall[],
): CanonicalMessage | undefined {
  if (hasPartialTextToolCall || toolCalls.length > 0) {
    return undefined;
  }
  const textMessage = withoutThinkingBlocks(message);
  return textFromMessage(textMessage).trim().length > 0 ? textMessage : undefined;
}

/** 流中断恢复提示（按中断阶段定制）。 */
export function buildStreamInterruptionRecoveryPrompt(interruption: StreamInterruption): string {
  if (interruption.phase === "tool_call") {
    const tools = interruption.activeToolCalls?.map(call => call.name || "unknown").filter(Boolean) ?? [];
    const toolLabel = tools.length > 0 ? ` (${tools.slice(0, 3).join(", ")})` : "";
    return [
      `The previous model stream disconnected while generating a tool call${toolLabel}. No incomplete tool call was executed.`,
      "Continue the original task from the current workspace state. Inspect relevant files before writing.",
      "Do not retry the same large atomic write. Create or extend the artifact through small focused write_file or edit_file calls, keeping each tool call well under 8K output tokens.",
    ].join("\n");
  }
  if (interruption.phase === "reasoning") {
    return "The previous model stream disconnected during reasoning. Continue the original task directly from the current workspace state; do not repeat analysis or recap.";
  }
  if (interruption.phase === "text") {
    return "The previous model stream disconnected mid-response. Continue exactly where the visible response ended; do not repeat prior text or recap.";
  }
  return "The previous model stream disconnected before producing a response. Continue the original task directly from the current workspace state.";
}

/** 未知 finishReason 恢复提示。 */
export function buildUnknownFinishRecoveryPrompt(toolCalls: CanonicalToolCall[]): string {
  if (toolCalls.length > 0) {
    return [
      "The previous response ended without a recognized finish reason after generating tool calls. No tool call was executed.",
      "Continue the original task from the current workspace state. Inspect relevant files before acting.",
      "Do not repeat the same large atomic write. Use small focused write_file or edit_file calls.",
    ].join("\n");
  }
  return "The previous response ended without a recognized finish reason. Continue exactly where the visible response ended; do not repeat prior text or recap.";
}

export function appendTextToFirstContent(
  content: SatiToolErrorResult["content"],
  suffix: string,
): SatiToolErrorResult["content"] {
  const [first, ...rest] = content;
  if (!first) {
    return [{ type: "text", text: suffix.trimStart() }];
  }
  if (first.type !== "text") {
    return [{ type: "text", text: suffix.trimStart() }, first, ...rest];
  }
  return [{ ...first, text: `${first.text}${suffix}` }, ...rest];
}

export function markCompactReplacementMessages(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.map(message => ({
    ...message,
    metadata: {
      ...(message.metadata ?? {}),
      compactReplacement: true,
    },
  }));
}
