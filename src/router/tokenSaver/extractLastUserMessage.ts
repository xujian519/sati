import type { CanonicalMessage } from "../../model/index.js";
import { isPromptDateNotice } from "../../context/prompt/promptDateNotice.js";
import { isTailInjection } from "../../context/prompt/tailInjection.js";

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
    // 尾部注入（账本块/记忆附件/方法论/plan-todo）是运行时拼进来的上下文，不是用户说的话：
    // 拿它分类会把「最近检索到的知识卡片」当成用户意图。
    if (isTailInjection(message)) {
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
