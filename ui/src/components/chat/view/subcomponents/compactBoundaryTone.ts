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

/** 各色调的配色与文案键（`ok` 复用既有的默认文案，故无 `labelDefault`）。 */
export const COMPACT_BOUNDARY_TONE_STYLES: Record<
  CompactBoundaryTone,
  { line: string; badge: string; labelKey: string; labelDefault?: string }
> = {
  ok: {
    line: "bg-emerald-200/70 dark:bg-emerald-900/50",
    badge:
      "border-emerald-200/80 bg-emerald-50 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-300",
    labelKey: "compact.label",
  },
  degraded: {
    line: "bg-amber-200/70 dark:bg-amber-900/50",
    badge:
      "border-amber-300/80 bg-amber-50 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300",
    labelKey: "compact.labelDegraded",
    labelDefault: "摘要降级",
  },
  cancelled: {
    line: "bg-amber-200/70 dark:bg-amber-900/50",
    badge:
      "border-amber-300/80 bg-amber-50 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300",
    labelKey: "compact.labelCancelled",
    labelDefault: "已中断（沿用降级摘要）",
  },
};
