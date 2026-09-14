import type { CanonicalMessage } from "../../model/index.js";
import { isPromptDateNotice } from "../../context/prompt/promptDateNotice.js";

export function extractLastUserMessage(messages: CanonicalMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") {
      continue;
    }
    // 跨日日期通知只更新接收方的当日日期，不改变任务本身的复杂度，不能参与分类。
    if (isPromptDateNotice(message)) {
      continue;
    }
    const text = message.content
      .filter((block): block is import("../../model/index.js").CanonicalTextBlock => block.type === "text")
      .map(block => block.text)
      .join("\n")
      .trim();
    if (text.length > 0) {
      return text;
    }
  }
  return undefined;
}
