/**
 * 防死循环软提醒（阶段四 T6.2）。
 *
 * 按 (toolName, canonical args) 连续重复计数（denied 调用也计数，排除项不
 * 中断链）；达到阈值后向下一轮请求注入 advisory 提醒（不拦截，与 doomLoop
 * 的硬断开互补）。提醒以 synthetic user 消息进入消息序列，模型可见但标记
 * purpose 供审计识别。
 */
import { randomUUID } from "node:crypto";
import type { CanonicalMessage } from "../../model/index.js";

/** 连续重复提醒阈值：达到即注入一次 advisory。 */
export const REPEAT_REMINDER_THRESHOLD = 3;

/**
 * (toolName, args) 的稳定链键：args 按 canonical JSON 序列化（raw 剥离）。
 *
 * @param toolName - 工具名。
 * @param args - 工具入参。
 * @returns 链键。
 */
export function toolCallKey(toolName: string, args: unknown): string {
  // canonical 序列化：剥离 raw 键、跳过 undefined，保证同参数同键。
  const canonical =
    JSON.stringify(args, (key, item) => {
      if (key === "raw") return undefined;
      if (item === undefined) return undefined;
      return item;
    }) ?? "null";
  return toolName + "|" + canonical;
}

/**
 * 连续重复计数器：同键累加，异键重置。
 */
export class RepeatTracker {
  private currentKey: string | undefined;
  private count = 0;

  /**
   * 记录一次工具调用。
   *
   * @param key - toolCallKey 产出的链键。
   * @returns 记录后的连续次数。
   */
  record(key: string): number {
    if (key !== this.currentKey) {
      this.currentKey = key;
      this.count = 0;
    }
    this.count += 1;
    return this.count;
  }

  /** 当前链的连续次数（0 = 无链）。 */
  current(): number {
    return this.currentKey === undefined ? 0 : this.count;
  }
}

/**
 * 构建重复提醒的 synthetic 用户消息（注入下一轮请求上下文）。
 *
 * @param toolName - 重复调用的工具名。
 * @param count - 当前连续次数。
 * @returns 带 purpose 标记的 synthetic 消息。
 */
export function buildRepeatReminderMessage(toolName: string, count: number): CanonicalMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `注意：你已连续 ${count} 次调用 ${toolName}（参数相同或高度相似）。如果上一步没有改变任何状态或取得新信息，请停止重复该调用，改为总结现状、换一种方式推进，或向用户说明阻塞原因。`,
      },
    ],
    // transient：仅注入下一轮请求，消费后随 transient 提示一并过期。
    metadata: { synthetic: true, transient: true, transientId: randomUUID(), purpose: "repeat_tool_reminder" },
  };
}
