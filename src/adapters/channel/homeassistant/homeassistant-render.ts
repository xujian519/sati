import type { GatewayEvent } from "../../../gateway/index.js";
import { renderPlainTextEvent } from "../protocol/render.js";

export function renderHomeAssistantEvent(event: GatewayEvent): string | undefined {
  return renderPlainTextEvent(event);
}
