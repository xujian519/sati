import type { GatewayEvent } from "../../../gateway/index.js";
import { renderPlainTextEvent } from "../protocol/render.js";

export function renderWeixinEvent(event: GatewayEvent): string | undefined {
  return renderPlainTextEvent(event, { toolFailureLabel: "执行失败", skipToolNames: new Set(["send_attachment"]) });
}
