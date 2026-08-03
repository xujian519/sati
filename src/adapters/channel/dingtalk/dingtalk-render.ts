import type { GatewayEvent } from "../../../gateway/index.js";
import { renderPlainTextEvent } from "../protocol/render.js";

export function renderDingTalkEvent(event: GatewayEvent): string | undefined {
  return renderPlainTextEvent(event, { toolFailureLabel: "执行失败" });
}
