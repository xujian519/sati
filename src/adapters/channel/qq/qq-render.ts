import type { GatewayEvent } from "../../../gateway/index.js";

export function renderQQEvent(event: GatewayEvent): string | undefined {
  switch (event.type) {
    case "assistant_text_delta":
      return event.text;
    case "assistant_thinking_delta":
      return "";
    case "tool_call_started":
      return "";
    case "tool_call_finished":
      if (!event.ok) {
        const name = event.toolName ?? event.toolCallId;
        return `\n⚠️ ${name} 执行失败\n`;
      }
      return "";
    case "error":
      return `\n❌ ${event.message}\n`;
    default:
      return undefined;
  }
}
