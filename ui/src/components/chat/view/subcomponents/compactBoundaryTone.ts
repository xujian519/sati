import type { ChatMessage } from "../../types/types";

export type CompactBoundaryTone = "ok" | "degraded" | "cancelled";

/**
 * 压缩边界行的色调。降级/中断不得与成功共用同一个绿色徽标（上游 #570 移植）。
 *
 * `failed` 不会落成边界行（硬失败不写 transcript，也没有终态帧），一并归入降级色
 * 以防投影来源将来变化。缺省（旧记录读不到终态）视为成功——读不到不等于失败。
 */
export function resolveCompactBoundaryTone(
  message: Pick<ChatMessage, "compactState" | "compactSummarySucceeded">,
): CompactBoundaryTone {
  if (message.compactState === "cancelled") return "cancelled";
  if (
    message.compactSummarySucceeded === false ||
    message.compactState === "fallback" ||
    message.compactState === "failed"
  ) {
    return "degraded";
  }
  return "ok";
}
