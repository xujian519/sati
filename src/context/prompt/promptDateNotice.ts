/**
 * 跨 UTC 午夜的日期通知（上游 PilotDeck v2026.09.14 / PR #571 语义移植）。
 *
 * 系统提示里的 `<environment>now:` 位于前缀中，是 Anthropic prompt cache 的
 * 缓存键：跨天改写它会让整段前缀失效、按 cache miss 重付一次全量 prefill。
 * 因此会话首次正式组装请求时锚定日期（见 DefaultContextRuntime 的 promptTimeState），
 * 跨天改为在请求消息尾部追加一条合成 user 消息告知真实日期——前缀逐字不变，
 * 模型也不会拿到陈旧日期（陈旧上界收敛到 0 天）。
 *
 * 该通知只存在于请求投影：不落 transcript、不写用户会话记录、不参与记忆检索。
 */

import type { CanonicalMessage } from "../../model/index.js";

/** 日期通知消息的 `metadata.purpose` 标记（router 分类等旁路据此排除）。 */
export const PROMPT_DATE_NOTICE_PURPOSE = "date_update";

/**
 * 构造一条跨日日期通知。
 *
 * 不带 `transient`：通知要在同一会话的后续请求中保留在同一位置，以维持已有
 * 缓存前缀。
 *
 * @param date - UTC 日期，形如 `2026-09-14`。
 * @returns 合成 user 消息。
 */
export function buildPromptDateNotice(date: string): CanonicalMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text:
          `<date-update>\ncurrent_date: ${date} (UTC)\n` +
          "The date has changed. Use this date for today and relative dates, " +
          "superseding earlier environment dates.\n</date-update>",
      },
    ],
    metadata: { synthetic: true, purpose: PROMPT_DATE_NOTICE_PURPOSE },
  };
}

/**
 * 判定消息是否为跨日日期通知。
 *
 * @param message - 待判定消息。
 * @returns 是日期通知时为 true。
 */
export function isPromptDateNotice(message: CanonicalMessage): boolean {
  return message.metadata?.synthetic === true && message.metadata?.purpose === PROMPT_DATE_NOTICE_PURPOSE;
}
