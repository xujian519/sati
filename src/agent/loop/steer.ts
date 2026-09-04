/**
 * Mid-turn steering 注入（协议 1.6）。
 *
 * 模型调用边界 drain SteerMailbox，把排队插话构造为用户消息追加到消息
 * 序列尾部（尾部追加不破坏 prompt-cache 前缀）；消息经 onDurableMessage
 * 落库（不丢消息，transcript 顺序正确）。与 repeatToolReminder 的
 * transient advisory 不同：插话是用户真实输入，非 transient、Web 投影
 * 正常显示，metadata.purpose 供审计识别。
 */
import type { CanonicalMessage } from "../../model/index.js";
import type { SteerItem } from "../session/SteerMailbox.js";

/** 事件与审计用的插话预览长度上限。 */
const STEER_PREVIEW_MAX_CHARS = 160;

/** 构造插话预览（单行化 + 截断）。 */
export function steerPreview(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= STEER_PREVIEW_MAX_CHARS ? singleLine : `${singleLine.slice(0, STEER_PREVIEW_MAX_CHARS)}…`;
}

/** 构造插话用户消息。不带 synthetic 标记：用户真实输入，Web 投影正常显示（synthetic 会被 readSessionMessages 过滤）。 */
export function buildSteerMessage(item: SteerItem): CanonicalMessage {
  return {
    role: "user",
    content: [{ type: "text", text: item.text }],
    metadata: { purpose: "steer", steerId: item.steerId },
  };
}
