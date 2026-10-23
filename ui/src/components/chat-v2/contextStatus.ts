export type ContextStatus = {
  known: boolean;
  used: number;
  total: number;
  displayTotal: number;
  percent: number;
  percentLabel: string;
  usedLabel: string;
  totalLabel: string;
  /**
   * system prompt + 工具 schema 的固定开销，以及由它推出的对话用量。服务端未给
   * 固定开销（压缩重建的历史预算、旧帧）时两者为 undefined——此时不展示拆分行，
   * 只显示合计，行为与拆分前一致。
   */
  fixedOverhead?: { tokens: number; label: string; percent: number };
  conversation?: { tokens: number; label: string; percent: number };
  state: "ok" | "warning" | "blocking" | "unknown";
  tone: "normal" | "amber" | "red" | "unknown";
};

/** 上下文用量按钮/徽章按 tone 查表取样式（tone 四值完备）。 */
export const CONTEXT_TONE_TRIGGER_STYLES: Record<ContextStatus["tone"], string> = {
  red: "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30",
  amber: "text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30",
  normal: "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
  unknown: "text-neutral-400 hover:bg-neutral-100 dark:text-neutral-500 dark:hover:bg-neutral-800",
};

export const CONTEXT_TONE_BADGE_STYLES: Record<ContextStatus["tone"], string> = {
  red: "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300",
  amber: "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300",
  normal: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300",
  unknown: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
};

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  }
  return value.toLocaleString();
}

function formatContextPercentLabel(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) {
    return "0%";
  }
  if (percent > 100) {
    return "100%+";
  }
  return `${percent}%`;
}

/** 服务器下发的 snapshot 状态优先于本地百分比阈值（blocking→red、warning→amber）。 */
function resolveContextTone(snapshotState: string | null, percent: number): ContextStatus["tone"] {
  if (snapshotState === "blocking") return "red";
  if (snapshotState === "warning") return "amber";
  if (percent >= 95) return "red";
  if (percent >= 80) return "amber";
  return "normal";
}

export function getContextStatus(tokenBudget?: Record<string, unknown> | null): ContextStatus {
  const used = readNumber(tokenBudget?.displayUsed) ?? readNumber(tokenBudget?.used) ?? 0;
  const total = readNumber(tokenBudget?.total) ?? 0;
  const effectiveTotal = readNumber(tokenBudget?.effectiveTotal);
  const windowTotal = total > 0 ? total : 0;
  const budgetTotal = effectiveTotal && effectiveTotal > 0 ? effectiveTotal : 0;
  const displayTotal = windowTotal > 0 ? windowTotal : budgetTotal;
  if (displayTotal <= 0) {
    return {
      known: false,
      used: 0,
      total: 0,
      displayTotal: 0,
      percent: 0,
      percentLabel: "0%",
      usedLabel: "--",
      totalLabel: "--",
      state: "unknown",
      tone: "unknown",
    };
  }

  // 百分比与「x / y」必须同分母：都用模型完整上下文窗口（缺 total 时退回扣掉输出
  // 预留的可用预算），否则同一句提示里会出现「39%。已用 38.2k / 131k tokens」这种
  // 自相矛盾的两个比例。
  const percent = Math.max(0, Math.round((used / displayTotal) * 100));
  // 策略严重度是另一个问题，且这个百分比不展示给用户：服务端 snapshot 带 state 时
  // 以它为准，缺失时（历史回放路径可能不带）才退回用「逼近自动压缩线」的可用预算
  // 算阈值，避免窗口口径的百分把压缩线的告警吃掉。
  const policyTotal = effectiveTotal && effectiveTotal > 0 ? effectiveTotal : displayTotal;
  const policyPercent = Math.max(0, Math.round((used / policyTotal) * 100));
  const snapshotState = typeof tokenBudget?.state === "string" ? tokenBudget.state : null;
  const tone = resolveContextTone(snapshotState, policyPercent);
  const { fixedOverhead, conversation } = splitFixedOverhead(
    readNumber(tokenBudget?.fixedOverheadTokens),
    used,
    displayTotal,
  );
  return {
    known: true,
    used,
    total,
    displayTotal,
    percent,
    percentLabel: formatContextPercentLabel(percent),
    usedLabel: formatTokenCount(used),
    totalLabel: formatTokenCount(displayTotal),
    ...(fixedOverhead && conversation ? { fixedOverhead, conversation } : {}),
    state: snapshotState === "blocking" || snapshotState === "warning" ? snapshotState : "ok",
    tone,
  };
}

/**
 * 把「已用」拆成固定开销（system prompt + 工具 schema）与对话用量。
 *
 * 服务端的固定开销是本地估算，而合计可能来自供应商计数——两者不同源时以合计为准，
 * 固定开销会被夹到不超过合计，保证两行数字恒等于合计本身（不出现三行互相矛盾）。
 * 缺失或非正值的固定开销视为「未拆分」，返回空对象，调用方退回只显示合计。
 */
function splitFixedOverhead(
  fixedOverheadTokens: number | null,
  used: number,
  displayTotal: number,
): {
  fixedOverhead?: ContextStatus["fixedOverhead"];
  conversation?: ContextStatus["conversation"];
} {
  if (fixedOverheadTokens === null || fixedOverheadTokens <= 0 || used <= 0) {
    return {};
  }
  const overhead = Math.min(Math.round(fixedOverheadTokens), used);
  const conversationTokens = used - overhead;
  const slice = (tokens: number) => ({
    tokens,
    label: formatTokenCount(tokens),
    percent: Math.max(0, Math.round((tokens / displayTotal) * 100)),
  });
  return { fixedOverhead: slice(overhead), conversation: slice(conversationTokens) };
}
