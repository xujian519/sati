import type { GatewayEvent } from "../../../gateway/index.js";
import { renderCliStyleEvent } from "../protocol/render.js";

export function renderApiServerEvent(event: GatewayEvent): string | undefined {
  return renderCliStyleEvent(event);
}
