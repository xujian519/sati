/**
 * 尾部注入（2.3「系统提示分桶」）：**逐调用可变**的上下文段落不进 system prompt，
 * 而是合成一条 synthetic user 消息追加在请求消息末尾。
 *
 * 为什么：system prompt 整体是一个缓存前缀块——Anthropic 的 `cache_control` 打在
 * system 块上（`src/model/providers/anthropic/request.ts`），OpenAI / DeepSeek 的隐式
 * 前缀缓存同理。任何逐轮变化的内容落在 system prompt 里，被作废的就不只是那一小段，
 * 而是它**之前**的全部前缀（工具 schema + 整个 system prompt + 消息前缀）。
 * `src/context/cache/CachePlan.ts` 已声明该布局约束（可变注入位于最近 N 条断点之后），
 * 本模块是它的实现。
 *
 * 形状与既有尾部注入一致（`promptDateNotice` / `plan_mode_reminder` /
 * `repeat_tool_reminder` / `steer`）：synthetic user 消息 + `purpose` 标记；只存在于
 * **请求投影**，不落 transcript、不进消息历史（因此不参与记忆检索与重放投影）。
 * 段落原文仍以 `InjectionRecord` 落 `injected_context`（「模型可见 = 已记录」）。
 *
 * 分桶判据（谁进尾部、谁留 system prompt）：
 *   - 进尾部：逐轮可变（账本块、plan-todo 追加段、记忆附件）或随请求重算（方法论追加段）。
 *   - 留 system prompt：会话内静态的产品框架与指令（默认系统提示、user/system context、
 *     调用方 `appendSystemPrompt`、`<project-instructions>`、`<memory-tools>` 清单），
 *     以及元认知提示（开关开启后内容恒定）。
 */

import type { CanonicalMessage } from "../../model/index.js";
import type { InjectionRecord } from "../protocol/types.js";

/** 尾部注入消息的 `metadata.purpose` 标记（缓存布局与审计据此识别）。 */
export const TAIL_INJECTION_PURPOSE = "context_injection";

/**
 * 把注入段落合成为一条尾部用户消息。段落按**调用方给定的顺序**用空行连接，
 * 每段原文逐字节保留（审计记录的文本即模型所见）。无有效段落时返回 undefined——
 * 调用方据此保持请求形状不变（不产生空消息）。
 *
 * @param records - 注入段落（source + text）。
 * @returns 合成消息；无内容时为 undefined。
 */
export function buildTailInjectionMessage(records: readonly InjectionRecord[]): CanonicalMessage | undefined {
  const texts = records.map(record => record.text.trim()).filter(text => text.length > 0);
  if (texts.length === 0) return undefined;
  return {
    role: "user",
    content: [{ type: "text", text: texts.join("\n\n") }],
    metadata: { synthetic: true, purpose: TAIL_INJECTION_PURPOSE },
  };
}

/**
 * 判定消息是否为尾部注入。
 *
 * @param message - 待判定消息。
 * @returns 是尾部注入时为 true。
 */
export function isTailInjection(message: CanonicalMessage): boolean {
  return message.metadata?.synthetic === true && message.metadata?.purpose === TAIL_INJECTION_PURPOSE;
}
